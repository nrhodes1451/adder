// Loading screen / easter egg: the logo's snake on its 5×5 grid. It glides
// left to right on its own; WASD (or the arrow keys) takes over and "+" food
// appears. The pace quickens the longer a game lasts, filling the grid adds a
// row and a column, and a crash ends the game until the next key.
// Geometry and colours follow the README logo (temp/logo-anim/logo.js).
import "./snake.css";
import { canTurn, placeFood, start, START_SIZE, step, VEC, type Cell, type Dir, type Snake } from "./game";

const NS = "http://www.w3.org/2000/svg";
const PITCH = 100; // grid cell pitch
const CELL = 90; // snake cell size (gap of 10 between cells)
const R = 14; // corner radius
const SLOW = 340; // ms per grid step when idle and as a game starts...
const FAST = 120; // ...shrinking to this...
const HALVING = 45_000; // ...halving the gap every 45 s of play
const GLIDE = 0.74; // share of each step spent gliding; the rest is a beat on the cell
const INTRO = 700; // grid draws in, then the head pops in
const POP = 300;
const ZOOM = 450; // the grid making room for a new row and column
const REST = 350; // a crash ignores keys this long, so a mashed key doesn't skip the game over

const KEYS: Record<string, Dir> = {
  w: "up", a: "left", s: "down", d: "right",
  arrowup: "up", arrowleft: "left", arrowdown: "down", arrowright: "right",
};
const MODIFIERS = new Set(["shift", "control", "alt", "meta", "capslock", "tab"]);
const ANGLE: Record<Dir, number> = { right: 0, down: 90, left: 180, up: -90 };

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const backOut = (t: number, s = 2) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Shortest signed step from a to b on a wrapping line of `size` cells (-1, 0 or 1 for neighbours). */
const delta = (a: number, b: number, size: number) => ((((b - a + size / 2) % size) + size) % size) - size / 2;
/** The angle equivalent to `deg` closest to `prev`, so rotations take the short way. */
const unwrap = (deg: number, prev: number) => deg + 360 * Math.round((prev - deg) / 360);

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** A "D": rounded-square left side, semicircular right side, centred on 0,0, facing +x. */
function dPath(size = CELL, r = R): string {
  const h = size / 2;
  return `M ${-h},${-h + r} a ${r},${r} 0 0 1 ${r},${-r} H 0 a ${h},${h} 0 0 1 0,${size} H ${-h + r} a ${r},${r} 0 0 1 ${-r},${-r} Z`;
}

type Kind = "head" | "cell" | "cap";

/** One logical piece of snake, drawn up to four times so it can straddle a wrapping edge. */
class Piece {
  readonly g: SVGGElement;
  private uses: SVGUseElement[] = [];
  private kind: Kind | null = null;

  constructor(parent: Element) {
    this.g = el("g", {}, parent);
  }

  draw(kind: Kind, x: number, y: number, size: number, angle: number, scale: number, opacity: number): void {
    if (kind !== this.kind) {
      this.kind = kind;
      for (const u of this.uses) u.setAttribute("href", `#snake-${kind}`);
    }
    // Copies shifted a whole grid over; the board's clip shows whatever pokes in from the far side.
    const xs = [x, ...(x > size - 1.5 ? [x - size] : x < 0.5 ? [x + size] : [])];
    const ys = [y, ...(y > size - 1.5 ? [y - size] : y < 0.5 ? [y + size] : [])];
    let n = 0;
    for (const cx of xs) {
      for (const cy of ys) {
        const u = (this.uses[n] ??= el("use", { href: `#snake-${kind}` }, this.g));
        u.setAttribute("transform", `translate(${cx * PITCH + PITCH / 2} ${cy * PITCH + PITCH / 2}) rotate(${angle}) scale(${scale})`);
        u.style.display = "";
        n++;
      }
    }
    for (; n < this.uses.length; n++) this.uses[n]!.style.display = "none";
    this.g.setAttribute("opacity", String(opacity));
  }

  remove(): void {
    this.g.remove();
  }
}

interface Dying {
  piece: Piece;
  kind: Kind;
  at: Cell;
  angle: number;
}

export class SnakeScreen {
  private static open: SnakeScreen | null = null;

  /**
   * Show the screen. While `loading`, it closes itself on `ready()` unless the
   * user has started playing; opened as a toy it waits for Esc/Enter.
   */
  static show(loading: boolean): SnakeScreen {
    SnakeScreen.open?.close();
    return (SnakeScreen.open = new SnakeScreen(loading));
  }

