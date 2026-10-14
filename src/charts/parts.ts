import type { echarts } from "./echarts";
import type { Box, ChartStyle } from "./model";

// Geometry of the movable parts inside a chart: the title, the legend and the
// plot area (the axes' grid, or the pie itself), in px relative to the chart canvas.

export type MovablePart = "title" | "legend" | "plot";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Parts that can be resized as well as moved, like Excel (titles size to their text). */
export const RESIZABLE: Record<MovablePart, boolean> = { title: false, legend: true, plot: true };

export const PART_NAMES: Record<MovablePart, string> = { title: "Title", legend: "Legend", plot: "Plot Area" };

// The component views and models are internal to ECharts (not in its typings),
// but stable; echarts is pinned to an exact version in package.json.
interface Internal {
  getModel(): {
    getComponent(type: string): unknown;
    getSeriesByIndex(i: number): { getData(): { count(): number; getItemLayout(i: number): { cx: number; cy: number; r: number } | null } } | undefined;
  };
  getViewOfComponentModel(model: unknown): { group: { getBoundingRect(): Rect & { applyTransform(m: unknown): void }; getComputedTransform(): unknown } } | undefined;
}

/** A part's on-screen box, or null when it isn't shown. */
export function partRect(chart: echarts.ECharts, part: MovablePart): Rect | null {
  const c = chart as unknown as Internal;
  const model = c.getModel();
  if (part === "plot") {
    const grid = model.getComponent("grid") as { coordinateSystem?: { getRect(): Rect } } | undefined;
    if (grid?.coordinateSystem) return copy(grid.coordinateSystem.getRect());
    const data = model.getSeriesByIndex(0)?.getData();
    const pie = data && data.count() ? data.getItemLayout(0) : null;
    return pie ? { x: pie.cx - pie.r, y: pie.cy - pie.r, width: 2 * pie.r, height: 2 * pie.r } : null;
  }
  const component = model.getComponent(part);
  if (!component || !(component as { get(k: string): unknown }).get("show")) return null;
  const group = c.getViewOfComponentModel(component)?.group;
  if (!group) return null;
  const r = group.getBoundingRect();
  r.applyTransform(group.getComputedTransform());
  return r.width > 0 && r.height > 0 ? copy(r) : null;
}

/** The part under a canvas point; the title and legend sit above the plot. */
export function partAt(chart: echarts.ECharts, x: number, y: number): MovablePart | null {
  for (const part of ["title", "legend", "plot"] as const) {
    const r = partRect(chart, part);
    if (r && x >= r.x - 2 && x <= r.x + r.width + 2 && y >= r.y - 2 && y <= r.y + r.height + 2) return part;
  }
  return null;
}

/** Whether the user has positioned this part by hand. */
export function hasLayout(style: ChartStyle, part: MovablePart): boolean {
  return part === "plot" ? !!style.plot : !!style[part]?.pos;
}

/** Style with a part placed at `r` (canvas px), stored as fractions of the canvas so it scales with the chart. */
export function placePart(style: ChartStyle, part: MovablePart, r: Rect, size: { width: number; height: number }): ChartStyle {
  const box: Box = { x: r.x / size.width, y: r.y / size.height };
  if (RESIZABLE[part]) {
    box.w = r.width / size.width;
    box.h = r.height / size.height;
  }
  if (part === "plot") return { ...style, plot: box };
  return { ...style, [part]: { ...style[part], pos: box } };
}

/** Style with a part back on automatic layout. */
export function resetPart(style: ChartStyle, part: MovablePart): ChartStyle {
  if (part === "plot") {
    const { plot: _, ...rest } = style;
    return rest;
  }
  const { pos: _, ...rest } = style[part] ?? {};
  return { ...style, [part]: Object.keys(rest).length ? rest : undefined };
}

/**
 * Moving the title or legend pins the plot area where it is, as Excel does,
 * so the plot doesn't reflow into the space they leave.
 */
export function pinPlot(chart: echarts.ECharts, style: ChartStyle, size: { width: number; height: number }): ChartStyle {
  if (style.plot) return style;
  const r = partRect(chart, "plot");
  return r ? placePart(style, "plot", r, size) : style;
}

/** Keep a box inside the canvas and at least `min` px in each dimension. */
export function clampRect(r: Rect, size: { width: number; height: number }, min: number): Rect {
  const width = Math.max(min, Math.min(r.width, size.width));
  const height = Math.max(min, Math.min(r.height, size.height));
  return { x: Math.max(0, Math.min(r.x, size.width - width)), y: Math.max(0, Math.min(r.y, size.height - height)), width, height };
}

function copy(r: Rect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
