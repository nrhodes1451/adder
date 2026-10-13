import type { Engine } from "../engine/types";
import type { PythonHostEvents } from "./host";

type Args = Record<string, unknown>;

/** Synchronous workbook queries from Python (`_adder_bridge.sync`). */
export function query(e: Engine, activeSheet: () => number, op: string, a: Args): unknown {
  const n = (k: string) => a[k] as number;
  switch (op) {
    case "sheets":
      return e.sheets().filter((s) => !(s.hidden && s.name.startsWith("__")));
    case "active":
      return activeSheet();
    case "add_sheet":
      return e.addSheet((a.name as string | null) ?? undefined);
    case "used":
      return e.usedRange(n("sheet"));
    case "read":
      return e.getRangeValues({ sheet: n("sheet"), row: n("row"), col: n("col"), rows: n("rows"), cols: n("cols") });
    case "inputs": {
      const out: string[][] = [];
      for (let i = 0; i < n("rows"); i++) {
        const row: string[] = [];
        for (let j = 0; j < n("cols"); j++) row.push(e.getInput(n("sheet"), n("row") + i, n("col") + j));
        out.push(row);
      }
      return out;
    }
    default:
      throw new Error(`Unknown query ${op}`);
  }
}

/** Fire-and-forget mutations from Python (`_adder_bridge.post`), applied in order. */
export function apply(e: Engine, events: PythonHostEvents, op: string, a: Args): void {
  const n = (k: string) => a[k] as number;
  switch (op) {
    case "write": {
      const [sheet, row, col] = [n("sheet"), n("row"), n("col")];
      let values = a.values as string[][];
      const t = events.transformInput;
      // Only formulas can contain custom-function calls.
      if (t && values.some((r) => r.some((v) => v.startsWith("="))))
        values = values.map((r, i) => r.map((v, j) => (v.startsWith("=") ? t(sheet, row + i, col + j, v) : v)));
      e.setRange(sheet, row, col, values, "script");
      break;
    }
    case "clear":
      e.clearRange({ sheet: n("sheet"), row: n("row"), col: n("col"), rows: n("rows"), cols: n("cols") }, "script");
      break;
    case "functions":
      events.functions?.(a.names as string[]);
      break;
    case "edit_handlers":
      events.editHandlers?.(a.refs as string[]);
      break;
    default:
      throw new Error(`Unknown op ${op}`);
  }
}
