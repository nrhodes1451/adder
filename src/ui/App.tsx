import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Grid } from "../grid/grid";
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
  const python = useMemo(
    () =>
      new PythonHost(engine, () => sheetRef.current, {
        output: (stream, text) => consoleStore.push(stream, text),
        status: (s) => consoleStore.setStatus(s),
      }),
    [engine, consoleStore],
  );
  useEffect(() => () => python.dispose(), [python]);

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
        <FileMenu workbook={workbook} sheet={sheet} onOpenWorkbook={(wb) => void switchTo(wb)} onSheetAdded={selectSheet} />
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
