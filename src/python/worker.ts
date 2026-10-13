/// <reference lib="webworker" />
// Pyodide runtime. Runs user scripts off the main thread; talks to the
// workbook through the `_adder_bridge` JS module (see channel.ts).

import type { PyodideAPI } from "pyodide";
import adderSource from "./adder.py?raw";
import { ChannelClient } from "./channel";
import { cleanTraceback } from "./traceback";
import { type FromWorker, PYODIDE_INDEX, type Stream, type ToWorker } from "./protocol";

const post = (m: FromWorker) => self.postMessage(m);

let channel: ChannelClient | null = null;
let interrupt: Uint8Array | null = null;
let pyodide: Promise<PyodideAPI> | null = null;

// Output is batched; the worker's event loop is blocked while Python runs, so
// flush on size/time inside the write callback rather than with timers.
let outBuf: { stream: Stream; text: string } | null = null;
let lastFlush = 0;
function write(stream: Stream, text: string): void {
  if (outBuf && outBuf.stream !== stream) flushOutput();
  outBuf = outBuf ? { stream, text: outBuf.text + text } : { stream, text };
  const now = performance.now();
  if (outBuf.text.length > 16_384 || now - lastFlush > 50) flushOutput();
}
function flushOutput(): void {
  if (outBuf) post({ type: "output", ...outBuf });
  outBuf = null;
  lastFlush = performance.now();
}

function boot(): Promise<PyodideAPI> {
  pyodide ??= (async () => {
    post({ type: "status", status: "loading" });
    const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE_INDEX}pyodide.mjs`)) as typeof import("pyodide");
    const py = await loadPyodide({ indexURL: PYODIDE_INDEX });
    py.setStdout({ batched: (s: string) => write("stdout", s + "\n") });
    py.setStderr({ batched: (s: string) => write("stderr", s + "\n") });
    if (interrupt) py.setInterruptBuffer(interrupt);
    py.registerJsModule("_adder_bridge", {
      sync: (op: string, args: string) =>
        channel!.request((first) => post(first ? { type: "sync", op, args } : { type: "sync-next" })),
      post: (op: string, args: string) => post({ type: "post", op, args }),
    });
    py.FS.writeFile("/home/pyodide/adder.py", adderSource);
    post({ type: "status", status: "ready" });
    return py;
  })();
  return pyodide;
}

async function run(id: number, code: string): Promise<void> {
  const py = await boot();
  post({ type: "status", status: "running" });
  let error: string | undefined;
  const globals = py.globals.get("dict")();
  try {
    const messageCallback = (m: string) => write("info", m + "\n");
    await py.loadPackagesFromImports(code, { messageCallback });
    // adder imports pandas lazily, so the import scan can't see it.
    if (/\b(to|from)_pandas\b/.test(code)) await py.loadPackage("pandas", { messageCallback });
    if (interrupt) interrupt[0] = 0;
    await py.runPythonAsync(code, { globals, filename: "<script>" });
  } catch (e) {
    error = cleanTraceback(e instanceof Error ? e.message : String(e));
  } finally {
    try {
      py.runPython("import adder; adder.flush()");
    } catch (e) {
      error ??= cleanTraceback(e instanceof Error ? e.message : String(e));
    }
    globals.destroy();
    flushOutput();
  }
  post({ type: "done", id, error });
  post({ type: "status", status: "ready" });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      channel = new ChannelClient(msg.channel);
      interrupt = new Uint8Array(msg.interrupt);
      break;
    case "run":
      void run(msg.id, msg.code);
      break;
    case "call":
    case "edit":
      // Wired up in M6.
      break;
  }
};
