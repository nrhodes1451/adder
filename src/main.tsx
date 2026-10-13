import { createRoot } from "react-dom/client";
import { createEngine } from "./engine";
import { App } from "./ui/App";
import "./ui/styles.css";

const engine = await createEngine();

// Dev helper: ?seed=100000 fills N rows × 26 cols for performance testing.
const seed = Number(new URLSearchParams(location.search).get("seed") ?? 0);
if (seed > 0) {
  const t = performance.now();
  for (let start = 1; start <= seed; start += 10_000) {
    const n = Math.min(10_000, seed - start + 1);
    const block = Array.from({ length: n }, (_, i) => Array.from({ length: 26 }, (_, c) => (c === 0 ? `Row ${start + i}` : String((start + i) * c))));
    engine.setRange(0, start, 1, block, "system");
  }
  console.info(`seeded ${seed}×26 in ${Math.round(performance.now() - t)}ms`);
}

createRoot(document.getElementById("root")!).render(<App engine={engine} />);
