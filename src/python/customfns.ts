// Python custom functions in cells, e.g. =DOUBLE(A1)+1.
//
// IronCalc has no custom-function hook, so each call site is backed by a row
// on a hidden "__adder" sheet:
//   column A      the result, written by us (outside undo history)
//   columns B…    one mirror cell per argument: "=<arg>" (or a TEXTJOIN of a
//                 range argument), so IronCalc tracks dependencies for us
// The user's cell stores a rewritten formula that references the result cell;
// the original text is kept in workbook meta and shown in the formula bar.
// After every change we diff the mirror values and re-invoke only the call
// sites whose arguments changed.

import type { CellInput, Engine } from "../engine/types";

export const SHADOW_SHEET = "__adder";
const PENDING = "#CALC!";

export type ArgSpec = { kind: "value" } | { kind: "range"; sheet: string; r1: number; c1: number; r2: number; c2: number };

export interface CallSite {
  fn: string;
  /** Row on the shadow sheet. */
  row: number;
  args: ArgSpec[];
}

export interface CustomCell {
  original: string;
  rewritten: string;
  sites: number[];
}

export interface CustomState {
  cells: Record<string, CustomCell>; // key: "sheet:row:col"
  sites: Record<number, CallSite>; // key: shadow row
  nextRow: number;
}

export const emptyCustomState = (): CustomState => ({ cells: {}, sites: {}, nextRow: 1 });

export interface CustomFunctionHost {
  call(name: string, args: unknown[]): Promise<{ value?: string; error?: string }>;
}

const key = (sheet: number, row: number, col: number) => `${sheet}:${row}:${col}`;
const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

interface RewriteContext {
  engine: Engine;
  sheetName: string;
  isCustom(name: string): boolean;
  /** Allocate a call site and return the reference to its result cell. */
  allocate(fn: string, args: { text: string; spec: ArgSpec }[]): string;
}

/** Prefix every unqualified cell/range reference in `text` with the sheet name. */
export function qualifyRefs(engine: Engine, text: string, sheetName: string): string {
  let out = "";
  let pos = 0;
  for (const t of engine.tokenize(text)) {
    if ((t.kind === "ref" || t.kind === "range") && t.sheet === null) {
      out += text.slice(pos, t.start) + quoteSheet(sheetName) + "!";
      pos = t.start;
    }
  }
  return out + text.slice(pos);
}

/**
 * Replace calls to custom functions in a formula body with result-cell
 * references, innermost first. Returns null if there are none.
 */
export function rewriteFormula(body: string, ctx: RewriteContext): string | null {
  const toks = ctx.engine.tokenize(body);
  let out = "";
  let pos = 0;
  let changed = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== "ident" || !ctx.isCustom(t.text!) || toks[i + 1]?.kind !== "lparen") continue;
    let depth = 0;
    let j = i + 1;
    const commas: number[] = [];
    for (; j < toks.length; j++) {
      const k = toks[j]!.kind;
      if (k === "lparen") depth++;
      else if (k === "rparen" && --depth === 0) break;
      else if (k === "comma" && depth === 1) commas.push(j);
    }
    if (j >= toks.length) return null; // unbalanced; let the engine report it
    const starts = [toks[i + 1]!.end, ...commas.map((c) => toks[c]!.end)];
    const ends = [...commas.map((c) => toks[c]!.start), toks[j]!.start];
    const rawArgs = starts.map((s, k) => body.slice(s, ends[k]).trim());
    const args = (rawArgs.length === 1 && rawArgs[0] === "" ? [] : rawArgs).map((arg) => {
      const inner = rewriteFormula(arg, ctx) ?? arg;
      const text = qualifyRefs(ctx.engine, inner, ctx.sheetName);
      const at = ctx.engine.tokenize(text);
      const only = at.length === 1 ? at[0]! : null;
      const spec: ArgSpec =
        only?.kind === "range"
          ? { kind: "range", sheet: only.sheet ?? ctx.sheetName, r1: only.r1!, c1: only.c1!, r2: only.r2!, c2: only.c2! }
          : { kind: "value" };
      return { text, spec };
    });
    out += body.slice(pos, t.start) + ctx.allocate(t.text!.toUpperCase(), args);
    pos = toks[j]!.end;
    i = j;
    changed = true;
  }
  return changed ? out + body.slice(pos) : null;
}

