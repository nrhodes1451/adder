import type { CellKind, CellStyle, Engine } from "../engine/types";
import { type Axis, colName, type Selection, selectionBounds } from "./geometry";
import type { Rect } from "./tween";

export const ROW_HEADER_WIDTH = 64;
export const COL_HEADER_HEIGHT = 24;
const PAD = 4;

export interface Palette {
  bg: string;
  text: string;
  grid: string;
  headerBg: string;
  headerText: string;
  headerActiveBg: string;
  headerActiveText: string;
  selectionFill: string;
  selectionBorder: string;
  /** Line at the edge of frozen rows/columns. */
  freezeLine: string;
  /** Colours for the references in a formula being edited, in order of appearance (like Excel). */
  refColors: string[];
  error: string;
}

export const LIGHT: Palette = {
  bg: "#ffffff",
  text: "#1f2328",
  grid: "#e3e5e8",
  headerBg: "#f6f7f9",
  headerText: "#5b6170",
  headerActiveBg: "#dde6fb",
  headerActiveText: "#1c3d8f",
  selectionFill: "rgba(37, 99, 235, 0.10)",
  selectionBorder: "#2563eb",
  freezeLine: "#b4b9c2",
  refColors: ["#2563eb", "#dc2626", "#9333ea", "#16a34a", "#c2410c", "#db2777", "#0891b2"],
  error: "#c62828",
};

export const DARK: Palette = {
  bg: "#16181d",
  text: "#e6e8eb",
  grid: "#2b2f37",
  headerBg: "#1d2027",
  headerText: "#9aa1ad",
  headerActiveBg: "#26324d",
  headerActiveText: "#b8cbff",
  selectionFill: "rgba(96, 140, 255, 0.16)",
  selectionBorder: "#6b93ff",
  freezeLine: "#4a505c",
  refColors: ["#6b93ff", "#f87171", "#c084fc", "#4ade80", "#fb923c", "#f472b6", "#22d3ee"],
  error: "#ff8a80",
};

interface CellRender {
  text: string;
  /** Measured text width, filled lazily by the renderer. */
  width?: number;
  kind: CellKind;
  style: CellStyle | null;
}

/** Per-sheet cache of what each cell paints as. Cleared on any engine change. */
export class CellCache {
  private map = new Map<number, CellRender>();

  constructor(private engine: Engine) {}

  clear(): void {
    this.map.clear();
  }

  get(sheet: number, row: number, col: number): CellRender {
    const key = row * 16_385 + col;
    let c = this.map.get(key);
    if (!c) {
      if (this.map.size > 50_000) this.map.clear();
      const text = this.engine.getDisplay(sheet, row, col);
      const kind = text === "" ? "empty" : this.engine.getKind(sheet, row, col);
      const style = this.engine.getStyle(sheet, row, col);
      const plain = !style.bold && !style.italic && !style.underline && !style.strike && !style.color && !style.fill && !style.align && !style.wrap;
      c = { text, kind, style: plain ? null : style };
      this.map.set(key, c);
    }
    return c;
  }
}

export interface RenderState {
  sheet: number;
  rows: Axis;
  cols: Axis;
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  /** Frozen rows at the top / columns at the left, which don't scroll. */
  frozen: { rows: number; cols: number };
  selection: Selection;
  /** Where to draw the selection outline, in sheet px (animated between cells). */
  selectionRect: Rect;
  active: { row: number; col: number };
  /** Dashed outlines of the references in the formula being edited, in sheet px. */
  references?: { rect: Rect; color: string }[];
  palette: Palette;
  font: string;
}

/** A screen rectangle showing part of the sheet at a given scroll offset. */
interface Pane {
  x: number;
  y: number;
  w: number;
  h: number;
  scrollX: number;
  scrollY: number;
}

interface Visible {
  i: number;
  /** Screen position of the item's start. */
  at: number;
  size: number;
}

/** Items of `axis` whose screen span overlaps [from, to), for a pane whose sheet origin is at `origin - scroll`. */
function visible(axis: Axis, origin: number, scroll: number, from: number, to: number): Visible[] {
  const out: Visible[] = [];
  for (let i = axis.indexAt(from - origin + scroll), at = origin + axis.offset(i) - scroll; i <= axis.count && at < to; i++) {
    const size = axis.size(i);
    if (size > 0) out.push({ i, at, size });
    at += size;
  }
  return out;
}

