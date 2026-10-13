import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine/types";
import { a1, colName, selectionBounds } from "../grid/geometry";
import type { Grid } from "../grid/grid";

export function FormulaBar({ grid, engine }: { grid: Grid; engine: Engine }) {
  const [, force] = useState(0);
  const [editText, setEditText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offGrid = grid.on((e) => {
      if (e.type === "edit") setEditText(e.text);
      else if (e.type === "caret") {
        // After autocomplete inserts text, keep the caret where the editor put it.
        const el = input.current;
        if (el && document.activeElement === el) requestAnimationFrame(() => el.setSelectionRange(e.position, e.position));
      } else force((n) => n + 1);
    });
    const offEngine = engine.onChange(() => force((n) => n + 1));
    return () => {
      offGrid();
      offEngine();
    };
  }, [grid, engine]);

  const { row, col } = grid.active;
  const b = selectionBounds(grid.selection);
  const whole = grid.wholeSelection;
  const name =
    whole === "cols"
      ? `${colName(b.c1)}:${colName(b.c2)}`
      : whole === "rows"
        ? `${b.r1}:${b.r2}`
        : b.r1 === b.r2 && b.c1 === b.c2
          ? a1(row, col)
          : `${a1(b.r1, b.c1)}:${a1(b.r2, b.c2)}`;
  const value = editText ?? grid.inputAt(row, col);

  return (
    <div className="formula-bar" data-formula-bar>
      <input className="name-box" aria-label="Cell reference" value={name} readOnly />
      <span className="fx">fx</span>
      <input
        aria-label="Formula"
        data-testid="formula-input"
        value={value}
        ref={input}
        onChange={(e) => grid.setEditText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={(e) => {
          if (grid.handleCompletionKey(e)) return;
          if (e.key === "Tab" && grid.isEditing) {
            e.preventDefault();
            grid.commitEdit([0, e.shiftKey ? -1 : 1]);
          } else if (e.key === "Enter") {
            e.preventDefault();
            // Ctrl+Enter fills the whole selection.
            if (e.ctrlKey || e.metaKey) grid.commitEdit(null, true);
            else grid.commitEdit([1, 0]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            grid.cancelEdit();
          }
        }}
      />
    </div>
  );
}