export class CustomFunctions {
  private registered = new Set<string>();
  private lastSig = new Map<number, string>();
  private version = new Map<number, number>();
  private scheduled = false;
  /** Cells rewritten by toEngine whose engine-normalized text we haven't seen yet. */
  private awaitingCommit = new Set<string>();
  private off: () => void;

  constructor(
    private engine: Engine,
    private host: CustomFunctionHost,
    private state: CustomState,
    private save: (s: CustomState) => void,
    private log: (text: string) => void,
  ) {
    // Results stored in the workbook are current; only re-run on changes.
    for (const row of this.liveSites()) this.lastSig.set(row, this.signature(row));
    this.off = engine.onChange((e) => {
      if (e.kind === "cells" && e.source !== "system") this.recordCommitted(e.ranges);
      // System writes matter too: a nested call's result feeds its parent's mirror.
      this.schedule();
    });
  }

  dispose(): void {
    this.off();
  }

  get names(): string[] {
    return [...this.registered];
  }

  /** Python (re)registered its functions: recompute their call sites and adopt #NAME? cells. */
  setRegistered(names: string[]): void {
    const usable = names.filter((n) => !this.engine.isBuiltinFunction(n));
    for (const n of names) if (!usable.includes(n)) this.log(`Not registering ${n}: it would shadow a built-in function.`);
    const added = usable.filter((n) => !this.registered.has(n));
    this.registered = new Set(usable);
    if (!added.length) return;
    for (const row of this.liveSites()) if (added.includes(this.state.sites[row]!.fn)) this.lastSig.delete(row);
    this.adoptNameErrors(added);
    this.schedule();
  }

  /** Transform user input before it reaches the engine. */
  toEngine(sheet: number, row: number, col: number, input: string): string {
    const k = key(sheet, row, col);
    const prior = this.state.cells[k];
    if (!input.startsWith("=") || !this.registered.size) {
      if (prior) this.forget(k);
      return input;
    }
    if (prior && prior.original === input && !this.awaitingCommit.has(k)) return prior.rewritten;
    const rewritten = this.rewrite(sheet, input);
    if (prior) this.forget(k);
    if (rewritten === null) return input;
    this.state.cells[k] = rewritten.cell;
    this.awaitingCommit.add(k);
    this.save(this.state);
    return rewritten.cell.rewritten;
  }

  /** What to show the user for a cell's stored input. */
  toUser(sheet: number, row: number, col: number, input: string): string {
    const c = this.state.cells[key(sheet, row, col)];
    return c && c.rewritten === input ? c.original : input;
  }

  /** Original formula text if this cell is a live custom-function cell. */
  originalFor(sheet: number, row: number, col: number): string | undefined {
    const c = this.state.cells[key(sheet, row, col)];
    return c && this.engine.getInput(sheet, row, col) === c.rewritten ? c.original : undefined;
  }

  // ---- internals

  private shadow(): number {
    return this.engine.ensureSheet(SHADOW_SHEET, true);
  }

  private rewrite(sheet: number, input: string): { cell: CustomCell } | null {
    const sheetName = this.engine.sheets()[sheet]?.name ?? "Sheet1";
    const shadow = this.shadow();
    const writes: CellInput[] = [];
    const sites: number[] = [];
    const body = rewriteFormula(input.slice(1), {
      engine: this.engine,
      sheetName,
      isCustom: (n) => this.registered.has(n.toUpperCase()),
      allocate: (fn, args) => {
        const row = this.state.nextRow++;
        this.state.sites[row] = { fn, row, args: args.map((a) => a.spec) };
        sites.push(row);
        writes.push({ sheet: shadow, row, col: 1, input: PENDING });
        args.forEach((a, i) =>
          writes.push({
            sheet: shadow,
            row,
            col: i + 2,
            input: a.spec.kind === "range" ? `=TEXTJOIN(CHAR(31),FALSE,${a.text})` : `=${a.text}`,
          }),
        );
        return `${SHADOW_SHEET}!$A$${row}`;
      },
    });
    if (body === null) return null;
    this.engine.setSystemInputs(writes);
    return { cell: { original: input, rewritten: "=" + body, sites } };
  }

  /** IronCalc normalizes formula text (quoting, spacing, case); keep what it actually stored. */
  private recordCommitted(ranges: { sheet: number; row: number; col: number; rows: number; cols: number }[]): void {
    for (const k of this.awaitingCommit) {
      const [s, r, c] = k.split(":").map(Number) as [number, number, number];
      const hit = ranges.some((g) => g.sheet === s && r >= g.row && r < g.row + g.rows && c >= g.col && c < g.col + g.cols);
      const cell = this.state.cells[k];
      if (!hit || !cell) continue;
      this.awaitingCommit.delete(k);
      cell.rewritten = this.engine.getInput(s, r, c);
      this.save(this.state);
    }
  }

