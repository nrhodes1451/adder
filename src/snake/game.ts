// Snake on the logo's grid, which starts 5×5 and grows each time the snake fills it.
// Pure state; the loader screen animates it. Edges wrap: leaving one side
// re-enters from the opposite side.

export const START_SIZE = 5;

export interface Cell {
  x: number;
  y: number;
}

export type Dir = "up" | "down" | "left" | "right";

export const VEC: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

export interface Snake {
  /** Head first. */
  body: Cell[];
  dir: Dir;
  food: Cell | null;
  /** The grid is size × size. */
  size: number;
}

/**
 * "crash": ran into itself; the snake is left as it was, for the game to end on.
 * "expand": ate the last free cell, so the grid gained a row and a column.
 */
export type StepResult = "move" | "eat" | "crash" | "expand";

/** A head and tail in the middle of the grid, heading `dir` (right unless told otherwise). */
export function start(dir: Dir = "right"): Snake {
  const head = { x: 2, y: 2 };
  const tail = { x: wrap(head.x - VEC[dir].x, START_SIZE), y: wrap(head.y - VEC[dir].y, START_SIZE) };
  return { body: [head, tail], dir, food: null, size: START_SIZE };
}

export const wrap = (n: number, size: number): number => ((n % size) + size) % size;
export const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

/** A snake longer than its head can't reverse into its own neck. */
export function canTurn(from: Dir, to: Dir, length: number): boolean {
  return to !== from && (length === 1 || to !== OPPOSITE[from]);
}

export function step(s: Snake, rand: () => number = Math.random): { snake: Snake; result: StepResult } {
  const head = s.body[0]!;
  const v = VEC[s.dir];
  const next = { x: wrap(head.x + v.x, s.size), y: wrap(head.y + v.y, s.size) };
  const eats = s.food !== null && same(next, s.food);
  // The tail moves out of the way this step unless the snake is growing.
  const rest = eats ? s.body : s.body.slice(0, -1);
  if (rest.some((c) => same(c, next))) return { snake: s, result: "crash" };
  const body = [next, ...rest];
  if (!eats) return { snake: { ...s, body }, result: "move" };
  const food = placeFood(body, s.size, rand);
  if (food) return { snake: { ...s, body, food }, result: "eat" };
  // Full: the snake keeps its cells and the new column and row along the right and bottom become free.
  const size = s.size + 1;
  return { snake: { ...s, body, size, food: placeFood(body, size, rand) }, result: "expand" };
}

/** A random free cell, or null when the snake fills the grid. */
export function placeFood(body: Cell[], size: number, rand: () => number = Math.random): Cell | null {
  const free: Cell[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!body.some((c) => c.x === x && c.y === y)) free.push({ x, y });
  return free.length ? free[Math.floor(rand() * free.length)]! : null;
}
