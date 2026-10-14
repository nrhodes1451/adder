import { expect, test } from "@playwright/test";

test("the loading snake keeps playing past load until Enter", async ({ page }) => {
  // Hold the engine back so the loading screen stays up.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\.wasm/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  const screen = page.locator(".snake-screen");
  await expect(screen.locator(".snake-status")).toHaveText("Loading…");
  await page.keyboard.press("s");
  await expect(screen.locator(".snake-status")).toHaveText("Loading… · length 2");
  release();
  await expect(screen.locator(".snake-status")).toHaveText("Ready · length 2 · Enter to continue");
  await page.keyboard.press("Enter");
  await expect(screen).toHaveCount(0);
});

test("clicking the logo opens snake; its keys don't reach the grid", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".snake-screen")).toHaveCount(0);
  const grid = page.getByTestId("grid");
  await grid.click({ position: { x: 100, y: 36 } }); // A1
  await page.locator(".toolbar .logo").click();
  await page.keyboard.press("d");
  await expect(page.locator(".snake-status")).toHaveText("Snake · length 2 · Esc to close");
  await page.keyboard.press("Escape");
  await expect(page.locator(".snake-screen")).toHaveCount(0);
  await expect(page.getByTestId("formula-input")).toHaveValue("");
});

test("a crash ends the game with a crossed-out eye until the next key", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".snake-screen")).toHaveCount(0);
  await page.locator(".toolbar .logo").click();
  await page.keyboard.press("d");
  // Coil the snake so its next step (down) runs into its own body.
  await page.evaluate(() => {
    const s = (window as unknown as { adderSnake: { snake: unknown; from: unknown } }).adderSnake;
    const body = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 2 }];
    s.snake = { body, dir: "down", food: { x: 4, y: 4 }, size: 5 };
    s.from = body;
  });
  const hint = page.locator(".snake-hint");
  await expect(hint).toHaveText("Game over · press any key");
  await expect(page.locator(".snake-dead-eye")).toBeAttached();
  await page.waitForTimeout(600);
  await expect(hint).toHaveText("Game over · press any key"); // it doesn't restart by itself
  await page.keyboard.press("x");
  await expect(hint).toHaveText("WASD");
  await expect(page.locator(".snake-status")).toHaveText("Snake · length 2 · Esc to close");
});
