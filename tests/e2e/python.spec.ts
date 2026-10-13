import { expect, type Page, test } from "@playwright/test";

// One page for the whole file so Pyodide is downloaded and booted once.
test.describe.configure({ mode: "serial", timeout: 180_000 });

let page: Page;
const consoleLog = () => page.getByTestId("console");
const status = () => page.getByTestId("py-status");
const formula = () => page.getByTestId("formula-input");

async function clickCell(row: number, col: number) {
  await page.getByTestId("grid").click({ position: { x: 64 + (col - 1) * 90 + 45, y: 24 + (row - 1) * 25 + 12 } });
}

async function runScript(code: string) {
  await page.evaluate((c) => (window as unknown as { adderScriptEditor: { setValue(v: string): void } }).adderScriptEditor.setValue(c), code);
  await page.getByRole("button", { name: "Run" }).click();
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e));
  page.on("console", (m) => m.type() === "error" && console.error("console", m.text()));
  await page.goto("/");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.getByRole("button", { name: "Python" }).click();
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled({ timeout: 60_000 });
});

test.afterAll(async () => page.close());

test("default script writes cells and prints", async () => {
  await page.getByRole("button", { name: "Run" }).click();
  await expect(consoleLog()).toContainText("Total: 385", { timeout: 120_000 });
  await expect(consoleLog()).toContainText("✓ Done");
  await clickCell(2, 4);
  await expect(formula()).toHaveValue("=SUM(B2:B11)");
});

test("writing 10k cells takes under a second once Python is warm", async () => {
  await runScript(`
import adder, time
ws = adder.active()
t = time.perf_counter()
for i in range(1, 1001):
    for j in range(1, 11):
        ws.cell(i, j).value = i * j
adder.flush()
print(f"wrote 10k cells in {(time.perf_counter() - t) * 1000:.0f} ms")
print("check", ws.cell(1000, 10).value)
`);
  await expect(consoleLog()).toContainText("check 10000");
  const text = await consoleLog().innerText();
  const done = [...text.matchAll(/✓ Done in ([\d.]+) (ms|s)/g)].at(-1)!;
  const ms = done[2] === "s" ? Number(done[1]) * 1000 : Number(done[1]);
  console.log(`10k-cell script total: ${ms} ms; ${text.match(/wrote 10k cells in \d+ ms/)?.[0]}`);
  expect(ms).toBeLessThan(1000);
});

test("tracebacks show the user's line", async () => {
  await runScript("x = 1\ny = x / 0\n");
  await expect(consoleLog()).toContainText("ZeroDivisionError: division by zero");
  await expect(consoleLog()).toContainText('File "<script>", line 2');
  await expect(consoleLog()).not.toContainText("_pyodide");
  await expect(consoleLog()).not.toContainText("run_async");
});

test("an infinite loop doesn't freeze the UI and Stop recovers", async () => {
  await runScript("while True:\n    pass\n");
  await expect(status()).toHaveText("Running…");
  // The grid still responds while Python spins.
  await clickCell(5, 5);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Cell reference")).toHaveValue("E6");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(consoleLog()).toContainText("KeyboardInterrupt");
  await expect(status()).toHaveText("Ready");
  await runScript("print('alive')");
  await expect(consoleLog()).toContainText("alive");
});

test("a loop that ignores interrupts is terminated", async () => {
  await runScript("import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True:\n    pass\n");
  await expect(status()).toHaveText("Running…");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(consoleLog()).toContainText("worker was restarted");
  await runScript("print('rebooted')");
  await expect(consoleLog()).toContainText("rebooted", { timeout: 120_000 });
});

test("pandas round trip", async () => {
  await runScript(`
import adder
ws = adder.active()
ws.range("A1:J1000").clear()
ws.range("E1").values = [["name", "score"], ["ann", 3], ["bob", 5]]
df = ws.range("E1:F3").to_pandas(header=True)
df["double"] = df["score"] * 2
ws.range("A6").from_pandas(df)
print(df.to_string())
`);
  await expect(consoleLog()).toContainText("double", { timeout: 150_000 });
  await clickCell(8, 3); // C8: bob's double
  await expect(formula()).toHaveValue("10");
});
