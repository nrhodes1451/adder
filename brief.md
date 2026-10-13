# Adder — Handoff Brief

## What
Adder is a browser-based spreadsheet, like Google Sheets, whose scripting is done in **Python** instead of Apps Script. It's a personal project, built greenfield.

## Goals (MVP)
1. A grid that stays smooth with 100k+ rows: scrolling, selection, editing, copy/paste, undo/redo.
2. Excel-style formulas and recalculation, with multiple sheets.
3. Import and export of .xlsx and CSV.
4. Python scripting in the browser:
   - a script editor panel
   - run on demand
   - read/write ranges
   - register custom functions callable from cells
5. Workbooks saved locally (IndexedDB). No accounts.

## Non-goals (for now)
Real-time collaboration, server-side scheduled triggers, VBA, pivot tables, charts beyond basics, mobile layout.

## Stack
- **TypeScript + Vite**. React is fine only for the chrome around the grid (menus, panels). The grid itself is **canvas-rendered**, not DOM.
- **Calc engine: IronCalc** (Rust → WASM, MIT/Apache-2.0).
  - Handles formulas, recalculation, and .xlsx read/write.
  - Use its WASM bindings and UserModel layer (undo/redo, clipboard, autofill).
  - **Verify the current package name, API and version before building on it.**
- **Python: Pyodide**, running in a **Web Worker** so the UI never blocks.
  - Lazy-load it on first script run.
  - Bundle numpy and pandas on demand.
- **Do not use HyperFormula.** It is GPLv3.

## Architecture
```
UI (canvas grid + panels)
   │  commands / render requests
   ▼
Engine adapter (TS)  ←→  IronCalc WASM   (single source of truth for cell state)
   │  postMessage (batched ranges, typed arrays where possible)
   ▼
Python worker (Pyodide) ── exposes `adder` module to user scripts
```
- **Single source of truth.** All cell state lives in IronCalc. The grid renders only the visible viewport from it.
- **Interfaces.** The engine adapter is a thin TS interface, so the engine could be swapped later.
- **Range transfer.** Python ↔ engine moves whole ranges in batches, never cell-by-cell round trips.

## Python API (v0 sketch)
```python
import adder

ws = adder.sheet("Sheet1")
ws["A1"].value = 42
vals = ws.range("A1:C100").values        # list[list]
df = ws.range("A1:C100").to_pandas(header=True)
ws.range("E1").from_pandas(df)

@adder.function                         # callable in cells as =DOUBLE(A1)
def double(x):
    return x * 2

@adder.on_edit("Sheet1!B:B")            # runs after edits in that range
def log_change(event):
    ...
```
- Custom functions are evaluated asynchronously.
  - Cells show `#CALC…` until a result arrives.
  - Results are written back through the engine.
- Script errors appear in a console panel, with tracebacks.

## Milestones
1. **Spike**
   - IronCalc WASM loads.
   - Set and get a cell.
   - Evaluate `=SUM(A1:A3)`.
2. **Grid**
   - Canvas viewport with virtual scrolling.
   - Selection and keyboard navigation.
   - In-cell editor and formula bar.
3. **Workbook**
   - Multiple sheets and tabs.
   - Undo/redo.
   - Copy/paste, including TSV from other apps.
   - Save and load to IndexedDB.
4. **Files**
   - .xlsx import/export via IronCalc.
   - CSV import/export.
5. **Python**
   - Pyodide in a worker.
   - Editor panel (Monaco).
   - The `adder` module with range read/write.
   - Run button and console.
6. **Custom functions and `on_edit` hooks.**

## Acceptance checks
- Scrolling 100k rows × 26 columns stays at about 60fps on a mid-range laptop.
- Opening a real-world .xlsx file and saving it again keeps its formulas and basic formatting.
- A Python script that writes 10k cells finishes in under 1s after Pyodide has loaded.
- The UI never freezes while Python runs, including during an infinite-loop script. A stop button terminates the worker.

## Conventions
- Strict TS.
- Vitest for unit tests.
- Playwright smoke test for load, edit and save.
- Small modules: `engine/`, `grid/`, `python/`, `io/`, `ui/`.
- Commit per milestone, with a short README update.

## Open questions (decide during build)
- Whether Python should eventually also be usable in formulas (`=PY(...)`), and how that would interact with IronCalc's dependency graph.
- Server-side Python for triggers and secrets (later). This needs a sandbox design.
- PyPI and package naming: `adder` is taken, so use `adder-sheets` if publishing a Python helper.
