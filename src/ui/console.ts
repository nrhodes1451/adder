import type { PyStatus, Stream } from "../python/protocol";

export type EntryKind = Stream | "run" | "ok" | "error";
export interface ConsoleEntry {
  id: number;
  kind: EntryKind;
  text: string;
}

const MAX_ENTRIES = 2000;

/** Console output and Python status, shared between the host and the panel. */
export class ConsoleStore {
  entries: ConsoleEntry[] = [];
  status: PyStatus = "idle";
  private nextId = 1;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  push(kind: EntryKind, text: string): void {
    const last = this.entries[this.entries.length - 1];
    // Merge consecutive stream output into one entry.
    if (last && last.kind === kind && (kind === "stdout" || kind === "stderr" || kind === "info")) {
      this.entries = [...this.entries.slice(0, -1), { ...last, text: last.text + text }];
    } else {
      this.entries = [...this.entries, { id: this.nextId++, kind, text }].slice(-MAX_ENTRIES);
    }
    this.emit();
  }

  setStatus(s: PyStatus): void {
    this.status = s;
    this.emit();
  }

  clear(): void {
    this.entries = [];
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
