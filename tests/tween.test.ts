import { describe, expect, it } from "vitest";
import { RectTween } from "../src/grid/tween";

const A = { x1: 0, y1: 0, x2: 90, y2: 25 };
const B = { x1: 90, y1: 0, x2: 180, y2: 25 };

describe("RectTween", () => {
  it("appears in place first, then slides to a new target with ease-out", () => {
    const t = new RectTween(100);
    expect(t.at(A, 0)).toEqual({ rect: A, moving: false });
    const mid = t.at(B, 1000);
    expect(mid).toEqual({ rect: A, moving: true });
    const half = t.at(B, 1050).rect.x1;
    expect(half).toBeGreaterThan(45); // ease-out: past halfway at half time
    expect(half).toBeLessThan(90);
    expect(t.at(B, 1100)).toEqual({ rect: B, moving: false });
  });

  it("retargets from the current position", () => {
    const t = new RectTween(100);
    t.at(A, 0);
    t.at(B, 0);
    const x = t.at(B, 50).rect.x1;
    const back = t.at(A, 50);
    expect(back.rect.x1).toBeCloseTo(x);
    expect(back.moving).toBe(true);
  });

  it("jumps when not animating, but finishes a slide already under way", () => {
    const t = new RectTween(100);
    t.at(A, 0);
    t.at(B, 0);
    expect(t.at(B, 50, false).moving).toBe(true);
    expect(t.at(A, 60, false)).toEqual({ rect: A, moving: false });
  });
});
