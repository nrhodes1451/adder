import init, { getTokens, Model } from "@ironcalc/wasm";
import { BUILTIN_FUNCTIONS } from "./functions";
import type {
  CellInput,
  CellKind,
  CellStyle,
  CellValue,
  ChangeEvent,
  ChangeSource,
  Direction,
  Engine,
  EngineClipboard,
  FormulaToken,
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
  /** Mirror model used to produce diffs that are applied outside undo history. */
  private scratch: Model | null = null;
  private builtins = new Map<string, boolean>();
  /**
   * IronCalc undo steps per user-visible operation, so an operation made of
   * several IronCalc calls (e.g. a sparse clear) undoes with one Ctrl+Z.
   * Every history-creating IronCalc call here is exactly one step.
   */
  private undoSizes: number[] = [];
  private redoSizes: number[] = [];

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
    // We don't use IronCalc's collaboration queue; drain it so it doesn't grow.
    this.model.flushSendQueue();
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
    this.recorded(name ? 2 : 1);
    this.emit({ kind: "sheets" });
    return index;
  }

  renameSheet(sheet: number, name: string): void {
    this.model.renameSheet(sheet, name);
    this.recorded();
    this.emit({ kind: "sheets" });
  }

  deleteSheet(sheet: number): void {
    this.model.deleteSheet(sheet);
    this.recorded();
    this.emit({ kind: "sheets" });
  }

  setSheetHidden(sheet: number, hidden: boolean): void {
    if (hidden) this.model.hideSheet(sheet);
    else this.model.unhideSheet(sheet);
    this.recorded();
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

  numberFormat(sheet: number, row: number, col: number): string {
    return this.model.getCellStyle(sheet, row, col).style.num_fmt || "general";
  }

  setNumberFormat(r: Range, format: string): void {
    this.model.updateRangeStyle({ sheet: r.sheet, row: r.row, column: r.col, width: r.cols, height: r.rows }, "num_fmt", format);
    this.recorded();
    this.emit({ kind: "cells", ranges: [r], source: "user" });
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
    this.recorded();
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
    this.recorded();
    this.cells({ sheet, row, col, rows, cols }, source);
  }

  clearRange(r: Range, source: ChangeSource = "user"): void {
    // IronCalc visits (and leaves an empty cell at) every position in the
    // range, and aborts on whole-sheet ranges. Clear only rows that hold
    // content, in blocks of consecutive rows, as one undoable operation.
    const clipped = this.clipToUsed(r);
    if (!clipped) return;
    const c1 = clipped.col;
    const c2 = clipped.col + clipped.cols - 1;
    const blocks: [number, number, number, number][] = [];
    let open: [number, number, number, number] | null = null;
    const has = (row: number, c: number) => this.model.getCellContent(clipped.sheet, row, c) !== "";
    for (let row = clipped.row; row < clipped.row + clipped.rows; row++) {
      // Only the first and last occupied column matter; probe from both ends.
      const cols = Array.from(this.model.getColumnsWithData(clipped.sheet, row))
        .filter((c) => c >= c1 && c <= c2)
        .sort((a, b) => a - b);
      const lo = cols.find((c) => has(row, c));
      if (lo === undefined) {
        open = null;
        continue;
      }
      const hi = cols.findLast((c) => has(row, c))!;
      if (open) {
        open[2] = row;
        open[1] = Math.min(open[1], lo);
        open[3] = Math.max(open[3], hi);
      } else {
        open = [row, lo, row, hi];
        blocks.push(open);
      }
    }
    for (const [r1, b1, r2, b2] of blocks) this.model.rangeClearContents(clipped.sheet, r1, b1, r2, b2);
    if (!blocks.length) return;
    this.recorded(blocks.length);
    // Rescanning is slow (cleared cells linger in IronCalc), so only reset the
    // cached extent when the clear covered all of it; otherwise it may overstate.
    const u = this.used.get(clipped.sheet);
    const coveredAll = u && clipped.row === 1 && clipped.col === 1 && clipped.rows >= u.rows && clipped.cols >= u.cols;
    this.cells(clipped, source);
    if (coveredAll) this.used.set(clipped.sheet, { rows: 0, cols: 0 }); // after emit, which grows the cache
  }

  /** Columns in `row` holding content, ascending (IronCalc also reports emptied cells). */
  contentColumns(sheet: number, row: number): number[] {
    const cols = this.model.getColumnsWithData(sheet, row);
    if (!cols.length) return [];
    return Array.from(cols)
      .filter((c) => this.model.getCellContent(sheet, row, c) !== "")
      .sort((a, b) => a - b);
  }

  /** Intersection of `r` with the sheet's used range, or null if empty. */
  private clipToUsed(r: Range): Range | null {
    const used = this.usedRange(r.sheet);
    const rows = Math.min(r.row + r.rows - 1, used.rows) - r.row + 1;
    const cols = Math.min(r.col + r.cols - 1, used.cols) - r.col + 1;
    return rows > 0 && cols > 0 ? { ...r, rows, cols } : null;
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
        // Cells emptied by a clear still exist; only count ones with content.
        let max = 0;
        for (const c of cols) if (c > max && c > u.cols && this.model.getCellContent(sheet, r, c) !== "") max = c;
        const hasContent = max > 0 || Array.from(cols).some((c) => this.model.getCellContent(sheet, r, c) !== "");
        if (!hasContent) continue;
        u.rows = r;
        if (max > u.cols) u.cols = max;
      }
      this.used.set(sheet, u);
    }
    return { ...u };
  }

  // ---- structure

  insertRows(sheet: number, row: number, count: number): void {
    this.structural(() => this.model.insertRows(sheet, row, count), "row");
    this.recorded();
    const u = this.used.get(sheet);
    if (u && row <= u.rows) u.rows = Math.min(MAX_ROWS, u.rows + count);
    this.emit({ kind: "all" });
  }

  insertCols(sheet: number, col: number, count: number): void {
    this.structural(() => this.model.insertColumns(sheet, col, count), "column");
    this.recorded();
    const u = this.used.get(sheet);
    if (u && col <= u.cols) u.cols = Math.min(MAX_COLS, u.cols + count);
    this.emit({ kind: "all" });
  }

  deleteRows(sheet: number, row: number, count: number): void {
    // IronCalc only shifts rows that exist; clamp to the sheet.
    this.structural(() => this.model.deleteRows(sheet, row, Math.min(count, MAX_ROWS - row + 1)), "row");
    this.recorded();
    this.used.delete(sheet);
    this.emit({ kind: "all" });
  }

  deleteCols(sheet: number, col: number, count: number): void {
    this.structural(() => this.model.deleteColumns(sheet, col, Math.min(count, MAX_COLS - col + 1)), "column");
    this.recorded();
    this.used.delete(sheet);
    this.emit({ kind: "all" });
  }

  /** Run a row/column operation, turning IronCalc's errors into readable ones. */
  private structural(fn: () => void, what: "row" | "column"): void {
    try {
      fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/delete cells at the end/i.test(msg)) {
        const last = what === "row" ? `row ${MAX_ROWS.toLocaleString("en-US")}` : "column XFD";
        throw new Error(`Can't insert: the sheet's last ${what} (${last}) isn't empty. Clear it first.`);
      }
      throw new Error(msg);
    }
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
    this.recorded();
    this.emit({ kind: "all" });
  }

  frozen(sheet: number): { rows: number; cols: number } {
    return { rows: this.model.getFrozenRowsCount(sheet), cols: this.model.getFrozenColumnsCount(sheet) };
  }

  setFrozen(sheet: number, rows: number, cols: number): void {
    const now = this.frozen(sheet);
    let steps = 0;
    if (now.rows !== rows) {
      this.model.setFrozenRowsCount(sheet, rows);
      steps++;
    }
    if (now.cols !== cols) {
      this.model.setFrozenColumnsCount(sheet, cols);
      steps++;
    }
    if (!steps) return;
    this.recorded(steps);
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
    const steps = this.undoSizes.pop() ?? 1;
    for (let i = 0; i < steps && this.model.canUndo(); i++) this.model.undo();
    this.redoSizes.push(steps);
    this.used.clear();
    this.emit({ kind: "all" });
  }

  redo(): void {
    const steps = this.redoSizes.pop() ?? 1;
    for (let i = 0; i < steps && this.model.canRedo(); i++) this.model.redo();
    this.undoSizes.push(steps);
    this.used.clear();
    this.emit({ kind: "all" });
  }

  /** Note that an operation added `steps` entries to IronCalc's history. */
  private recorded(steps = 1): void {
    this.undoSizes.push(steps);
    this.redoSizes = [];
  }

  canUndo(): boolean {
    return this.model.canUndo();
  }

  canRedo(): boolean {
    return this.model.canRedo();
  }

  // ---- clipboard

  copy(range: Range): EngineClipboard {
    // Copying a whole-sheet selection only needs the cells with data.
    const r = this.clipToUsed(range) ?? { ...range, rows: 1, cols: 1 };
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
    this.recorded();
    const [r1, c1, r2, c2] = clip.sourceRange;
    this.cells({ ...target, rows: r2 - r1 + 1, cols: c2 - c1 + 1 }, "user");
  }

  pasteText(target: Range, tsv: string): void {
    const body = tsv.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    if (body === "") return;
    // Shape is only used to size the change event; IronCalc parses quoting itself.
    const lines = body.split("\n");
    const rows = lines.length;
    const cols = Math.max(...lines.map((l) => l.split("\t").length));
    this.withSelection(target.sheet, target.row, target.col, () =>
      this.model.pasteCsvText({ sheet: target.sheet, row: target.row, column: target.col, width: cols, height: rows }, body),
    );
    this.recorded();
    this.cells({ ...target, rows, cols }, "user");
  }

  // ---- system writes

  /**
   * Apply changes without touching undo history: make them on a scratch model
   * with the same sheet layout, then replay its diffs as "external" changes.
   */
  private external(fn: (m: Model) => void): void {
    const sheets = this.model.getWorksheetsProperties();
    const s = this.scratch;
    const inSync = s && s.getWorksheetsProperties().map((p) => p.name).join("\0") === sheets.map((p) => p.name).join("\0");
    if (!inSync) {
      this.scratch?.free();
      const m = new Model("scratch", LOCALE, "UTC", LANG);
      sheets.forEach((p, i) => {
        if (i > 0) m.newSheet();
        m.renameSheet(i, p.name);
      });
      m.pauseEvaluation();
      m.flushSendQueue();
      this.scratch = m;
    }
    fn(this.scratch!);
    this.model.applyExternalDiffs(this.scratch!.flushSendQueue());
  }

  setSystemInputs(cells: CellInput[]): void {
    if (!cells.length) return;
    this.external((m) => {
      for (const c of cells) m.setUserInput(c.sheet, c.row, c.col, c.input);
    });
    this.emit({ kind: "cells", ranges: cells.map((c) => ({ sheet: c.sheet, row: c.row, col: c.col, rows: 1, cols: 1 })), source: "system" });
  }

  ensureSheet(name: string, hidden: boolean): number {
    const existing = this.sheets().find((s) => s.name === name);
    if (existing) return existing.index;
    this.external((m) => {
      m.newSheet();
      const index = m.getWorksheetsProperties().length - 1;
      m.renameSheet(index, name);
      if (hidden) m.hideSheet(index);
    });
    this.emit({ kind: "sheets" });
    return this.sheets().length - 1;
  }

  // ---- formulas

  tokenize(body: string): FormulaToken[] {
    return getTokens(body).map(({ token: t, start, end }): FormulaToken => {
      if (t === "LeftParenthesis") return { kind: "lparen", start, end };
      if (t === "RightParenthesis") return { kind: "rparen", start, end };
      if (t === "Comma") return { kind: "comma", start, end };
      if (typeof t === "object" && "Ident" in t) return { kind: "ident", start, end, text: t.Ident };
      if (typeof t === "object" && "Reference" in t) {
        const r = t.Reference as unknown as { sheet?: string | null; row: number; column: number };
        return { kind: "ref", start, end, sheet: r.sheet ?? null, r1: r.row, c1: r.column, r2: r.row, c2: r.column };
      }
      if (typeof t === "object" && "Range" in t) {
        const { sheet, left, right } = t.Range;
        return { kind: "range", start, end, sheet: sheet ?? null, r1: left.row, c1: left.column, r2: right.row, c2: right.column };
      }
      return { kind: "other", start, end };
    });
  }

  builtinFunctions(): readonly string[] {
    return BUILTIN_FUNCTIONS;
  }

  functionCompletion(sheet: number, row: number, col: number, text: string, cursor: number): { prefix: string; from: number } | null {
    if (!text.startsWith("=")) return null;
    if (cursor === 1 && text.length >= 1 && /^=\s*$/.test(text.slice(0, cursor))) return { prefix: "", from: 1 };
    try {
      const ctx = this.model.getFormulaCompletion(sheet, row, col, text, cursor);
      for (const e of ctx.expecting) {
        // replace_from is relative to the formula body (after "=").
        if (typeof e === "object" && "FunctionName" in e) return { prefix: e.FunctionName, from: ctx.replace_from + 1 };
      }
    } catch {
      // half-typed formulas the parser can't make sense of: no suggestions
    }
    return null;
  }

  /** IronCalc upper-cases names it knows and leaves unknown ones as typed. */
  isBuiltinFunction(name: string): boolean {
    const key = name.toUpperCase();
    let known = this.builtins.get(key);
    if (known === undefined) {
      const m = new Model("probe", LOCALE, "UTC", LANG);
      m.setUserInput(0, 1, 1, `=${name.toLowerCase()}()`);
      known = m.getCellContent(0, 1, 1).startsWith(`=${key}(`);
      m.free();
      this.builtins.set(key, known);
    }
    return known;
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
