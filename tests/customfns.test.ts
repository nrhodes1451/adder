import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { IronCalcEngine, loadIronCalc } from "../src/engine/ironcalc";
import { CustomFunctions, type CustomState, emptyCustomState, SHADOW_SHEET } from "../src/python/customfns";

const require = createRequire(import.meta.url);
beforeAll(async () => {
  await loadIronCalc(readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")));
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

type Impl = (...args: unknown[]) => unknown;

function setup(impls: Record<string, Impl>, state: CustomState = emptyCustomState(), engine = IronCalcEngine.create()) {
  const calls: { name: string; args: unknown[] }[] = [];
  const logs: string[] = [];
  const cf = new CustomFunctions(
    engine,
    {
      async call(name, args) {
        calls.push({ name, args });
        try {
          const v = impls[name]!(...args);
          return { value: typeof v === "string" ? `'${v}` : String(v) };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },
    state,
    () => {},
    (t) => logs.push(t),
  );
  cf.setRegistered(Object.keys(impls));
  // What the grid does on commit:
  const type = (sheet: number, row: number, col: number, input: string) => engine.setInput(sheet, row, col, cf.toEngine(sheet, row, col, input));
  return { engine, cf, calls, logs, type, state };
}

describe("custom functions", () => {
  it("evaluates, recalculates on input change, and feeds dependents", async () => {
    const { engine, cf, calls, type } = setup({ DOUBLE: (x) => (x as number) * 2 });
    type(0, 1, 1, "5");
    type(0, 1, 2, "=DOUBLE(A1)+1");
    type(0, 1, 3, "=B1*10");
    await settle();
    expect(engine.getDisplay(0, 1, 2)).toBe("11");
    expect(engine.getDisplay(0, 1, 3)).toBe("110");
    expect(cf.toUser(0, 1, 2, engine.getInput(0, 1, 2))).toBe("=DOUBLE(A1)+1");
    expect(calls).toHaveLength(1);

    type(0, 1, 1, "7");
    await settle();
    expect(engine.getDisplay(0, 1, 2)).toBe("15");
    expect(calls).toHaveLength(2);

    type(0, 5, 5, "unrelated");
    await settle();
    expect(calls).toHaveLength(2); // args unchanged: no call
    expect(engine.sheets().find((s) => s.name === SHADOW_SHEET)?.hidden).toBe(true);
  });

  it("passes ranges as 2D lists and handles nested calls", async () => {
    const { engine, calls, type } = setup({
      TOTAL: (rows) => (rows as number[][]).flat().reduce((a, b) => a + b, 0),
      DOUBLE: (x) => (x as number) * 2,
    });
    engine.setRange(0, 1, 1, [["1", "2"], ["3", "4"]]);
    type(0, 5, 1, "=DOUBLE(TOTAL(A1:B2))");
    await settle();
    expect(engine.getDisplay(0, 5, 1)).toBe("20");
    expect(calls.map((c) => c.name)).toEqual(["TOTAL", "DOUBLE"]); // DOUBLE waited for TOTAL
    expect(calls[0]!.args).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
    ]);
    engine.setInput(0, 2, 2, "40");
    await settle();
    expect(engine.getDisplay(0, 5, 1)).toBe("92"); // (1 + 2 + 3 + 40) * 2
  });

  it("reports errors as #VALUE! and logs them", async () => {
    const { engine, logs, type } = setup({
      BOOM: () => {
        throw new Error("nope");
      },
    });
    type(0, 1, 1, "=BOOM()");
    await settle();
    expect(engine.getDisplay(0, 1, 1)).toBe("#VALUE!");
    expect(logs.join("\n")).toContain("Error in BOOM");
  });

  it("works with undo and keeps results across reloads", async () => {
    const { engine, cf, type, state } = setup({ DOUBLE: (x) => (x as number) * 2 });
    type(0, 1, 1, "4");
    type(0, 2, 1, "=DOUBLE(A1)");
    await settle();
    expect(engine.getDisplay(0, 2, 1)).toBe("8");
    engine.undo(); // undoes the formula itself, not the computed result
    expect(engine.getInput(0, 2, 1)).toBe("");
    engine.redo();
    expect(cf.toUser(0, 2, 1, engine.getInput(0, 2, 1))).toBe("=DOUBLE(A1)");
    await settle();

    const reloaded = IronCalcEngine.fromBytes(engine.serialize());
    expect(reloaded.getDisplay(0, 2, 1)).toBe("8");
    // New session without the function registered: stored results stay until inputs change.
    const logs: string[] = [];
    new CustomFunctions(reloaded, { call: async () => ({ value: "0" }) }, structuredClone(state), () => {}, (t) => logs.push(t));
    await settle();
    expect(reloaded.getDisplay(0, 2, 1)).toBe("8");
    reloaded.setInput(0, 1, 1, "5");
    await settle();
    expect(reloaded.getDisplay(0, 2, 1)).toBe("#NAME?");
    expect(logs[0]).toContain("isn't registered");
  });

  it("adopts cells typed before registration and refuses to shadow builtins", async () => {
    const engine = IronCalcEngine.create();
    engine.setInput(0, 1, 1, "3");
    engine.setInput(0, 1, 2, "=triple(A1)");
    expect(engine.getDisplay(0, 1, 2)).toBe("#NAME?");
    const { logs } = setup({ TRIPLE: (x) => (x as number) * 3, SUM: () => 0 }, emptyCustomState(), engine);
    await settle();
    expect(engine.getDisplay(0, 1, 2)).toBe("9");
    expect(logs.join()).toContain("Not registering SUM");
  });

  it("qualifies references to the formula's own sheet", async () => {
    const engine = IronCalcEngine.create();
    const data = engine.addSheet("My Data");
    engine.setInput(data, 1, 1, "21");
    const { type } = setup({ DOUBLE: (x) => (x as number) * 2 }, emptyCustomState(), engine);
    type(data, 2, 1, "=DOUBLE(A1)");
    await settle();
    expect(engine.getDisplay(data, 2, 1)).toBe("42");
  });
});
