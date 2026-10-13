import { useEffect, useState } from "react";
import { listWorkbooks, type WorkbookSummary } from "../io/idb";
import type { Workbook } from "./workbook";

interface Props {
  workbook: Workbook;
  onOpen: (id: string) => void;
  onNew: () => void;
  children?: React.ReactNode;
}

export function Toolbar({ workbook, onOpen, onNew, children }: Props) {
  const { engine } = workbook;
  const [, force] = useState(0);
  const [list, setList] = useState<WorkbookSummary[]>([]);
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    const refresh = () => void listWorkbooks().then(setList);
    refresh();
    const offSaved = workbook.onSaved(() => {
      setSaved(true);
      refresh();
    });
    const offChange = engine.onChange(() => {
      setSaved(false);
      force((n) => n + 1);
    });
    return () => {
      offSaved();
      offChange();
    };
  }, [workbook, engine]);

  return (
    <div className="toolbar">
      <img className="logo" src="/icon.png" alt="Adder" title="Adder" />
      <input
        type="text"
        aria-label="Workbook name"
        className="wb-name"
        defaultValue={workbook.name}
        onBlur={(e) => e.target.value.trim() && workbook.rename(e.target.value.trim())}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <select
        aria-label="Open workbook"
        value=""
        onChange={(e) => (e.target.value === "__new" ? onNew() : e.target.value && onOpen(e.target.value))}
      >
        <option value="">Open…</option>
        <option value="__new">+ New workbook</option>
        {list
          .filter((w) => w.id !== workbook.id)
          .map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {new Date(w.updatedAt).toLocaleString()}
            </option>
          ))}
      </select>
      <span className="sep" />
      <button onClick={() => engine.undo()} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button onClick={() => engine.redo()} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">
        Redo
      </button>
      {children}
      <span className="spacer" />
      <span className="save-state" data-testid="save-state">
        {saved ? "Saved" : "Saving…"}
      </span>
    </div>
  );
}
