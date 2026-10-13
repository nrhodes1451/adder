import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PythonHost } from "../python/host";
import type { ConsoleStore } from "./console";
import type { Workbook } from "./workbook";

export const DEFAULT_SCRIPT = `import adder

ws = adder.active()

# Write a block of values (one undo step)
ws.range("A1").values = [["x", "x squared"]] + [[i, i * i] for i in range(1, 11)]

# Formulas are just strings starting with "="
ws["D1"].value = "Total"
ws["D2"].value = "=SUM(B2:B11)"
print("Total:", ws["D2"].value)

# Custom functions are callable from cells, e.g. =DOUBLE(A2)
@adder.function
def double(x):
    return x * 2
`;

const STATUS_TEXT = { idle: "Python not loaded", loading: "Loading Python…", ready: "Ready", running: "Running…" } as const;

interface Props {
  workbook: Workbook;
  host: PythonHost;
  console: ConsoleStore;
}

export function ScriptPanel({ workbook, host, console: store }: Props) {
  const editorHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ getValue(): string } | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const status = useSyncExternalStore(store.subscribe, () => store.status);
  const entries = useSyncExternalStore(store.subscribe, () => store.entries);
  const consoleEnd = useRef<HTMLDivElement>(null);
  const runRef = useRef<() => void>(() => {});

  const code = () => editorRef.current?.getValue() ?? workbook.meta.scripts[0]?.code ?? "";

  const run = async () => {
    if (host.running) return;
    const source = code();
    workbook.setMeta({ scripts: [{ name: "main.py", code: source }] });
    store.push("run", "▶ Run main.py");
    try {
      const r = await host.run(source);
      if (r.ok) store.push("ok", `✓ Done in ${r.ms < 1000 ? `${Math.round(r.ms)} ms` : `${(r.ms / 1000).toFixed(2)} s`}`);
      else store.push("error", r.error ?? "Failed");
    } catch (e) {
      store.push("error", e instanceof Error ? e.message : String(e));
    }
  };
  runRef.current = () => void run();

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    void import("./monaco").then(({ monaco }) => {
      if (disposed || !editorHost.current) return;
      const dark = matchMedia("(prefers-color-scheme: dark)");
      const editor = monaco.editor.create(editorHost.current, {
        value: workbook.meta.scripts[0]?.code ?? DEFAULT_SCRIPT,
        language: "python",
        theme: dark.matches ? "vs-dark" : "vs",
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
      const save = editor.onDidChangeModelContent(() => workbook.setMeta({ scripts: [{ name: "main.py", code: editor.getValue() }] }));
      const onScheme = () => monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs");
      dark.addEventListener("change", onScheme);
      editorRef.current = editor;
      if (import.meta.env.DEV) (window as unknown as { adderScriptEditor: typeof editor }).adderScriptEditor = editor;
      setEditorReady(true);
      dispose = () => {
        dark.removeEventListener("change", onScheme);
        save.dispose();
        editor.dispose();
      };
    });
    return () => {
      disposed = true;
      dispose();
      editorRef.current = null;
    };
  }, [workbook]);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView.
    void consoleEnd.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const busy = status === "running" || status === "loading";
  return (
    <aside className="script-panel" aria-label="Python scripts">
      <div className="script-toolbar">
        <strong>main.py</strong>
        <span className={`py-status ${status}`} data-testid="py-status">
          {STATUS_TEXT[status]}
        </span>
        <span className="spacer" />
        <button className="primary" onClick={() => void run()} disabled={busy || !editorReady} title="Run (Ctrl+Enter)">
          Run
        </button>
        <button onClick={() => host.stop()} disabled={!busy} title="Interrupt; restarts Python if it doesn't stop">
          Stop
        </button>
      </div>
      <div className="script-editor" ref={editorHost} data-testid="script-editor" />
      <div className="console" role="log" aria-label="Console" data-testid="console">
        <div className="console-head">
          <span>Console</span>
          <button className="link" onClick={() => store.clear()}>
            Clear
          </button>
        </div>
        <div className="console-body">
          {entries.map((e) => (
            <pre key={e.id} className={`entry ${e.kind}`}>
              {e.text}
            </pre>
          ))}
          <div ref={consoleEnd} />
        </div>
      </div>
    </aside>
  );
}
