import type { Engine } from "../engine/types";
import { selectionBounds } from "../grid/geometry";
import type { Grid } from "../grid/grid";
import { DARK, LIGHT } from "../grid/renderer";
import type { Workbook } from "../ui/workbook";
import { echarts } from "./echarts";
import { showMenu } from "./menu";
import { canvasSize, type ChartPart, type ChartSpec, type ChartStyle, type ChartType, defaultTitle, plotted, type SeriesData, toOption } from "./model";
import { clampRect, hasLayout, type MovablePart, PART_NAMES, partAt, partRect, pinPlot, placePart, type Rect, RESIZABLE, resetPart } from "./parts";

const DEFAULT_SIZE = { width: 480, height: 300 };
const MIN_SIZE = 120;
/** Smallest a legend or plot area can be dragged to, in px. */
const MIN_PART = 24;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
/** What double-clicking a part opens in the format panel. */
const PART_SECTION: Record<MovablePart, ChartPart> = { title: "title", legend: "legend", plot: "area" };

/** A right-clicked part of a chart, to format in the side panel. */
export interface EditTarget {
  id: string;
  part: ChartPart;
  series?: number;
}

const EDIT_LABELS: Record<ChartPart, string> = {
  area: "Edit Chart Area",
  title: "Edit Title",
  legend: "Edit Legend",
  series: "Edit Series",
  xAxis: "Edit Horizontal Axis",
  yAxis: "Edit Vertical Axis",
};

interface Mounted {
  spec: ChartSpec;
  /** Unsaved spec shown while dragging. */
  draft: ChartSpec | null;
  el: HTMLDivElement;
  chart: echarts.ECharts;
  /** The part selected inside the chart, outlined by `partBox`. */
  part: MovablePart | null;
  partBox: HTMLDivElement;
  /** Legend entries toggled off (series, or pie slices, by name); kept across redraws, not saved. */
  hidden: Record<string, boolean>;
}

/**
 * Charts floating over the grid's cell area. Specs live in the workbook's meta;
 * only the current sheet's charts are mounted as ECharts instances.
 */
export class ChartLayer {
  private mounted = new Map<string, Mounted>();
  private sheetName: string | null = null;
  private sheetNames: string[];
  private refreshQueued = false;
  private disposers: (() => void)[] = [];
  private dark = matchMedia("(prefers-color-scheme: dark)");
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private listeners = new Set<() => void>();
  /** Chart shown as selected while the format panel edits it. */
  private editing: string | null = null;
  /** Called when "Edit …" is picked from a chart's context menu. */
  onEdit: ((target: EditTarget) => void) | null = null;

  constructor(
    private grid: Grid,
    private workbook: Workbook,
  ) {
    this.sheetNames = this.engine.sheets().map((s) => s.name);
    this.disposers.push(
      grid.on((e) => e.type === "viewport" && this.onViewport()),
      this.engine.onChange((e) => {
        if (e.kind !== "cells") this.onSheetsChanged();
        this.queueRefresh();
      }),
    );
    const scheme = () => this.queueRefresh();
    this.dark.addEventListener("change", scheme);
    this.disposers.push(() => this.dark.removeEventListener("change", scheme));
    this.onViewport();
  }

  private get engine(): Engine {
    return this.workbook.engine;
  }

  private get specs(): ChartSpec[] {
    return this.workbook.meta.charts ?? [];
  }

  private saveSpecs(specs: ChartSpec[]): void {
    this.workbook.setMeta({ charts: specs });
    for (const l of this.listeners) l();
  }

  /** Notified whenever any chart spec changes. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get(id: string): ChartSpec | undefined {
    return this.specs.find((s) => s.id === id);
  }

  /** What a chart plots now, for labelling the format panel. */
  data(id: string): (SeriesData & { title?: string }) | null {
    const spec = this.get(id);
    const sheet = spec ? this.engine.sheets().findIndex((s) => s.name === spec.sheet) : -1;
    if (!spec || sheet < 0) return null;
    const d = plotted(spec, this.engine.getRangeValues({ sheet, ...spec.range }));
    return { ...d, title: defaultTitle(spec, d) };
  }

