import { useCallback, useEffect, useState } from "react";
import type { Grid } from "../grid/grid";
import { FileMenu } from "./FileMenu";
import { FormulaBar } from "./FormulaBar";
import { GridView } from "./GridView";
import { SheetTabs } from "./SheetTabs";
import { Toolbar } from "./Toolbar";
import { Workbook } from "./workbook";

export function App({ initial }: { initial: Workbook }) {
  const [workbook, setWorkbook] = useState(initial);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [sheet, setSheet] = useState(0);
  const { engine } = workbook;

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
      </Toolbar>
      {grid && <FormulaBar grid={grid} engine={engine} />}
      <div className="main">
        <div className="sheet-area">
          <GridView key={workbook.id} engine={engine} onReady={setGrid} />
          <SheetTabs key={`tabs-${workbook.id}`} engine={engine} active={sheet} onSelect={selectSheet} />
        </div>
      </div>
    </div>
  );
}
