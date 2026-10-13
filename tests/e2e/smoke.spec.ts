import { expect, test } from "@playwright/test";

test("edit a cell and see the formula result", async ({ page }) => {
  await page.goto("/");
  const grid = page.getByTestId("grid");
  await grid.click({ position: { x: 100, y: 36 } }); // A1
  await page.keyboard.type("=1+2");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("formula-input")).toHaveValue("=1+2");
  await page.screenshot({ path: "test-results/grid.png" });
});
