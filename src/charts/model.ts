import type { CellValue } from "../engine/types";
import type { Palette } from "../grid/renderer";

// Chart objects float over a sheet, anchored to a cell, and plot a source range.
//
// v1 limitations: inserting/deleting rows or columns doesn't shift `range` or
// `anchor`; charts aren't in undo history; xlsx import/export ignores them.

export const CHART_TYPES = ["bar", "line", "pie", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSpec {
  id: string;
  /** Sheet name: indices shift when a sheet is deleted. */
  sheet: string;
  /** Source data, 1-based like the engine. */
  range: { row: number; col: number; rows: number; cols: number };
  type: ChartType;
  /** Top-left corner: a cell plus a px offset into it. */
  anchor: { row: number; col: number; dx: number; dy: number };
  width: number;
  height: number;
  /** Formatting overrides; anything unset follows the theme. */
  style?: ChartStyle;
}

export const FONTS = {
  sans: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;
export type FontKey = keyof typeof FONTS;

export interface TextFormat {
  color?: string;
  font?: FontKey;
  size?: number;
  bold?: boolean;
  italic?: boolean;
}

/** ECharts symbol names; the "empty" ones are drawn as an outline. */
export const MARKER_SHAPES = ["emptyCircle", "circle", "emptyRect", "rect", "emptyTriangle", "triangle", "emptyDiamond", "diamond"] as const;
export type MarkerShape = (typeof MARKER_SHAPES)[number];
export const isHollow = (shape: MarkerShape) => shape.startsWith("empty");
/** Default marker per chart type: ECharts' own for lines, solid dots for scatter. */
export const DEFAULT_MARKER = { line: { shape: "emptyCircle", size: 6 }, scatter: { shape: "circle", size: 10 } } as const;

export interface MarkerFormat {
  shape?: MarkerShape;
  size?: number;
  /** Solid shapes only; hollow ones are filled by ECharts. */
  fill?: string;
  /** Outline colour; for a hollow shape this is the whole marker's colour. */
  border?: string;
  /** Solid shapes only. */
  borderWidth?: number;
}

export interface SeriesFormat {
  name?: string;
  color?: string;
  /** Show values on the bars / points / slices. */
  labels?: boolean;
  /** Line charts: markers on/off; unset shows them for up to 50 points. */
  markers?: boolean;
  marker?: MarkerFormat;
  /** Line width (line), or point size in workbooks saved before `marker.size` (scatter). */
  width?: number;
  smooth?: boolean;
  /** Pie slice colours by category index. */
  points?: Record<string, string>;
}

export interface AxisFormat extends TextFormat {
  title?: string;
  gridLines?: boolean;
  /** Bounds for value axes; unset is automatic. */
  min?: number;
  max?: number;
}

/** A hand-placed part, in fractions of the chart canvas so it scales with the chart. */
export interface Box {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface ChartStyle {
  area?: { background?: string; font?: FontKey };
  title?: TextFormat & { show?: boolean; text?: string; align?: "left" | "center" | "right"; pos?: Box };
  legend?: TextFormat & { show?: boolean; position?: "top" | "bottom" | "left" | "right"; pos?: Box };
  /** The plot area (axes grid, or the pie), placed by hand. */
  plot?: Box;
  xAxis?: AxisFormat;
  yAxis?: AxisFormat;
  /** By plotted series index. */
  series?: Record<string, SeriesFormat>;
}

/** The parts of a chart that can be formatted, and the target of a right-click. */
export type ChartPart = "area" | "title" | "legend" | "series" | "xAxis" | "yAxis";

export interface SeriesData {
  categories: string[];
  series: { name: string; data: (number | null)[] }[];
}

const isText = (v: CellValue | undefined) => typeof v === "string" && v !== "";
const isLabel = (v: CellValue | undefined) => v === null || v === undefined || typeof v === "string";
const num = (v: CellValue | undefined) => (typeof v === "number" ? v : null);

/**
 * Split a range into categories and series, like Excel: a text first row holds
 * series names, a text first column holds category labels, and series run along
 * the longer side of the data.
 */
export function inferSeries(values: CellValue[][]): SeriesData {
  const rows = values.length;
  const cols = values[0]?.length ?? 0;
  const headRow = rows > 1 && values[0]!.every(isLabel) && values[0]!.some(isText);
  const labelCol = cols > 1 && values.slice(headRow ? 1 : 0).every((r) => isLabel(r[0])) && values.some((r, i) => (!headRow || i > 0) && isText(r[0]));
  const r0 = headRow ? 1 : 0;
  const c0 = labelCol ? 1 : 0;
  const data = values.slice(r0).map((r) => r.slice(c0).map(num));
  const dataRows = data.length;
  const dataCols = data[0]?.length ?? 0;
  const rowNames = values.slice(r0).map((r, i) => (labelCol ? String(r[0] ?? "") : String(i + 1)));
  const colNames = Array.from({ length: dataCols }, (_, j) => (headRow ? String(values[0]![j + c0] ?? "") : `Series ${j + 1}`));

  if (dataCols > dataRows) {
    // Wide data: each row is a series across the columns.
    const categories = headRow ? colNames : colNames.map((_, j) => String(j + 1));
    return { categories, series: data.map((r, i) => ({ name: labelCol ? rowNames[i]! : `Series ${i + 1}`, data: r })) };
  }
  return { categories: rowNames, series: colNames.map((name, j) => ({ name, data: data.map((r) => r[j] ?? null) })) };
}

/**
 * What a chart actually plots: a pie shows only the first series, and a scatter
 * uses the first series as X. Series indices here are the ones `style.series` keys on.
 */
export function plotted(spec: ChartSpec, values: CellValue[][]): SeriesData & { xs?: (number | null)[] } {
  const d = inferSeries(values);
  if (spec.type === "pie") return { categories: d.categories, series: d.series.slice(0, 1) };
  if (spec.type === "scatter" && d.series.length > 1) return { categories: d.categories, series: d.series.slice(1), xs: d.series[0]!.data };
  if (spec.type === "scatter") return { ...d, xs: d.categories.map((_, i) => i + 1) };
  return d;
}

/** The title shown when none is set: a single series' name, like Excel. */
export function defaultTitle(spec: ChartSpec, data: SeriesData): string | undefined {
  return data.series.length === 1 && spec.type !== "pie" ? data.series[0]!.name : undefined;
}

/** The chart's drawing area in px: the chart less its 1px border. */
export const canvasSize = (spec: Pick<ChartSpec, "width" | "height">) => ({ width: spec.width - 2, height: spec.height - 2 });

const pct = (f: number) => `${+(f * 100).toFixed(3)}%`;

export const seriesColor = (palette: Palette, i: number) => palette.refColors[i % palette.refColors.length]!;

function textStyle(f: TextFormat | undefined, base: { color: string; fontFamily: string }, size: number, bold = false) {
  return {
    color: f?.color ?? base.color,
    fontFamily: f?.font ? FONTS[f.font] : base.fontFamily,
    fontSize: f?.size ?? size,
    fontWeight: (f?.bold ?? bold) ? 600 : 400,
    fontStyle: f?.italic ? "italic" : "normal",
  };
}

/** ECharts option for a chart, coloured to match the grid. */
export function toOption(spec: ChartSpec, values: CellValue[][], palette: Palette, animate: boolean): Record<string, unknown> {
  const style = spec.style ?? {};
  const data = plotted(spec, values);
  const { categories } = data;
  const fmt = (i: number) => style.series?.[i] ?? {};
  const series = data.series.map((s, i) => ({ ...s, name: fmt(i).name || s.name }));
  const base = { color: palette.text, fontFamily: FONTS[style.area?.font ?? "sans"] };

  const titleText = style.title?.text ?? defaultTitle(spec, { categories, series });
  const showTitle = (style.title?.show ?? true) && !!titleText;
  const showLegend = style.legend?.show ?? (series.length > 1 || spec.type === "pie");
  const legendAt = style.legend?.position ?? "bottom";
  const titleH = showTitle ? 18 + (style.title?.size ?? 14) : 0;
  const legendText = textStyle(style.legend, base, 12);
  const vertical = legendAt === "left" || legendAt === "right";
  const lp = style.legend?.pos;
  // Zero padding so a part's drawn box is exactly where it was placed.
  const legendPos = lp
    ? { left: pct(lp.x), top: pct(lp.y), width: lp.w && pct(lp.w), height: lp.h && pct(lp.h), orient: vertical ? "vertical" : "horizontal" }
    : {
        top: { top: titleH + 8, left: "center" },
        bottom: { bottom: 8, left: "center" },
        left: { left: 8, top: "middle", orient: "vertical" },
        right: { right: 8, top: "middle", orient: "vertical" },
      }[legendAt];
  const tp = style.title?.pos;

  const common = {
    animation: animate,
    color: palette.refColors,
    backgroundColor: style.area?.background ?? palette.bg,
    textStyle: base,
    title: showTitle
      ? {
          text: titleText,
          ...(tp ? { left: pct(tp.x), top: pct(tp.y) } : { left: style.title?.align ?? "center", top: 10 }),
          padding: 0,
          triggerEvent: true,
          textStyle: textStyle(style.title, base, 14, true),
        }
      : undefined,
    // Clicking an entry shows/hides its series; dragging moves the legend (see ChartLayer).
    legend: showLegend ? { ...legendPos, padding: 0, type: "scroll", triggerEvent: true, textStyle: legendText, pageTextStyle: legendText } : undefined,
    tooltip: { trigger: spec.type === "pie" || spec.type === "scatter" ? "item" : "axis", confine: true },
  };

  if (spec.type === "pie") {
    const s = series[0];
    const f = fmt(0);
    const side = showLegend && !lp && vertical ? (legendAt === "left" ? "58%" : "42%") : "50%";
    const legendGap = showLegend && !lp && legendAt === "bottom" ? -6 : showLegend && !lp && legendAt === "top" ? 6 : 0;
    const box = style.plot;
    const size = canvasSize(spec);
    const placed = box && {
      center: [pct(box.x + (box.w ?? 0) / 2), pct(box.y + (box.h ?? 0) / 2)],
      radius: ["0%", Math.max(10, Math.min((box.w ?? 0) * size.width, (box.h ?? 0) * size.height) / 2)],
    };
    return {
      ...common,
      series: [
        {
          type: "pie",
          name: s?.name,
          radius: placed?.radius ?? ["0%", "62%"],
          center: placed?.center ?? [side, `${50 + (showTitle ? 5 : 0) + legendGap}%`],
          label: { show: f.labels ?? true, color: palette.text, fontFamily: base.fontFamily, ...(f.labels ? { formatter: "{b}: {c}" } : {}) },
          data: categories.map((name, i) => ({ name, value: s?.data[i] ?? null, itemStyle: f.points?.[i] ? { color: f.points[i] } : undefined })),
        },
      ],
    };
  }

  const pad = (at: "top" | "bottom" | "left" | "right", px: number) => (showLegend && !lp && legendAt === at ? px : 0);
  const pb = style.plot;
  // Automatic: axis labels and names sit inside the grid rect, clear of the legend.
  // Placed by hand: the rect is the plot itself, with labels outside it, like Excel's inner plot area.
  const grid = pb
    ? { left: pct(pb.x), top: pct(pb.y), width: pct(pb.w ?? 0.5), height: pct(pb.h ?? 0.5), outerBoundsMode: "none" }
    : {
        left: 12 + pad("left", 96),
        right: 20 + pad("right", 96),
        top: (showTitle ? titleH + 16 : 16) + pad("top", 24),
        bottom: 12 + pad("bottom", 24),
        outerBoundsMode: "same",
        outerBoundsContain: "all",
      };
  const axis = (f: AxisFormat | undefined, value: boolean, gridLines: boolean) => {
    const text = textStyle(f, { ...base, color: palette.headerText }, 12);
    return {
      type: value ? "value" : "category",
      triggerEvent: true,
      axisLine: { lineStyle: { color: palette.headerText } },
      axisLabel: text,
      splitLine: { show: f?.gridLines ?? gridLines, lineStyle: { color: palette.grid } },
      ...(f?.title ? { name: f.title, nameLocation: "middle", nameGap: 28, nameTextStyle: { ...text, fontWeight: 600 } } : {}),
      ...(value ? { scale: spec.type === "scatter", min: f?.min, max: f?.max } : {}),
    };
  };
  const lineSeries = (i: number, points: number) => {
    const on = fmt(i).markers ?? points <= 50;
    return {
      ...markers(i, "line"),
      ...(on ? {} : { symbol: "none" }),
      showSymbol: on,
      smooth: fmt(i).smooth ?? false,
      lineStyle: { color: fmt(i).color ?? seriesColor(palette, i), width: fmt(i).width ?? 2 },
    };
  };
  const label = (i: number) => (fmt(i).labels ? { show: true, position: "top", color: palette.text, fontFamily: base.fontFamily } : undefined);
  const itemColor = (i: number) => (fmt(i).color ? { itemStyle: { color: fmt(i).color } } : {});
  // Markers draw from itemStyle, as do the legend icon and tooltip dot; the line has its own colour.
  const markers = (i: number, type: "line" | "scatter") => {
    const f = fmt(i);
    const mk = f.marker ?? {};
    const shape = mk.shape ?? DEFAULT_MARKER[type].shape;
    const itemStyle = isHollow(shape)
      ? { color: mk.border ?? f.color }
      : { color: mk.fill ?? f.color, borderColor: mk.border, borderWidth: mk.borderWidth ?? (mk.border ? 1 : undefined) };
    return { symbol: shape, symbolSize: mk.size ?? (type === "scatter" ? f.width : undefined) ?? DEFAULT_MARKER[type].size, itemStyle };
  };

  if (spec.type === "scatter") {
    const xs = data.xs!;
    return {
      ...common,
      grid,
      xAxis: axis(style.xAxis, true, true),
      yAxis: axis(style.yAxis, true, true),
      series: series.map((s, i) => ({
        type: "scatter",
        name: s.name,
        label: label(i),
        ...markers(i, "scatter"),
        data: s.data.map((y, j) => [xs[j] ?? null, y]),
      })),
    };
  }

  return {
    ...common,
    grid,
    xAxis: { ...axis(style.xAxis, false, false), data: categories },
    yAxis: axis(style.yAxis, true, true),
    series: series.map((s, i) => ({
      type: spec.type,
      name: s.name,
      data: s.data,
      label: label(i),
      ...itemColor(i),
      ...(spec.type === "line" ? lineSeries(i, s.data.length) : {}),
    })),
  };
}
