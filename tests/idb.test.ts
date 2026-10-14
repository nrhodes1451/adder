import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { deleteWorkbook, listWorkbooks, loadWorkbook, saveWorkbook } from "../src/io/idb";

describe("idb store", () => {
  it("saves, lists newest first, loads and deletes", async () => {
    const meta = { scripts: [{ name: "main.py", code: "print(1)" }] };
    await saveWorkbook({ id: "a", name: "A", bytes: new Uint8Array([1, 2]), meta, updatedAt: 1 });
    await saveWorkbook({ id: "b", name: "B", bytes: new Uint8Array([3]), meta, updatedAt: 2 });
    expect((await listWorkbooks()).map((w) => w.id)).toEqual(["b", "a"]);
    const a = await loadWorkbook("a");
    expect(Array.from(a!.bytes)).toEqual([1, 2]);
    expect(a!.meta.scripts[0]!.code).toBe("print(1)");
    await deleteWorkbook("a");
    expect(await loadWorkbook("a")).toBeUndefined();
  });

  it("round-trips charts in meta", async () => {
    const chart = {
      id: "c1",
      sheet: "Sheet1",
      range: { row: 1, col: 1, rows: 3, cols: 2 },
      type: "bar" as const,
      anchor: { row: 1, col: 4, dx: 3, dy: 0 },
      width: 480,
      height: 300,
    };
    await saveWorkbook({ id: "c", name: "C", bytes: new Uint8Array(), meta: { scripts: [], charts: [chart] }, updatedAt: 3 });
    expect((await loadWorkbook("c"))!.meta.charts).toEqual([chart]);
    await deleteWorkbook("c");
    expect(await loadWorkbook("a")).toBeUndefined();
  });
});
