import type { IronCalcEngine } from "../engine/ironcalc";
import type { Engine } from "../engine/types";
import { parseCsv, toCsv } from "./csv";
import type { ExportOptions } from "./xlsx";

// SheetJS is large; load it only when a file is imported or exported.
const codec = () => import("./xlsx").then((m) => m.sheetjsCodec);

export async function readXlsx(file: File): Promise<IronCalcEngine> {
  return (await codec()).read(new Uint8Array(await file.arrayBuffer()));
}

export async function xlsxBlob(engine: Engine, opts?: ExportOptions): Promise<Blob> {
  const bytes = (await codec()).write(engine, opts);
  return new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** Files the importer accepts (the file picker and drag-and-drop). */
export const IMPORTABLE = /\.(xlsx|csv|tsv|txt)$/i;

/** An .xlsx opens as a new workbook; anything else is read as CSV into a new sheet of `engine`. */
export async function importFile(engine: Engine, file: File): Promise<{ engine: IronCalcEngine } | { sheet: number }> {
  if (/\.xlsx$/i.test(file.name)) return { engine: await readXlsx(file) };
  return { sheet: importCsv(engine, await file.text(), baseName(file.name)) };
}

/** Import CSV text into a new sheet; returns its index. */
export function importCsv(engine: Engine, text: string, name: string): number {
  const rows = parseCsv(text);
  const sheet = engine.addSheet(uniqueSheetName(engine, name));
  if (rows.length) engine.setRange(sheet, 1, 1, rows, "user");
  return sheet;
}

/** CSV of a sheet's used range, as displayed (like Excel's CSV export). */
export function exportCsv(engine: Engine, sheet: number): string {
  const { rows, cols } = engine.usedRange(sheet);
  const out: string[][] = [];
  for (let r = 1; r <= rows; r++) {
    const row: string[] = Array<string>(cols).fill("");
    for (const c of engine.contentColumns(sheet, r)) if (c <= cols) row[c - 1] = engine.getDisplay(sheet, r, c);
    out.push(row);
  }
  return toCsv(out);
}

export function uniqueSheetName(engine: Engine, base: string): string {
  const clean = base.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet";
  const taken = new Set(engine.sheets().map((s) => s.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) {
    const name = `${clean.slice(0, 27)} (${i})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}
