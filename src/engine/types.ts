// Engine-agnostic interface. All cell state lives behind this; the grid,
// IO and Python layers talk only to `Engine`, so the calc engine can be swapped.
//
// Coordinates: sheet is 0-based; row and col are 1-based (spreadsheet style).

export interface Range {
  sheet: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface SheetInfo {
  index: number;
  name: string;
  hidden: boolean;
}

/** Raw-ish cell value as seen by scripts. */
export type CellValue = number | string | boolean | null | { error: string };

export type CellKind = "empty" | "number" | "text" | "boolean" | "error";

/** Engine-neutral subset of cell formatting the grid draws. */
export interface CellStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  wrap: boolean;
}

export type ChangeEvent =
  | { kind: "cells"; ranges: Range[]; source: ChangeSource }
  | { kind: "sheets" }
  | { kind: "all" };

/** Who caused a change: on_edit hooks only fire for "user" edits. */
export type ChangeSource = "user" | "script" | "system";

export type Direction = "up" | "down" | "left" | "right";

export interface EngineClipboard {
  tsv: string;
  /** Opaque engine payload for lossless internal paste. */
  native: unknown;
  sourceSheet: number;
  sourceRange: [number, number, number, number];
}

export interface Engine {
  // sheets
  sheets(): SheetInfo[];
  addSheet(name?: string): number;
  renameSheet(sheet: number, name: string): void;
  deleteSheet(sheet: number): void;
  setSheetHidden(sheet: number, hidden: boolean): void;

  // cells
  getDisplay(sheet: number, row: number, col: number): string;
  getInput(sheet: number, row: number, col: number): string;
  getKind(sheet: number, row: number, col: number): CellKind;
  getValue(sheet: number, row: number, col: number): CellValue;
  getStyle(sheet: number, row: number, col: number): CellStyle;
  getRangeValues(range: Range): CellValue[][];
  setInput(sheet: number, row: number, col: number, input: string, source?: ChangeSource): void;
  /** Batched write of raw inputs anchored at (sheet,row,col); one undo step. */
  setRange(sheet: number, row: number, col: number, inputs: string[][], source?: ChangeSource): void;
  clearRange(range: Range, source?: ChangeSource): void;
  usedRange(sheet: number): { rows: number; cols: number };

  // geometry
  rowHeight(sheet: number, row: number): number;
  colWidth(sheet: number, col: number): number;
  setColWidth(sheet: number, col: number, width: number): void;

  // navigation helpers
  edge(sheet: number, row: number, col: number, dir: Direction): { row: number; col: number };

  // history
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  // clipboard
  copy(range: Range): EngineClipboard;
  paste(target: Range, clip: EngineClipboard, cut: boolean): void;
  pasteText(target: Range, tsv: string): void;

  // persistence
  serialize(): Uint8Array;

  onChange(listener: (e: ChangeEvent) => void): () => void;
}

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;
