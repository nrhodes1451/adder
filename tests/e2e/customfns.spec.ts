import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import * as XLSX from "xlsx";

test.describe.configure({ timeout: 180_000 });

const formula = (p: Page) => p.getByTestId("formula-input");

async function clickCell(page: Page, row: number, col: number) {
  await page.getByTestId("grid").click({ position: { x: 64 + (col - 1) * 90 + 45, y: 24 + (row - 1) * 25 + 12 } });
}

async function typeAt(page: Page, row: number, col: number, text: string) {
  await clickCell(page, row, col);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** Read the rendered text of a cell via the engine (the grid is a canvas). */
const display = (page: Page, row: number, col: number) =>
  page.evaluate(([r, c]) => {
    const g = (window as unknown as { adderGrid?: { sheet: number; engine: { getDisplay(s: number, r: number, c: number): string } } }).adderGrid;
    return g ? g.engine.getDisplay(g.sheet, r!, c!) : null; // null while the app is still booting
  }, [row, col] as const);

test("custom functions and on_edit hooks", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Python" }).click();
  await page.waitForFunction(() => "adderScriptEditor" in window);
  await page.evaluate(() =>
    (window as unknown as { adderScriptEditor: { setValue(v: string): void } }).adderScriptEditor.setValue(`
import adder

@adder.function
def double(x):
    return x * 2

@adder.function
def total(rows):
    return sum(v for r in rows for v in r if isinstance(v, (int, float)))

@adder.on_edit("Sheet1!B:B")
def stamp(event):
    event.range.offset(cols=1).value = f"B changed to {event.value}"
`),
  );
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByTestId("console")).toContainText("✓ Done", { timeout: 120_000 });

  await typeAt(page, 1, 1, "5");
  await typeAt(page, 2, 1, "=DOUBLE(A1)+1");
  await expect.poll(() => display(page, 2, 1)).toBe("11");
  await clickCell(page, 2, 1);
  await expect(formula(page)).toHaveValue("=DOUBLE(A1)+1");

  await typeAt(page, 1, 1, "7");
  await expect.poll(() => display(page, 2, 1)).toBe("15");

  await typeAt(page, 3, 1, "=TOTAL(A1:A2)*10");
  await expect.poll(() => display(page, 3, 1)).toBe("220");

  await typeAt(page, 1, 2, "hello");
  await expect.poll(() => display(page, 1, 3)).toBe("B changed to hello");

  // Export keeps the user's formula and drops the bookkeeping sheet.
  const dl = page.waitForEvent("download");
  await page.getByLabel("File", { exact: true }).selectOption("xlsx");
  const wb = XLSX.read(readFileSync(await (await dl).path()), { type: "buffer", cellFormula: true });
  expect(wb.SheetNames).toEqual(["Sheet1"]);
  expect(wb.Sheets.Sheet1!.A2!.f).toBe("DOUBLE(A1)+1");
  expect(wb.Sheets.Sheet1!.A2!.v).toBe(15);

  // Results persist; the formula bar still shows the original after reload.
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.reload();
  await expect.poll(() => display(page, 2, 1)).toBe("15");
  await clickCell(page, 3, 1);
  await expect(formula(page)).toHaveValue("=TOTAL(A1:A2)*10");
});