/** Paint the visible viewport. Coordinates are CSS px; ctx is pre-scaled for DPR. */
export function render(ctx: CanvasRenderingContext2D, s: RenderState, cache: CellCache): void {
  const { rows, cols, palette: p } = s;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, s.width, s.height);

  // Frozen rows/columns are drawn unscrolled, the rest scrolled; each pane is clipped to its own area.
  const fw = cols.offset(s.frozen.cols + 1);
  const fh = rows.offset(s.frozen.rows + 1);
  const x1 = ROW_HEADER_WIDTH + fw;
  const y1 = COL_HEADER_HEIGHT + fh;
  const panes: Pane[] = [{ x: x1, y: y1, w: s.width - x1, h: s.height - y1, scrollX: s.scrollX, scrollY: s.scrollY }];
  if (fh) panes.push({ x: x1, y: COL_HEADER_HEIGHT, w: s.width - x1, h: fh, scrollX: s.scrollX, scrollY: 0 });
  if (fw) panes.push({ x: ROW_HEADER_WIDTH, y: y1, w: fw, h: s.height - y1, scrollX: 0, scrollY: s.scrollY });
  if (fw && fh) panes.push({ x: ROW_HEADER_WIDTH, y: COL_HEADER_HEIGHT, w: fw, h: fh, scrollX: 0, scrollY: 0 });
  for (const pane of panes) {
    if (pane.w <= 0 || pane.h <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, pane.y, pane.w, pane.h);
    ctx.clip();
    renderPane(ctx, s, cache, pane);
    ctx.restore();
  }

  // Headers (drawn last so they stay on top), frozen part unscrolled.
  const sel = selectionBounds(s.selection);
  const headerCols = [
    ...visible(cols, ROW_HEADER_WIDTH, 0, ROW_HEADER_WIDTH, x1),
    ...visible(cols, ROW_HEADER_WIDTH, s.scrollX, x1, s.width).map((c) => clipStart(c, x1)),
  ].filter((c) => c.size > 0);
  const headerRows = [
    ...visible(rows, COL_HEADER_HEIGHT, 0, COL_HEADER_HEIGHT, y1),
    ...visible(rows, COL_HEADER_HEIGHT, s.scrollY, y1, s.height).map((r) => clipStart(r, y1)),
  ].filter((r) => r.size > 0);
  ctx.font = `12px ${s.font.replace(/^\d+px\s*/, "")}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = p.headerBg;
  ctx.fillRect(0, 0, s.width, COL_HEADER_HEIGHT);
  ctx.fillRect(0, 0, ROW_HEADER_WIDTH, s.height);
  for (const c of headerCols) {
    const active = c.i >= sel.c1 && c.i <= sel.c2;
    if (active) {
      ctx.fillStyle = p.headerActiveBg;
      ctx.fillRect(c.at, 0, c.size, COL_HEADER_HEIGHT);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.at, 0, c.size, COL_HEADER_HEIGHT);
    ctx.clip();
    ctx.fillStyle = active ? p.headerActiveText : p.headerText;
    // Centre on the whole column even when its start is hidden under frozen columns.
    ctx.fillText(colName(c.i), c.at + c.size - cols.size(c.i) / 2, COL_HEADER_HEIGHT / 2);
    ctx.restore();
  }
  for (const r of headerRows) {
    const active = r.i >= sel.r1 && r.i <= sel.r2;
    if (active) {
      ctx.fillStyle = p.headerActiveBg;
      ctx.fillRect(0, r.at, ROW_HEADER_WIDTH, r.size);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, r.at, ROW_HEADER_WIDTH, r.size);
    ctx.clip();
    ctx.fillStyle = active ? p.headerActiveText : p.headerText;
    ctx.fillText(String(r.i), ROW_HEADER_WIDTH / 2, r.at + r.size - rows.size(r.i) / 2);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  ctx.moveTo(0, COL_HEADER_HEIGHT - 0.5);
  ctx.lineTo(s.width, COL_HEADER_HEIGHT - 0.5);
  ctx.moveTo(ROW_HEADER_WIDTH - 0.5, 0);
  ctx.lineTo(ROW_HEADER_WIDTH - 0.5, s.height);
  for (const c of headerCols) {
    ctx.moveTo(c.at + c.size - 0.5, 0);
    ctx.lineTo(c.at + c.size - 0.5, COL_HEADER_HEIGHT);
  }
  for (const r of headerRows) {
    ctx.moveTo(0, r.at + r.size - 0.5);
    ctx.lineTo(ROW_HEADER_WIDTH, r.at + r.size - 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = p.headerBg;
  ctx.fillRect(0, 0, ROW_HEADER_WIDTH - 1, COL_HEADER_HEIGHT - 1);

  // Freeze boundaries, across headers and cells.
  ctx.fillStyle = p.freezeLine;
  if (fw) ctx.fillRect(x1 - 1, 0, 2, s.height);
  if (fh) ctx.fillRect(0, y1 - 1, s.width, 2);
}

/** Trim an item that starts before `edge` (scrolled under a frozen pane) to the visible part. */
function clipStart(v: Visible, edge: number): Visible {
  return v.at >= edge ? v : { i: v.i, at: edge, size: v.at + v.size - edge };
}

/** Cells, gridlines, selection and reference outlines for one pane. */
function renderPane(ctx: CanvasRenderingContext2D, s: RenderState, cache: CellCache, pane: Pane): void {
  const { rows, cols, palette: p } = s;
  const vr = visible(rows, COL_HEADER_HEIGHT, pane.scrollY, pane.y, pane.y + pane.h).map(({ i, at, size }) => ({ i, y: at, h: size }));
  const vc = visible(cols, ROW_HEADER_WIDTH, pane.scrollX, pane.x, pane.x + pane.w).map(({ i, at, size }) => ({ i, x: at, w: size }));
  const sel = selectionBounds(s.selection);
  // Cells: fills, then text.
  ctx.textBaseline = "middle";
  for (const r of vr) {
    for (const c of vc) {
      const cell = cache.get(s.sheet, r.i, c.i);
      if (cell.style?.fill) {
        ctx.fillStyle = cell.style.fill;
        ctx.fillRect(c.x, r.y, c.w, r.h);
      }
    }
  }

  // Gridlines.
  ctx.beginPath();
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  for (const r of vr) {
    ctx.moveTo(pane.x, r.y + r.h - 0.5);
    ctx.lineTo(pane.x + pane.w, r.y + r.h - 0.5);
  }
  for (const c of vc) {
    ctx.moveTo(c.x + c.w - 0.5, pane.y);
    ctx.lineTo(c.x + c.w - 0.5, pane.y + pane.h);
  }
  ctx.stroke();

  let font = "";
  for (const r of vr) {
    for (let k = 0; k < vc.length; k++) {
      const c = vc[k]!;
      const cell = cache.get(s.sheet, r.i, c.i);
      if (cell.kind === "empty") continue;
      const st = cell.style;
      const f = st?.italic || st?.bold ? `${st.italic ? "italic " : ""}${st.bold ? "600 " : ""}${s.font}` : s.font;
      if (f !== font) ctx.font = font = f;
      const color = cell.kind === "error" ? p.error : (st?.color ?? p.text);
      const align = st?.align ?? (cell.kind === "number" ? "right" : cell.kind === "boolean" || cell.kind === "error" ? "center" : "left");
      const text = cell.text.includes("\n") ? cell.text.replace(/\n/g, " ") : cell.text;
      cell.width ??= ctx.measureText(text).width;

      // Left-aligned text spills into empty neighbours to the right.
      let clipW = c.w;
      if (align === "left" && cell.kind === "text") {
        for (let j = k + 1; j < vc.length && cell.width + 2 * PAD > clipW && cache.get(s.sheet, r.i, vc[j]!.i).kind === "empty"; j++) {
          clipW += vc[j]!.w;
        }
      }
      const clip = cell.width + 2 * PAD > clipW;
      if (clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(c.x, r.y, clipW - 1, r.h - 1);
        ctx.clip();
      }
      if (clipW > c.w) {
        // Hide the gridlines the spilled text crosses.
        ctx.fillStyle = p.bg;
        ctx.fillRect(c.x + c.w - 1, r.y, clipW - c.w, r.h - 1);
      }
      ctx.fillStyle = color;
      ctx.textAlign = align;
      const tx = align === "left" ? c.x + PAD : align === "right" ? c.x + c.w - PAD : c.x + c.w / 2;
      const ty = r.y + r.h / 2;
      ctx.fillText(text, tx, ty);
      if (st?.underline || st?.strike) {
        const lx = align === "left" ? tx : align === "right" ? tx - cell.width : tx - cell.width / 2;
        ctx.fillRect(lx, st.underline ? ty + 7 : ty, cell.width, 1);
      }
      if (clip) ctx.restore();
    }
  }

  // Selection.
  const sx1 = ROW_HEADER_WIDTH + s.selectionRect.x1 - pane.scrollX;
  const sy1 = COL_HEADER_HEIGHT + s.selectionRect.y1 - pane.scrollY;
  const sx2 = ROW_HEADER_WIDTH + s.selectionRect.x2 - pane.scrollX;
  const sy2 = COL_HEADER_HEIGHT + s.selectionRect.y2 - pane.scrollY;
  if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) {
    // Shade the range except the active cell.
    const { row, col } = s.active;
    const ax = ROW_HEADER_WIDTH + cols.offset(col) - pane.scrollX;
    const ay = COL_HEADER_HEIGHT + rows.offset(row) - pane.scrollY;
    ctx.beginPath();
    ctx.rect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    ctx.rect(ax, ay, cols.size(col), rows.size(row));
    ctx.fillStyle = p.selectionFill;
    ctx.fill("evenodd");
  }
  ctx.strokeStyle = p.selectionBorder;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx1 - 0.5, sy1 - 0.5, sx2 - sx1, sy2 - sy1);
  ctx.setLineDash([4, 3]);
  for (const { rect: r, color } of s.references ?? []) {
    // Clamp whole rows/columns to just past the viewport so the dashes stay put.
    const rx1 = Math.max(pane.x - 2, ROW_HEADER_WIDTH + r.x1 - pane.scrollX);
    const ry1 = Math.max(pane.y - 2, COL_HEADER_HEIGHT + r.y1 - pane.scrollY);
    const rx2 = Math.min(pane.x + pane.w + 2, ROW_HEADER_WIDTH + r.x2 - pane.scrollX);
    const ry2 = Math.min(pane.y + pane.h + 2, COL_HEADER_HEIGHT + r.y2 - pane.scrollY);
    if (rx2 < rx1 || ry2 < ry1) continue;
    ctx.strokeStyle = color;
    ctx.strokeRect(rx1 - 0.5, ry1 - 0.5, rx2 - rx1, ry2 - ry1);
  }
  ctx.setLineDash([]);
}