  get palette() {
    return this.dark.matches ? DARK : LIGHT;
  }

  setStyle(id: string, fn: (s: ChartStyle) => ChartStyle): void {
    const spec = this.get(id);
    if (spec) this.update(id, { style: fn(spec.style ?? {}) });
  }

  setType(id: string, type: ChartType): void {
    this.update(id, { type });
  }

  setEditing(id: string | null): void {
    this.editing = id;
    for (const m of this.mounted.values()) m.el.classList.toggle("editing", m.spec.id === id);
  }

  destroy(): void {
    for (const d of this.disposers) d();
    for (const m of this.mounted.values()) this.unmount(m);
    this.mounted.clear();
  }

  /** Chart the grid's selection. Returns an error message when there's nothing to chart. */
  insert(type: ChartType): string | null {
    const sheet = this.engine.sheets()[this.grid.sheet];
    if (!sheet) return "No sheet to chart.";
    let { r1, c1, r2, c2 } = selectionBounds(this.grid.selection);
    if (this.grid.wholeSelection) {
      const used = this.engine.usedRange(this.grid.sheet);
      r2 = Math.min(r2, Math.max(used.rows, r1));
      c2 = Math.min(c2, Math.max(used.cols, c1));
    }
    if (r1 === r2 && c1 === c2) return "Select the data to chart first.";
    const spec: ChartSpec = {
      id: crypto.randomUUID(),
      sheet: sheet.name,
      range: { row: r1, col: c1, rows: r2 - r1 + 1, cols: c2 - c1 + 1 },
      type,
      anchor: { row: r1, col: c2 + 2, dx: 0, dy: 0 },
      ...DEFAULT_SIZE,
    };
    this.saveSpecs([...this.specs, spec]);
    this.onViewport();
    this.mounted.get(spec.id)?.el.focus({ preventScroll: true });
    return null;
  }

  /** Dev/test hook: a mounted chart's ECharts instance. */
  instance(index: number): echarts.ECharts | undefined {
    return [...this.mounted.values()][index]?.chart;
  }

  /** Dev/test hook: where a part of a mounted chart is drawn, in canvas px. */
  partBounds(index: number, part: MovablePart): Rect | null {
    const chart = this.instance(index);
    return chart ? partRect(chart, part) : null;
  }

  /** Dev/test hook: the option a chart is showing. */
  option(index: number): unknown {
    return this.instance(index)?.getOption();
  }

  remove(id: string): void {
    this.saveSpecs(this.specs.filter((s) => s.id !== id));
    const m = this.mounted.get(id);
    if (m) this.unmount(m);
    this.mounted.delete(id);
    this.grid.focus();
  }