  private root: HTMLDivElement;
  private status: HTMLDivElement;
  private hint: HTMLDivElement;
  private svg: SVGSVGElement;
  private grid: SVGGElement;
  private frameRect: SVGRectElement;
  private clipRect: SVGRectElement;
  private lines: SVGLineElement[] = [];
  private bodyLayer: SVGGElement;
  private headLayer: SVGGElement;
  private food: SVGGElement;
  private tongue: SVGPathElement;
  private eye: SVGCircleElement;
  private deadEye: SVGPathElement;
  private pieces: Piece[] = [];
  private dying: Dying[] = [];
  private dyingAt = 0;

  private snake: Snake = start();
  /** Where the head and tail glide from this step, unwrapped so `to - from` is the real move. */
  private from: Cell[] = this.snake.body;
  private headAngle = { from: 0, to: 0 };
  private tailAngle = { from: 180, to: 180 }; // facing away from the head
  private headAt: number; // when the head (re)appeared
  private grownAt = -Infinity;
  private eaten: { at: Cell; time: number } | null = null;
  private foodAt = 0;
  private queue: Dir[] = [];
  private view = { from: START_SIZE, to: START_SIZE, at: -Infinity };

  private t0 = performance.now();
  private tickAt = this.t0 + INTRO + 200;
  private stepStart = -Infinity;
  private stepGlide = 0;
  private nextFlick = this.t0 + INTRO + 600;
  private nextBlink = this.t0 + INTRO + 1800;
  private still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  private playing = false;
  private playStart = 0;
  private deadAt: number | null = null;
  private isReady: boolean;
  private failed = false;
  private closed = false;
  private frame = 0;
  private restoreFocus: HTMLElement | null;

  private constructor(private loading: boolean) {
    this.isReady = !loading;
    this.restoreFocus = document.activeElement as HTMLElement | null;
    this.headAt = this.grownAt = this.t0 + INTRO;

    this.root = document.createElement("div");
    this.root.className = "snake-screen";
    this.root.tabIndex = -1;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", loading ? "Loading Adder" : "Snake");
    if (!loading) this.root.classList.add("instant");

    this.svg = el("svg", { class: "snake-board", "aria-hidden": "true" }, this.root);
    const defs = el("defs", {}, this.svg);
    const clip = el("clipPath", { id: "snake-clip" }, defs);
    this.clipRect = el("rect", { x: 0, y: 0, rx: 12 }, clip);
    el("rect", { id: "snake-cell", x: -CELL / 2, y: -CELL / 2, width: CELL, height: CELL, rx: R, class: "snake-fill" }, defs);
    el("path", { id: "snake-cap", d: dPath(), class: "snake-fill" }, defs);
    const head = el("g", { id: "snake-head" }, defs);
    this.tongue = el("path", { d: "M 40,8 H 72 M 72,8 L 84,-2 M 72,8 L 84,18", class: "snake-tongue" }, head);
    el("path", { d: dPath(), class: "snake-fill" }, head);
    this.eye = el("circle", { cx: 8, cy: -18, r: 7.5, class: "snake-eye" }, head);
    this.deadEye = el("path", { d: "M -1,-27 L 17,-9 M 17,-27 L -1,-9", class: "snake-dead-eye", style: "display:none" }, head);

    this.grid = el("g", { class: "snake-grid" }, this.svg);
    this.frameRect = el("rect", { x: 0, y: 0, rx: 12, pathLength: 1 }, this.grid);
    this.setLines(START_SIZE, false);

    const board = el("g", { "clip-path": "url(#snake-clip)" }, this.svg);
    this.food = el("g", { class: "snake-food", opacity: 0 }, board);
    el("rect", { x: -26, y: -9, width: 52, height: 18, rx: 9 }, this.food);
    el("rect", { x: -9, y: -26, width: 18, height: 52, rx: 9 }, this.food);
    this.bodyLayer = el("g", {}, board);
    this.headLayer = el("g", {}, board);

    this.status = document.createElement("div");
    this.status.className = "snake-status";
    this.status.setAttribute("aria-live", "polite");
    this.hint = document.createElement("div");
    this.hint.className = "snake-hint";
    this.root.append(this.status, this.hint);

    this.root.addEventListener("click", () => this.isReady && this.close());
    window.addEventListener("keydown", this.onKey, true);
    document.body.append(this.root);
    this.root.focus({ preventScroll: true });
    this.updateStatus();
    this.layout(START_SIZE);
    this.frame = requestAnimationFrame(this.render);
    if (import.meta.env.DEV) (window as unknown as { adderSnake: SnakeScreen }).adderSnake = this;
  }

