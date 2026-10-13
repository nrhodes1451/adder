import init, { Model } from "@ironcalc/wasm";
import type {
  CellKind,
  CellStyle,
  CellValue,
  ChangeEvent,
  ChangeSource,
  Direction,
  Engine,
  EngineClipboard,
  Range,
  SheetInfo,
} from "./types";
import { MAX_COLS, MAX_ROWS } from "./types";

const LOCALE = "en";
const LANG = "en";

let ready: Promise<unknown> | null = null;

/** Load the IronCalc WASM module once. `wasm` is a URL (browser) or bytes (node tests). */
export function loadIronCalc(wasm?: string | URL | BufferSource): Promise<unknown> {
  ready ??= init(wasm === undefined ? undefined : { module_or_path: wasm });
  return ready;
}

// IronCalc getCellType codes.
const KIND: Record<number, CellKind> = { 1: "number", 2: "text", 4: "boolean", 16: "error" };

/** Quote a field for IronCalc's TSV paste parser. */
function tsvField(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvField).join("\t")).join("\n");
}

function parseDisplayNumber(display: string): number | null {
  let s = display.trim().replace(/[$,\s]/g, "");
  let scale = 1;
  if (s.endsWith("%")) {
    s = s.slice(0, -1);
    scale = 0.01;
  }
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);
  if (s === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(E[-+]?\d+)?$/i.test(s)) return null;
  return Number(s) * scale;
}

export class IronCalcEngine implements Engine {
  private listeners = new Set<(e: ChangeEvent) => void>();
  /** Cached per-sheet used range; grows on writes, may overstate after deletes. */
  private used = new Map<number, { rows: number; cols: number }>();

  private constructor(private model: Model) {}

  static create(name = "Workbook"): IronCalcEngine {
    return new IronCalcEngine(new Model(name, LOCALE, "UTC", LANG));
  }

  static fromBytes(bytes: Uint8Array): IronCalcEngine {
    const model = Model.from_bytes(bytes, LANG);
    model.evaluate();
    return new IronCalcEngine(model);
  }

  /** Escape hatch for engine-specific features (IO, tests). */
  get raw(): Model {
    return this.model;
  }

  // ---- events

  onChange(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: ChangeEvent): void {
    if (e.kind === "sheets") this.used.clear();
    if (e.kind === "cells") {
      for (const r of e.ranges) {
        const u = this.used.get(r.sheet);
        if (u) {
          u.rows = Math.max(u.rows, r.row + r.rows - 1);
          u.cols = Math.max(u.cols, r.col + r.cols - 1);
        }
      }
    }
    for (const l of this.listeners) l(e);
  }

  private cells(range: Range, source: ChangeSource): void {
    this.emit({ kind: "cells", ranges: [range], source });
  }

  // ---- sheets

  sheets(): SheetInfo[] {
    return this.model.getWorksheetsProperties().map((p, index) => ({
      index,
      name: p.name,
      hidden: p.state !== "visible",
    }));
  }

  addSheet(name?: string): number {
    this.model.newSheet();
    const index = this.sheets().length - 1;
    if (name) this.model.renameSheet(index, name);
    this.emit({ kind: "sheets" });
    return index;
  }

  renameSheet(sheet: number, name: string): void {
    this.model.renameSheet(sheet, name);
    this.emit({ kind: "sheets" });
  }

  deleteSheet(sheet: number): void {
    this.model.deleteSheet(sheet);
    this.emit({ kind: "sheets" });
  }

  setSheetHidden(sheet: number, hidden: boolean): void {
    if (hidden) this.model.hideSheet(sheet);
    else this.model.unhideSheet(sheet);
    this.emit({ kind: "sheets" });
  }

  // ---- cells

  getDisplay(sheet: number, row: number, col: number): string {
    return this.model.getFormattedCellValue(sheet, row, col);
  }

  getInput(sheet: number, row: number, col: number): string {
    return this.model.getCellContent(sheet, row, col);
  }

