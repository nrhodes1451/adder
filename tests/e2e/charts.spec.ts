import { expect, type Page, test } from "@playwright/test";

const chart = (p: Page) => p.getByTestId("chart");
const seriesData = (p: Page) =>
  p.evaluate(() => (window as any).adderCharts.option(0).series.map((s: { data: unknown }) => s.data));

async function typeCell(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // no chart animation, so hit-testing sees final shapes
  await page.goto("/");
  await page.getByTestId("grid").click({ position: { x: 100, y: 36 } }); // A1
  // A1:B4 with a header row and a label column.
  for (const v of ["Month", "Jan", "Feb", "Mar"]) await typeCell(page, v);
  await page.getByTestId("grid").click({ position: { x: 190, y: 36 } }); // B1
  for (const v of ["Sales", "10", "12", "9"]) await typeCell(page, v);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByLabel("Insert chart").selectOption("bar");
  await expect(chart(page)).toBeVisible();
});

test("inserts a chart that follows edits", async ({ page }) => {
  expect(await seriesData(page)).toEqual([[10, 12, 9]]);
  await page.getByTestId("grid").click({ position: { x: 190, y: 61 } }); // B2
  await page.keyboard.type("20");
  await page.keyboard.press("Enter");
  await expect.poll(() => seriesData(page)).toEqual([[20, 12, 9]]);
});

test("chart scrolls with the cells", async ({ page }) => {
  const before = (await chart(page).boundingBox())!;
  await page.mouse.move(400, 500);
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await chart(page).boundingBox())!.y).toBeLessThan(before.y - 50);
});

test("chart persists, hides on other sheets, and deletes", async ({ page }) => {
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.reload();
  await expect(chart(page)).toBeVisible();

  await page.getByLabel("Add sheet").click();
  await expect(chart(page)).toHaveCount(0);
  await page.getByRole("tab", { name: "Sheet1" }).click();
  await expect(chart(page)).toBeVisible();

  await chart(page).click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Delete");
  await expect(chart(page)).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("grid")).toBeVisible();
  await expect(chart(page)).toHaveCount(0);
});

/** Viewport point of a chart-relative pixel. */
async function chartPoint(page: Page, x: number, y: number) {
  const box = (await chart(page).boundingBox())!;
  return { x: box.x + 1 + x, y: box.y + 1 + y };
}

