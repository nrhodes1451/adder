import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { IronCalcEngine, loadIronCalc } from "../src/engine/ironcalc";
import { sheetjsCodec } from "../src/io/xlsx";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  await loadIronCalc(readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")));
});

/** A small workbook that looks like what Excel writes. */
function fixture(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {
    A1: { t: "s", v: "Item" },
    B1: { t: "s", v: "Price" },
    A2: { t: "s", v: "Apple" },
    B2: { t: "n", v: 1.25, z: "$#,##0.00" },
    A3: { t: "s", v: "007" },
    B3: { t: "n", v: 2 },
    A4: { t: "s", v: "Total" },
    B4: { t: "n", v: 3.25, f: "SUM(B2:B3)" },
    C4: { t: "b", v: true },
    "!ref": "A1:C4",
    "!cols": [{ wch: 20 }],
  };
  XLSX.utils.book_append_sheet(wb, ws, "Prices");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[null]]), "Summary");
  wb.Sheets.Summary!.A1 = { t: "n", v: 32.5, f: "Prices!B4*10" };
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

describe("sheetjs xlsx codec", () => {
  it("imports values, formulas, formats, widths and sheets", () => {
    const e = sheetjsCodec.read(fixture());
    expect(e.sheets().map((s) => s.name)).toEqual(["Prices", "Summary"]);
    expect(e.getInput(0, 4, 2)).toBe("=SUM(B2:B3)");
    expect(e.getDisplay(0, 2, 2)).toBe("$1.25");
    expect(e.getValue(0, 3, 1)).toBe("007"); // text that looks numeric stays text
    expect(e.getValue(0, 4, 3)).toBe(true);
    expect(e.getValue(1, 1, 1)).toBe(32.5); // display inherits B2's currency format, like Excel
    expect(e.colWidth(0, 1)).toBe(125); // 20 chars at SheetJS's 6px max digit width
    expect(e.canUndo()).toBe(false);
  });

  it("round-trips formulas and number formats through export", () => {
    const e = sheetjsCodec.read(fixture());
    e.setInput(0, 2, 2, "10");
    const out = XLSX.read(sheetjsCodec.write(e), { type: "array", cellFormula: true, cellNF: true });
    const prices = out.Sheets.Prices!;
    expect(prices.B4!.f).toBe("SUM(B2:B3)");
    expect(prices.B4!.v).toBe(12);
    expect(prices.B2!.z).toBe("$#,##0.00");
    expect(prices.A3!.t).toBe("s");
    expect(out.Sheets.Summary!.A1!.f).toBe("Prices!B4*10");

    const again = sheetjsCodec.read(sheetjsCodec.write(e));
    expect(again.getValue(1, 1, 1)).toBe(120);
    expect(again.colWidth(0, 1)).toBe(e.colWidth(0, 1));
  });

  it("can override formulas on export", () => {
    const e = IronCalcEngine.create();
    e.setInput(0, 1, 1, "=__adder!B1");
    const out = XLSX.read(sheetjsCodec.write(e, { formulaFor: (s, r, c) => (s === 0 && r === 1 && c === 1 ? "=DOUBLE(2)" : undefined) }), {
      type: "array",
      cellFormula: true,
    });
    expect(out.Sheets.Sheet1!.A1!.f).toBe("DOUBLE(2)");
  });
});
