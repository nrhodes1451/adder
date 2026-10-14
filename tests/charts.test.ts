import { describe, expect, it } from "vitest";
import { type ChartSpec, inferSeries, toOption } from "../src/charts/model";
import { clampRect, hasLayout, placePart, resetPart } from "../src/charts/parts";
import { LIGHT } from "../src/grid/renderer";

const spec = (type: ChartSpec["type"]): ChartSpec => ({
  id: "c",
  sheet: "Sheet1",
  range: { row: 1, col: 1, rows: 3, cols: 3 },
  type,
  anchor: { row: 1, col: 5, dx: 0, dy: 0 },
  width: 480,
  height: 300,
});

describe("inferSeries", () => {
  it("reads a header row and a label column", () => {
    const d = inferSeries([
      [null, "Sales", "Costs"],
      ["Jan", 10, 4],
      ["Feb", 12, 5],
      ["Mar", 9, 3],
    ]);
    expect(d.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(d.series).toEqual([
      { name: "Sales", data: [10, 12, 9] },
      { name: "Costs", data: [4, 5, 3] },
    ]);
  });

  it("numbers categories for plain numbers", () => {
    const d = inferSeries([[1], [2], [3]]);
    expect(d.categories).toEqual(["1", "2", "3"]);
    expect(d.series).toEqual([{ name: "Series 1", data: [1, 2, 3] }]);
  });

  it("runs series along rows for wide data", () => {
    const d = inferSeries([
      [null, "Q1", "Q2", "Q3"],
      ["North", 1, 2, 3],
    ]);
    expect(d.categories).toEqual(["Q1", "Q2", "Q3"]);
    expect(d.series).toEqual([{ name: "North", data: [1, 2, 3] }]);
  });

  it("treats non-numbers in the data as gaps", () => {
    expect(inferSeries([["x"], [1], ["oops"], [3]]).series[0]!.data).toEqual([1, null, 3]);
  });
});

describe("toOption", () => {
  const values = [
    [null, "Sales", "Costs"],
    ["Jan", 10, 4],
    ["Feb", 12, 5],
  ];

  it("builds category-axis bar and line charts", () => {
    for (const type of ["bar", "line"] as const) {
      const o = toOption(spec(type), values, LIGHT, false) as any;
      expect(o.xAxis.data).toEqual(["Jan", "Feb"]);
      expect(o.series.map((s: any) => [s.type, s.name])).toEqual([
        [type, "Sales"],
        [type, "Costs"],
      ]);
      expect(o.color).toEqual(LIGHT.refColors);
    }
  });

  it("uses the first series for a pie", () => {
    const o = toOption(spec("pie"), values, LIGHT, false) as any;
    expect(o.series[0].data).toEqual([
      { name: "Jan", value: 10 },
      { name: "Feb", value: 12 },
    ]);
  });

  it("plots scatter as the first series against the rest", () => {
    const o = toOption(spec("scatter"), [["x", "y"], [1, 2], [3, 4]], LIGHT, false) as any;
    expect(o.series).toHaveLength(1);
    expect(o.series[0].data).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("titles a single-series chart with its name", () => {
    const o = toOption(spec("bar"), [["Sales"], [1], [2]], LIGHT, false) as any;
    expect(o.title.text).toBe("Sales");
  });
});

describe("toOption styles", () => {
  const values = [
    [null, "Sales", "Costs"],
    ["Jan", 10, 4],
    ["Feb", 12, 5],
  ];
  const styled = (type: ChartSpec["type"], style: ChartSpec["style"]) => toOption({ ...spec(type), style }, values, LIGHT, false) as any;

  it("applies series overrides by plotted index", () => {
    const o = styled("line", { series: { 1: { name: "Spend", color: "#ff0000", labels: true, width: 4, smooth: true } } });
    expect(o.series[0].name).toBe("Sales");
    expect(o.series[1]).toMatchObject({ name: "Spend", smooth: true, label: { show: true }, itemStyle: { color: "#ff0000" }, lineStyle: { color: "#ff0000", width: 4 } });
    expect(o.legend).toBeDefined();
  });

  it("formats title, legend, axes and the chart area", () => {
    const o = styled("bar", {
      area: { background: "#101010", font: "serif" },
      title: { text: "Q1", size: 20, italic: true, align: "left" },
      legend: { position: "right", bold: true },
      yAxis: { title: "GBP", min: 0, max: 50, gridLines: false },
    });
    expect(o.backgroundColor).toBe("#101010");
    expect(o.title).toMatchObject({ text: "Q1", left: "left", textStyle: { fontSize: 20, fontStyle: "italic", fontFamily: expect.stringContaining("Georgia") } });
    expect(o.legend).toMatchObject({ right: 8, orient: "vertical", textStyle: { fontWeight: 600 } });
    expect(o.yAxis).toMatchObject({ name: "GBP", min: 0, max: 50, splitLine: { show: false } });
    expect(o.grid.right).toBeGreaterThan(100);
  });

  it("hides the title and legend when asked", () => {
    const o = styled("bar", { title: { show: false, text: "x" }, legend: { show: false } });
    expect(o.title).toBeUndefined();
    expect(o.legend).toBeUndefined();
  });

  it("colours pie slices individually", () => {
    const o = styled("pie", { series: { 0: { points: { 1: "#00ff00" } } } });
    expect(o.series[0].data[1].itemStyle).toEqual({ color: "#00ff00" });
    expect(o.series[0].data[0].itemStyle).toBeUndefined();
  });

  it("keys scatter styles on the plotted Y series", () => {
    const o = toOption({ ...spec("scatter"), style: { series: { 0: { color: "#123456" } } } }, [["x", "y"], [1, 2]], LIGHT, false) as any;
    expect(o.series[0].itemStyle.color).toBe("#123456");
  });
});

describe("hand-placed layout", () => {
  const values = [
    [null, "Sales", "Costs"],
    ["Jan", 10, 4],
    ["Feb", 12, 5],
  ];
  const styled = (type: ChartSpec["type"], style: ChartSpec["style"]) => toOption({ ...spec(type), style }, values, LIGHT, false) as any;

  it("places the plot area exactly, with labels outside it", () => {
    const o = styled("bar", { plot: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } });
    expect(o.grid).toEqual({ left: "10%", top: "20%", width: "50%", height: "25%", outerBoundsMode: "none" });
  });

  it("places the title and legend by their top-left corner", () => {
    const o = styled("bar", { title: { text: "T", pos: { x: 0.05, y: 0.5 } }, legend: { pos: { x: 0.7, y: 0.1, w: 0.25, h: 0.3 } } });
    expect(o.title).toMatchObject({ left: "5%", top: "50%", padding: 0 });
    expect(o.legend).toMatchObject({ left: "70%", top: "10%", width: "25%", height: "30%", padding: 0 });
    expect(o.legend.selectedMode).toBeUndefined(); // entries stay clickable to hide series
    expect(o.legend.bottom).toBeUndefined();
  });

  it("sizes a placed pie to fit its box", () => {
    // Canvas is 478x298 (480x300 less the border); a 0.5 x 0.5 box is 239 x 149, so radius 74.5.
    const o = styled("pie", { plot: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
    expect(o.series[0].center).toEqual(["50%", "50%"]);
    expect(o.series[0].radius).toEqual(["0%", 74.5]);
  });
});

describe("part layout helpers", () => {
  const size = { width: 400, height: 200 };

  it("stores boxes as fractions, with sizes only for resizable parts", () => {
    const r = { x: 40, y: 20, width: 200, height: 100 };
    expect(placePart({}, "plot", r, size).plot).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(placePart({}, "legend", r, size).legend?.pos).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(placePart({ title: { text: "T" } }, "title", r, size).title).toEqual({ text: "T", pos: { x: 0.1, y: 0.1 } });
  });

  it("resets a part to automatic layout, keeping its formatting", () => {
    const style = { plot: { x: 0, y: 0, w: 1, h: 1 }, legend: { bold: true, pos: { x: 0, y: 0 } }, title: { pos: { x: 0, y: 0 } } };
    expect(resetPart(style, "plot").plot).toBeUndefined();
    expect(resetPart(style, "legend").legend).toEqual({ bold: true });
    expect(resetPart(style, "title").title).toBeUndefined();
    expect(hasLayout(style, "legend")).toBe(true);
    expect(hasLayout(resetPart(style, "legend"), "legend")).toBe(false);
  });

  it("keeps boxes inside the canvas and above a minimum size", () => {
    expect(clampRect({ x: -10, y: 190, width: 50, height: 50 }, size, 24)).toEqual({ x: 0, y: 150, width: 50, height: 50 });
    expect(clampRect({ x: 0, y: 0, width: 5, height: 900 }, size, 24)).toEqual({ x: 0, y: 0, width: 24, height: 200 });
  });
});

describe("markers", () => {
  const values = [
    [null, "Sales", "Costs"],
    ["Jan", 10, 4],
    ["Feb", 12, 5],
  ];
  const line = (series: NonNullable<ChartSpec["style"]>["series"]) => (toOption({ ...spec("line"), style: { series } }, values, LIGHT, false) as any).series;

  it("defaults to ECharts' hollow circles, with the line in the series colour", () => {
    const [s] = line({});
    expect(s).toMatchObject({ symbol: "emptyCircle", symbolSize: 6, showSymbol: true, lineStyle: { color: LIGHT.refColors[0] } });
  });

  it("turns markers off", () => {
    const [s] = line({ 0: { markers: false } });
    expect(s).toMatchObject({ symbol: "none", showSymbol: false });
  });

  it("styles solid markers independently of the line", () => {
    const [s] = line({ 0: { color: "#111111", marker: { shape: "diamond", size: 12, fill: "#00ff00", border: "#0000ff", borderWidth: 3 } } });
    expect(s).toMatchObject({
      symbol: "diamond",
      symbolSize: 12,
      itemStyle: { color: "#00ff00", borderColor: "#0000ff", borderWidth: 3 },
      lineStyle: { color: "#111111" },
    });
  });

  it("colours a hollow marker with its border colour", () => {
    const [s] = line({ 0: { marker: { shape: "emptyRect", border: "#ff00ff", fill: "#ignored" } } });
    expect(s.itemStyle).toEqual({ color: "#ff00ff" });
  });

  it("gives a solid marker a 1px border once a border colour is set", () => {
    expect(line({ 0: { marker: { shape: "circle", border: "#000000" } } })[0].itemStyle.borderWidth).toBe(1);
    expect(line({ 0: { marker: { shape: "circle" } } })[0].itemStyle.borderWidth).toBeUndefined();
  });

  it("uses marker settings for scatter points, falling back to the old point size", () => {
    const scatter = (f: object) => (toOption({ ...spec("scatter"), style: { series: { 0: f } } }, [["x", "y"], [1, 2]], LIGHT, false) as any).series[0];
    expect(scatter({})).toMatchObject({ symbol: "circle", symbolSize: 10 });
    expect(scatter({ width: 14 }).symbolSize).toBe(14);
    expect(scatter({ width: 14, marker: { size: 8, shape: "triangle" } })).toMatchObject({ symbol: "triangle", symbolSize: 8 });
  });
});
