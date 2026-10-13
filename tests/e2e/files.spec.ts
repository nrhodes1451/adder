import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const formula = (p: Page) => p.getByTestId("formula-input");

async function clickCell(page: Page, row: number, col: number) {
  await page.getByTestId("grid").click({ position: { x: 64 + (col - 1) * 90 + 45, y: 24 + (row - 1) * 25 + 12 } });
}

test("CSV import lands in a new sheet; xlsx export re-imports with formulas", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({
    name: "sales.csv",
    mimeType: "text/csv",
    buffer: Buffer.from('region,amount\n"North, East",10\nSouth,32\n'),
  });
  await expect(page.getByRole("tab", { selected: true })).toHaveText("sales");
  await clickCell(page, 2, 1);
  await expect(formula(page)).toHaveValue("North, East");
  await clickCell(page, 4, 2);
  await page.keyboard.type("=SUM(B2:B3)");
  await page.keyboard.press("Enter");

  const csvDownload = page.waitForEvent("download");
  await page.getByLabel("File", { exact: true }).selectOption("csv");
  const csv = readFileSync(await (await csvDownload).path(), "utf8");
  expect(csv).toBe('region,amount\r\n"North, East",10\r\nSouth,32\r\n,42\r\n');

  await page.getByLabel("Workbook name").fill("Report");
  await page.getByLabel("Workbook name").press("Enter");
  const xlsxDownload = page.waitForEvent("download");
  await page.getByLabel("File", { exact: true }).selectOption("xlsx");
  const dl = await xlsxDownload;
  expect(dl.suggestedFilename()).toBe("Report.xlsx");

  await page.getByTestId("file-input").setInputFiles({ name: "Report.xlsx", mimeType: "application/octet-stream", buffer: readFileSync(await dl.path()) });
  await expect(page.getByLabel("Workbook name")).toHaveValue("Report");
  await expect(page.getByRole("tab")).toHaveText(["Sheet1", "sales"]);
  await page.getByRole("tab", { name: "sales" }).click();
  await clickCell(page, 4, 2);
  await expect(formula(page)).toHaveValue("=SUM(B2:B3)");
});
