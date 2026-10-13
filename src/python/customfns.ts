// Python custom functions in cells, e.g. =DOUBLE(A1)+1.
//
// IronCalc has no custom-function hook, so each call site is backed by a row
// on a hidden "__adder" sheet:
//   column A      the result, written by us (outside undo history)
//   columns B…    one mirror cell per argument: "=<arg>" (or a TEXTJOIN of a
//                 range argument), so IronCalc tracks dependencies for us
// The user's cell stores a rewritten formula that references the result cell
// (=__adder!$A$7+1). What the user sees is rebuilt from that formula and the
// mirror cells, which IronCalc keeps up to date when rows/columns move, so
// nothing here depends on cell positions.
// After every change we diff the mirror values and re-invoke only the call
// sites whose arguments changed.

import type { CellInput, Engine } from "../engine/types";

export const SHADOW_SHEET = "__adder";
const PENDING = "#CALC!";
const SHADOW_REF = /__adder!\$A\$(\d+)/gi;
const TEXTJOIN_MIRROR = /^=TEXTJOIN\(CHAR\(31\),FALSE,(.*)\)$/i;

export type ArgSpec = { kind: "value" } | { kind: "range" };

export interface CallSite {
  fn: string;
  /** Row on the shadow sheet. */
  row: number;
  args: ArgSpec[];
}

export interface CustomState {
  sites: Record<number, CallSite>; // key: shadow row
  nextRow: number;
}

export const emptyCustomState = (): CustomState => ({ sites: {}, nextRow: 1 });

export interface CustomFunctionHost {
  call(name: string, args: unknown[]): Promise<{ value?: string; error?: string }>;
}

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

function shadowRows(input: string): number[] {
  return [...input.matchAll(SHADOW_REF)].map((m) => Number(m[1]));
}

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
      const spec: ArgSpec = only?.kind === "range" ? { kind: "range" } : { kind: "value" };
      return { text, spec };
    });
    out += body.slice(pos, t.start) + ctx.allocate(t.text!.toUpperCase(), args);
    pos = toks[j]!.end;
    i = j;
    changed = true;
  }
  return changed ? out + body.slice(pos) : null;
}

/** Remove "Sheet!" prefixes that point at `sheetName` (the formula's own sheet). */
export function unqualifyRefs(engine: Engine, text: string, sheetName: string): string {
  let out = "";
  let pos = 0;
  for (const t of engine.tokenize(text)) {
    if ((t.kind !== "ref" && t.kind !== "range") || t.sheet?.toLowerCase() !== sheetName.toLowerCase()) continue;
    const bang = text.lastIndexOf("!", t.end);
    if (bang < t.start) continue;
    out += text.slice(pos, t.start);
    pos = bang + 1;
  }
  return out + text.slice(pos);
}

export class CustomFunctions {
  private registered = new Set<string>();
  private lastSig = new Map<number, string>();
  private version = new Map<number, number>();
  /** Sites whose cell was overwritten. Undo can bring them back, so this is advisory. */
  private dead = new Set<number>();
  private scheduled = false;
  private off: () => void;

