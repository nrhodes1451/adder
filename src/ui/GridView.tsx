import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/types";
import { Grid } from "../grid/grid";

/** Mounts the canvas grid and hands the instance up once ready. */
export function GridView({ engine, onReady }: { engine: Engine; onReady: (g: Grid) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<Grid | null>(null);

  useEffect(() => {
    const g = new Grid(host.current!, engine);
    setGrid(g);
    if (import.meta.env.DEV) (window as unknown as { adderGrid: Grid }).adderGrid = g;
    g.focus();
    return () => g.destroy();
  }, [engine]);

  useEffect(() => {
    if (grid) onReady(grid);
  }, [grid, onReady]);

  return <div className="grid-host" ref={host} data-testid="grid" />;
}
