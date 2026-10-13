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
});
