import { describe, expect, it } from "vitest";
import { a1, Axis, colName, colNumber, selectionBounds } from "../src/grid/geometry";

describe("Axis", () => {
  it("handles uniform sizes", () => {
    const ax = new Axis(100_000, 20);
    expect(ax.offset(1)).toBe(0);
    expect(ax.offset(101)).toBe(2000);
    expect(ax.total()).toBe(2_000_000);
    expect(ax.indexAt(0)).toBe(1);
    expect(ax.indexAt(19.9)).toBe(1);
    expect(ax.indexAt(20)).toBe(2);
    expect(ax.indexAt(1e12)).toBe(100_000);
  });

  it("handles overrides", () => {
    const ax = new Axis(10, 10, [
      [3, 30],
      [5, 0],
      [7, 10],
    ]);
    expect(ax.size(3)).toBe(30);
    expect(ax.size(5)).toBe(0);
    expect(ax.size(4)).toBe(10);
    expect(ax.offset(4)).toBe(50);
    expect(ax.offset(6)).toBe(60);
    expect(ax.total()).toBe(110);
    expect(ax.indexAt(49)).toBe(3);
    expect(ax.indexAt(50)).toBe(4);
    // zero-size row 5 is never hit
    expect(ax.indexAt(60)).toBe(6);
  });
});

describe("addresses", () => {
  it("converts column names", () => {
    expect([1, 26, 27, 52, 702, 703, 16384].map(colName)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA", "XFD"]);
    expect(["A", "z", "AA", "XFD"].map(colNumber)).toEqual([1, 26, 27, 16384]);
    expect(a1(10, 3)).toBe("C10");
  });

  it("normalizes selections", () => {
    expect(selectionBounds({ anchor: { row: 5, col: 1 }, focus: { row: 2, col: 3 } })).toEqual({ r1: 2, c1: 1, r2: 5, c2: 3 });
  });
});
