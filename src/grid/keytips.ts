/** A command reachable by a key-tip sequence, e.g. "WFF". */
export interface KeyTip {
  keys: string;
  label: string;
  run(): void;
}

/**
 * Excel-style ribbon key tips: tap Alt (or hold it for the first key), then
 * type letters or digits, e.g. Alt W F F. Keys are read from their physical
 * position so Option-modified characters on macOS still match.
 */
export class KeyTips {
  /** Letters typed so far; null when inactive. */
  private seq: string | null = null;
  private altAlone = false;

  constructor(
    private tips: KeyTip[],
    /** Names for the intermediate steps, e.g. { W: "View", WF: "Freeze" }. */
    private groups: Record<string, string>,
    private onChange: (hint: { seq: string; options: { key: string; label: string }[] } | null) => void,
  ) {}

  get active(): boolean {
    return this.seq !== null;
  }

  /** Returns true when the key was consumed. */
  keydown(e: KeyboardEvent): boolean {
    if (e.key === "Alt") {
      this.altAlone = true;
      return false;
    }
    this.altAlone = false;
    const letter = /^(?:Key|Digit)([A-Z0-9])$/.exec(e.code)?.[1];
    if (this.seq === null) {
      if (!e.altKey || e.ctrlKey || e.metaKey || !letter || !this.continues(letter)) return false;
      this.step(letter);
      return true;
    }
    if (e.key === "Escape") {
      this.set(null);
      return true;
    }
    if (!letter) {
      // Anything else (arrows, Enter...) leaves key-tip mode and acts as usual.
      this.set(null);
      return false;
    }
    if (this.continues(this.seq + letter)) this.step(this.seq + letter);
    else this.set(null); // unknown letter: swallow it, like Excel
    return true;
  }

  /** Returns true when the key was consumed. */
  keyup(e: KeyboardEvent): boolean {
    if (e.key !== "Alt" || !this.altAlone) return false;
    this.altAlone = false;
    this.set(this.seq === null ? "" : null); // tapping Alt again closes the tips
    return true;
  }

  cancel(): void {
    if (this.seq !== null) this.set(null);
  }

  private continues(prefix: string): boolean {
    return this.tips.some((t) => t.keys.startsWith(prefix));
  }

  private step(seq: string): void {
    const tip = this.tips.find((t) => t.keys === seq);
    if (tip) {
      this.set(null);
      tip.run();
    } else {
      this.set(seq);
    }
  }

  private set(seq: string | null): void {
    this.seq = seq;
    if (seq === null) return this.onChange(null);
    const options = new Map<string, string>();
    for (const t of this.tips) {
      if (!t.keys.startsWith(seq)) continue;
      const next = t.keys.slice(0, seq.length + 1);
      options.set(next.at(-1)!, next === t.keys ? t.label : (this.groups[next] ?? "…"));
    }
    this.onChange({ seq, options: [...options].map(([key, label]) => ({ key, label })) });
  }
}
