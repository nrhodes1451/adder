import wasmUrl from "@ironcalc/wasm/wasm_bg.wasm?url";
import { IronCalcEngine, loadIronCalc } from "./ironcalc";

export type * from "./types";
export { IronCalcEngine };

/** Browser entry: load WASM and return a fresh or restored engine. */
export async function createEngine(bytes?: Uint8Array): Promise<IronCalcEngine> {
  await loadIronCalc(wasmUrl);
  return bytes ? IronCalcEngine.fromBytes(bytes) : IronCalcEngine.create();
}
