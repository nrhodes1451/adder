/** Drop Pyodide's internal frames (and their source context lines) from a traceback. */
export function cleanTraceback(message: string): string {
  const lines = message.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s+File "/.test(line)) {
      skipping = /^\s+File "\/lib\/python[^"]*\/_pyodide\//.test(line) || /^\s+File "<exec>"/.test(line);
      if (skipping) continue;
    } else if (skipping && line.startsWith("    ")) {
      continue; // source context of a skipped frame, incl. 3.14's "...<N lines>..."
    } else {
      skipping = false;
    }
    out.push(line);
  }
  return out.join("\n").trimEnd();
}
