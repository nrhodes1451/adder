import { createEngine, type IronCalcEngine } from "../engine";
import { loadWorkbook, saveWorkbook, type WorkbookMeta } from "../io/idb";

const LAST_KEY = "adder:last-workbook";
const AUTOSAVE_MS = 500;

/** An open workbook: engine plus Adder metadata, autosaved to IndexedDB. */
export class Workbook {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private off: () => void;
  private listeners = new Set<() => void>();

  private constructor(
    readonly id: string,
    public name: string,
    readonly engine: IronCalcEngine,
    public meta: WorkbookMeta,
  ) {
    this.off = engine.onChange(() => this.touch());
    rememberLast(id);
  }

  static async create(name = "Untitled", engine?: IronCalcEngine): Promise<Workbook> {
    const wb = new Workbook(crypto.randomUUID(), name, engine ?? (await createEngine()), { scripts: [] });
    await wb.save();
    return wb;
  }

  static async open(id: string): Promise<Workbook | null> {
    const rec = await loadWorkbook(id);
    if (!rec) return null;
    return new Workbook(rec.id, rec.name, await createEngine(rec.bytes), rec.meta);
  }

  /** Reopen the last workbook, or start a fresh one. */
  static async openLast(): Promise<Workbook> {
    const id = readLast();
    return (id && (await Workbook.open(id))) || Workbook.create();
  }

  onSaved(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  rename(name: string): void {
    this.name = name;
    this.touch();
  }

  setMeta(meta: Partial<WorkbookMeta>): void {
    this.meta = { ...this.meta, ...meta };
    this.touch();
  }

  /** Schedule an autosave. */
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), AUTOSAVE_MS);
  }

  async save(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Serialize saves so an older snapshot never lands after a newer one.
    this.saving = this.saving.then(() =>
      saveWorkbook({ id: this.id, name: this.name, bytes: this.engine.serialize(), meta: this.meta, updatedAt: Date.now() }),
    );
    await this.saving;
    for (const l of this.listeners) l();
  }

  /** Flush pending changes and detach. */
  async close(): Promise<void> {
    if (this.timer) await this.save();
    this.off();
  }

  get hasPendingSave(): boolean {
    return this.timer !== null;
  }
}

function rememberLast(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // Storage unavailable: we just won't reopen it automatically.
  }
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
