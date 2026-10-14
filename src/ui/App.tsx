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
        transformInput: (s, r, c, input) => customRef.current?.toEngine(s, r, c, input) ?? input,
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

  // Errors from grid operations (e.g. an insert IronCalc refuses) shown as a dismissible notice.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => grid?.on((e) => e.type === "error" && setNotice(e.message)), [grid]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

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
  const selectSheetRef = useRef(selectSheet);
  selectSheetRef.current = selectSheet;

  // Ctrl+PageUp/PageDown (and Ctrl+Shift+, as Google Sheets does, since Chrome
  // keeps the unshifted keys for its own tabs) moves to the previous/next visible sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key !== "PageUp" && e.key !== "PageDown") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const visible = engine.sheets().filter((s) => !s.hidden).map((s) => s.index);
      const at = visible.indexOf(sheetRef.current);
      const next = visible[at + (e.key === "PageDown" ? 1 : -1)];
      e.preventDefault();
      if (next !== undefined) selectSheetRef.current(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine]);

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
      {notice && (
        <div className="notice" role="alert" data-testid="notice">
          <span>{notice}</span>
          <button className="link" aria-label="Dismiss" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
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
