import { useEffect, useState } from "react";
import type { Engine } from "../engine/types";

interface Props {
  engine: Engine;
  active: number;
  onSelect: (sheet: number) => void;
}

export function SheetTabs({ engine, active, onSelect }: Props) {
  const [sheets, setSheets] = useState(() => engine.sheets());
  const [renaming, setRenaming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => engine.onChange((e) => e.kind !== "cells" && setSheets(engine.sheets())), [engine]);

  const rename = (index: number, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === sheets[index]?.name) return;
    try {
      engine.renameSheet(index, trimmed);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const remove = (index: number) => {
    if (sheets.filter((s) => !s.hidden).length <= 1) return;
    if (!confirm(`Delete sheet "${sheets[index]?.name}"?`)) return;
    engine.deleteSheet(index);
    onSelect(Math.max(0, index - 1));
  };

  return (
    <div className="tabs" role="tablist" aria-label="Sheets">
      {sheets.map((s) =>
        s.hidden ? null : renaming === s.index ? (
          <input
            key={s.index}
            type="text"
            aria-label="Sheet name"
            defaultValue={s.name}
            autoFocus
            onBlur={(e) => rename(s.index, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename(s.index, e.currentTarget.value);
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button
            key={s.index}
            role="tab"
            aria-selected={s.index === active}
            className={`tab${s.index === active ? " active" : ""}`}
            onClick={() => onSelect(s.index)}
            onDoubleClick={() => setRenaming(s.index)}
            onContextMenu={(e) => {
              e.preventDefault();
              remove(s.index);
            }}
            title="Double-click to rename, right-click to delete"
          >
            {s.name}
          </button>
        ),
      )}
      <button
        className="add"
        aria-label="Add sheet"
        onClick={() => {
          const i = engine.addSheet();
          onSelect(i);
        }}
      >
        +
      </button>
      {error && <span className="tab-error">{error}</span>}
    </div>
  );
}