  constructor(
    private engine: Engine,
    private host: CustomFunctionHost,
    private state: CustomState,
    private save: (s: CustomState) => void,
    private log: (text: string) => void,
  ) {
    this.findDeadSites();
    // Results stored in the workbook are current; only re-run on changes.
    for (const row of this.liveSites()) this.lastSig.set(row, this.signature(row));
    this.off = engine.onChange((e) => {
      // Undo/redo/structural edits can resurrect overwritten cells.
      if (e.kind === "all") this.dead.clear();
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
    const current = this.engine.getInput(sheet, row, col);
    const currentSites = shadowRows(current);
    if (currentSites.length) {
      if (input === this.toUser(sheet, row, col, current)) return current; // unchanged: keep its call sites
      for (const r of currentSites) this.markDead(r);
    }
    if (!input.startsWith("=") || !this.registered.size) return input;
    return this.rewrite(sheet, input) ?? input;
  }

  /** What to show the user for a cell's stored input (position-independent). */
  toUser(sheet: number, _row: number, _col: number, input: string): string {
    if (!input.startsWith("=") || !shadowRows(input).length) return input;
    const sheetName = this.engine.sheets()[sheet]?.name ?? "";
    return "=" + unqualifyRefs(this.engine, this.expand(input.slice(1), 0), sheetName);
  }

  /** Original formula text if this cell is a custom-function cell. */
  originalFor(sheet: number, row: number, col: number): string | undefined {
    const input = this.engine.getInput(sheet, row, col);
    return shadowRows(input).length ? this.toUser(sheet, row, col, input) : undefined;
  }

  // ---- internals

  private shadow(): number {
    return this.engine.ensureSheet(SHADOW_SHEET, true);
  }

  /** Replace result references with FN(args), rebuilt from the mirror cells. */
  private expand(body: string, depth: number): string {
    if (depth > 20) return body;
    return body.replace(SHADOW_REF, (match, n: string) => {
      const site = this.state.sites[Number(n)];
      if (!site) return match;
      const shadow = this.shadow();
      const args = site.args.map((a, i) => {
        const mirror = this.engine.getInput(shadow, site.row, i + 2);
        const text = a.kind === "range" ? (TEXTJOIN_MIRROR.exec(mirror)?.[1] ?? mirror.slice(1)) : mirror.slice(1);
        return this.expand(text, depth + 1);
      });
      return `${site.fn}(${args.join(", ")})`;
    });
  }

  private rewrite(sheet: number, input: string): string | null {
    const sheetName = this.engine.sheets()[sheet]?.name ?? "Sheet1";
    const shadow = this.shadow();
    const writes: CellInput[] = [];
    const body = rewriteFormula(input.slice(1), {
      engine: this.engine,
      sheetName,
      isCustom: (n) => this.registered.has(n.toUpperCase()),
      allocate: (fn, args) => {
        const row = this.state.nextRow++;
        this.state.sites[row] = { fn, row, args: args.map((a) => a.spec) };
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
    this.save(this.state);
    return "=" + body;
  }

  /** A site and the nested sites feeding its arguments. */
  private markDead(row: number): void {
    const site = this.state.sites[row];
    if (!site || this.dead.has(row)) return;
    this.dead.add(row);
    const shadow = this.shadow();
    site.args.forEach((_, i) => shadowRows(this.engine.getInput(shadow, row, i + 2)).forEach((r) => this.markDead(r)));
  }

  /** On load, sites no cell refers to (overwritten in earlier sessions) are dead. */
  private findDeadSites(): void {
    const rows = Object.keys(this.state.sites).map(Number);
    if (!rows.length) return;
    const referenced = new Set<number>();
    for (const s of this.engine.sheets()) {
      if (s.name === SHADOW_SHEET) continue;
      const used = this.engine.usedRange(s.index);
      if (used.rows * used.cols > 500_000) return; // too big to scan: treat all as live
      for (let r = 1; r <= used.rows; r++) {
        for (let c = 1; c <= used.cols; c++) for (const n of shadowRows(this.engine.getInput(s.index, r, c))) referenced.add(n);
      }
    }
    for (const row of rows) this.dead.add(row);
    for (const row of referenced) this.revive(row);
  }

  private revive(row: number): void {
    const site = this.state.sites[row];
    if (!site || !this.dead.delete(row)) return;
    const shadow = this.shadow();
    site.args.forEach((_, i) => shadowRows(this.engine.getInput(shadow, row, i + 2)).forEach((r) => this.revive(r)));
  }

  private liveSites(): number[] {
    return Object.keys(this.state.sites)
      .map(Number)
      .filter((r) => !this.dead.has(r));
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
    const live = this.liveSites();
    if (!live.length) return;
    const shadow = this.shadow();
    for (const row of live) {
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
    const args = site.args.map((a, i): unknown =>
      a.kind === "value" ? this.engine.getValue(shadow, row, i + 2) : this.rangeArg(this.engine.getInput(shadow, row, i + 2)),
    );
    const res = await this.host.call(site.fn, args);
    if (this.version.get(row) !== v) return; // a newer call superseded this one
    if (res.error) this.log(`Error in ${site.fn}:\n${res.error}`);
    this.write(shadow, row, res.error ? "#VALUE!" : (res.value ?? ""));
  }

  /** Values of a range argument, located from its (engine-maintained) mirror formula. */
  private rangeArg(mirror: string): unknown {
    const text = TEXTJOIN_MIRROR.exec(mirror)?.[1] ?? "";
    const t = this.engine.tokenize(text).find((x) => x.kind === "range");
    const sheet = t && this.engine.sheets().find((s) => s.name.toLowerCase() === t.sheet?.toLowerCase());
    if (!t || !sheet) return { error: "#REF!" };
    const used = this.engine.usedRange(sheet.index);
    // Whole rows/columns are clipped to the used area.
    const r2 = Math.min(t.r2!, Math.max(t.r1!, used.rows));
    const c2 = Math.min(t.c2!, Math.max(t.c1!, used.cols));
    return this.engine.getRangeValues({ sheet: sheet.index, row: t.r1!, col: t.c1!, rows: r2 - t.r1! + 1, cols: c2 - t.c1! + 1 });
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
