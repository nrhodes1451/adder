import type { CellKind, CellStyle, Engine } from "../engine/types";
import { type Axis, colName, type Selection, selectionBounds } from "./geometry";

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
  selection: Selection;
  active: { row: number; col: number };
  palette: Palette;
  font: string;
}

/** Paint the visible viewport. Coordinates are CSS px; ctx is pre-scaled for DPR. */
export function render(ctx: CanvasRenderingContext2D, s: RenderState, cache: CellCache): void {
  const { rows, cols, palette: p } = s;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, s.width, s.height);

  const r0 = rows.indexAt(s.scrollY);
  const c0 = cols.indexAt(s.scrollX);
  const x0 = ROW_HEADER_WIDTH + cols.offset(c0) - s.scrollX;
  const y0 = COL_HEADER_HEIGHT + rows.offset(r0) - s.scrollY;

  // Visible rows/cols with their screen positions.
  const vr: { i: number; y: number; h: number }[] = [];
  for (let i = r0, y = y0; i <= rows.count && y < s.height; i++) {
    const h = rows.size(i);
    if (h > 0) vr.push({ i, y, h });
    y += h;
  }
  const vc: { i: number; x: number; w: number }[] = [];
  for (let i = c0, x = x0; i <= cols.count && x < s.width; i++) {
    const w = cols.size(i);
    if (w > 0) vc.push({ i, x, w });
    x += w;
  }

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
    ctx.moveTo(ROW_HEADER_WIDTH, r.y + r.h - 0.5);
    ctx.lineTo(s.width, r.y + r.h - 0.5);
  }
  for (const c of vc) {
    ctx.moveTo(c.x + c.w - 0.5, COL_HEADER_HEIGHT);
    ctx.lineTo(c.x + c.w - 0.5, s.height);
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
  const sx1 = ROW_HEADER_WIDTH + cols.offset(sel.c1) - s.scrollX;
  const sy1 = COL_HEADER_HEIGHT + rows.offset(sel.r1) - s.scrollY;
  const sx2 = ROW_HEADER_WIDTH + cols.offset(sel.c2 + 1) - s.scrollX;
  const sy2 = COL_HEADER_HEIGHT + rows.offset(sel.r2 + 1) - s.scrollY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ROW_HEADER_WIDTH, COL_HEADER_HEIGHT, s.width, s.height);
  ctx.clip();
  if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) {
    // Shade the range except the active cell.
    const { row, col } = s.active;
    const ax = ROW_HEADER_WIDTH + cols.offset(col) - s.scrollX;
    const ay = COL_HEADER_HEIGHT + rows.offset(row) - s.scrollY;
    ctx.beginPath();
    ctx.rect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    ctx.rect(ax, ay, cols.size(col), rows.size(row));
    ctx.fillStyle = p.selectionFill;
    ctx.fill("evenodd");
  }
  ctx.strokeStyle = p.selectionBorder;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx1 - 0.5, sy1 - 0.5, sx2 - sx1, sy2 - sy1);
  ctx.restore();

  // Headers (drawn last so they stay on top).
  ctx.font = `12px ${s.font.replace(/^\d+px\s*/, "")}`;
  ctx.textAlign = "center";
  ctx.fillStyle = p.headerBg;
  ctx.fillRect(0, 0, s.width, COL_HEADER_HEIGHT);
  ctx.fillRect(0, 0, ROW_HEADER_WIDTH, s.height);
  for (const c of vc) {
    const active = c.i >= sel.c1 && c.i <= sel.c2;
    if (active) {
      ctx.fillStyle = p.headerActiveBg;
      ctx.fillRect(c.x, 0, c.w, COL_HEADER_HEIGHT);
    }
    ctx.fillStyle = active ? p.headerActiveText : p.headerText;
    ctx.fillText(colName(c.i), c.x + c.w / 2, COL_HEADER_HEIGHT / 2);
  }
  for (const r of vr) {
    const active = r.i >= sel.r1 && r.i <= sel.r2;
    if (active) {
      ctx.fillStyle = p.headerActiveBg;
      ctx.fillRect(0, r.y, ROW_HEADER_WIDTH, r.h);
    }
    ctx.fillStyle = active ? p.headerActiveText : p.headerText;
    ctx.fillText(String(r.i), ROW_HEADER_WIDTH / 2, r.y + r.h / 2);
  }
  ctx.beginPath();
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  ctx.moveTo(0, COL_HEADER_HEIGHT - 0.5);
  ctx.lineTo(s.width, COL_HEADER_HEIGHT - 0.5);
  ctx.moveTo(ROW_HEADER_WIDTH - 0.5, 0);
  ctx.lineTo(ROW_HEADER_WIDTH - 0.5, s.height);
  for (const c of vc) {
    ctx.moveTo(c.x + c.w - 0.5, 0);
    ctx.lineTo(c.x + c.w - 0.5, COL_HEADER_HEIGHT);
  }
  for (const r of vr) {
    ctx.moveTo(0, r.y + r.h - 0.5);
    ctx.lineTo(ROW_HEADER_WIDTH, r.y + r.h - 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = p.headerBg;
  ctx.fillRect(0, 0, ROW_HEADER_WIDTH - 1, COL_HEADER_HEIGHT - 1);
}
