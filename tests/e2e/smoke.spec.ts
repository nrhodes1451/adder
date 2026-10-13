import { expect, test } from "@playwright/test";

test("engine spike renders SUM", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("spike")).toHaveText("SUM(A1:A3) = 6");
});
