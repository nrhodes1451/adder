import { createRoot } from "react-dom/client";
import { createEngine } from "./engine";

const engine = await createEngine();
engine.setRange(0, 1, 1, [["1"], ["2"], ["3"], ["=SUM(A1:A3)"]]);

createRoot(document.getElementById("root")!).render(
  <p data-testid="spike">SUM(A1:A3) = {engine.getDisplay(0, 4, 1)}</p>,
);