test("right-click a series to format it in the side panel", async ({ page }) => {
  // Middle of the Feb bar (value 12).
  const [x, y] = await page.evaluate(() => (window as any).adderCharts.instance(0).convertToPixel({ seriesIndex: 0 }, [1, 6]));
  const p = await chartPoint(page, x, y);
  await page.mouse.click(p.x, p.y, { button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit Series", "Edit Chart Area", "Delete Chart"]);
  await menu.getByRole("menuitem", { name: "Edit Series" }).click();
  await expect(menu).toHaveCount(0);

  const panel = page.getByTestId("chart-panel");
  await expect(panel.locator("details[open] summary")).toHaveText(["Series"]);
  await panel.getByLabel("Series name").fill("Revenue");
  await panel.getByLabel("Data labels").check();
  await expect.poll(() => page.evaluate(() => (window as any).adderCharts.option(0).series[0])).toMatchObject({ name: "Revenue", label: { show: true } });

  // Persisted with the workbook.
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.reload();
  await expect(chart(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).adderCharts.option(0).series[0].name)).toBe("Revenue");
});

test("right-click the title, axis and empty area", async ({ page }) => {
  const menuItems = () => page.getByTestId("context-menu").getByRole("menuitem");
  const box = (await chart(page).boundingBox())!;
  // Title: a single series is titled with its name, centred at the top.
  await page.mouse.click(box.x + box.width / 2, box.y + 16, { button: "right" });
  await expect(menuItems().first()).toHaveText("Edit Title");
  await page.keyboard.press("Escape");
  await expect(menuItems()).toHaveCount(0);

  // Vertical axis label "0" at the bottom-left of the plot.
  const label = await page.evaluate(() => {
    const c = (window as any).adderCharts.instance(0);
    const plot = c.getModel().getComponent("grid").coordinateSystem.getRect();
    return { x: plot.x - 12, y: c.convertToPixel({ yAxisIndex: 0 }, 0) as number };
  });
  const yLabel = await chartPoint(page, label.x, label.y);
  await page.mouse.click(yLabel.x, yLabel.y, { button: "right" });
  await expect(menuItems().first()).toHaveText("Edit Vertical Axis");
  await menuItems().first().click();
  const panel = page.getByTestId("chart-panel");
  await panel.getByLabel("Maximum").fill("40");
  await expect.poll(() => page.evaluate(() => (window as any).adderCharts.option(0).yAxis[0].max)).toBe(40);

  // Empty corner: chart area; changing the type there redraws.
  await page.mouse.click(box.x + box.width - 6, box.y + 6, { button: "right" });
  await expect(menuItems()).toHaveText(["Edit Chart Area", "Delete Chart"]);
  await menuItems().first().click();
  await panel.getByLabel("Chart type").selectOption("line");
  await expect.poll(() => page.evaluate(() => (window as any).adderCharts.option(0).series[0].type)).toBe("line");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
});

test("right-click the legend", async ({ page }) => {
  // Add a second series so the legend shows.
  await page.getByTestId("grid").click({ position: { x: 280, y: 36 } }); // C1
  for (const v of ["Costs", "4", "6", "5"]) await typeCell(page, v);
  await page.getByTestId("grid").click({ position: { x: 100, y: 36 } });
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByLabel("Insert chart").selectOption("bar");
  const second = chart(page).last();
  const box = (await second.boundingBox())!;
  const legend = await page.evaluate(() => {
    const c = (window as any).adderCharts.instance(1);
    const view = c.getViewOfComponentModel(c.getModel().getComponent("legend"));
    const r = view.group.getBoundingRect();
    return { x: view.group.x + r.x + 12, y: view.group.y + r.y + r.height / 2 };
  });
  await page.mouse.click(box.x + 1 + legend.x, box.y + 1 + legend.y, { button: "right" });
  await expect(page.getByTestId("context-menu").getByRole("menuitem").first()).toHaveText("Edit Legend");
  await page.getByTestId("context-menu").getByRole("menuitem").first().click();
  await page.getByTestId("chart-panel").getByLabel("Position").selectOption("top");
  await expect.poll(() => page.evaluate(() => (window as any).adderCharts.option(1).legend[0].top)).toBeGreaterThan(0);
});

test.describe("moving and resizing chart parts", () => {
  type Rect = { x: number; y: number; width: number; height: number };
  const bounds = (page: Page, part: string, index = 0): Promise<Rect> =>
    page.evaluate(([i, p]) => (window as any).adderCharts.partBounds(i, p), [index, part] as const);
  const part = (p: Page) => p.getByTestId("chart-part");
  /** Same box to within a pixel (layouts are saved as rounded percentages). */
  const expectSameBox = (a: Rect | null, b: Rect) => {
    for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(a![k] - b[k])).toBeLessThan(1);
  };

  /** Drag from a chart-canvas point by (dx, dy). */
  async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
    const a = await chartPoint(page, from.x, from.y);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + dx / 2, a.y + dy / 2, { steps: 3 });
    await page.mouse.move(a.x + dx, a.y + dy, { steps: 3 });
    await page.mouse.up();
  }

  test.beforeEach(async ({ page }) => {
    // Two series, so the chart has a legend; then select the chart.
    await page.getByTestId("grid").click({ position: { x: 280, y: 36 } }); // C1
    for (const v of ["Costs", "4", "6", "5"]) await typeCell(page, v);
    // Replace the single-series chart from the outer beforeEach.
    await chart(page).click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Delete");
    await expect(chart(page)).toHaveCount(0);
    await page.getByTestId("grid").click({ position: { x: 100, y: 36 } });
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.getByLabel("Insert chart").selectOption("bar");
    await expect(chart(page)).toHaveCount(1);
  });

  test("drag the legend; the plot area stays put", async ({ page }) => {
    const legend = await bounds(page, "legend");
    const plot = await bounds(page, "plot");
    // Chart is focused after insert, so this click selects the legend.
    await drag(page, { x: legend.x + 10, y: legend.y + legend.height / 2 }, -120, -180);
    await expect(part(page)).toBeVisible();
    await expect(part(page)).toHaveAttribute("data-part", "legend");
    const moved = await bounds(page, "legend");
    expect(Math.round(moved.x - legend.x)).toBe(-120);
    expect(Math.round(moved.y - legend.y)).toBe(-180);
    expectSameBox(await bounds(page, "plot"), plot);

    // A second drag doesn't drift.
    await drag(page, { x: moved.x + 10, y: moved.y + moved.height / 2 }, 30, 20);
    const again = await bounds(page, "legend");
    expect(Math.round(again.x - moved.x)).toBe(30);
    expect(Math.round(again.y - moved.y)).toBe(20);

    // Saved: survives a reload.
    await expect(page.getByTestId("save-state")).toHaveText("Saved");
    await page.reload();
    await expect(chart(page)).toBeVisible();
    const reloaded = await bounds(page, "legend");
    expect(Math.abs(reloaded.x - again.x)).toBeLessThan(1);
    expect(Math.abs(reloaded.y - again.y)).toBeLessThan(1);
  });

  test("resize and move the plot area", async ({ page }) => {
    const plot = await bounds(page, "plot");
    // Select the plot area, then drag its bottom-right handle in.
    const mid = await chartPoint(page, plot.x + plot.width / 2, plot.y + 10);
    await page.mouse.click(mid.x, mid.y);
    await expect(part(page)).toHaveAttribute("data-part", "plot");
    await expect(part(page).locator('[data-dir="se"]')).toBeVisible();
    await drag(page, { x: plot.x + plot.width, y: plot.y + plot.height }, -100, -60);
    const smaller = await bounds(page, "plot");
    expect(Math.round(smaller.x)).toBe(Math.round(plot.x));
    expect(Math.round(smaller.width - plot.width)).toBe(-100);
    expect(Math.round(smaller.height - plot.height)).toBe(-60);

    // Move it, then nudge with the keyboard.
    await drag(page, { x: smaller.x + smaller.width / 2, y: smaller.y + smaller.height / 2 }, 50, 30);
    const moved = await bounds(page, "plot");
    expect(Math.round(moved.x - smaller.x)).toBe(50);
    expect(Math.round(moved.width)).toBe(Math.round(smaller.width));
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(async () => Math.round((await bounds(page, "plot")).x - moved.x)).toBe(-10);

    // Reset from the context menu.
    const c = await bounds(page, "plot");
    const inPlot = await chartPoint(page, c.x + 5, c.y + 5);
    await page.mouse.click(inPlot.x, inPlot.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Reset Plot Area Layout" }).click();
    await expect.poll(async () => Math.abs((await bounds(page, "plot")).width - plot.width)).toBeLessThan(1);
    expectSameBox(await bounds(page, "plot"), plot);
  });

  test("delete hides the selected legend; Escape deselects", async ({ page }) => {
    const legend = await bounds(page, "legend");
    const p = await chartPoint(page, legend.x + 10, legend.y + legend.height / 2);
    await page.mouse.click(p.x, p.y);
    await expect(part(page)).toHaveAttribute("data-part", "legend");
    await page.keyboard.press("Escape");
    await expect(part(page)).toBeHidden();
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press("Delete");
    await expect(part(page)).toBeHidden();
    expect(await bounds(page, "legend")).toBeNull();
    await expect(chart(page)).toHaveCount(1); // the chart itself wasn't deleted
  });

  test("clicking a legend entry hides its series; dragging doesn't", async ({ page }) => {
    const shown = (name: string) =>
      page.evaluate((n) => (window as any).adderCharts.instance(0).getModel().getComponent("legend").isSelected(n), name);
    const legend = await bounds(page, "legend");
    const sales = await chartPoint(page, legend.x + 10, legend.y + legend.height / 2); // first entry

    await page.mouse.click(sales.x, sales.y);
    await expect.poll(() => shown("Sales")).toBe(false);
    expect(await shown("Costs")).toBe(true);

    // A redraw (a data edit) keeps it hidden.
    await page.getByTestId("grid").click({ position: { x: 280, y: 61 } }); // C2
    await page.keyboard.type("8");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).adderCharts.option(0).series[1].data[0])).toBe(8);
    expect(await shown("Sales")).toBe(false);

    // Click again to show it. (The chart lost focus to the grid, so this first click selects the chart.)
    await page.mouse.click(sales.x, sales.y);
    await expect.poll(() => shown("Sales")).toBe(true);

    // Dragging the legend by an entry moves it without toggling.
    await drag(page, { x: legend.x + 10, y: legend.y + legend.height / 2 }, -60, -40);
    await expect.poll(async () => Math.round((await bounds(page, "legend")).x - legend.x)).toBe(-60);
    expect(await shown("Sales")).toBe(true);

    // So does dragging the whole chart by it.
    await page.getByTestId("grid").click({ position: { x: 100, y: 300 } });
    const before = (await chart(page).boundingBox())!;
    const moved = await bounds(page, "legend");
    await drag(page, { x: moved.x + 10, y: moved.y + moved.height / 2 }, 30, 30);
    await expect.poll(async () => Math.round((await chart(page).boundingBox())!.x - before.x)).toBe(30);
    expect(await shown("Sales")).toBe(true);
  });

  test("the first click on an unselected chart moves the whole chart", async ({ page }) => {
    await page.getByTestId("grid").click({ position: { x: 100, y: 300 } });
    const before = (await chart(page).boundingBox())!;
    const plot = await bounds(page, "plot");
    await drag(page, { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 }, 40, 50);
    const after = (await chart(page).boundingBox())!;
    expect(Math.round(after.x - before.x)).toBe(40);
    expect(Math.round(after.y - before.y)).toBe(50);
    expectSameBox(await bounds(page, "plot"), plot);
  });
});

