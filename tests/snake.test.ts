import { describe, expect, it } from "vitest";
import { canTurn, placeFood, start, START_SIZE, step, type Snake } from "../src/snake/game";

const first = () => 0;
const snake = (s: Partial<Snake>): Snake => ({ ...start(), ...s });

describe("snake", () => {
  it("starts with length 2, heading right on a 5×5 grid", () => {
    expect(start()).toEqual({ body: [{ x: 2, y: 2 }, { x: 1, y: 2 }], dir: "right", food: null, size: 5 });
  });

  it("starts with the tail behind the head whichever way it's heading", () => {
    expect(start("up").body).toEqual([{ x: 2, y: 2 }, { x: 2, y: 3 }]);
    expect(start("left").body).toEqual([{ x: 2, y: 2 }, { x: 3, y: 2 }]);
    expect(step(start("left")).result).toBe("move");
  });

  it("wraps off every edge to the opposite side", () => {
    const at = (x: number, y: number, dir: Snake["dir"]) => step(snake({ body: [{ x, y }], dir })).snake.body[0];
    expect(at(4, 2, "right")).toEqual({ x: 0, y: 2 });
    expect(at(0, 2, "left")).toEqual({ x: 4, y: 2 });
    expect(at(1, 0, "up")).toEqual({ x: 1, y: 4 });
    expect(at(1, 4, "down")).toEqual({ x: 1, y: 0 });
  });

  it("wraps at the edge of a bigger grid", () => {
    expect(step(snake({ body: [{ x: 5, y: 2 }], size: 6 })).snake.body[0]).toEqual({ x: 0, y: 2 });
    expect(step(snake({ body: [{ x: 4, y: 2 }], size: 6 })).snake.body[0]).toEqual({ x: 5, y: 2 });
  });

  it("loops left to right on its own", () => {
    let s = start();
    const xs = [];
    for (let i = 0; i < 6; i++) xs.push((s = step(s).snake).body[0]!.x);
    expect(xs).toEqual([3, 4, 0, 1, 2, 3]);
  });

  it("grows when it eats and places new food on a free cell", () => {
    const { snake: s, result } = step(snake({ body: [{ x: 4, y: 2 }], food: { x: 0, y: 2 } }), first);
    expect(result).toBe("eat");
    expect(s.body).toEqual([{ x: 0, y: 2 }, { x: 4, y: 2 }]);
    expect(s.food).toEqual({ x: 0, y: 0 });
  });

  it("stops where it is when it runs into itself", () => {
    const body = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 2 }];
    const before = snake({ body, dir: "down" });
    const { snake: s, result } = step(before);
    expect(result).toBe("crash");
    expect(s).toBe(before);
  });

  it("can follow its own tail into the cell the tail is leaving", () => {
    const body = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }];
    expect(step(snake({ body, dir: "down" })).result).toBe("move");
  });

  it("adds a row and a column when it fills the grid", () => {
    // Snake along every row in turn, head at (3,4) next to the last free cell.
    const path = [];
    for (let y = 0; y < START_SIZE; y++) for (let x = 0; x < START_SIZE; x++) path.push({ x: y % 2 ? START_SIZE - 1 - x : x, y });
    const food = path.pop()!;
    const { snake: s, result } = step(snake({ body: path.reverse(), food }), first);
    expect(result).toBe("expand");
    expect(s.size).toBe(6);
    expect(s.body).toHaveLength(25);
    expect(s.body[0]).toEqual({ x: 4, y: 4 });
    // The only free cells are the new column and row.
    expect(s.food).toEqual({ x: 5, y: 0 });
    expect(placeFood(s.body, 5)).toBeNull();
  });

  it("can't reverse into its neck unless it's only a head", () => {
    expect(canTurn("right", "left", 1)).toBe(true);
    expect(canTurn("right", "left", 2)).toBe(false);
    expect(canTurn("right", "up", 2)).toBe(true);
    expect(canTurn("right", "right", 1)).toBe(false);
  });
});
