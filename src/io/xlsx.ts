// .xlsx import/export through SheetJS Community Edition.
//
// Stopgap until IronCalc publishes its wasm build with the `xlsx` feature
// (`Model.fromXlsx` / `toXlsx`); swap this codec for one that calls those.
// SheetJS CE reads fills and number formats but cannot write cell styles, so
// exports keep values, formulas, number formats, column widths and sheet names.

import * as XLSX from "xlsx";
import { IronCalcEngine } from "../engine/ironcalc";
import type { Engine } from "../engine/types";

export interface XlsxCodec {
  read(bytes: Uint8Array): IronCalcEngine;
  write(engine: Engine, opts?: ExportOptions): Uint8Array;
}

export interface ExportOptions {
  /** Override the formula text written for a cell (used to restore custom-function formulas). */
  formulaFor?: (sheet: number, row: number, col: number) => string | undefined;
  /** Leave out sheets (e.g. Adder's hidden bookkeeping sheet). */
  skipSheet?: (name: string) => boolean;
}

// Fallback when SheetJS gives only a character width (it normally supplies wpx).
const wchToPx = (wch: number) => Math.round(wch * 7 + 5);

/** Text that IronCalc would otherwise parse as a number, boolean or formula. */
function needsQuotePrefix(s: string): boolean {
  return /^[=+\-@']/.test(s) || /^(true|false)$/i.test(s) || (s.trim() !== "" && !Number.isNaN(Number(s))) || /^\d+%$/.test(s) || /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(s);
}

function rgb(color: { rgb?: string } | undefined): string | undefined {
  const v = color?.rgb;
  if (!v || !/^[0-9a-f]{6,8}$/i.test(v)) return undefined;
  return `#${v.slice(-6).toUpperCase()}`;
}

export const sheetjsCodec: XlsxCodec = {
  read(bytes) {
    const wb = XLSX.read(bytes, { type: "array", cellFormula: true, cellNF: true, cellStyles: true, cellDates: false });
    const engine = IronCalcEngine.create(wb.Props?.Title ?? "Imported");
    const model = engine.raw;
    model.pauseEvaluation();

    wb.SheetNames.forEach((name, index) => {
      if (index > 0) model.newSheet();
      model.renameSheet(index, name);
      const ws = wb.Sheets[name]!;
      if (wb.Workbook?.Sheets?.[index]?.Hidden) model.hideSheet(index);

      for (const [addr, cell] of Object.entries(ws) as [string, XLSX.CellObject][]) {
        if (addr.startsWith("!")) continue;
        const { r, c } = XLSX.utils.decode_cell(addr);
        const row = r + 1;
        const col = c + 1;
        let input: string | null = null;
        if (cell.f) {
          // Array formulas: write the anchor; IronCalc spills dynamic arrays itself.
          if (cell.F && !cell.F.startsWith(addr + ":") && cell.F !== addr) continue;
          input = "=" + cell.f;
        } else if (cell.t === "n") input = String(cell.v);
        else if (cell.t === "b") input = cell.v ? "TRUE" : "FALSE";
        else if (cell.t === "e") input = cell.w ?? "#N/A";
        else if (cell.t === "s") input = needsQuotePrefix(String(cell.v)) ? `'${cell.v}` : String(cell.v);
        if (input !== null) model.setUserInput(index, row, col, input);

        const area = { sheet: index, row, column: col, width: 1, height: 1 };
        if (cell.z && cell.z !== "General" && typeof cell.z === "string") model.updateRangeStyle(area, "num_fmt", cell.z);
        const style = cell.s as { patternType?: string; fgColor?: { rgb?: string } } | undefined;
        const fill = style?.patternType === "solid" ? rgb(style.fgColor) : undefined;
        if (fill && fill !== "#FFFFFF") model.updateRangeStyle(area, "fill.color", fill);
      }

      ws["!cols"]?.forEach((ci, i) => {
        if (!ci) return;
        const px = ci.wpx ?? (ci.wch !== undefined ? wchToPx(ci.wch) : undefined);
        if (px) model.setColumnsWidth(index, i + 1, i + 1, px);
        if (ci.hidden) model.setColumnsHidden(index, i + 1, i + 1, true);
      });
      ws["!rows"]?.forEach((ri, i) => {
        if (ri?.hpx) model.setRowsHeight(index, i + 1, i + 1, ri.hpx);
        if (ri?.hidden) model.setRowsHidden(index, i + 1, i + 1, true);
      });
    });

    for (const n of wb.Workbook?.Names ?? []) {
      try {
        model.newDefinedName(n.Name, n.Sheet ?? null, n.Ref);
      } catch {
        // Skip names IronCalc can't represent (e.g. built-ins like _xlnm.Print_Area).
      }
    }

    model.resumeEvaluation();
    model.evaluate();
    // Round-trip through bytes so the import isn't sitting in the undo history.
    return IronCalcEngine.fromBytes(engine.serialize());
  },

  write(engine, opts = {}) {
    const wb = XLSX.utils.book_new();
    let index = 0;
    for (const sheet of engine.sheets()) {
      if (opts.skipSheet?.(sheet.name)) continue;
      const ws: XLSX.WorkSheet = {};
      const used = engine.usedRange(sheet.index);
      for (let row = 1; row <= used.rows; row++) {
        for (let col = 1; col <= used.cols; col++) {
          const input = opts.formulaFor?.(sheet.index, row, col) ?? engine.getInput(sheet.index, row, col);
          if (input === "") continue;
          const value = engine.getValue(sheet.index, row, col);
          const cell: XLSX.CellObject =
            value === null
              ? { t: "s", v: "" }
              : typeof value === "number"
                ? { t: "n", v: value }
                : typeof value === "boolean"
                  ? { t: "b", v: value }
                  : typeof value === "string"
                    ? { t: "s", v: value }
                    : { t: "e", v: 0, w: value.error };
          if (input.startsWith("=")) cell.f = input.slice(1);
          const fmt = numFmt(engine, sheet.index, row, col);
          if (fmt) cell.z = fmt;
          ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })] = cell;
        }
      }
      ws["!ref"] = used.rows && used.cols ? XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: used.rows - 1, c: used.cols - 1 } }) : "A1";
      const defaultW = engine.colWidth(sheet.index, 16_384);
      ws["!cols"] = Array.from({ length: used.cols }, (_, i) => {
        const px = engine.colWidth(sheet.index, i + 1);
        return px === defaultW ? {} : { wpx: px };
      });
      XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      if (sheet.hidden) {
        wb.Workbook ??= { Sheets: [] };
        wb.Workbook.Sheets ??= [];
        wb.Workbook.Sheets[index] = { Hidden: 1 };
      }
      index++;
    }
    return XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as Uint8Array;
  },
};

function numFmt(engine: Engine, sheet: number, row: number, col: number): string | undefined {
  if (!(engine instanceof IronCalcEngine)) return undefined;
  const fmt = engine.raw.getCellStyle(sheet, row, col).style.num_fmt;
  return fmt && fmt.toLowerCase() !== "general" ? fmt : undefined;
}
