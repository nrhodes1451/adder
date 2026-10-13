import { describe, expect, it } from "vitest";
import { matchingRefs, parseRef } from "../src/python/edits";

const sheets = [
  { index: 0, name: "Sheet1", hidden: false },
  { index: 1, name: "My Data", hidden: false },
];
const cell = (sheet: number, row: number, col: number) => ({ sheet, row, col, rows: 1, cols: 1 });

describe("on_edit refs", () => {
  it("parses refs", () => {
    expect(parseRef("Sheet1!B:B")).toEqual({ sheet: "Sheet1", r1: 1, r2: 1_048_576, c1: 2, c2: 2 });
    expect(parseRef("'My Data'!$A$1:C3")).toEqual({ sheet: "My Data", r1: 1, r2: 3, c1: 1, c2: 3 });
    expect(parseRef("2:5")).toMatchObject({ r1: 2, r2: 5, c1: 1, c2: 16_384 });
    expect(parseRef("B")).toBeNull();
    expect(parseRef("nonsense!!")).toBeNull();
  });

  it("matches edits that intersect", () => {
    const refs = ["Sheet1!B:B", "'My Data'!A1:C3", "D4"];
    expect(matchingRefs(refs, sheets, cell(0, 100, 2))).toEqual(["Sheet1!B:B"]);
    expect(matchingRefs(refs, sheets, cell(0, 1, 1))).toEqual([]);
    expect(matchingRefs(refs, sheets, cell(1, 3, 3))).toEqual(["'My Data'!A1:C3"]);
    expect(matchingRefs(refs, sheets, cell(1, 4, 4))).toEqual(["D4"]);
    expect(matchingRefs(refs, sheets, { sheet: 0, row: 1, col: 1, rows: 10, cols: 3 })).toEqual(["Sheet1!B:B"]);
  });
});
