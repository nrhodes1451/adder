/** A rectangle in sheet pixels (offsets from the first row/column, excluding headers). */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Slides a rectangle towards its latest target with a short ease-out, like
 * Excel's animated cell cursor. Call `at` once per frame; it reports whether
 * another frame is needed.
 */
export class RectTween {
  private from: Rect | null = null;
  private to: Rect | null = null;
  private start = 0;

  constructor(private duration = 90) {}

  /**
   * Current rectangle for `target` at time `now` (ms), plus whether the motion
   * is still running. With `animate` false a new target is jumped to rather
   * than slid to.
   */
  at(target: Rect, now: number, animate = true): { rect: Rect; moving: boolean } {
    if (!this.to || (!animate && !same(target, this.to))) {
      this.from = this.to = target;
      return { rect: target, moving: false };
    }
    if (!same(target, this.to)) {
      // Retarget from wherever the motion is now, so fast key repeats stay smooth.
      this.from = this.at(this.to, now).rect;
      this.to = target;
      this.start = now;
    }
    const t = Math.min(1, (now - this.start) / this.duration);
    if (t >= 1) {
      this.from = target;
      return { rect: target, moving: false };
    }
    const k = 1 - (1 - t) ** 3; // ease-out cubic
    const f = this.from!;
    const lerp = (a: number, b: number) => a + (b - a) * k;
    return { rect: { x1: lerp(f.x1, target.x1), y1: lerp(f.y1, target.y1), x2: lerp(f.x2, target.x2), y2: lerp(f.y2, target.y2) }, moving: true };
  }

  /** Forget the last position, so the next target appears without motion. */
  reset(): void {
    this.from = this.to = null;
  }
}

function same(a: Rect, b: Rect): boolean {
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}
