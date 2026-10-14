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

test("ctrl+space selects columns, shift+space selects rows", async ({ page }) => {
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+Space");
  await expect(nameBox(page)).toHaveValue("B:C");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+Space");
  await expect(nameBox(page)).toHaveValue("2:3");
  // Typing still starts an edit.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("a b");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("a b");
});

test("ctrl+shift+plus inserts rows or columns for a whole-row/column selection", async ({ page }) => {
  await typeCell(page, "1");
  await typeCell(page, "2");
  await typeCell(page, "=SUM(A1:A2)");
  // Select rows 2 and insert two rows above.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+Space");
  await page.keyboard.press("Control+Shift+Equal");
  await expect(nameBox(page)).toHaveValue("2:3");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowDown"); // A1 is alone now
  await expect(nameBox(page)).toHaveValue("A4");
  await page.keyboard.press("ArrowDown");
  await expect(formula(page)).toHaveValue("=SUM(A1:A4)");

  // Column insert via header click.
  await page.getByTestId("grid").click({ position: { x: 64 + 45, y: 12 } }); // column A header
  await expect(nameBox(page)).toHaveValue("A:A");
  await page.keyboard.press("Control+Shift+Equal");
  await page.keyboard.press("Control+Home");
  await expect(formula(page)).toHaveValue("");
  await page.keyboard.press("ArrowRight");
  await expect(formula(page)).toHaveValue("1");

  // Undo removes the column again; a plain cell selection doesn't insert.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Home");
  await expect(formula(page)).toHaveValue("1");
  await page.keyboard.press("Control+Shift+Equal");
  await expect(formula(page)).toHaveValue("1");

  // Ctrl+Alt+= is an alternative that browsers never use for zoom.
  await page.keyboard.press("Shift+Space");
  await page.keyboard.press("Control+Alt+Equal");
  await page.keyboard.press("Control+Home");
  await expect(formula(page)).toHaveValue("");
  await page.keyboard.press("ArrowDown");
  await expect(formula(page)).toHaveValue("1");
});

test("ctrl+a then delete clears everything without hanging", async ({ page }) => {
  await typeCell(page, "1");
  await typeCell(page, "=A1+1");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+Home");
  await expect(formula(page)).toHaveValue("");
  await page.keyboard.press("ArrowDown");
  await expect(formula(page)).toHaveValue("");
  await page.keyboard.press("Control+z");
  await expect(formula(page)).toHaveValue("=A1+1");
});

test("ctrl+a then delete with a stray cell in the last row stays fast", async ({ page }) => {
  await typeCell(page, "keep me?");
  await page.keyboard.press("Control+ArrowDown"); // row 1,048,576
  await page.keyboard.type("stray");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+a");
  const t = Date.now();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+Home");
  await expect(formula(page)).toHaveValue("");
  expect(Date.now() - t).toBeLessThan(3000);
  await page.keyboard.press("Control+z");
  await expect(formula(page)).toHaveValue("keep me?");
});

test("ctrl+minus deletes selected rows/columns, row header click + insert works", async ({ page }) => {
  for (const v of ["1", "2", "3", "=SUM(A1:A3)"]) await typeCell(page, v);
  // Row header click on row 2, then delete it.
  await page.getByTestId("grid").click({ position: { x: 20, y: 24 + 25 + 12 } });
  await expect(nameBox(page)).toHaveValue("2:2");
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowDown"); // A1:A3 is one block now
  await expect(nameBox(page)).toHaveValue("A3");
  await expect(formula(page)).toHaveValue("=SUM(A1:A2)");

  // Insert two rows above row 2 via header drag selection.
  await page.getByTestId("grid").click({ position: { x: 20, y: 24 + 25 + 12 } });
  await page.getByTestId("grid").click({ position: { x: 20, y: 24 + 50 + 12 }, modifiers: ["Shift"] });
  await expect(nameBox(page)).toHaveValue("2:3");
  await page.keyboard.press("Control+Shift+Equal");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowDown"); // skips the two new empty rows
  await expect(nameBox(page)).toHaveValue("A4");
  await page.keyboard.press("ArrowDown");
  await expect(formula(page)).toHaveValue("=SUM(A1:A4)");

  // Delete column A.
  await page.keyboard.press("Control+Space");
  await page.keyboard.press("Control+Minus");
  await page.keyboard.press("Control+Home");
  await expect(formula(page)).toHaveValue("");

  // A plain cell selection leaves Ctrl+Minus alone.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Minus");
  await expect(formula(page)).toHaveValue("1");
});