  private forget(k: string): void {
    const c = this.state.cells[k];
    if (!c) return;
    delete this.state.cells[k];
    this.save(this.state);
  }

  /** Shadow rows referenced by cells whose stored input still matches (undo can invalidate). */
  private liveSites(): number[] {
    const rows: number[] = [];
    for (const [k, c] of Object.entries(this.state.cells)) {
      const [s, r, col] = k.split(":").map(Number) as [number, number, number];
      if (this.engine.getInput(s, r, col) === c.rewritten) rows.push(...c.sites);
    }
    return rows;
  }

  private signature(row: number): string {
    const site = this.state.sites[row]!;
    const shadow = this.shadow();
    return JSON.stringify([site.fn, site.args.map((_, i) => this.engine.getDisplay(shadow, row, i + 2))]);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.check();
    });
  }

  private check(): void {
    if (!Object.keys(this.state.cells).length) return;
    const shadow = this.shadow();
    for (const row of this.liveSites()) {
      const sig = this.signature(row);
      if (this.lastSig.get(row) === sig) continue;
      // Wait for upstream custom calls to finish rather than calling with #CALC!.
      const args = this.state.sites[row]!.args;
      if (args.some((_, i) => this.engine.getDisplay(shadow, row, i + 2) === PENDING)) continue;
      this.lastSig.set(row, sig);
      void this.dispatch(row);
    }
  }

  private async dispatch(row: number): Promise<void> {
    const site = this.state.sites[row]!;
    const shadow = this.shadow();
    if (!this.registered.has(site.fn)) {
      this.write(shadow, row, "#NAME?");
      this.log(`${site.fn} isn't registered in this session. Run your script to register it.`);
      return;
    }
    const v = (this.version.get(row) ?? 0) + 1;
    this.version.set(row, v);
    this.write(shadow, row, PENDING);
    const args = site.args.map((a, i): unknown => (a.kind === "value" ? this.engine.getValue(shadow, row, i + 2) : this.rangeArg(a)));
    const res = await this.host.call(site.fn, args);
    if (this.version.get(row) !== v) return; // a newer call superseded this one
    if (res.error) this.log(`Error in ${site.fn}:\n${res.error}`);
    this.write(shadow, row, res.error ? "#VALUE!" : (res.value ?? ""));
  }

  private rangeArg(a: Extract<ArgSpec, { kind: "range" }>): unknown {
    const sheet = this.engine.sheets().find((s) => s.name === a.sheet);
    if (!sheet) return { error: "#REF!" };
    const used = this.engine.usedRange(sheet.index);
    // Whole rows/columns are clipped to the used area.
    const r2 = Math.min(a.r2, Math.max(a.r1, used.rows));
    const c2 = Math.min(a.c2, Math.max(a.c1, used.cols));
    return this.engine.getRangeValues({ sheet: sheet.index, row: a.r1, col: a.c1, rows: r2 - a.r1 + 1, cols: c2 - a.c1 + 1 });
  }

  private write(shadow: number, row: number, input: string): void {
    this.engine.setSystemInputs([{ sheet: shadow, row, col: 1, input }]);
  }

  /** Cells typed before their function was registered show #NAME?; rewrite them now. */
  private adoptNameErrors(names: string[]): void {
    const pattern = new RegExp(`\\b(${names.join("|")})\\s*\\(`, "i");
    const fixes: CellInput[] = [];
    for (const s of this.engine.sheets()) {
      if (s.name === SHADOW_SHEET) continue;
      const used = this.engine.usedRange(s.index);
      if (used.rows * used.cols > 500_000) continue; // too big to scan; retype to adopt
      for (let r = 1; r <= used.rows; r++) {
        for (let c = 1; c <= used.cols; c++) {
          if (this.engine.getKind(s.index, r, c) !== "error") continue;
          const input = this.engine.getInput(s.index, r, c);
          if (!input.startsWith("=") || !pattern.test(input)) continue;
          const out = this.toEngine(s.index, r, c, input);
          if (out !== input) fixes.push({ sheet: s.index, row: r, col: c, input: out });
        }
      }
    }
    this.engine.setSystemInputs(fixes);
  }
}
