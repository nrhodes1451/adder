import { expect, type Page, test } from "@playwright/test";

const nameBox = (p: Page) => p.getByLabel("Cell reference");
const formula = (p: Page) => p.getByTestId("formula-input");

async function typeCell(page: Page, text: string) {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("grid").click({ position: { x: 100, y: 36 } }); // A1
});

test("keyboard navigation and range selection", async ({ page }) => {
  await expect(nameBox(page)).toHaveValue("A1");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(nameBox(page)).toHaveValue("B2");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(nameBox(page)).toHaveValue("B2:C3");
  await page.keyboard.press("Tab");
  await expect(nameBox(page)).toHaveValue("B2:C3"); // Tab cycles within the selection
});

test("ctrl+arrow jumps to data edges", async ({ page }) => {
  for (const v of ["1", "2", "3"]) await typeCell(page, v);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowDown");
  await expect(nameBox(page)).toHaveValue("A3");
});

test("escape cancels, delete clears, F2 edits", async ({ page }) => {
  await typeCell(page, "hello");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("bye");
  await page.keyboard.press("Escape");
  await expect(formula(page)).toHaveValue("hello");
  await page.keyboard.press("F2");
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("hello!");
  await page.keyboard.press("Delete");
  await expect(formula(page)).toHaveValue("");
});

test("formula bar edits the active cell", async ({ page }) => {
  await formula(page).fill("=6*7");
  await formula(page).press("Enter");
  await expect(nameBox(page)).toHaveValue("A2");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=6*7");
});

test("clicking a cell while typing a formula inserts a reference", async ({ page }) => {
  await typeCell(page, "5");
  await page.keyboard.type("=");
  await page.getByTestId("grid").click({ position: { x: 100, y: 36 } }); // A1
  await page.keyboard.type("*2");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=A1*2");
});