  /** The app has loaded: leave now, or once the player is done. */
  ready(): void {
    if (this.closed) return;
    this.isReady = true;
    if (!this.playing) this.close();
    else this.updateStatus();
  }

  fail(message: string): void {
    this.failed = true;
    this.status.textContent = message;
    this.status.classList.add("error");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (SnakeScreen.open === this) SnakeScreen.open = null;
    window.removeEventListener("keydown", this.onKey, true);
    this.root.classList.add("closing");
    this.root.addEventListener("transitionend", () => this.destroy(), { once: true });
    setTimeout(() => this.destroy(), 400); // in case the transition never runs
    if (this.root.contains(document.activeElement) && this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
  }

  private destroy(): void {
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  private onKey = (e: KeyboardEvent): void => {
    // Nothing reaches the app underneath while the screen is up.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if ((key === "escape" || key === "enter") && this.isReady) {
      e.preventDefault();
      this.close();
      return;
    }
    if (this.failed) return;
    const dir = KEYS[key];
    const now = performance.now();
    if (this.deadAt !== null) {
      if (MODIFIERS.has(key)) return;
      e.preventDefault();
      if (now - this.deadAt >= REST) this.restart(now, dir);
      return;
    }
    if (!dir) return;
    e.preventDefault();
    if (!this.playing) {
      this.playing = true;
      this.playStart = now;
      this.snake = { ...this.snake, food: placeFood(this.snake.body, this.snake.size) };
      this.foodAt = now;
      this.updateStatus();
    }
    // Queue up to two turns so quick double-taps (e.g. up then left) both land.
    const last = this.queue.at(-1) ?? this.snake.dir;
    if (this.queue.length < 2 && canTurn(last, dir, this.snake.body.length)) this.queue.push(dir);
  };

  private updateStatus(): void {
    if (this.failed) return;
    const { body, size } = this.snake;
    const parts = [!this.isReady ? "Loading…" : this.loading ? "Ready" : "Snake"];
    if (this.playing) parts.push(`length ${body.length}`);
    if (size > START_SIZE) parts.push(`${size}×${size}`);
    if (this.isReady) parts.push(this.loading ? "Enter to continue" : "Esc to close");
    this.status.textContent = parts.join(" · ");
    if (this.deadAt !== null) this.hint.textContent = "Game over · press any key";
    else this.hint.innerHTML = "<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>";
  }

  /** ms per step: slow at first, quickening the longer a game lasts. */
  private stepLength(now: number): number {
    if (!this.playing) return SLOW;
    return FAST + (SLOW - FAST) * 0.5 ** ((now - this.playStart) / HALVING);
  }

  private tick(now: number): void {
    const prev = this.snake;
    const dir = this.queue.shift() ?? prev.dir;
    const { snake, result } = step({ ...prev, dir });
    this.headAngle = { from: this.headAngle.to, to: unwrap(ANGLE[dir], this.headAngle.to) };

    if (result === "crash") {
      // Frozen where it hit, facing the way it tried to go.
      this.snake = { ...prev, dir };
      this.from = prev.body;
      this.tailAngle.from = this.tailAngle.to;
      this.deadAt = now;
      this.queue = [];
      this.eye.style.display = "none";
      this.deadEye.style.display = "";
      this.updateStatus();
      return;
    }

    this.snake = snake;
    const grew = result !== "move";
    const head = snake.body[0]!;
    const tail = snake.body.at(-1)!;
    const prevTail = prev.body.at(-1)!;
    this.from = snake.body.map((c) => c);
    this.from[0] = { x: head.x - VEC[dir].x, y: head.y - VEC[dir].y };
    if (snake.body.length > 1 && !grew) {
      this.from[snake.body.length - 1] = { x: tail.x - delta(prevTail.x, tail.x, prev.size), y: tail.y - delta(prevTail.y, tail.y, prev.size) };
    }
    const tailAngle = this.restingTailAngle();
    this.tailAngle = {
      from: prev.body.length > 1 ? this.tailAngle.to : tailAngle,
      to: unwrap(tailAngle, this.tailAngle.to),
    };

    if (grew) {
      this.eaten = { at: prev.food!, time: now };
      this.foodAt = now + this.stepGlide;
      this.nextFlick = now + this.stepGlide; // a flick of the tongue to celebrate
      this.grownAt = now;
      this.updateStatus();
    }
    if (result === "expand") this.resize(prev.size, snake.size, now);
  }

  private restart(now: number, dir?: Dir): void {
    // The old body fades where it lay while a fresh head pops in.
    const old = this.snake;
    for (const d of this.dying) d.piece.remove();
    this.dying = old.body.slice(1).map((at, i, rest) => ({
      piece: this.pieces[i + 1]!,
      kind: i === rest.length - 1 ? "cap" : "cell",
      at,
      angle: this.tailAngle.to,
    }));
    this.pieces.splice(1);
    this.dyingAt = now;

    const fresh = start(dir);
    this.snake = { ...fresh, food: placeFood(fresh.body, fresh.size) };
    this.from = this.snake.body;
    const angle = ANGLE[this.snake.dir];
    this.headAngle = { from: angle, to: angle };
    const tail = this.restingTailAngle();
    this.tailAngle = { from: tail, to: tail };
    this.headAt = this.grownAt = now;
    this.foodAt = now + POP;
    this.eaten = null;
    this.deadAt = null;
    this.playStart = now;
    this.stepStart = -Infinity;
    this.tickAt = now + POP + 100;
    this.eye.style.display = "";
    this.deadEye.style.display = "none";
    if (old.size !== START_SIZE) this.resize(old.size, START_SIZE, now);
    this.updateStatus();
  }

  /** The tail's round end faces away from the segment ahead of it. */
  private restingTailAngle(): number {
    const { body, size } = this.snake;
    if (body.length < 2) return 0;
    const tail = body.at(-1)!;
    const ahead = body.at(-2)!;
    return (Math.atan2(delta(ahead.y, tail.y, size), delta(ahead.x, tail.x, size)) * 180) / Math.PI;
  }

  private resize(from: number, to: number, now: number): void {
    this.view = { from, to, at: now };
    this.setLines(to, to > from);
  }

  /** Inner grid lines for a size × size grid; `fresh` ones draw in like the intro. */
  private setLines(size: number, fresh: boolean): void {
    const want = 2 * (size - 1);
    while (this.lines.length > want) this.lines.pop()!.remove();
    for (let i = this.lines.length / 2 + 1; i < size; i++) {
      const attrs = { pathLength: 1, class: fresh ? "fresh" : "", style: `--i:${fresh ? 0 : i}` };
      this.lines.push(el("line", { ...attrs, x1: 0, y1: i * PITCH }, this.grid));
      this.lines.push(el("line", { ...attrs, x1: i * PITCH, y1: 0, style: `--i:${fresh ? 1 : i + 4}` }, this.grid));
    }
  }

  /** Fit the frame, lines, clip and view to a (possibly fractional, mid-zoom) grid size. */
  private layout(size: number): void {
    const w = size * PITCH;
    const pad = w / 10;
    this.svg.setAttribute("viewBox", `${-pad} ${-pad} ${w + 2 * pad} ${w + 2 * pad}`);
    for (const r of [this.frameRect, this.clipRect]) {
      r.setAttribute("width", String(w));
      r.setAttribute("height", String(w));
    }
    // Lines alternate horizontal, vertical; each runs the full width of the frame.
    this.lines.forEach((l, i) => {
      const horizontal = i % 2 === 0;
      l.setAttribute("x2", horizontal ? String(w) : l.getAttribute("x1")!);
      l.setAttribute("y2", horizontal ? l.getAttribute("y1")! : String(w));
    });
  }

  private render = (now: number): void => {
    this.frame = requestAnimationFrame(this.render);
    if (this.deadAt === null) {
      if (now - this.tickAt > SLOW * 2) this.tickAt = now; // back from a hidden tab: don't race to catch up
      if (now >= this.tickAt) {
        const length = this.stepLength(now);
        this.stepStart = this.tickAt;
        this.stepGlide = this.still ? 0 : length * GLIDE;
        this.tick(now);
        this.tickAt += length;
      }
    }

    const zoom = this.still ? 1 : easeInOut(clamp01((now - this.view.at) / ZOOM));
    if (zoom < 1 || this.view.at > now - ZOOM - 50) this.layout(this.view.from + (this.view.to - this.view.from) * zoom);

    const t = this.stepGlide ? easeInOut(clamp01((now - this.stepStart) / this.stepGlide)) : 1;
    const { body, size } = this.snake;
    while (this.pieces.length < body.length) this.pieces.push(new Piece(this.pieces.length ? this.bodyLayer : this.headLayer));
    body.forEach((to, i) => {
      // Only the ends glide: the head into its new cell, the tail up to the next one.
      // The cells between are the same before and after a step, so they stay put.
      const from = this.deadAt === null && (i === 0 || i === body.length - 1) ? this.from[i]! : to;
      let x = from.x + (to.x - from.x) * t;
      let y = from.y + (to.y - from.y) * t;
      const head = i === 0;
      const kind: Kind = head ? "head" : i === body.length - 1 ? "cap" : "cell";
      let angle = 0;
      let scale = 1;
      let opacity = 1;
      if (head) {
        angle = this.headAngle.from + (this.headAngle.to - this.headAngle.from) * t;
        scale = now < this.headAt ? 0 : backOut(clamp01((now - this.headAt) / POP));
        if (this.deadAt !== null) {
          // Turn to face the way it crashed, and bump into it.
          const p = clamp01((now - this.deadAt) / 240);
          angle = this.headAngle.from + (this.headAngle.to - this.headAngle.from) * easeInOut(clamp01(p * 2));
          const bump = this.still ? 0 : 0.18 * Math.sin(Math.PI * p);
          x += VEC[this.snake.dir].x * bump;
          y += VEC[this.snake.dir].y * bump;
        }
      } else if (kind === "cap") {
        angle = this.tailAngle.from + (this.tailAngle.to - this.tailAngle.from) * t;
      }
      if (!head && i === body.length - 1 && now - this.grownAt < POP) {
        const p = clamp01((now - this.grownAt) / POP);
        scale = 0.5 + 0.5 * backOut(p, 2.5);
        opacity = p;
      }
      this.pieces[i]!.draw(kind, x, y, size, angle, scale, opacity);
    });

    if (this.dying.length) {
      const p = clamp01((now - this.dyingAt) / 260);
      for (const d of this.dying) d.piece.draw(d.kind, d.at.x, d.at.y, size, d.kind === "cap" ? d.angle : 0, 1 - 0.4 * p, 1 - p);
      if (p >= 1) {
        for (const d of this.dying) d.piece.remove();
        this.dying = [];
      }
    }

    this.renderFood(now);
    this.animateFace(now);
  };

  private renderFood(now: number): void {
    // The eaten "+" shrinks as the head arrives; the next one pops in after.
    if (this.eaten && now - this.eaten.time < this.stepGlide + 120) {
      const p = clamp01((now - this.eaten.time - this.stepGlide * 0.5) / 160);
      this.placeFood(this.eaten.at, 1 - p, 1 - p);
      return;
    }
    this.eaten = null;
    const food = this.snake.food;
    if (!food) return void this.food.setAttribute("opacity", "0");
    const p = clamp01((now - this.foodAt) / POP);
    this.placeFood(food, p > 0 ? backOut(p, 2.5) : 0, p > 0 ? 1 : 0);
  }

  private placeFood(at: Cell, scale: number, opacity: number): void {
    this.food.setAttribute("transform", `translate(${at.x * PITCH + PITCH / 2} ${at.y * PITCH + PITCH / 2}) scale(${Math.max(0, scale)})`);
    this.food.setAttribute("opacity", String(opacity));
  }

  /** Tongue flicks and blinks, as at the end of the logo animation. A dead snake does neither. */
  private animateFace(now: number): void {
    if (this.deadAt !== null) {
      this.tongue.setAttribute("transform", "translate(40 8) scale(0.35 1) translate(-40 -8)");
      return;
    }
    if (now >= this.nextFlick + 330) this.nextFlick = now + 1800 + Math.random() * 1600;
    const f = now - this.nextFlick;
    // Out at rest; flicks in to 35% and back.
    const sx = f < 0 ? 1 : f < 90 ? 1 - 0.65 * (f / 90) : f < 210 ? 0.35 + 0.65 * ((f - 90) / 120) : 1;
    this.tongue.setAttribute("transform", `translate(40 8) scale(${sx} 1) translate(-40 -8)`);

    if (now >= this.nextBlink + 140) this.nextBlink = now + 2500 + Math.random() * 2500;
    const b = now - this.nextBlink;
    const sy = b < 0 || b > 140 ? 1 : 1 - 0.9 * Math.sin((b / 140) * Math.PI);
    this.eye.setAttribute("transform", `translate(8 -18) scale(1 ${sy}) translate(-8 18)`);
  }
}
