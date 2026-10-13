import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadPyodide, type PyodideAPI } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { IronCalcEngine, loadIronCalc } from "../src/engine/ironcalc";
import { apply, query } from "../src/python/ops";
import { PYODIDE_VERSION } from "../src/python/protocol";
import { cleanTraceback } from "../src/python/traceback";

const require = createRequire(import.meta.url);
let py: PyodideAPI;
let engine: IronCalcEngine;
let active = 0;
const events: { functions: string[][]; edits: string[][] } = { functions: [], edits: [] };

beforeAll(async () => {
  await loadIronCalc(readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")));
  py = await loadPyodide();
  // In the browser this bridge goes through the worker channel; here it calls the ops directly.
  py.registerJsModule("_adder_bridge", {
    sync: (op: string, args: string) => JSON.stringify(query(engine, () => active, op, JSON.parse(args)) ?? null),
    post: (op: string, args: string) =>
      apply(
        engine,
        {
          functions: (n) => events.functions.push(n),
          editHandlers: (r) => events.edits.push(r),
          transformInput: (_s, _r, _c, input) => input.replace(/MARGIN\(/g, "0+("),
        },
        op,
        JSON.parse(args),
      ),
  });
  py.FS.writeFile("/home/pyodide/adder.py", readFileSync(new URL("../src/python/adder.py", import.meta.url), "utf8"));
}, 60_000);

function run(code: string): unknown {
  engine ??= IronCalcEngine.create();
  try {
    const out = py.runPython(code, { globals: py.globals.get("dict")() });
    return out?.toJs ? out.toJs() : out;
  } finally {
    py.runPython("import adder; adder.flush()");
  }
}

describe("adder Python module", () => {
  it("pins the pyodide version used for the CDN", () => {
    expect(PYODIDE_VERSION).toBe(require("pyodide/package.json").version);
  });

  it("writes and reads cells and ranges", () => {
    engine = IronCalcEngine.create();
    run(`
import adder
ws = adder.sheet("Sheet1")
ws["A1"].value = 42
ws["A2"].value = 1.5
ws["A3"].value = "=SUM(A1:A2)"
ws["B1"].value = "007"
ws.range("C1").values = [[True, None], ["x", 3]]
`);
    expect(engine.getDisplay(0, 3, 1)).toBe("43.5");
    expect(engine.getValue(0, 1, 2)).toBe("007");
    expect(engine.getValue(0, 1, 3)).toBe(true);
    expect(engine.getValue(0, 2, 4)).toBe(3);
    expect(
      run(`
import adder
adder.sheet(0).range("A1:B3").values == [[42, "007"], [1.5, None], [43.5, None]]`),
    ).toBe(true);
    expect(run(`import adder; adder.range("Sheet1!A3").formula`)).toBe("=SUM(A1:A2)");
  });

  it("coalesces single-cell writes into one undo step", () => {
    engine = IronCalcEngine.create();
    run(`
import adder
ws = adder.active()
for i in range(1, 1001):
    ws.cell(i, 1).value = i
    ws.cell(i, 2).value = i * 2
`);
    expect(engine.getValue(0, 1000, 2)).toBe(2000);
    engine.undo();
    expect(engine.getValue(0, 1000, 2)).toBe(null);
    expect(engine.canUndo()).toBe(false);
  });

  it("reads after writes see the new values (writes flush first)", () => {
    engine = IronCalcEngine.create();
    expect(
      run(`
import adder
ws = adder.active()
ws["A1"].value = 2
ws["A2"].value = "=A1*21"
ws["A2"].value`),
    ).toBe(42);
  });

  it("reports errors, whole columns, sheets and bad references", () => {
    engine = IronCalcEngine.create();
    expect(
      run(`
import adder
ws = adder.active()
ws["A1"].values = [1, 2, 3]
ws["B1"].value = "=1/0"
s2 = adder.add_sheet("Out")
s2["A1"].value = "hi"
(len(ws.range("A:A").values), ws["B1"].value, repr(ws["B1"].value), [s.name for s in adder.sheets()])`),
    ).toEqual([3, "#DIV/0!", "CellError('#DIV/0!')", ["Sheet1", "Out"]]);
    expect(() => run(`import adder; adder.sheet("Nope")`)).toThrow(/No sheet named 'Nope'/);
    expect(() => run(`import adder; adder.active()["A0"]`)).toThrow(/1-based/);
  });

  it("registers custom functions and edit handlers", () => {
    engine = IronCalcEngine.create();
    run(`
import adder
@adder.function
def double(x):
    return x * 2

@adder.on_edit("Sheet1!B:B")
def log(event):
    pass
`);
    expect(events.functions.at(-1)).toEqual(["DOUBLE"]);
    expect(events.edits.at(-1)).toEqual(["Sheet1!B:B"]);
  });
});

describe("custom function and edit dispatch", () => {
  it("invokes functions with values and ranges, converting results to inputs", () => {
    engine = IronCalcEngine.create();
    run(`
import adder
@adder.function
def total(rows):
    return sum(v for row in rows for v in row if isinstance(v, (int, float)))

@adder.function(name="greet")
def _greet(name):
    return "=hi " + name

@adder.function
def pair():
    return [1, 2]
`);
    expect(run(`import adder; adder._invoke("TOTAL", '[[[1, 2], [3, null]]]')`)).toBe("6");
    expect(run(`import adder; adder._invoke("GREET", '["bob"]')`)).toBe("'=hi bob");
    expect(() => run(`import adder; adder._invoke("PAIR", "[]")`)).toThrow(/single value/);
    expect(() => run(`import adder; adder._invoke("NOPE", "[]")`)).toThrow(/isn't registered/);
  });

  it("dispatches edit events to matching handlers, which can write cells", () => {
    engine = IronCalcEngine.create();
    run(`
import adder
@adder.on_edit("Sheet1!B:B")
def stamp(event):
    event.range.offset(cols=1).value = f"edited {event.range.address} -> {event.value}"
`);
    run(`import adder; adder._dispatch_edit("Sheet1!B:B", '{"sheet": "Sheet1", "sheetIndex": 0, "row": 3, "col": 2, "rows": 1, "cols": 1, "values": [[7]]}')`);
    expect(engine.getValue(0, 3, 3)).toBe("edited B3 -> 7");
  });
});

describe("script-written formulas", () => {
  it("pass through the input transform (custom functions)", () => {
    engine = IronCalcEngine.create();
    run(`
import adder
ws = adder.active()
ws["A1"].value = 3
ws["B1"].value = "=MARGIN(A1)*2"
ws["C1"].value = "MARGIN( stays text"
`);
    expect(engine.getInput(0, 1, 2)).not.toContain("MARGIN"); // rewritten by the transform
    expect(engine.getValue(0, 1, 2)).toBe(6);
    expect(engine.getValue(0, 1, 3)).toBe("MARGIN( stays text");
  });
});

describe("cleanTraceback", () => {
  it("drops pyodide internal frames", () => {
    const tb = [
      "Traceback (most recent call last):",
      '  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async',
      "    await CodeRunner(",
      "    ...<10 lines>...",
      "    .run_async(globals, locals)",
      '  File "<script>", line 2, in <module>',
      "ZeroDivisionError: division by zero",
    ].join("\n");
    expect(cleanTraceback(tb)).toBe('Traceback (most recent call last):\n  File "<script>", line 2, in <module>\nZeroDivisionError: division by zero');
  });
});