test("a refused insert explains why", async ({ page }) => {
  await page.keyboard.press("Control+ArrowDown"); // jumps to row 1,048,576
  await page.keyboard.type("bottom");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+Space");
  await page.keyboard.press("Control+Shift+Equal");
  await expect(page.getByTestId("notice")).toContainText("last row");
});

test("formula autocomplete: =aver → AVERAGE( → click A1 → Tab commits =AVERAGE(A1)", async ({ page }) => {
  const list = page.getByTestId("formula-completion");
  await typeCell(page, "4");
  await page.getByTestId("grid").click({ position: { x: 64 + 90 + 45, y: 36 } }); // B1

  await page.keyboard.type("=");
  await expect(list).toBeVisible(); // everything on "="
  await page.keyboard.type("aver");
  await expect(list.getByRole("option")).toHaveText(["AVERAGE(", "AVERAGEA(", "AVERAGEIF(", "AVERAGEIFS("]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(list.getByRole("option", { selected: true })).toHaveText("AVERAGE(");

  await page.keyboard.press("Tab");
  await expect(list).toBeHidden();
  await expect(formula(page)).toHaveValue("=AVERAGE(");

  await page.getByTestId("grid").click({ position: { x: 64 + 45, y: 36 } }); // A1 → reference
  await expect(formula(page)).toHaveValue("=AVERAGE(A1");
  await page.keyboard.press("Tab");
  await expect(nameBox(page)).toHaveValue("C1");
  await page.keyboard.press("ArrowLeft");
  await expect(formula(page)).toHaveValue("=AVERAGE(A1)");

  // Escape closes the list without cancelling the edit; typing in the formula bar completes too.
  await page.keyboard.press("ArrowDown");
  await formula(page).click();
  await formula(page).pressSequentially("=1+ro");
  await expect(list.getByRole("option").first()).toHaveText("ROMAN(");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(formula(page)).toHaveValue("=1+ro");
  await page.keyboard.type("und");
  await page.keyboard.press("Tab");
  await expect(formula(page)).toHaveValue("=1+ROUND(");
  await page.keyboard.type("2.6");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=1+ROUND(2.6)");
});

test("arrow keys point at references while typing a formula; shift extends, F4 locks", async ({ page }) => {
  for (const v of ["1", "2", "3"]) await typeCell(page, v); // A1:A3, now at A4
  await page.keyboard.type("=pow");
  await page.keyboard.press("Tab");
  await expect(formula(page)).toHaveValue("=POWER(");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=POWER(A3");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=POWER(A2");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(formula(page)).toHaveValue("=POWER(A1:A2");
  await page.keyboard.press("ArrowRight"); // collapses back to a single cell
  await expect(formula(page)).toHaveValue("=POWER(B2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("F4");
  await expect(formula(page)).toHaveValue("=POWER($A$2");
  await page.keyboard.press("ArrowUp"); // keeps the lock while pointing
  await expect(formula(page)).toHaveValue("=POWER($A$1");
  await page.keyboard.press("F4");
  await page.keyboard.press("F4");
  await expect(formula(page)).toHaveValue("=POWER($A1");
  await page.keyboard.type(",");
  await page.keyboard.press("ArrowUp"); // typing an operator starts a new reference
  await expect(formula(page)).toHaveValue("=POWER($A1,A3");
  await page.keyboard.press("Enter");
  await expect(nameBox(page)).toHaveValue("A5");
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=POWER($A1,A3)");
});

test("F2 switches between pointing and moving the caret", async ({ page }) => {
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("=SUM(");
  await page.keyboard.press("F2"); // edit mode: arrows move the caret
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X");
  await expect(formula(page)).toHaveValue("=SUMX(");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("End");
  await page.keyboard.press("F2"); // back to pointing
  await page.keyboard.press("ArrowUp");
  await expect(formula(page)).toHaveValue("=SUM(A1");
  await page.keyboard.press("Escape");

  // A cell opened with F2 starts in edit mode; F4 locks the reference at the caret.
  await typeCell(page, "=A1+B1");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("F2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("F4");
  await expect(formula(page)).toHaveValue("=A1+$B$1");

  // Plain text: arrows commit and move, like Excel.
  await page.keyboard.press("Escape");
  await page.keyboard.type("hi");
  await page.keyboard.press("ArrowRight");
  await expect(nameBox(page)).toHaveValue("B2");
});

test("dragging over cells while typing a formula inserts a range", async ({ page }) => {
  const grid = page.getByTestId("grid");
  const box = (await grid.boundingBox())!;
  const at = (col: number, row: number) => ({ x: box.x + 64 + 90 * (col - 1) + 45, y: box.y + 24 + 25 * (row - 1) + 12 });
  await grid.click({ position: { x: 64 + 90 * 3 + 45, y: 36 } }); // D1
  await page.keyboard.type("=SUM(");
  await page.mouse.move(at(1, 1).x, at(1, 1).y);
  await page.mouse.down();
  await page.mouse.move(at(2, 3).x, at(2, 3).y, { steps: 4 });
  await page.mouse.up();
  await expect(formula(page)).toHaveValue("=SUM(A1:B3");
  await page.keyboard.press("Shift+ArrowRight"); // keyboard extends the dragged range
  await expect(formula(page)).toHaveValue("=SUM(A1:C3");
  await page.mouse.click(at(2, 2).x, at(2, 2).y); // clicking again replaces it
  await expect(formula(page)).toHaveValue("=SUM(B2");
  await page.keyboard.press("Enter");
  await expect(nameBox(page)).toHaveValue("D2");
});

test("references in a formula being edited are coloured and outlined in the grid", async ({ page }) => {
  await page.getByTestId("grid").click({ position: { x: 64 + 90 * 4 + 45, y: 36 } }); // E1
  await page.keyboard.type("=A1+B2:C3+$a$1+Other!D4");
  const refs = page.getByTestId("editor-highlight").locator("[data-ref]");
  await expect(refs).toHaveText(["A1", "B2:C3", "$a$1", "Other!D4"]);
  const colors = await refs.evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(colors[0]).toBe(colors[2]); // the same cell shares a colour
  expect(new Set([colors[0], colors[1], colors[3]]).size).toBe(3);
  await expect(page.getByTestId("formula-highlight").locator("[data-ref]")).toHaveText(["A1", "B2:C3", "$a$1", "Other!D4"]);

  // B2:C3's top edge is dashed in its colour.
  const [r, g, b] = colors[1]!.match(/\d+/g)!.map(Number);
  const hasOutline = () =>
    page.evaluate(
      ([r, g, b]) => {
        const c = document.querySelector<HTMLCanvasElement>("canvas.adder-grid-canvas")!;
        const dpr = devicePixelRatio;
        const d = c.getContext("2d")!.getImageData(Math.round(160 * dpr), Math.round(48 * dpr), Math.round(160 * dpr), Math.round(3 * dpr)).data;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - r!) + Math.abs(d[i + 1]! - g!) + Math.abs(d[i + 2]! - b!) < 30) return true;
        return false;
      },
      [r, g, b],
    );
  await expect.poll(hasOutline).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("editor-highlight")).toBeHidden();
  await expect.poll(hasOutline).toBe(false);
});