  getKind(sheet: number, row: number, col: number): CellKind {
    const kind = KIND[this.model.getCellType(sheet, row, col)] ?? "text";
    if (kind === "number" && this.model.getFormattedCellValue(sheet, row, col) === "") return "empty";
    return kind;
  }

  getValue(sheet: number, row: number, col: number): CellValue {
    const display = this.model.getFormattedCellValue(sheet, row, col);
    switch (this.getKind(sheet, row, col)) {
      case "empty":
        return null;
      case "boolean":
        return display.toUpperCase() === "TRUE";
      case "error":
        return { error: display };
      case "text":
        return display;
      case "number": {
        // Literal inputs keep full precision; formula results only expose
        // formatted text (IronCalc has no raw-value getter yet).
        const input = this.model.getCellContent(sheet, row, col);
        if (!input.startsWith("=")) {
          const n = parseDisplayNumber(input);
          if (n !== null) return n;
        }
        return parseDisplayNumber(display) ?? display;
      }
    }
  }

  getStyle(sheet: number, row: number, col: number): CellStyle {
    const { font, fill, alignment } = this.model.getCellStyle(sheet, row, col).style;
    const h = alignment?.horizontal;
    return {
      bold: font.b,
      italic: font.i,
      underline: font.u,
      strike: font.strike,
      color: font.color === undefined ? undefined : this.model.resolveColor(font.color),
      fill: fill.color === undefined ? undefined : this.model.resolveColor(fill.color),
      align: h === "left" || h === "center" || h === "right" ? h : undefined,
      wrap: alignment?.wrap_text ?? false,
    };
  }

  getRangeValues(r: Range): CellValue[][] {
    const out: CellValue[][] = [];
    for (let i = 0; i < r.rows; i++) {
      const row: CellValue[] = [];
      for (let j = 0; j < r.cols; j++) row.push(this.getValue(r.sheet, r.row + i, r.col + j));
      out.push(row);
    }
    return out;
  }

  setInput(sheet: number, row: number, col: number, input: string, source: ChangeSource = "user"): void {
    this.model.setUserInput(sheet, row, col, input);
    this.cells({ sheet, row, col, rows: 1, cols: 1 }, source);
  }

  setRange(sheet: number, row: number, col: number, inputs: string[][], source: ChangeSource = "script"): void {
    const rows = inputs.length;
    const cols = Math.max(0, ...inputs.map((r) => r.length));
    if (!rows || !cols) return;
    // Pad ragged rows so the paste is rectangular.
    const grid = inputs.map((r) => (r.length === cols ? r : [...r, ...Array<string>(cols - r.length).fill("")]));
    this.withSelection(sheet, row, col, () =>
      this.model.pasteCsvText({ sheet, row, column: col, width: cols, height: rows }, toTsv(grid)),
    );
    this.cells({ sheet, row, col, rows, cols }, source);
  }

  clearRange(r: Range, source: ChangeSource = "user"): void {
    this.model.rangeClearContents(r.sheet, r.row, r.col, r.row + r.rows - 1, r.col + r.cols - 1);
    this.cells(r, source);
  }

  usedRange(sheet: number): { rows: number; cols: number } {
    let u = this.used.get(sheet);
    if (!u) {
      // getColumnsWithData is a cheap per-row lookup; getRowsWithData scans the
      // whole sheet, so scan rows rather than columns.
      u = { rows: 0, cols: 0 };
      for (let r = 1; r <= MAX_ROWS; r++) {
        const cols = this.model.getColumnsWithData(sheet, r);
        if (cols.length === 0) continue;
        u.rows = r;
        for (const c of cols) if (c > u.cols) u.cols = c;
      }
      this.used.set(sheet, u);
    }
    return { ...u };
  }

  // ---- geometry

  rowHeight(sheet: number, row: number): number {
    return this.model.getRowHeight(sheet, row);
  }

