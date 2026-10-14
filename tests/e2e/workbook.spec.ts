import { expect, type Page, test } from "@playwright/test";

const nameBox = (p: Page) => p.getByLabel("Cell reference");
const formula = (p: Page) => p.getByTestId("formula-input");
const grid = (p: Page) => p.getByTestId("grid");

/** Click cell (row, col) assuming default sizes (64px row header, 90×25 cells, 24px col header). */
async function clickCell(page: Page, row: number, col: number) {
  await grid(page).click({ position: { x: 64 + (col - 1) * 90 + 45, y: 24 + (row - 1) * 25 + 12 } });
}

async function clipboardEvent(page: Page, type: "copy" | "cut" | "paste", text?: string): Promise<string> {
  return page.evaluate(
    ([type, text]) => {
      const dt = new DataTransfer();
      if (text !== undefined) dt.setData("text/plain", text);
      document.activeElement!.dispatchEvent(new ClipboardEvent(type!, { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData("text/plain");
    },
    [type, text] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await clickCell(page, 1, 1);
});

test("edits persist across reload", async ({ page }) => {
  await page.keyboard.type("=1+2");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.reload();
  await clickCell(page, 1, 1);
  await expect(formula(page)).toHaveValue("=1+2");
});

test("undo and redo", async ({ page }) => {
  await page.keyboard.type("a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Control+z");
  await expect(formula(page)).toHaveValue("");
  await page.keyboard.press("Control+y");
  await expect(formula(page)).toHaveValue("a");
});

test("sheet tabs: add, rename, switch", async ({ page }) => {
  await page.keyboard.type("on sheet 1");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add sheet" }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet2");
  await page.getByRole("tab", { name: "Sheet2" }).dblclick();
  await page.getByLabel("Sheet name").fill("Data");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "Data" })).toBeVisible();
  await clickCell(page, 1, 1);
  await page.keyboard.type("=Sheet1!A1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=Sheet1!A1");
  await page.getByRole("tab", { name: "Sheet1" }).click();
  await clickCell(page, 1, 1);
  await expect(formula(page)).toHaveValue("on sheet 1");
});

test("Ctrl(+Shift)+PageUp/PageDown switch sheets", async ({ page }) => {
  await page.getByRole("button", { name: "Add sheet" }).click();
  await page.getByRole("button", { name: "Add sheet" }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet3");
  await page.keyboard.press("Control+PageDown");
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet3");
  await page.keyboard.press("Control+PageUp");
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet2");
  await page.keyboard.press("Control+Shift+PageUp");
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet1");
  await page.keyboard.press("Control+PageUp");
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet1");
  await page.keyboard.press("Control+Shift+PageDown");
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Sheet2");
});

test("copy/paste internally adjusts formulas; external TSV pastes as a block", async ({ page }) => {
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("=A1*10");
  await page.keyboard.press("Enter");
  await clickCell(page, 1, 1);
  await page.keyboard.press("Shift+ArrowRight");
  const copied = await clipboardEvent(page, "copy");
  expect(copied).toBe("2\t20");
  await clickCell(page, 3, 1);
  await clipboardEvent(page, "paste", copied);
  await clickCell(page, 3, 2);
  await expect(formula(page)).toHaveValue("=A3*10");

  await clickCell(page, 5, 1);
  await clipboardEvent(page, "paste", "x\ty\n1\t2\n");
  await expect(nameBox(page)).toHaveValue("A5:B6");
  await clickCell(page, 6, 2);
  await expect(formula(page)).toHaveValue("2");
});

test("create a second workbook and switch back", async ({ page }) => {
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.getByLabel("Workbook name").fill("First");
  await page.getByLabel("Workbook name").press("Enter");
  await page.getByLabel("Open workbook").selectOption("__new");
  await expect(page.getByLabel("Workbook name")).toHaveValue("Untitled");
  await clickCell(page, 1, 1);
  await expect(formula(page)).toHaveValue("");
  const first = page.getByLabel("Open workbook").locator("option", { hasText: "First" });
  await page.getByLabel("Open workbook").selectOption(await first.getAttribute("value"));
  await expect(page.getByLabel("Workbook name")).toHaveValue("First");
  await clickCell(page, 1, 1);
  await expect(formula(page)).toHaveValue("first");
  await page.screenshot({ path: "test-results/workbook.png" });
});

test("pasting one copied cell fills the whole selection, shifting formulas", async ({ page }) => {
  await page.keyboard.type("1");
  await page.keyboard.press("Tab");
  await page.keyboard.type("=A1*10");
  await page.keyboard.press("Enter");
  await clickCell(page, 1, 2);
  await clipboardEvent(page, "copy");
  await clickCell(page, 2, 3);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await clipboardEvent(page, "paste", "10");
  await expect(nameBox(page)).toHaveValue("C2:D3"); // selection kept
  await clickCell(page, 3, 4);
  await expect(formula(page)).toHaveValue("=C3*10");

  // External text fills too; one undo reverts the whole fill.
  await clickCell(page, 5, 1);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await clipboardEvent(page, "paste", "x\n");
  await clickCell(page, 7, 1);
  await expect(formula(page)).toHaveValue("x");
  await page.keyboard.press("Control+z");
  await expect(formula(page)).toHaveValue("");
  await clickCell(page, 5, 1);
  await expect(formula(page)).toHaveValue("");
});

test("ctrl+enter puts the typed value in every selected cell", async ({ page }) => {
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.type("=ROW()*10");
  await page.keyboard.press("Control+Enter");
  await expect(nameBox(page)).toHaveValue("A1:B2");
  await clickCell(page, 2, 2);
  await expect(formula(page)).toHaveValue("=ROW()*10");

  // Relative references shift from the edited cell.
  await clickCell(page, 4, 3);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.type("=A1");
  await page.keyboard.press("Control+Enter");
  await clickCell(page, 5, 3);
  await expect(formula(page)).toHaveValue("=A2");

  // Also from the formula bar.
  await clickCell(page, 7, 1);
  await page.keyboard.press("Shift+ArrowRight");
  await formula(page).fill("same");
  await formula(page).press("Control+Enter");
  await clickCell(page, 7, 2);
  await expect(formula(page)).toHaveValue("same");
});
