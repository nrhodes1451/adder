import type { Engine } from "../engine/types";
import { ChannelHost, createChannel } from "./channel";
import { apply, query } from "./ops";
import type { EditEvent, FromWorker, PyStatus, Stream, ToWorker } from "./protocol";

export interface PythonHostEvents {
  output?(stream: Stream, text: string): void;
  status?(status: PyStatus): void;
  functions?(names: string[]): void;
  editHandlers?(refs: string[]): void;
  /** Rewrite a cell input written by a script before it reaches the engine (custom functions). */
  transformInput?(sheet: number, row: number, col: number, input: string): string;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  ms: number;
}

const HARD_STOP_MS = 1500;

/** Main-thread side of the Python worker: runs scripts and serves their workbook calls. */
export class PythonHost {
  private worker: Worker | null = null;
  private channel: ChannelHost | null = null;
  private interrupt: Uint8Array | null = null;
  private nextId = 1;
  private runs = new Map<number, { resolve: (r: RunResult) => void; started: number }>();
  private calls = new Map<number, (r: { value?: string; error?: string }) => void>();
  status: PyStatus = "idle";

  constructor(
    private engine: Engine,
    private activeSheet: () => number,
    private events: PythonHostEvents = {},
  ) {}

  get running(): boolean {
    return this.runs.size > 0;
  }

  run(code: string): Promise<RunResult> {
    const id = this.nextId++;
    const started = performance.now();
    return new Promise((resolve) => {
      this.runs.set(id, { resolve, started });
      this.send({ type: "run", id, code });
    });
  }

  /** Evaluate a registered custom function; resolves to the result cell's input. */
  call(name: string, args: unknown[]): Promise<{ value?: string; error?: string }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      this.send({ type: "call", id, name, args });
    });
  }

  /** Notify on_edit handlers registered for `ref`. */
  edit(ref: string, event: EditEvent): void {
    if (this.worker) this.send({ type: "edit", id: this.nextId++, ref, event });
  }

  /** Interrupt the running script; terminate the worker if it doesn't stop promptly. */
  stop(): void {
    if (!this.worker || !this.running) return;
    if (this.interrupt) this.interrupt[0] = 2; // SIGINT -> KeyboardInterrupt
    const worker = this.worker;
    setTimeout(() => {
      if (this.worker === worker && this.running) this.terminate("Stopped: the worker was restarted.");
    }, HARD_STOP_MS);
  }

  terminate(reason = "Stopped."): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, r] of this.runs) r.resolve({ ok: false, error: reason, ms: performance.now() - r.started });
    this.runs.clear();
    for (const [, resolve] of this.calls) resolve({ error: "Python was stopped" });
    this.calls.clear();
    // A fresh worker has nothing registered.
    this.events.functions?.([]);
    this.events.editHandlers?.([]);
    this.setStatus("idle");
  }

  dispose(): void {
    this.terminate();
  }

  private send(msg: ToWorker): void {
    this.ensureWorker().postMessage(msg);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!crossOriginIsolated) throw new Error("Python needs cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer.");
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "adder-python" });
    const buffers = createChannel();
    const interrupt = new SharedArrayBuffer(1);
    this.channel = new ChannelHost(buffers);
    this.interrupt = new Uint8Array(interrupt);
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    worker.onerror = (e) => {
      this.events.output?.("stderr", `Python worker error: ${e.message}\n`);
      this.terminate("The Python worker crashed.");
    };
    worker.postMessage({ type: "init", channel: buffers, interrupt } satisfies ToWorker);
    this.worker = worker;
    return worker;
  }

  private setStatus(s: PyStatus): void {
    this.status = s;
    this.events.status?.(s);
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case "status":
        this.setStatus(msg.status);
        break;
      case "output":
        this.events.output?.(msg.stream, msg.text);
        break;
      case "done": {
        const r = this.runs.get(msg.id);
        this.runs.delete(msg.id);
        r?.resolve({ ok: !msg.error, error: msg.error, ms: performance.now() - r.started });
        break;
      }
      case "sync": {
        let reply: unknown;
        try {
          reply = query(this.engine, this.activeSheet, msg.op, JSON.parse(msg.args) as Record<string, unknown>);
        } catch (e) {
          reply = { __error: e instanceof Error ? e.message : String(e) };
        }
        this.channel!.reply(JSON.stringify(reply ?? null));
        break;
      }
      case "sync-next":
        this.channel!.next();
        break;
      case "post":
        try {
          apply(this.engine, this.events, msg.op, JSON.parse(msg.args) as Record<string, unknown>);
        } catch (e) {
          this.events.output?.("stderr", `adder: ${msg.op} failed: ${e instanceof Error ? e.message : String(e)}\n`);
        }
        break;
      case "call-result": {
        const resolve = this.calls.get(msg.id);
        this.calls.delete(msg.id);
        resolve?.(msg.error ? { error: msg.error } : { value: msg.value as string });
        break;
      }
    }
  }
}