  colWidth(sheet: number, col: number): number {
    return this.model.getColumnWidth(sheet, col);
  }

  setColWidth(sheet: number, col: number, width: number): void {
    this.model.setColumnsWidth(sheet, col, col, width);
    this.emit({ kind: "all" });
  }

  // ---- navigation

  /** Ctrl+Arrow semantics: jump to the edge of the current data block. */
  edge(sheet: number, row: number, col: number, dir: Direction): { row: number; col: number } {
    const vertical = dir === "up" || dir === "down";
    const pos = vertical ? row : col;
    const max = vertical ? MAX_ROWS : MAX_COLS;
    const step = dir === "down" || dir === "right" ? 1 : -1;
    const filled = new Set(vertical ? this.model.getRowsWithData(sheet, col) : this.model.getColumnsWithData(sheet, row));
    const has = (p: number) => filled.has(p);
    let p = pos;
    if (has(p) && has(p + step)) {
      // Inside a block: run to its end.
      while (p + step >= 1 && p + step <= max && has(p + step)) p += step;
    } else {
      // Skip to the next filled cell, or the sheet edge.
      const candidates = [...filled].filter((x) => (step > 0 ? x > p : x < p));
      p = candidates.length ? (step > 0 ? Math.min(...candidates) : Math.max(...candidates)) : step > 0 ? max : 1;
    }
    return vertical ? { row: p, col } : { row, col: p };
  }

  // ---- history

  undo(): void {
    this.model.undo();
    this.emit({ kind: "all" });
  }

  redo(): void {
    this.model.redo();
    this.emit({ kind: "all" });
  }

  canUndo(): boolean {
    return this.model.canUndo();
  }

  canRedo(): boolean {
    return this.model.canRedo();
  }

  // ---- clipboard

  copy(r: Range): EngineClipboard {
    const clip = this.withSelection(r.sheet, r.row, r.col, () => {
      this.model.setSelectedRange(r.row, r.col, r.row + r.rows - 1, r.col + r.cols - 1);
      return this.model.copyToClipboard();
    });
    return { tsv: clip.csv, native: clip.data, sourceSheet: r.sheet, sourceRange: clip.range };
  }

  paste(target: Range, clip: EngineClipboard, cut: boolean): void {
    this.withSelection(target.sheet, target.row, target.col, () =>
      this.model.pasteFromClipboard(clip.sourceSheet, clip.sourceRange, clip.native as never, cut),
    );
    const [r1, c1, r2, c2] = clip.sourceRange;
    this.cells({ ...target, rows: r2 - r1 + 1, cols: c2 - c1 + 1 }, "user");
  }

  pasteText(target: Range, tsv: string): void {
    const lines = tsv.replace(/\r?\n$/, "").split(/\r?\n/);
    const rows = lines.length;
    const cols = Math.max(...lines.map((l) => l.split("\t").length));
    this.withSelection(target.sheet, target.row, target.col, () =>
      this.model.pasteCsvText({ sheet: target.sheet, row: target.row, column: target.col, width: cols, height: rows }, tsv),
    );
    this.cells({ ...target, rows, cols }, "user");
  }

  // ---- persistence

  serialize(): Uint8Array {
    return this.model.toBytes();
  }

  /**
   * Several IronCalc operations act on the model's selection. Run `fn` with the
   * selection at (sheet,row,col), then restore whatever was selected before.
   */
  private withSelection<T>(sheet: number, row: number, col: number, fn: () => T): T {
    const prev = this.model.getSelectedView();
    this.model.setSelectedSheet(sheet);
    this.model.setSelectedCell(row, col);
    try {
      return fn();
    } finally {
      this.model.setSelectedSheet(prev.sheet);
      this.model.setSelectedCell(prev.row, prev.column);
      const [r1, c1, r2, c2] = prev.range;
      this.model.setSelectedRange(r1, c1, r2, c2);
    }
  }
}
