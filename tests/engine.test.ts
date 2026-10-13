import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { IronCalcEngine, loadIronCalc } from "../src/engine/ironcalc";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  await loadIronCalc(readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")));
});

describe("IronCalcEngine", () => {
  it("evaluates SUM", () => {
    const e = IronCalcEngine.create();
    e.setInput(0, 1, 1, "1");
    e.setInput(0, 2, 1, "2");
    e.setInput(0, 3, 1, "3");
    e.setInput(0, 4, 1, "=SUM(A1:A3)");
    expect(e.getDisplay(0, 4, 1)).toBe("6");
    expect(e.getInput(0, 4, 1)).toBe("=SUM(A1:A3)");
    expect(e.getValue(0, 4, 1)).toBe(6);
  });

  it("reports kinds and values", () => {
    const e = IronCalcEngine.create();
    e.setRange(0, 1, 1, [["0.12", "hi", "TRUE", "=1/0", ""]]);
    expect(e.getRangeValues({ sheet: 0, row: 1, col: 1, rows: 1, cols: 5 })).toEqual([
      [0.12, "hi", true, { error: "#DIV/0!" }, null],
    ]);
  });

  it("batch writes are a single undo step and preserve tricky text", () => {
    const e = IronCalcEngine.create();
    const data = Array.from({ length: 100 }, (_, r) => Array.from({ length: 10 }, (_, c) => String(r * 10 + c)));
    data[0]![0] = 'tab\there "quoted"\nnewline';
    e.setRange(0, 1, 1, data);
    expect(e.getInput(0, 1, 1)).toBe('tab\there "quoted"\nnewline');
    expect(e.getValue(0, 100, 10)).toBe(999);
    e.undo();
    expect(e.getValue(0, 100, 10)).toBe(null);
    expect(e.canUndo()).toBe(false);
  });

  it("supports multiple sheets and cross-sheet refs", () => {
    const e = IronCalcEngine.create();
    const s = e.addSheet("Data");
    expect(e.sheets().map((x) => x.name)).toEqual(["Sheet1", "Data"]);
    e.setInput(0, 1, 1, "4");
    e.setInput(s, 1, 1, "=Sheet1!A1*10");
    expect(e.getDisplay(s, 1, 1)).toBe("40");
  });

  it("round-trips through bytes", () => {
    const e = IronCalcEngine.create();
    e.setInput(0, 2, 2, "=21*2");
    const e2 = IronCalcEngine.fromBytes(e.serialize());
    expect(e2.getDisplay(0, 2, 2)).toBe("42");
  });

  it("finds used range and block edges", () => {
    const e = IronCalcEngine.create();
    e.setRange(0, 3, 2, [["a"], ["b"], ["c"]]);
    e.setInput(0, 10, 2, "z");
    e.setInput(0, 1, 5, "far");
    expect(e.usedRange(0)).toEqual({ rows: 10, cols: 5 });
    expect(e.edge(0, 1, 2, "down")).toEqual({ row: 3, col: 2 });
    expect(e.edge(0, 3, 2, "down")).toEqual({ row: 5, col: 2 });
    expect(e.edge(0, 5, 2, "down")).toEqual({ row: 10, col: 2 });
    expect(e.edge(0, 10, 2, "down")).toEqual({ row: 1_048_576, col: 2 });
    expect(e.edge(0, 10, 2, "up")).toEqual({ row: 5, col: 2 });
  });

  it("copies and pastes internally keeping formulas relative", () => {
    const e = IronCalcEngine.create();
    e.setInput(0, 1, 1, "2");
    e.setInput(0, 1, 2, "=A1*2");
    const clip = e.copy({ sheet: 0, row: 1, col: 1, rows: 1, cols: 2 });
    expect(clip.tsv).toBe("2\t4");
    e.paste({ sheet: 0, row: 5, col: 1, rows: 1, cols: 1 }, clip, false);
    expect(e.getInput(0, 5, 2)).toBe("=A5*2");
  });

  it("emits change events with source", () => {
    const e = IronCalcEngine.create();
    const seen: string[] = [];
    e.onChange((ev) => seen.push(ev.kind === "cells" ? ev.source : ev.kind));
    e.setInput(0, 1, 1, "1");
    e.setRange(0, 1, 1, [["2"]]);
    e.undo();
    expect(seen).toEqual(["user", "script", "all"]);
  });

  it("system writes and hidden sheets stay out of undo history", () => {
    const e = IronCalcEngine.create();
    e.renameSheet(0, "Sheet3"); // the scratch model must not pick a clashing name
    e.addSheet("Data");
    const shadow = e.ensureSheet("__adder", true);
    expect(e.ensureSheet("__adder", true)).toBe(shadow);
    expect(e.sheets()[shadow]).toMatchObject({ name: "__adder", hidden: true });
    e.setInput(0, 1, 1, "=__adder!$A$1*2");
    e.setSystemInputs([{ sheet: shadow, row: 1, col: 1, input: "21" }]);
    expect(e.getDisplay(0, 1, 1)).toBe("42");
    e.setSystemInputs([{ sheet: shadow, row: 1, col: 1, input: "5" }]);
    expect(e.getDisplay(0, 1, 1)).toBe("10");
    e.undo(); // undoes the user's formula, not the system writes
    expect(e.getInput(0, 1, 1)).toBe("");
    expect(e.getDisplay(shadow, 1, 1)).toBe("5");
    const e2 = IronCalcEngine.fromBytes(e.serialize());
    expect(e2.getDisplay(shadow, 1, 1)).toBe("5");
  });

  it("tokenizes formulas and recognises builtins", () => {
    const e = IronCalcEngine.create();
    const t = e.tokenize("DOUBLE(A1, 'My Sheet'!B2:C3)");
    expect(t.map((x) => x.kind)).toEqual(["ident", "lparen", "ref", "comma", "range", "rparen"]);
    expect(t[4]).toMatchObject({ sheet: "My Sheet", r1: 2, c1: 2, r2: 3, c2: 3 });
    expect(t[2]).toMatchObject({ sheet: null, r1: 1, c1: 1 });
    expect(e.tokenize("A1:B2")[0]).toMatchObject({ kind: "range", sheet: null });
    expect(e.isBuiltinFunction("sum")).toBe(true);
    expect(e.isBuiltinFunction("TEXTJOIN")).toBe(true);
    expect(e.isBuiltinFunction("double")).toBe(false);
  });

  it("inserts rows and columns as single undo steps, adjusting formulas", () => {
    const e = IronCalcEngine.create();
    e.setRange(0, 1, 1, [["1", "=A1*2"], ["3", "=SUM(A1:A2)"]]);
    e.insertRows(0, 2, 2);
    expect(e.getInput(0, 4, 2)).toBe("=SUM(A1:A4)");
    expect(e.getValue(0, 4, 1)).toBe(3);
    expect(e.usedRange(0)).toEqual({ rows: 4, cols: 2 });
    e.insertCols(0, 1, 1);
    expect(e.getInput(0, 1, 3)).toBe("=B1*2");
    e.undo();
    expect(e.getInput(0, 1, 2)).toBe("=A1*2");
    e.undo();
    expect(e.getInput(0, 2, 2)).toBe("=SUM(A1:A2)");
  });
});
