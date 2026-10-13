import { shiftFormula, tile } from "../engine/formula";
import type { Engine, EngineClipboard, Range } from "../engine/types";
import { parseCsv } from "../io/csv";
import { MAX_COLS, MAX_ROWS } from "../engine/types";
import { a1, Axis, type CellPos, type Selection, selectionBounds } from "./geometry";
import { CellCache, COL_HEADER_HEIGHT, DARK, LIGHT, render, ROW_HEADER_WIDTH } from "./renderer";

const FONT = '13px Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const MIN_ROWS = 1000;
const MIN_COLS = 26;
const RESIZE_HIT = 4;
/** Largest area filled by a tiled paste or Ctrl+Enter, in cells. */
const MAX_FILL = 200_000;

/** Translates between what the user types/sees and what the engine stores (custom functions). */
export interface FormulaAdapter {
  toEngine(sheet: number, row: number, col: number, input: string): string;
  toUser(sheet: number, row: number, col: number, input: string): string;
}

export type GridEvent = { type: "selection" } | { type: "edit"; text: string | null } | { type: "error"; message: string };

/**
 * Canvas spreadsheet grid. Owns scrolling, selection, keyboard and the in-cell
 * editor; reads everything it paints from the engine.
 */
export class Grid {
  sheet = 0;
  formulas: FormulaAdapter | null = null;
  private sel: Selection = { anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } };
  /** Active cell when it differs from the anchor (Enter/Tab cycling inside a range). */
  private cursor: CellPos | null = null;
  /** Set when the selection is whole rows/columns (header click, Shift/Ctrl+Space). */
  private whole: "rows" | "cols" | null = null;

  private rows = new Axis(MIN_ROWS, 25);
  private cols = new Axis(MIN_COLS, 90);
  private cache: CellCache;
  private wrapper: HTMLDivElement;
  private scroller: HTMLDivElement;
  private spacer: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private editor: HTMLTextAreaElement;
  private rowOverrides: [number, number][] = [];
  private clip: { data: EngineClipboard; cut: boolean } | null = null;
  private editing: { row: number; col: number } | null = null;
  private dirty = false;
  private listeners = new Set<(e: GridEvent) => void>();
  private disposers: (() => void)[] = [];
  private dark = matchMedia("(prefers-color-scheme: dark)");
  /** Duration of recent paints in ms (dev diagnostics). */
  readonly paintTimes: number[] = [];

  constructor(
    container: HTMLElement,
    readonly engine: Engine,
  ) {
    this.cache = new CellCache(engine);

    this.wrapper = el("div", "adder-grid");
    this.scroller = el("div", "adder-grid-scroller");
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute("role", "grid");
    this.scroller.setAttribute("aria-label", "Spreadsheet");
    this.canvas = el("canvas", "adder-grid-canvas");
    this.spacer = el("div", "adder-grid-spacer");
    this.editor = el("textarea", "adder-grid-editor");
    this.editor.spellcheck = false;
    this.editor.hidden = true;
    this.scroller.append(this.canvas, this.spacer);
    this.wrapper.append(this.scroller, this.editor);
    container.append(this.wrapper);
    this.ctx = this.canvas.getContext("2d")!;

    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn);
      this.disposers.push(() => t.removeEventListener(type, fn));
    };
    on(this.scroller, "scroll", () => this.onScroll());
    on(this.scroller, "keydown", (e) => this.onKey(e));
    on(this.scroller, "mousedown", (e) => this.onMouseDown(e));
    on(this.scroller, "mousemove", (e) => this.onHover(e));
    on(this.scroller, "dblclick", (e) => this.onDblClick(e));
    on(this.scroller, "copy", (e) => this.onCopy(e, false));
    on(this.scroller, "cut", (e) => this.onCopy(e, true));
    on(this.scroller, "paste", (e) => this.onPaste(e));
    on(this.editor, "keydown", (e) => this.onEditorKey(e));
    on(this.editor, "input", () => this.emit({ type: "edit", text: this.editor.value }));
    on(this.editor, "blur", () => {
      // Clicking into the formula bar shouldn't drop the edit.
      if (this.editing && !this.wrapper.ownerDocument.activeElement?.closest("[data-formula-bar]")) this.commitEdit(null);
    });

    const ro = new ResizeObserver(() => this.invalidate());
    ro.observe(this.scroller);
    this.disposers.push(() => ro.disconnect());
    const scheme = () => this.invalidate();
    this.dark.addEventListener("change", scheme);
    this.disposers.push(() => this.dark.removeEventListener("change", scheme));
    this.disposers.push(
      engine.onChange((e) => {
        this.cache.clear();
        if (e.kind === "cells") {
          for (const r of e.ranges) if (r.sheet === this.sheet) this.ensureExtent(r.row + r.rows - 1, r.col + r.cols - 1);
        } else {
          this.loadGeometry(e.kind === "sheets");
        }
        this.invalidate();
      }),
    );

    this.loadGeometry();
    this.invalidate();
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.wrapper.remove();
  }

  on(fn: (e: GridEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  focus(): void {
    this.scroller.focus({ preventScroll: true });
  }

  setSheet(sheet: number): void {
    if (this.editing) this.commitEdit(null);
    this.sheet = sheet;
    this.cache.clear();
    this.loadGeometry();
    this.scroller.scrollTo(0, 0);
    this.select({ row: 1, col: 1 });
  }

  get selection(): Selection {
    return this.sel;
  }

  set selection(s: Selection) {
    this.sel = s;
    this.cursor = null;
    this.whole = null;
  }

  get wholeSelection(): "rows" | "cols" | null {
    return this.whole;
  }

  /** Select entire rows or columns `from`..`to`, optionally keeping the active cell. */
  private selectWhole(kind: "rows" | "cols", from: number, to: number, active?: CellPos): void {
    this.selection =
      kind === "cols"
        ? { anchor: { row: 1, col: from }, focus: { row: this.rows.count, col: to } }
        : { anchor: { row: from, col: 1 }, focus: { row: to, col: this.cols.count } };
    this.whole = kind;
    if (active) this.cursor = active;
    this.invalidate();
    this.emit({ type: "selection" });
  }

  /**
   * Insert (before) or delete the selected whole rows/columns. Errors are
   * reported as grid "error" events rather than thrown.
   */
  private structuralEdit(op: "insert" | "delete"): void {
    const b = selectionBounds(this.selection);
    try {
      if (this.whole === "rows") {
        const n = b.r2 - b.r1 + 1;
        if (op === "insert") this.engine.insertRows(this.sheet, b.r1, n);
        else this.engine.deleteRows(this.sheet, b.r1, n);
      } else if (this.whole === "cols") {
        const n = b.c2 - b.c1 + 1;
        if (op === "insert") this.engine.insertCols(this.sheet, b.c1, n);
        else this.engine.deleteCols(this.sheet, b.c1, n);
      }
    } catch (err) {
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  get active(): CellPos {
    return this.cursor ?? this.sel.anchor;
  }

  get selectedRange(): Range {
    const b = selectionBounds(this.selection);
    return { sheet: this.sheet, row: b.r1, col: b.c1, rows: b.r2 - b.r1 + 1, cols: b.c2 - b.c1 + 1 };
  }

  /** The cell's input as the user should see it. */
  inputAt(row: number, col: number): string {
    const raw = this.engine.getInput(this.sheet, row, col);
    return this.formulas ? this.formulas.toUser(this.sheet, row, col, raw) : raw;
  }

  get isEditing(): boolean {
    return this.editing !== null;
  }

  // ---- selection

  select(pos: CellPos, extend = false): void {
    const p = { row: clamp(pos.row, 1, MAX_ROWS), col: clamp(pos.col, 1, MAX_COLS) };
    this.selection = extend ? { anchor: this.selection.anchor, focus: p } : { anchor: p, focus: p };
    this.ensureExtent(p.row, p.col);
    this.scrollIntoView(p);
    this.invalidate();
    this.emit({ type: "selection" });
  }

  private move(dr: number, dc: number, extend: boolean): void {
    const from = extend ? this.selection.focus : this.selection.anchor;
    this.select({ row: from.row + dr, col: from.col + dc }, extend);
  }

  /** Enter/Tab inside a multi-cell selection cycles within it. */
  private advance(dr: number, dc: number): void {
    const b = selectionBounds(this.selection);
    if (b.r1 === b.r2 && b.c1 === b.c2) return this.move(dr, dc, false);
    let { row, col } = this.active;
    if (dc) {
      col += dc;
      if (col > b.c2) [col, row] = [b.c1, row + 1 > b.r2 ? b.r1 : row + 1];
      if (col < b.c1) [col, row] = [b.c2, row - 1 < b.r1 ? b.r2 : row - 1];
    } else {
      row += dr;
      if (row > b.r2) [row, col] = [b.r1, col + 1 > b.c2 ? b.c1 : col + 1];
      if (row < b.r1) [row, col] = [b.r2, col - 1 < b.c1 ? b.c2 : col - 1];
    }
    this.cursor = { row, col };
    this.scrollIntoView({ row, col });
    this.invalidate();
    this.emit({ type: "selection" });
  }

  // ---- editing

  /** Open the in-cell editor. `initial` replaces content (typing); undefined edits existing. */
  startEdit(initial?: string, focusEditor = true): void {
    const { row, col } = this.active;
    this.editing = { row, col };
    this.editor.value = initial ?? this.inputAt(row, col);
    this.editor.hidden = false;
    this.positionEditor();
    if (focusEditor) {
      this.editor.focus();
      const end = this.editor.value.length;
      this.editor.setSelectionRange(end, end);
    }
    this.emit({ type: "edit", text: this.editor.value });
  }

  /** Set the editor text from outside (formula bar). */
  setEditText(text: string): void {
    if (!this.editing) {
      this.startEdit(text, false);
      return;
    }
    this.editor.value = text;
    this.positionEditor();
  }

  /**
   * Commit the editor. With `fillSelection` (Ctrl+Enter) the value goes into
   * every selected cell, formulas shifted relative to the edited cell.
   */
  commitEdit(move: [number, number] | null, fillSelection = false): void {
    if (!this.editing) return;
    const { row, col } = this.editing;
    const value = this.editor.value;
    this.closeEditor();
    const sel = this.selectedRange;
    if (fillSelection && sel.rows * sel.cols > 1 && sel.rows * sel.cols <= MAX_FILL) {
      const block = Array.from({ length: sel.rows }, (_, i) =>
        Array.from({ length: sel.cols }, (_, j) => shiftFormula(this.engine, value, sel.row + i - row, sel.col + j - col)),
      );
      this.writeBlock(sel.row, sel.col, block);
      this.focus();
      return;
    }
    if (value !== this.inputAt(row, col)) {
      const input = this.formulas ? this.formulas.toEngine(this.sheet, row, col, value) : value;
      this.engine.setInput(this.sheet, row, col, input);
    }
    if (move) this.advance(move[0], move[1]);
    this.focus();
  }

  cancelEdit(): void {
    if (!this.editing) return;
    this.closeEditor();
    this.focus();
  }

  private closeEditor(): void {
    this.editing = null;
    this.editor.hidden = true;
    this.emit({ type: "edit", text: null });
  }

  private positionEditor(): void {
    if (!this.editing) return;
    const { row, col } = this.editing;
    const x = ROW_HEADER_WIDTH + this.cols.offset(col) - this.scroller.scrollLeft;
    const y = COL_HEADER_HEIGHT + this.rows.offset(row) - this.scroller.scrollTop;
    const s = this.editor.style;
    s.left = `${x - 1}px`;
    s.top = `${y - 1}px`;
    s.minWidth = `${this.cols.size(col) + 1}px`;
    s.height = `${this.rows.size(row) + 1}px`;
    s.font = FONT;
    // Grow to fit content.
    s.width = "0";
    s.width = `${Math.min(this.scroller.clientWidth - x, this.editor.scrollWidth + 8)}px`;
  }

  /** In a formula, a click at an operand position inserts a reference instead of committing. */
  private wantsReference(): boolean {
    const v = this.editor.value;
    if (!v.startsWith("=")) return false;
    const before = v.slice(0, this.editor.selectionStart).trimEnd();
    return /[=(,+\-*/^&<>:;]$/.test(before);
  }

  private insertReference(pos: CellPos): void {
    const start = this.editor.selectionStart;
    const v = this.editor.value;
    const ref = a1(pos.row, pos.col);
    this.editor.value = v.slice(0, start) + ref + v.slice(this.editor.selectionEnd);
    this.editor.focus();
    this.editor.setSelectionRange(start + ref.length, start + ref.length);
    this.emit({ type: "edit", text: this.editor.value });
  }

  // ---- clipboard

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (this.editing || !e.clipboardData) return;
    const data = this.engine.copy(this.selectedRange);
    e.clipboardData.setData("text/plain", data.tsv);
    e.preventDefault();
    this.clip = { data, cut };
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.editing || !e.clipboardData) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const sel = this.selectedRange;
    const { row, col } = sel; // paste anchors at the selection's top-left
    const norm = (t: string) => t.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const clip = this.clip && norm(text) === norm(this.clip.data.tsv) ? this.clip : null;

    // A selection larger than what was copied is filled by repeating it (Excel semantics).
    if (!clip?.cut && sel.rows * sel.cols <= MAX_FILL) {
      const source = clip ? this.clipInputs(clip.data) : parseCsv(norm(text), "\t");
      const [r1, c1] = clip ? clip.data.sourceRange : [row, col];
      const bigger = sel.rows > source.length || sel.cols > Math.max(0, ...source.map((r) => r.length));
      const filled = bigger ? tile(this.engine, source, sel, clip ? { dr: row - r1, dc: col - c1 } : null) : null;
      if (filled) {
        this.writeBlock(row, col, filled);
        return;
      }
    }

    let rows: number;
    let cols: number;
    const target = { sheet: this.sheet, row, col, rows: 1, cols: 1 };
    if (clip) {
      // Our own copy: lossless paste with formulas adjusted and styles kept.
      this.engine.paste(target, clip.data, clip.cut);
      const [r1, c1, r2, c2] = clip.data.sourceRange;
      [rows, cols] = [r2 - r1 + 1, c2 - c1 + 1];
      if (clip.cut) this.clip = null;
    } else {
      const lines = norm(text).split("\n");
      this.engine.pasteText(target, text);
      [rows, cols] = [lines.length, Math.max(...lines.map((l) => l.split("\t").length))];
    }
    this.selection = { anchor: { row, col }, focus: { row: row + rows - 1, col: col + cols - 1 } };
    this.invalidate();
    this.emit({ type: "selection" });
  }

  /** Current inputs of a copied range, as the user would type them. */
  private clipInputs(clip: EngineClipboard): string[][] {
    const [r1, c1, r2, c2] = clip.sourceRange;
    const out: string[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row: string[] = [];
      for (let c = c1; c <= c2; c++) {
        const raw = this.engine.getInput(clip.sourceSheet, r, c);
        row.push(this.formulas ? this.formulas.toUser(clip.sourceSheet, r, c, raw) : raw);
      }
      out.push(row);
    }
    return out;
  }

  /** Write user-typed inputs at (row, col) as one undo step; selection stays put. */
  private writeBlock(row: number, col: number, inputs: string[][]): void {
    const engineInputs = this.formulas
      ? inputs.map((r, i) => r.map((v, j) => this.formulas!.toEngine(this.sheet, row + i, col + j, v)))
      : inputs;
    this.engine.setRange(this.sheet, row, col, engineInputs, "user");
  }

  // ---- input handlers

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const structural = structuralShortcut(e);
    if (structural) {
      // These are also the browser's zoom keys: claim them only when whole
      // rows/columns are selected, and cancel before acting.
      if (!this.whole) return;
      e.preventDefault();
      this.structuralEdit(structural);
      return;
    }
    const page = Math.max(1, Math.floor((this.scroller.clientHeight - COL_HEADER_HEIGHT) / this.rows.defaultSize) - 1);
    const arrows: Record<string, [number, number, "up" | "down" | "left" | "right"]> = {
      ArrowUp: [-1, 0, "up"],
      ArrowDown: [1, 0, "down"],
      ArrowLeft: [0, -1, "left"],
      ArrowRight: [0, 1, "right"],
    };
    const arrow = arrows[e.key];
    if (arrow) {
      if (mod) {
        const from = e.shiftKey ? this.selection.focus : this.selection.anchor;
        this.select(this.engine.edge(this.sheet, from.row, from.col, arrow[2]), e.shiftKey);
      } else {
        this.move(arrow[0], arrow[1], e.shiftKey);
      }
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      this.move(e.key === "PageDown" ? page : -page, 0, e.shiftKey);
    } else if (e.key === "Home") {
      const from = e.shiftKey ? this.selection.focus : this.selection.anchor;
      this.select(mod ? { row: 1, col: 1 } : { row: from.row, col: 1 }, e.shiftKey);
    } else if (e.key === "End" && mod) {
      const used = this.engine.usedRange(this.sheet);
      this.select({ row: Math.max(1, used.rows), col: Math.max(1, used.cols) }, e.shiftKey);
    } else if (e.key === "Enter") {
      this.advance(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === "Tab") {
      this.advance(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "F2") {
      this.startEdit();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      this.engine.clearRange(this.selectedRange);
    } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      this.engine.redo();
    } else if (mod && e.key.toLowerCase() === "z") {
      this.engine.undo();
    } else if (e.key === " " && (mod || e.shiftKey) && !(mod && e.shiftKey)) {
      // Ctrl+Space: whole columns; Shift+Space: whole rows.
      const b = selectionBounds(this.selection);
      if (mod) this.selectWhole("cols", b.c1, b.c2, this.active);
      else this.selectWhole("rows", b.r1, b.r2, this.active);
    } else if (mod && e.key.toLowerCase() === "a") {
      this.selection = { anchor: { row: 1, col: 1 }, focus: { row: this.rows.count, col: this.cols.count } };
      this.invalidate();
      this.emit({ type: "selection" });
    } else if (!mod && !e.altKey && e.key.length === 1) {
      // Printable key starts editing; let the character land in the editor.
      this.startEdit("");
      return;
    } else {
      return;
    }
    e.preventDefault();
  }

  private onEditorKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      this.commitEdit(null, true);
    } else if (e.key === "Enter" && !e.altKey) {
      this.commitEdit([e.shiftKey ? -1 : 1, 0]);
    } else if (e.key === "Enter" && e.altKey) {
      const { selectionStart: a, selectionEnd: b, value } = this.editor;
      this.editor.value = value.slice(0, a) + "\n" + value.slice(b);
      this.editor.setSelectionRange(a + 1, a + 1);
      this.emit({ type: "edit", text: this.editor.value });
    } else if (e.key === "Tab") {
      this.commitEdit([0, e.shiftKey ? -1 : 1]);
    } else if (e.key === "Escape") {
      this.cancelEdit();
    } else {
      requestAnimationFrame(() => this.positionEditor());
      return;
    }
    e.preventDefault();
  }

  private hit(e: MouseEvent): { row: number; col: number; inColHeader: boolean; inRowHeader: boolean; x: number; y: number } {
    const rect = this.scroller.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x,
      y,
      inColHeader: y < COL_HEADER_HEIGHT,
      inRowHeader: x < ROW_HEADER_WIDTH,
      row: this.rows.indexAt(y - COL_HEADER_HEIGHT + this.scroller.scrollTop),
      col: this.cols.indexAt(x - ROW_HEADER_WIDTH + this.scroller.scrollLeft),
    };
  }

  /** Column whose right border is under x (header only), for resizing. */
  private resizeTarget(x: number): number | null {
    const px = x - ROW_HEADER_WIDTH + this.scroller.scrollLeft;
    const col = this.cols.indexAt(px);
    const right = this.cols.offset(col + 1);
    if (Math.abs(px - right) <= RESIZE_HIT) return col;
    const left = this.cols.offset(col);
    if (col > 1 && Math.abs(px - left) <= RESIZE_HIT) return col - 1;
    return null;
  }

  private onHover(e: MouseEvent): void {
    if (e.buttons) return;
    const h = this.hit(e);
    this.scroller.style.cursor = h.inColHeader && !h.inRowHeader && this.resizeTarget(h.x) !== null ? "col-resize" : "";
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const h = this.hit(e);
    if (h.x > this.scroller.clientWidth || h.y > this.scroller.clientHeight) return; // native scrollbar
    e.preventDefault();

    if (h.inColHeader && !h.inRowHeader) {
      const col = this.resizeTarget(h.x);
      if (col !== null) return this.dragResize(e, col);
    }

    if (this.editing && !h.inColHeader && !h.inRowHeader && this.wantsReference()) {
      this.insertReference({ row: h.row, col: h.col });
      return;
    }
    if (this.editing) this.commitEdit(null);
    this.focus();

    if (h.inColHeader && h.inRowHeader) {
      this.selection = { anchor: { row: 1, col: 1 }, focus: { row: this.rows.count, col: this.cols.count } };
    } else if (h.inColHeader) {
      this.selectWhole("cols", e.shiftKey ? this.selection.anchor.col : h.col, h.col);
    } else if (h.inRowHeader) {
      this.selectWhole("rows", e.shiftKey ? this.selection.anchor.row : h.row, h.row);
    } else {
      this.select({ row: h.row, col: h.col }, e.shiftKey);
    }
    this.invalidate();
    this.emit({ type: "selection" });

    const mode = h.inColHeader && !h.inRowHeader ? "col" : h.inRowHeader && !h.inColHeader ? "row" : "cell";
    const onMove = (ev: MouseEvent) => {
      const m = this.hit(ev);
      this.autoScroll(m.x, m.y);
      const focus =
        mode === "col"
          ? { row: this.rows.count, col: m.col }
          : mode === "row"
            ? { row: m.row, col: this.cols.count }
            : { row: m.row, col: m.col };
      if (focus.row === this.selection.focus.row && focus.col === this.selection.focus.col) return;
      if (mode === "col") this.selectWhole("cols", this.selection.anchor.col, m.col);
      else if (mode === "row") this.selectWhole("rows", this.selection.anchor.row, m.row);
      else {
        this.selection = { anchor: this.selection.anchor, focus };
        this.invalidate();
        this.emit({ type: "selection" });
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private dragResize(e: MouseEvent, col: number): void {
    const startX = e.clientX;
    const startW = this.cols.size(col);
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(8, startW + ev.clientX - startX);
      this.cols.setOverrides(new Map([...this.colOverrides(), [col, w]]));
      this.layout();
      this.invalidate();
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.engine.setColWidth(this.sheet, col, Math.max(8, startW + ev.clientX - startX));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private onDblClick(e: MouseEvent): void {
    const h = this.hit(e);
    if (h.inColHeader || h.inRowHeader) return;
    this.startEdit();
  }

  private autoScroll(x: number, y: number): void {
    const w = this.scroller.clientWidth;
    const hgt = this.scroller.clientHeight;
    const dx = x > w ? x - w : x < ROW_HEADER_WIDTH ? x - ROW_HEADER_WIDTH : 0;
    const dy = y > hgt ? y - hgt : y < COL_HEADER_HEIGHT ? y - COL_HEADER_HEIGHT : 0;
    if (dx || dy) this.scroller.scrollBy(dx, dy);
  }

  // ---- geometry & scrolling

  private colOverrides(): [number, number][] {
    const out: [number, number][] = [];
    for (let c = 1; c <= this.cols.count; c++) {
      const w = this.cols.size(c);
      if (w !== this.cols.defaultSize) out.push([c, w]);
    }
    return out;
  }

  /**
   * Read sizes and extent for the current sheet from the engine. Row heights
   * only change on load/import, so scanning them is optional.
   */
  private loadGeometry(withRows = true): void {
    const sheets = this.engine.sheets();
    if (this.sheet >= sheets.length) this.sheet = 0;
    const used = this.engine.usedRange(this.sheet);
    const rowCount = clamp(Math.max(MIN_ROWS, used.rows + 200, this.rows.count), 1, MAX_ROWS);
    const colCount = clamp(Math.max(MIN_COLS, used.cols + 5), 1, MAX_COLS);
    // Rows/cols past the used range are never customised; probe a far-away one for the default.
    const defRow = this.engine.rowHeight(this.sheet, MAX_ROWS);
    const defCol = this.engine.colWidth(this.sheet, MAX_COLS);
    const rowOv: [number, number][] = withRows ? [] : this.rowOverrides;
    if (withRows) for (let r = 1; r <= used.rows; r++) {
      const h = this.engine.rowHeight(this.sheet, r);
      if (h !== defRow) rowOv.push([r, h]);
    }
    const colOv: [number, number][] = [];
    for (let c = 1; c <= colCount; c++) {
      const w = this.engine.colWidth(this.sheet, c);
      if (w !== defCol) colOv.push([c, w]);
    }
    this.rowOverrides = rowOv;
    this.rows = new Axis(rowCount, defRow, rowOv);
    this.cols = new Axis(colCount, defCol, colOv);
    this.layout();
  }

  /** Grow the virtual extent so (row,col) and some slack are scrollable. */
  private ensureExtent(row: number, col: number): void {
    let changed = false;
    if (row + 50 > this.rows.count && this.rows.count < MAX_ROWS) {
      this.rows.count = Math.min(MAX_ROWS, Math.max(row + 200, this.rows.count + MIN_ROWS));
      changed = true;
    }
    if (col + 3 > this.cols.count && this.cols.count < MAX_COLS) {
      this.cols.count = Math.min(MAX_COLS, Math.max(col + 5, this.cols.count + 10));
      changed = true;
    }
    if (changed) this.layout();
  }

  private layout(): void {
    this.spacer.style.width = `${ROW_HEADER_WIDTH + this.cols.total()}px`;
    this.spacer.style.height = `${COL_HEADER_HEIGHT + this.rows.total()}px`;
  }

  private onScroll(): void {
    const { scrollTop, scrollLeft, clientHeight, clientWidth } = this.scroller;
    // Infinite-ish scroll: extend when nearing the end.
    if (scrollTop + 2 * clientHeight > this.rows.total()) this.ensureExtent(this.rows.indexAt(scrollTop + 2 * clientHeight), 1);
    if (scrollLeft + 2 * clientWidth > this.cols.total()) this.ensureExtent(1, this.cols.indexAt(scrollLeft + 2 * clientWidth));
    this.positionEditor();
    this.invalidate();
  }

  private scrollIntoView(p: CellPos): void {
    const s = this.scroller;
    const viewW = s.clientWidth - ROW_HEADER_WIDTH;
    const viewH = s.clientHeight - COL_HEADER_HEIGHT;
    const top = this.rows.offset(p.row);
    const bottom = top + this.rows.size(p.row);
    const left = this.cols.offset(p.col);
    const right = left + this.cols.size(p.col);
    let { scrollTop, scrollLeft } = s;
    if (top < scrollTop) scrollTop = top;
    else if (bottom > scrollTop + viewH) scrollTop = bottom - viewH;
    if (left < scrollLeft) scrollLeft = left;
    else if (right > scrollLeft + viewW) scrollLeft = right - viewW;
    if (scrollTop !== s.scrollTop || scrollLeft !== s.scrollLeft) s.scrollTo(scrollLeft, scrollTop);
  }

  // ---- painting

  invalidate(): void {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      this.dirty = false;
      this.paint();
    });
  }

  private paint(): void {
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = performance.now();
    render(
      this.ctx,
      {
        sheet: this.sheet,
        rows: this.rows,
        cols: this.cols,
        scrollX: this.scroller.scrollLeft,
        scrollY: this.scroller.scrollTop,
        width: w,
        height: h,
        selection: this.selection,
        active: this.active,
        palette: this.dark.matches ? DARK : LIGHT,
        font: FONT,
      },
      this.cache,
    );
    this.paintTimes.push(performance.now() - t);
    if (this.paintTimes.length > 600) this.paintTimes.splice(0, 300);
  }

  private emit(e: GridEvent): void {
    for (const l of this.listeners) l(e);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

/**
 * Ctrl+Shift+Plus / Ctrl+numpad Plus / Ctrl+Alt+= insert; Ctrl+Minus /
 * Ctrl+numpad Minus / Ctrl+Alt+- delete. The Ctrl+Alt forms are Google Sheets'
 * choice and no browser uses them for zoom. Matches on key position as well as
 * the character so other keyboard layouts work.
 */
function structuralShortcut(e: KeyboardEvent): "insert" | "delete" | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (e.key === "+" || e.code === "NumpadAdd") return "insert";
  if ((e.shiftKey || e.altKey) && (e.code === "Equal" || e.key === "=")) return "insert";
  if (e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") return "delete";
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
