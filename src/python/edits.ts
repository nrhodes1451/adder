import type { Range, SheetInfo } from "../engine/types";
import { MAX_COLS, MAX_ROWS } from "../engine/types";
import { colNumber } from "../grid/geometry";

export interface ParsedRef {
  sheet: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Parse "Sheet1!B:B", "'My Sheet'!A1:C3", "A1", "2:5". Returns null if invalid. */
export function parseRef(ref: string): ParsedRef | null {
  let sheet: string | null = null;
  let addr = ref.trim();
  const bang = addr.lastIndexOf("!");
  if (bang >= 0) {
    sheet = addr.slice(0, bang);
    if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    addr = addr.slice(bang + 1);
  }
  const parts = addr.replace(/\$/g, "").toUpperCase().split(":");
  if (parts.length > 2) return null;
  const corners = parts.map((p) => {
    const m = /^([A-Z]{1,3})?(\d+)?$/.exec(p);
    if (!m || (!m[1] && !m[2])) return null;
    return { col: m[1] ? colNumber(m[1]) : null, row: m[2] ? Number(m[2]) : null };
  });
  if (corners.some((c) => c === null)) return null;
  const [a, b = a] = corners as { col: number | null; row: number | null }[];
  if (parts.length === 1 && (a!.col === null || a!.row === null)) return null;
  const rows = a!.row === null || b!.row === null ? [1, MAX_ROWS] : [Math.min(a!.row, b!.row), Math.max(a!.row, b!.row)];
  const cols = a!.col === null || b!.col === null ? [1, MAX_COLS] : [Math.min(a!.col, b!.col), Math.max(a!.col, b!.col)];
  return { sheet, r1: rows[0]!, r2: rows[1]!, c1: cols[0]!, c2: cols[1]! };
}

/** Registered refs whose area intersects an edited range. Unqualified refs match any sheet. */
export function matchingRefs(refs: string[], sheets: SheetInfo[], edited: Range): string[] {
  const sheetName = sheets[edited.sheet]?.name.toLowerCase();
  return refs.filter((ref) => {
    const p = parseRef(ref);
    if (!p || (p.sheet !== null && p.sheet.toLowerCase() !== sheetName)) return false;
    return edited.row <= p.r2 && edited.row + edited.rows - 1 >= p.r1 && edited.col <= p.c2 && edited.col + edited.cols - 1 >= p.c1;
  });
}
