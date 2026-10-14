import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { closeParens, cycleLock, formatRef, referenceAt, shiftFormula, tile } from "../src/engine/formula";
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

describe("closeParens", () => {
  it("closes what's open, ignoring strings", () => {
    expect(closeParens("=AVERAGE(A1")).toBe("=AVERAGE(A1)");
    expect(closeParens("=IF(A1>0,SUM(B1:B2")).toBe("=IF(A1>0,SUM(B1:B2))");
    expect(closeParens('=CONCAT("(",A1')).toBe('=CONCAT("(",A1)');
    expect(closeParens("=SUM(A1)")).toBe("=SUM(A1)");
    expect(closeParens("not (a formula")).toBe("not (a formula");
  });
});

describe("function completion", () => {
  it("finds the partial name at the cursor", () => {
    expect(e.functionCompletion(0, 1, 1, "=", 1)).toEqual({ prefix: "", from: 1 });
    expect(e.functionCompletion(0, 1, 1, "=aver", 5)).toEqual({ prefix: "aver", from: 1 });
    expect(e.functionCompletion(0, 1, 1, "=SUM(A1:B2)+av", 14)).toEqual({ prefix: "av", from: 12 });
    expect(e.functionCompletion(0, 1, 1, "=AVERAGE(A1", 11)).toBeNull();
    expect(e.functionCompletion(0, 1, 1, "hello", 5)).toBeNull();
  });

  it("lists the engine's built-in functions", () => {
    const names = e.builtinFunctions();
    expect(names).toContain("AVERAGE");
    expect(names).toContain("XLOOKUP");
    expect(names.filter((n) => n.startsWith("AVER"))).toEqual(["AVERAGE", "AVERAGEA", "AVERAGEIF", "AVERAGEIFS"]);
    // spot-check that the generated list matches the installed engine
    for (const n of names.slice(0, 40)) expect(e.isBuiltinFunction(n)).toBe(true);
  });
});

describe("reference helpers", () => {
  it("formats pointed-at ranges", () => {
    expect(formatRef(2, 1, 2, 1)).toBe("A2");
    expect(formatRef(5, 3, 2, 1)).toBe("A2:C5");
    expect(formatRef(1, 1, 3, 2, 1)).toBe("$A$1:$B$3");
    expect(formatRef(1, 1, 1, 1, 2)).toBe("A$1");
    expect(formatRef(1, 1, 1, 1, 3)).toBe("$A1");
  });

  it("cycles locks like F4", () => {
    const seen = ["A1"];
    for (let i = 0; i < 4; i++) seen.push(cycleLock(seen[i]!));
    expect(seen).toEqual(["A1", "$A$1", "A$1", "$A1", "A1"]);
    expect(cycleLock("A1:B2")).toBe("$A$1:$B$2");
    expect(cycleLock("Data!$A$1:$B$2")).toBe("Data!A$1:B$2");
    expect(cycleLock("A:A")).toBe("$A:$A");
  });

  it("finds the reference at the caret", () => {
    expect(referenceAt(e, "=SUM(A1:B2)+C3", 7)).toEqual({ from: 5, to: 10 });
    expect(referenceAt(e, "=SUM(A1:B2)+C3", 14)).toEqual({ from: 12, to: 14 });
    expect(referenceAt(e, "=SUM(1)", 6)).toBeNull();
    expect(referenceAt(e, "A1", 2)).toBeNull();
  });
});
