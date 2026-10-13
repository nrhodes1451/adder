import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { Workbook } from "./ui/workbook";
import "./ui/styles.css";

// Workbooks live only in IndexedDB; ask the browser not to evict them.
navigator.storage?.persist?.().catch(() => {});

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? 0);
const workbook = seed > 0 ? await seeded(seed) : await Workbook.openLast();

/** Dev helper: ?seed=100000 creates a workbook with N rows × 26 cols. */
async function seeded(n: number): Promise<Workbook> {
  const wb = await Workbook.create(`Seed ${n}`);
  const t = performance.now();
  for (let start = 1; start <= n; start += 10_000) {
    const count = Math.min(10_000, n - start + 1);
    const block = Array.from({ length: count }, (_, i) => Array.from({ length: 26 }, (_, c) => (c === 0 ? `Row ${start + i}` : String((start + i) * c))));
    wb.engine.setRange(0, start, 1, block, "system");
  }
  console.info(`seeded ${n}×26 in ${Math.round(performance.now() - t)}ms`);
  return wb;
}

createRoot(document.getElementById("root")!).render(<App initial={workbook} />);
