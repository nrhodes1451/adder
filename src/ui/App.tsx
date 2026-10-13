import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Grid } from "../grid/grid";
import { CustomFunctions, emptyCustomState, SHADOW_SHEET } from "../python/customfns";
import { matchingRefs } from "../python/edits";
import { PythonHost } from "../python/host";
import { ConsoleStore } from "./console";
import { FileMenu } from "./FileMenu";
import { FormulaBar } from "./FormulaBar";
import { GridView } from "./GridView";
import { ScriptPanel } from "./ScriptPanel";
import { SheetTabs } from "./SheetTabs";
import { Toolbar } from "./Toolbar";
import { Workbook } from "./workbook";

export function App({ initial }: { initial: Workbook }) {
  const [workbook, setWorkbook] = useState(initial);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [sheet, setSheet] = useState(0);
  const { engine } = workbook;
  const [showScripts, setShowScripts] = useState(false);
  const sheetRef = useRef(0);
  sheetRef.current = sheet;

  const consoleStore = useMemo(() => new ConsoleStore(), [workbook]);
  const customRef = useRef<CustomFunctions | null>(null);
  const editRefs = useRef<string[]>([]);
  const python = useMemo(
    () =>
      new PythonHost(engine, () => sheetRef.current, {
        output: (stream, text) => consoleStore.push(stream, text),
        status: (s) => consoleStore.setStatus(s),
        functions: (names) => customRef.current?.setRegistered(names),
        editHandlers: (refs) => (editRefs.current = refs),
      }),
    [engine, consoleStore],
  );
  const custom = useMemo(
    () =>
      new CustomFunctions(
        engine,
        python,
        workbook.meta.custom ?? emptyCustomState(),
        (state) => workbook.setMeta({ custom: state }),
        (text) => consoleStore.push(text.startsWith("Error") ? "stderr" : "info", text + "\n"),
      ),
    [engine, python, workbook, consoleStore],
  );
  customRef.current = custom;
  useEffect(
    () => () => {
      custom.dispose();
      python.dispose();
    },
    [python, custom],
  );
  useEffect(() => {
    if (grid) grid.formulas = custom;
  }, [grid, custom]);

  // on_edit hooks: forward user edits that intersect a registered ref.
  useEffect(
    () =>
      engine.onChange((e) => {
        if (e.kind !== "cells" || e.source !== "user" || !editRefs.current.length) return;
        const sheets = engine.sheets();
        for (const r of e.ranges) {
          for (const ref of matchingRefs(editRefs.current, sheets, r)) {
            const small = r.rows * r.cols <= 10_000;
            python.edit(ref, {
              sheet: sheets[r.sheet]?.name ?? "",
              sheetIndex: r.sheet,
              row: r.row,
              col: r.col,
              rows: r.rows,
              cols: r.cols,
              values: small ? engine.getRangeValues(r) : [],
            });
          }
        }
      }),
    [engine, python],
  );

  // Flush on tab hide/close so a reload never loses the last edit.
  useEffect(() => {
    const flush = () => {
      if (workbook.hasPendingSave) void workbook.save();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [workbook]);

  const switchTo = useCallback(
    async (next: Promise<Workbook | null>) => {
      await workbook.close();
      const wb = await next;
      if (wb) {
        setGrid(null);
        setSheet(0);
        setWorkbook(wb);
      }
    },
    [workbook],
  );

  const selectSheet = (i: number) => {
    setSheet(i);
    grid?.setSheet(i);
    grid?.focus();
  };

  return (
    <div className="app">
      <Toolbar key={workbook.id} workbook={workbook} onOpen={(id) => void switchTo(Workbook.open(id))} onNew={() => void switchTo(Workbook.create())}>
        <span className="sep" />
        <FileMenu
          workbook={workbook}
          sheet={sheet}
          exportOptions={() => ({ formulaFor: (s, r, c) => custom.originalFor(s, r, c), skipSheet: (n) => n === SHADOW_SHEET })}
          onOpenWorkbook={(wb) => void switchTo(wb)} onSheetAdded={selectSheet} />
        <span className="sep" />
        <button className={showScripts ? "active" : ""} aria-pressed={showScripts} onClick={() => setShowScripts((v) => !v)}>
          Python
        </button>
      </Toolbar>
      {grid && <FormulaBar grid={grid} engine={engine} />}
      <div className="main">
        <div className="sheet-area">
          <GridView key={workbook.id} engine={engine} onReady={setGrid} />
          <SheetTabs key={`tabs-${workbook.id}`} engine={engine} active={sheet} onSelect={selectSheet} />
        </div>
        {showScripts && <ScriptPanel key={workbook.id} workbook={workbook} host={python} console={consoleStore} />}
      </div>
    </div>
  );
}
