/**
 * One axis (rows or columns) of the grid: a default size plus sparse overrides.
 * Indices are 1-based. Offsets are in CSS px from the start of the axis
 * (excluding headers). Lookups are O(log k) in the number of overrides.
 */
export class Axis {
  private keys: number[] = []; // sorted override indices
  private sizes: number[] = []; // size at keys[i]
  private deltaPrefix: number[] = [0]; // sum of (size - default) for keys[0..i)

  constructor(
    public count: number,
    public readonly defaultSize: number,
    overrides: Iterable<[number, number]> = [],
  ) {
    this.setOverrides(overrides);
  }

  setOverrides(overrides: Iterable<[number, number]>): void {
    const entries = [...overrides].filter(([, s]) => s !== this.defaultSize).sort((a, b) => a[0] - b[0]);
    this.keys = entries.map(([k]) => k);
    this.sizes = entries.map(([, s]) => s);
    this.deltaPrefix = [0];
    for (const s of this.sizes) this.deltaPrefix.push(this.deltaPrefix[this.deltaPrefix.length - 1]! + s - this.defaultSize);
  }

  size(i: number): number {
    const k = this.lowerBound(i);
    return this.keys[k] === i ? this.sizes[k]! : this.defaultSize;
  }

  /** Offset of the start of item i. */
  offset(i: number): number {
    return (i - 1) * this.defaultSize + this.deltaPrefix[this.lowerBound(i)]!;
  }

  total(): number {
    return this.offset(this.count + 1);
  }

  /** Item containing offset `px`, clamped to [1, count]. */
  indexAt(px: number): number {
    if (px <= 0) return 1;
    let lo = 1;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.offset(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** First index in `keys` that is >= i. */
  private lowerBound(i: number): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.keys[mid]! < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

export interface CellPos {
  row: number;
  col: number;
}

export interface Selection {
  anchor: CellPos;
  focus: CellPos;
}

export function selectionBounds(s: Selection): { r1: number; c1: number; r2: number; c2: number } {
  return {
    r1: Math.min(s.anchor.row, s.focus.row),
    c1: Math.min(s.anchor.col, s.focus.col),
    r2: Math.max(s.anchor.row, s.focus.row),
    c2: Math.max(s.anchor.col, s.focus.col),
  };
}

export function colName(col: number): string {
  let s = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function colNumber(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

export function a1(row: number, col: number): string {
  return `${colName(col)}${row}`;
}