  private update(id: string, patch: Partial<ChartSpec>): void {
    this.saveSpecs(this.specs.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const m = this.mounted.get(id);
    if (m) {
      m.spec = { ...m.spec, ...patch };
      if (patch.style || patch.type || patch.width || patch.height) this.render(m);
    }
  }

  /** Keep specs pointing at the right sheet after renames, and drop charts whose sheet was deleted. */
  private onSheetsChanged(): void {
    const names = this.engine.sheets().map((s) => s.name);
    const old = this.sheetNames;
    this.sheetNames = names;
    let specs = this.specs;
    if (names.length === old.length) {
      const renamed = new Map(old.map((n, i) => [n, names[i]!] as const).filter(([a, b]) => a !== b));
      if (renamed.size) specs = specs.map((s) => (renamed.has(s.sheet) ? { ...s, sheet: renamed.get(s.sheet)! } : s));
    }
    specs = specs.filter((s) => names.includes(s.sheet));
    if (specs.length !== this.specs.length || specs.some((s, i) => s !== this.specs[i])) this.saveSpecs(specs);
    this.sheetName = null; // remount against the new names
    this.onViewport();
  }

  /** Mount the current sheet's charts and place them over their anchor cells. */
  private onViewport(): void {
    const name = this.engine.sheets()[this.grid.sheet]?.name ?? null;
    if (name !== this.sheetName) {
      this.sheetName = name;
      for (const m of this.mounted.values()) this.unmount(m);
      this.mounted.clear();
    }
    for (const spec of this.specs) {
      if (spec.sheet === name && !this.mounted.has(spec.id)) this.mount(spec);
    }
    for (const m of this.mounted.values()) this.place(m);
  }

  private place(m: Mounted): void {
    const { row, col, dx, dy } = m.spec.anchor;
    const o = this.grid.cellOffset(row, col);
    m.el.style.transform = `translate(${o.x + dx}px, ${o.y + dy}px)`;
  }

  private mount(spec: ChartSpec): void {
    const el = document.createElement("div");
    el.className = "adder-chart";
    el.tabIndex = 0;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", `${spec.type} chart`);
    el.dataset.testid = "chart";
    if (spec.id === this.editing) el.classList.add("editing");
    el.style.width = `${spec.width}px`;
    el.style.height = `${spec.height}px`;
    const canvas = document.createElement("div");
    canvas.className = "adder-chart-canvas";
    const handle = document.createElement("div");
    handle.className = "adder-chart-handle";
    const partBox = document.createElement("div");
    partBox.className = "adder-chart-part";
    partBox.hidden = true;
    partBox.dataset.testid = "chart-part";
    for (const dir of HANDLES) {
      const h = document.createElement("div");
      h.className = "adder-part-handle";
      h.dataset.dir = dir;
      partBox.append(h);
    }
    el.append(canvas, partBox, handle);
    this.grid.overlay.append(el);

    const chart = echarts.init(canvas, null, { renderer: "canvas" });
    const m: Mounted = { spec, draft: null, el, chart, part: null, partBox, hidden: {} };
    this.mounted.set(spec.id, m);
    this.render(m);

    el.addEventListener("keydown", (e) => {
      if (m.part) return this.onPartKey(m, e);
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.remove(m.spec.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.grid.focus();
      }
    });
    // The overlay sits outside the scroller, so pass wheel scrolling through.
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.grid.scrollBy(e.deltaX, e.deltaY);
      },
      { passive: false },
    );
    chart.on("legendselectchanged", (p) => {
      m.hidden = Object.fromEntries(Object.entries((p as { selected: Record<string, boolean> }).selected).filter(([, on]) => !on));
    });
    // ECharts reports the part under the pointer before the DOM event bubbles up here.
    let target: EditTarget | null = null;
    chart.on("contextmenu", (p) => {
      const part = ({ series: "series", legend: "legend", title: "title", xAxis: "xAxis", yAxis: "yAxis" } as const)[p.componentType as string];
      if (part) target = { id: m.spec.id, part, series: part === "series" ? p.seriesIndex : undefined };
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      el.focus({ preventScroll: true });
      const p = this.localPoint(m, e);
      const placed = partAt(chart, p.x, p.y);
      // The title and legend report events only from their text and entries, so fall back to geometry.
      const t: EditTarget = target ?? { id: m.spec.id, part: placed === "legend" || placed === "title" ? placed : "area" };
      target = null;
      const edit = (t: EditTarget) => ({ label: EDIT_LABELS[t.part], run: () => this.onEdit?.(t) });
      const reset =
        placed && hasLayout(m.spec.style ?? {}, placed)
          ? [{ label: `Reset ${PART_NAMES[placed]} Layout`, run: () => this.setStyle(m.spec.id, (s) => resetPart(s, placed)) }]
          : [];
      showMenu(e.clientX, e.clientY, [
        edit(t),
        ...(t.part === "area" ? [] : [edit({ id: m.spec.id, part: "area" })]),
        ...reset,
        "separator",
        { label: "Delete Chart", danger: true, run: () => this.remove(m.spec.id) },
      ]);
    });
    // Like Excel: the first click selects the chart; once it's selected, a click
    // on the title, legend or plot area selects that part, and dragging moves it.
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const selected = document.activeElement === el;
      el.focus({ preventScroll: true });
      const t = e.target as HTMLElement;
      if (t === handle) return this.dragResize(m, e);
      if (t.dataset.dir && m.part) return this.dragPart(m, e, t.dataset.dir);
      const p = this.localPoint(m, e);
      const part = selected ? partAt(chart, p.x, p.y) : null;
      this.selectPart(m, part);
      if (part) this.dragPart(m, e, "move");
      else this.dragMove(m, e);
    });
    el.addEventListener("dblclick", (e) => {
      const p = this.localPoint(m, e);
      const part = partAt(chart, p.x, p.y);
      this.onEdit?.({ id: m.spec.id, part: part ? PART_SECTION[part] : "area" });
    });
    el.addEventListener("focusout", (e) => {
      if (!el.contains(e.relatedTarget as Node | null)) this.selectPart(m, null);
    });
  }

  /** Mouse position in chart-canvas px (inside the 1px border). */
  private localPoint(m: Mounted, e: MouseEvent): { x: number; y: number } {
    const r = m.el.getBoundingClientRect();
    return { x: e.clientX - r.left - 1, y: e.clientY - r.top - 1 };
  }

  private selectPart(m: Mounted, part: MovablePart | null): void {
    m.part = part;
    this.syncPart(m);
  }

  /** Outline the selected part where ECharts drew it; drop the selection if it's gone. */
  private syncPart(m: Mounted): void {
    const r = m.part && partRect(m.chart, m.part);
    if (!m.part || !r) {
      m.part = null;
      m.partBox.hidden = true;
      return;
    }
    const b = m.partBox;
    b.hidden = false;
    b.dataset.part = m.part;
    b.setAttribute("aria-label", `${PART_NAMES[m.part]} selected`);
    b.classList.toggle("resizable", RESIZABLE[m.part]);
    Object.assign(b.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  /** Style with the selected part at `r`; moving the title or legend pins the plot area first. */
  private placed(m: Mounted, base: ChartStyle, r: Rect): ChartStyle {
    const size = canvasSize(m.spec);
    return placePart(base, m.part!, clampRect(r, size, RESIZABLE[m.part!] ? MIN_PART : 1), size);
  }

  private onPartKey(m: Mounted, e: KeyboardEvent): void {
    const part = m.part!;
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (e.key === "Escape") {
      this.selectPart(m, null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // Excel deletes the title or legend; the plot area stays.
      if (part !== "plot") this.setStyle(m.spec.id, (s) => ({ ...s, [part]: { ...s[part], show: false } }));
    } else if (nudge) {
      const r = partRect(m.chart, part);
      if (!r) return;
      const step = e.shiftKey ? 10 : 1;
      const base = part === "plot" ? (m.spec.style ?? {}) : pinPlot(m.chart, m.spec.style ?? {}, canvasSize(m.spec));
      this.update(m.spec.id, { style: this.placed(m, base, { ...r, x: r.x + nudge[0]! * step, y: r.y + nudge[1]! * step }) });
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** Move ("move") or resize (a handle direction such as "se") the selected part, previewing live. */
  private dragPart(m: Mounted, start: MouseEvent, dir: string): void {
    const part = m.part;
    const r0 = part && partRect(m.chart, part);
    if (!part || !r0) return;
    const base = part === "plot" ? (m.spec.style ?? {}) : pinPlot(m.chart, m.spec.style ?? {}, canvasSize(m.spec));
    let style: ChartStyle | null = null;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - start.clientX;
      const dy = e.clientY - start.clientY;
      if (!style && Math.abs(dx) + Math.abs(dy) < 3) return; // a click, not a drag
      const r = { ...r0 };
      if (dir === "move") {
        r.x += dx;
        r.y += dy;
      } else {
        // Dragging an edge moves only that edge; the opposite one stays put.
        const right = r0.x + r0.width;
        const bottom = r0.y + r0.height;
        if (dir.includes("e")) r.width = Math.max(MIN_PART, r0.width + dx);
        if (dir.includes("s")) r.height = Math.max(MIN_PART, r0.height + dy);
        if (dir.includes("w")) r.x = Math.max(0, Math.min(right - MIN_PART, r0.x + dx));
        if (dir.includes("w")) r.width = right - r.x;
        if (dir.includes("n")) r.y = Math.max(0, Math.min(bottom - MIN_PART, r0.y + dy));
        if (dir.includes("n")) r.height = bottom - r.y;
      }
      style = this.placed(m, base, r);
      m.draft = { ...m.spec, style };
      this.render(m, false);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      m.draft = null;
      if (!style) return;
      this.swallowClick(m);
      this.update(m.spec.id, { style });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private unmount(m: Mounted): void {
    m.chart.dispose();
    m.el.remove();
  }

  private dragMove(m: Mounted, start: MouseEvent): void {
    const host = this.grid.overlay.getBoundingClientRect();
    const o = this.grid.cellOffset(m.spec.anchor.row, m.spec.anchor.col);
    const x0 = o.x + m.spec.anchor.dx;
    const y0 = o.y + m.spec.anchor.dy;
    let x = x0;
    let y = y0;
    const onMove = (e: MouseEvent) => {
      // Keep the top-left corner inside the cell area.
      x = Math.max(0, Math.min(host.width - 20, x0 + e.clientX - start.clientX));
      y = Math.max(0, Math.min(host.height - 20, y0 + e.clientY - start.clientY));
      m.el.style.transform = `translate(${x}px, ${y}px)`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (x === x0 && y === y0) return;
      this.swallowClick(m);
      this.update(m.spec.id, { anchor: this.grid.cellAtOffset(x, y) });
      this.place(m);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private dragResize(m: Mounted, start: MouseEvent): void {
    const { width: w0, height: h0 } = m.spec;
    let width = w0;
    let height = h0;
    const onMove = (e: MouseEvent) => {
      width = Math.max(MIN_SIZE, Math.round(w0 + e.clientX - start.clientX));
      height = Math.max(MIN_SIZE, Math.round(h0 + e.clientY - start.clientY));
      m.el.style.width = `${width}px`;
      m.el.style.height = `${height}px`;
      m.chart.resize();
      m.draft = { ...m.spec, width, height };
      this.render(m, false);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      m.draft = null;
      if (width === w0 && height === h0) return;
      this.swallowClick(m);
      this.update(m.spec.id, { width, height });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /**
   * Re-read every mounted chart's data on the next frame. Any edit can change a
   * chart's values through formulas, and the ranges are small, so no intersection test.
   */
  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      for (const m of this.mounted.values()) this.render(m);
    });
  }

  /**
   * A drag ends in a click; stop it reaching ECharts, which would toggle a legend
   * entry the drag started on. The click follows mouseup before any timer runs.
   */
  private swallowClick(m: Mounted): void {
    const stop = (e: Event) => e.stopPropagation();
    m.el.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => m.el.removeEventListener("click", stop, { capture: true }));
  }

  /** Draw a chart (its draft while dragging); dragging previews without animation. */
  private render(m: Mounted, animate = !this.reducedMotion.matches): void {
    const spec = m.draft ?? m.spec;
    const sheet = this.engine.sheets().findIndex((s) => s.name === spec.sheet);
    if (sheet < 0) return;
    const values = this.engine.getRangeValues({ sheet, ...spec.range });
    const option = toOption(spec, values, this.palette, animate && !m.draft);
    const legend = option.legend as Record<string, unknown> | undefined;
    if (legend) legend.selected = Object.fromEntries(Object.keys(m.hidden).map((name) => [name, false]));
    m.chart.setOption(option, true);
    this.syncPart(m);
  }
}
