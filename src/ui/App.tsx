import { useState } from "react";
import type { Engine } from "../engine/types";
import type { Grid } from "../grid/grid";
import { FormulaBar } from "./FormulaBar";
import { GridView } from "./GridView";

export function App({ engine }: { engine: Engine }) {
  const [grid, setGrid] = useState<Grid | null>(null);
  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">Adder</span>
      </div>
      {grid && <FormulaBar grid={grid} engine={engine} />}
      <div className="main">
        <div className="sheet-area">
          <GridView engine={engine} onReady={setGrid} />
        </div>
      </div>
    </div>
  );
}
