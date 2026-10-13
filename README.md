# Adder

A browser spreadsheet scripted in Python. See `brief.md` for goals.

## Stack
- TypeScript + Vite; React for the chrome, canvas for the grid.
- Calc engine: [IronCalc](https://github.com/ironcalc/IronCalc) via `@ironcalc/wasm` 0.8.4, behind the `Engine` interface in `src/engine/types.ts`.

## Develop
```sh
npm install
npm run dev        # http://localhost:5173 (COOP/COEP headers on)
npm test           # vitest
npm run e2e        # playwright (needs: sudo npx playwright install-deps chromium)
```

## Status
- [x] M1 spike: IronCalc loads, set/get cells, `=SUM`, batch writes, bytes round-trip.
- [x] M2 grid: canvas viewport with virtual scrolling, selection, keyboard navigation (arrows, Ctrl+arrows, Page, Home/End, Enter/Tab cycling), an in-cell editor with click-to-reference, a formula bar, and column resizing.
- [x] M3 workbook:
  - Sheet tabs: add, rename (double-click), delete (right-click).
  - Undo and redo.
  - Copy, cut and paste: internal pastes keep formulas and styles; TSV from other apps also works.
  - Workbooks are saved to IndexedDB with debounced autosave, and you can open or create them from the toolbar.

- Multi-cell editing:
  - Pasting into a selection larger than what was copied repeats the copy across it (Excel semantics), shifting relative references.
  - Ctrl+Enter, in the cell editor or the formula bar, writes the value to every selected cell.
  - Either one is a single undo step.
- Row and column selection and insert:
  - Ctrl+Space selects the selected columns; Shift+Space selects the rows.
  - Ctrl+Shift+Plus inserts that many rows or columns before a whole-row or whole-column selection.
- [x] M4 files:
  - .xlsx import and export through SheetJS CE (`src/io/xlsx.ts`, behind `XlsxCodec`).
  - CSV import goes into a new sheet, with RFC 4180 parsing and delimiter sniffing.
  - CSV export writes the active sheet's displayed values.

- [x] M5 Python:
  - Pyodide 314.0.7 (Python 3.14) runs in a Web Worker and loads lazily from jsDelivr on the first run.
  - Script panel with a Monaco editor, Run (Ctrl+Enter) and Stop, plus a console with cleaned-up tracebacks.
  - The `adder` module reads and writes ranges and works with pandas DataFrames.
  - numpy and pandas load on demand.

- [x] M6 custom functions and `on_edit` hooks.

### Python API
```python
import adder
ws = adder.sheet("Sheet1")            # or adder.active(), adder.sheet(0), adder.add_sheet("Out")
ws["A1"].value = 42                    # strings starting with "=" are formulas
vals = ws.range("A1:C100").values      # list[list]; errors come back as adder.CellError
df = ws.range("A1:C100").to_pandas(header=True)
ws.range("E1").from_pandas(df)
adder.range("'My Sheet'!B:B").values   # whole columns are clipped to the used range
```
**Custom functions and hooks**
```python
@adder.function                        # =DOUBLE(A1) in any cell
def double(x):
    return x * 2

@adder.function
def total(rows):                       # range args arrive as list[list]
    return sum(v for r in rows for v in r if isinstance(v, (int, float)))

@adder.on_edit("Sheet1!B:B")           # after user edits that touch column B
def log_change(event):                 # event.sheet, event.range, event.values, event.value
    event.range.offset(cols=1).value = f"changed to {event.value}"
```
- Running the script (re)registers its functions and hooks.
- **Cell values:** a cell shows `#CALC!` while its result is pending and `#VALUE!` if the function raised; the traceback goes to the console.
- **After a reload:** cells keep their last results. If the inputs change before the script runs again, the cell shows `#NAME?`.
- **Implementation:** IronCalc has no custom-function hook (`src/python/customfns.ts`), so each call site gets a row on a hidden `__adder` sheet:
  - Argument "mirror" cells let IronCalc track dependencies.
  - We diff the mirror values after each change and call Python only when the arguments changed.
  - The result is written back through IronCalc's external-diff API, so it never enters undo history.
  - The formula bar and xlsx export show the original formula text, rebuilt from the stored formula and the argument mirrors. IronCalc updates both when rows or columns move, so custom-function cells survive inserts and undo.

**How it works:**
- Writes are buffered in Python, grouped into rectangles, and sent as one batch per rectangle, each of which is a single undo step.
- Reads are synchronous. The worker blocks on `Atomics.wait` while the main thread answers over a SharedArrayBuffer (`src/python/channel.ts`), which is why the app needs COOP/COEP headers.
- **Stop:** first raises `KeyboardInterrupt`. If the script hasn't stopped after 1.5s, the worker is terminated and Python restarts on the next run.
- **Speed:** writing 10k cells one at a time takes about 35ms in Python, and the whole run about 90ms, once Python is warm.

### xlsx caveat
The published `@ironcalc/wasm` doesn't include IronCalc's xlsx reader/writer; those sit behind an unreleased `xlsx` cargo feature. Until it ships, Adder uses SheetJS Community Edition:
- **Round-trips:** values, formulas, number formats, column widths, sheet names and hidden sheets.
- **Import only:** solid fills.
- **Lost on export:** fonts, fills, borders and alignment, because SheetJS CE can't write styles.

To switch over, implement `XlsxCodec` with `Model.fromXlsx` / `toXlsx`.

## Performance
Load `/?seed=100000` to fill 100k × 26 cells. In headless Chromium with software rendering, scrolling holds 60fps: about 4ms median paint and under 8ms at p95. `window.adderGrid.paintTimes` has the numbers in dev builds.

## Known limitations
- **Python precision:** formula results reach Python with about 9 significant digits, because IronCalc has no raw-value API.
- **Custom functions:**
  - They must return a single value.
  - Copying a custom-function cell copies a reference to the same result rather than a new call.
- **`on_edit` events:** they carry new values only, not old ones.
- **Undo granularity:** each batched Python write is one undo step, so a script that writes several separate rectangles creates several steps.
- **xlsx export:** see the SheetJS caveat above.

## Engine notes
- IronCalc's `getRowsWithData` scans the whole sheet on every call. The adapter therefore computes the used range from per-row `getColumnsWithData` lookups, caches it, and grows the cache on each write.
- Batch writes (`Engine.setRange`) go through IronCalc's `pasteCsvText`, so they are a single undo step. Individual `setInput` calls are one undo step each.
- IronCalc doesn't expose raw cell values. Formula results are read from their formatted text, which limits precision to about 9 significant digits. Literal number inputs keep full precision.
