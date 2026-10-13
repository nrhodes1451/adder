import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { shiftFormula, tile } from "../src/engine/formula";
import { IronCalcEngine, loadIronCalc } from "../src/engine/ironcalc";

const require = createRequire(import.meta.url);
let e: IronCalcEngine;
beforeAll(async () => {
  await loadIronCalc(readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")));
  e = IronCalcEngine.create();
});

describe("shiftFormula", () => {
  it("shifts relative parts and keeps anchored ones", () => {
    expect(shiftFormula(e, "=A1*2", 2, 1)).toBe("=B3*2");
    expect(shiftFormula(e, "=$A1+A$1+$A$1", 1, 1)).toBe("=$A2+B$1+$A$1");
    expect(shiftFormula(e, "=SUM(A1:B2)", 3, 0)).toBe("=SUM(A4:B5)");
    expect(shiftFormula(e, "='My Sheet'!C3+Data!A1", 1, 1)).toBe("='My Sheet'!D4+Data!B2");
    expect(shiftFormula(e, "=SUM(B:B)", 5, 1)).toBe("=SUM(C:C)");
    expect(shiftFormula(e, '="A1"&A1', 1, 0)).toBe('="A1"&A2');
    expect(shiftFormula(e, "=A1", -1, 0)).toBe("=#REF!");
    expect(shiftFormula(e, "plain A1", 1, 1)).toBe("plain A1");
  });

  it("tiles a source block over a target that is a multiple of its size", () => {
    expect(tile(e, [["=A1"]], { rows: 2, cols: 2 }, { dr: 0, dc: 0 })).toEqual([
      ["=A1", "=B1"],
      ["=A2", "=B2"],
    ]);
    // copied from B1, pasted at D5
    expect(tile(e, [["=A1"]], { rows: 2, cols: 1 }, { dr: 4, dc: 2 })).toEqual([["=C5"], ["=C6"]]);
    expect(tile(e, [["x", "y"]], { rows: 2, cols: 4 }, null)).toEqual([
      ["x", "y", "x", "y"],
      ["x", "y", "x", "y"],
    ]);
    expect(tile(e, [["x", "y"]], { rows: 2, cols: 3 }, null)).toBeNull();
  });
});
