/** Excel's Ctrl+Shift+1: thousands separator, two decimals. */
export const NUMBER_FORMAT = "#,##0.00";
/** Excel's Ctrl+Shift+3 (Ctrl+#). */
export const DATE_FORMAT = "d-mmm-yy";

/**
 * Excel's Increase/Decrease Decimal (Alt H 0 / Alt H 9): add or remove one
 * decimal place in every section of `format`. A General format starts from
 * the decimals currently shown in `display`. Returns null when the format has
 * no number part to change (dates, text) or is already at zero decimals.
 */
export function adjustDecimals(format: string, delta: 1 | -1, display: string): string | null {
  if (!format || format.toLowerCase() === "general") {
    if (!/\d/.test(display)) return null;
    const decimals = /\.(\d+)/.exec(display)?.[1]?.length ?? 0;
    const next = decimals + delta;
    if (next < 0) return null;
    return next ? `0.${"0".repeat(next)}` : "0";
  }
  // Dates and times ("d-mmm-yy", "hh:mm:ss.000") have no decimals to adjust.
  if (/[dmyhs]/i.test(stripLiterals(format))) return null;
  let changed = false;
  const out = splitSections(format).map((section) =>
    mapUnquoted(section, (text) =>
      // First number placeholder run in the section, e.g. "#,##0.00", "0", "0.0".
      text.replace(/[#0?][#0?,]*(?:\.([#0?]*))?/, (num, dec: string | undefined) => {
        const int = dec === undefined ? num : num.slice(0, num.length - dec.length - 1);
        const next = (dec?.length ?? 0) + delta;
        if (next < 0) return num;
        changed = true;
        return next ? `${int}.${"0".repeat(next)}` : int;
      }),
    ),
  );
  return changed ? out.join(";") : null;
}

function stripLiterals(format: string): string {
  return format.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
}

/** Split on ";" outside quotes. */
function splitSections(format: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!;
    if (ch === "\\" && !quoted) {
      cur += ch + (format[++i] ?? "");
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Apply `fn` to the parts of a section that aren't literal text ("…",
 * \x escapes, [colour]/[condition] brackets), only to the first part that it
 * changes.
 */
function mapUnquoted(section: string, fn: (text: string) => string): string {
  const parts = section.split(/("[^"]*"|\\.|\[[^\]]*\])/);
  let done = false;
  return parts
    .map((p, i) => {
      if (done || i % 2 === 1) return p;
      const q = fn(p);
      if (q !== p) done = true;
      return q;
    })
    .join("");
}