test("format line markers from the series panel", async ({ page }) => {
  const series0 = () => page.evaluate(() => (window as any).adderCharts.option(0).series[0]);
  // Switch to a line chart from the chart-area menu, then edit the series.
  const box = (await chart(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + 6, { button: "right" });
  await page.getByRole("menuitem", { name: "Edit Chart Area" }).click();
  const panel = page.getByTestId("chart-panel");
  await panel.getByLabel("Chart type").selectOption("line");
  await panel.locator("summary", { hasText: "Series" }).click();
  const series = panel.locator("details", { has: page.locator("summary", { hasText: "Series" }) });

  await expect(series.getByLabel("Show markers")).toBeChecked();
  await series.getByLabel("Marker shape").selectOption("diamond");
  await series.getByLabel("Size", { exact: true }).fill("14");
  await series.getByLabel("Fill").fill("#00aa00");
  await series.getByLabel("Border width").fill("2");
  await expect.poll(series0).toMatchObject({ symbol: "diamond", symbolSize: 14, itemStyle: { color: "#00aa00", borderWidth: 2 } });

  // Hollow shapes have a single colour.
  await series.getByLabel("Marker shape").selectOption("emptyTriangle");
  await expect(series.getByLabel("Fill")).toHaveCount(0);

  await series.getByLabel("Show markers").uncheck();
  await expect(series.getByLabel("Marker shape")).toHaveCount(0);
  await expect.poll(async () => (await series0()).symbol).toBe("none");
});
