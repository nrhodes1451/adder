import type { Engine } from "./types";
import { MAX_COLS, MAX_ROWS } from "./types";

const REF_PART = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d+)?$/;

function colName(col: number): string {
  let s = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function colNumber(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/** Shift one "A1" / "$A$1" / "A" / "1" part; null if it falls off the sheet. */
function shiftPart(part: string, dr: number, dc: number): string | null {
  const m = REF_PART.exec(part);
  if (!m || (!m[2] && !m[4])) return part;
  const [, absCol = "", col, absRow = "", row] = m;
  let out = "";
  if (col) {
    const c = absCol ? colNumber(col) : colNumber(col) + dc;
    if (c < 1 || c > MAX_COLS) return null;
    out += absCol + colName(c);
  }
  if (row) {
    const r = absRow ? Number(row) : Number(row) + dr;
    if (r < 1 || r > MAX_ROWS) return null;
    out += absRow + r;
  }
  return out;
}

/**
 * Move a formula by (dr, dc) the way copy/paste does: relative references
 * shift, $-anchored parts stay. References pushed off the sheet become #REF!.
 * Non-formulas are returned unchanged.
 */
export function shiftFormula(engine: Engine, input: string, dr: number, dc: number): string {
  if (!input.startsWith("=") || (dr === 0 && dc === 0)) return input;
  const body = input.slice(1);
  let out = "";
  let pos = 0;
  for (const t of engine.tokenize(body)) {
    if (t.kind !== "ref" && t.kind !== "range") continue;
    const text = body.slice(t.start, t.end);
    const bang = text.lastIndexOf("!");
    const sheet = bang >= 0 ? text.slice(0, bang + 1) : "";
    const parts = text.slice(bang + 1).split(":").map((p) => shiftPart(p, dr, dc));
    out += body.slice(pos, t.start) + (parts.some((p) => p === null) ? "#REF!" : sheet + parts.join(":"));
    pos = t.end;
  }
  return "=" + out + body.slice(pos);
}

/**
 * Fill a target area by repeating `source` (Excel paste semantics): returns
 * the tiled block when the target is a whole multiple of the source size,
 * otherwise null.
 */
export function tile(
  engine: Engine,
  source: string[][],
  target: { rows: number; cols: number },
  /** Shift formulas by this base offset plus each tile's offset; null leaves them as typed. */
  shift: { dr: number; dc: number } | null,
): string[][] | null {
  const sr = source.length;
  const sc = Math.max(0, ...source.map((r) => r.length));
  if (!sr || !sc || target.rows % sr !== 0 || target.cols % sc !== 0) return null;
  const out: string[][] = [];
  for (let r = 0; r < target.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < target.cols; c++) {
      const v = source[r % sr]![c % sc] ?? "";
      const dr = r - (r % sr);
      const dc = c - (c % sc);
      row.push(shift ? shiftFormula(engine, v, shift.dr + dr, shift.dc + dc) : v);
    }
    out.push(row);
  }
  return out;
}

/** Append the closing parentheses a formula is missing (ignoring ones inside strings), like Excel on commit. */
export function closeParens(input: string): string {
  if (!input.startsWith("=")) return input;
  let depth = 0;
  let inString = false;
  for (const ch of input) {
    if (ch === '"') inString = !inString;
    else if (!inString && ch === "(") depth++;
    else if (!inString && ch === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0 && !inString ? input + ")".repeat(depth) : input;
}

/** Which parts of a reference are $-anchored, in Excel's F4 order: A1 → $A$1 → A$1 → $A1 → A1. */
export type RefLock = 0 | 1 | 2 | 3;
const LOCKS: { col: boolean; row: boolean }[] = [
  { col: false, row: false },
  { col: true, row: true },
  { col: false, row: true },
  { col: true, row: false },
];

/** "A1" / "A1:B2" text for a pointed-at range, anchored per `lock`. */
export function formatRef(r1: number, c1: number, r2: number, c2: number, lock: RefLock = 0): string {
  const { col, row } = LOCKS[lock]!;
  const part = (r: number, c: number) => `${col ? "$" : ""}${colName(c)}${row ? "$" : ""}${r}`;
  const [top, bottom, left, right] = [Math.min(r1, r2), Math.max(r1, r2), Math.min(c1, c2), Math.max(c1, c2)];
  return top === bottom && left === right ? part(top, left) : `${part(top, left)}:${part(bottom, right)}`;
}

/** The lock state of a reference's first part. */
export function refLock(ref: string): RefLock {
  const m = REF_PART.exec(ref.slice(ref.lastIndexOf("!") + 1).split(":")[0]!);
  const col = !!m?.[1] && !!m[2];
  const row = !!m?.[3] && !!m[4];
  return LOCKS.findIndex((l) => l.col === col && l.row === row) as RefLock;
}

/** Re-anchor every part of a reference ("Sheet1!A1:B2", "A:A", "$A$1"...) to `lock`. */
export function withLock(ref: string, lock: RefLock): string {
  const bang = ref.lastIndexOf("!");
  const { col, row } = LOCKS[lock]!;
  const parts = ref
    .slice(bang + 1)
    .split(":")
    .map((p) => {
      const m = REF_PART.exec(p);
      if (!m || (!m[2] && !m[4])) return p;
      return (m[2] ? (col ? "$" : "") + m[2] : "") + (m[4] ? (row ? "$" : "") + m[4] : "");
    });
  return ref.slice(0, bang + 1) + parts.join(":");
}

/** Excel's F4: step a reference to the next lock state. */
export function cycleLock(ref: string): string {
  return withLock(ref, ((refLock(ref) + 1) % 4) as RefLock);
}

/** Span of the reference/range token the caret is in or just after, in `text` offsets. */
export function referenceAt(engine: Engine, text: string, caret: number): { from: number; to: number } | null {
  if (!text.startsWith("=")) return null;
  const at = caret - 1; // body offset
  for (const t of engine.tokenize(text.slice(1))) {
    if ((t.kind === "ref" || t.kind === "range") && t.start <= at && at <= t.end) return { from: t.start + 1, to: t.end + 1 };
  }
  return null;
}
