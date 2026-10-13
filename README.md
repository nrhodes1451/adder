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

- [x] M4 files:
  - .xlsx import and export through SheetJS CE (`src/io/xlsx.ts`, behind `XlsxCodec`).
  - CSV import goes into a new sheet, with RFC 4180 parsing and delimiter sniffing.
  - CSV export writes the active sheet's displayed values.

### xlsx caveat
The published `@ironcalc/wasm` doesn't include IronCalc's xlsx reader/writer; those sit behind an unreleased `xlsx` cargo feature. Until it ships, Adder uses SheetJS Community Edition:
- **Round-trips:** values, formulas, number formats, column widths, sheet names and hidden sheets.
- **Import only:** solid fills.
- **Lost on export:** fonts, fills, borders and alignment, because SheetJS CE can't write styles.

To switch over, implement `XlsxCodec` with `Model.fromXlsx` / `toXlsx`.

## Performance
Load `/?seed=100000` to fill 100k × 26 cells. In headless Chromium with software rendering, scrolling holds 60fps: about 4ms median paint and under 8ms at p95. `window.adderGrid.paintTimes` has the numbers in dev builds.

## Engine notes
- IronCalc's `getRowsWithData` scans the whole sheet on every call. The adapter therefore computes the used range from per-row `getColumnsWithData` lookups, caches it, and grows the cache on each write.
- Batch writes (`Engine.setRange`) go through IronCalc's `pasteCsvText`, so they are a single undo step. Individual `setInput` calls are one undo step each.
- IronCalc doesn't expose raw cell values. Formula results are read from their formatted text, which limits precision to about 9 significant digits. Literal number inputs keep full precision.
