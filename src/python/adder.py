"""Adder spreadsheet API for Python scripts.

    import adder
    ws = adder.sheet("Sheet1")
    ws["A1"].value = 42
    vals = ws.range("A1:C100").values
    df = ws.range("A1:C100").to_pandas(header=True)
    ws.range("E1").from_pandas(df)

Rows and columns are 1-based, like the spreadsheet. Writes are buffered and
sent to the workbook in batches; reads flush pending writes first.
"""

from __future__ import annotations

import builtins
import json
import math
import re
from typing import Any, Callable, Iterable

import _adder_bridge as _bridge  # provided by the worker

__all__ = [
    "sheet",
    "sheets",
    "active",
    "add_sheet",
    "range",
    "Sheet",
    "Range",
    "CellError",
    "function",
    "on_edit",
    "flush",
]

# The module exports a spreadsheet-style `range()`; keep the builtin reachable.
_brange = builtins.range

MAX_ROWS = 1_048_576
MAX_COLS = 16_384


class CellError(str):
    """A spreadsheet error value such as ``#DIV/0!``."""

    def __repr__(self) -> str:
        return f"CellError({str.__repr__(self)})"


# ---------------------------------------------------------------- transport

_pending: dict[int, dict[tuple[int, int], str]] = {}
_pending_count = 0
_FLUSH_AT = 200_000


def _sync(op: str, **args: Any) -> Any:
    flush()
    reply = json.loads(_bridge.sync(op, json.dumps(args)))
    if isinstance(reply, dict) and "__error" in reply:
        raise RuntimeError(reply["__error"])
    return reply


def _post(op: str, **args: Any) -> None:
    _bridge.post(op, json.dumps(args))


def _queue(sheet: int, row: int, col: int, inputs: list[list[str]]) -> None:
    global _pending_count
    cells = _pending.setdefault(sheet, {})
    for i, line in enumerate(inputs):
        for j, v in enumerate(line):
            cells[(row + i, col + j)] = v
    _pending_count += sum(len(line) for line in inputs)
    if _pending_count >= _FLUSH_AT:
        flush()


def flush() -> None:
    """Send buffered writes to the workbook now (normally automatic)."""
    global _pending_count
    for sheet, cells in _pending.items():
        for row, col, block in _blocks(cells):
            _post("write", sheet=sheet, row=row, col=col, values=block)
    _pending.clear()
    _pending_count = 0


def _blocks(cells: dict[tuple[int, int], str]) -> Iterable[tuple[int, int, list[list[str]]]]:
    """Group sparse cell writes into rectangles: per-row runs, merged down rows."""
    rows: dict[int, list[int]] = {}
    for r, c in cells:
        rows.setdefault(r, []).append(c)
    runs: list[tuple[int, int, int]] = []  # (row, c1, c2)
    for r in sorted(rows):
        cs = sorted(rows[r])
        start = prev = cs[0]
        for c in cs[1:]:
            if c != prev + 1:
                runs.append((r, start, prev))
                start = c
            prev = c
        runs.append((r, start, prev))
    # Merge vertically adjacent runs with the same span.
    open_blocks: dict[tuple[int, int], tuple[int, int]] = {}  # span -> (first row, last row)
    done: list[tuple[int, int, int, int]] = []
    for r, c1, c2 in runs:
        key = (c1, c2)
        blk = open_blocks.get(key)
        if blk and blk[1] == r - 1:
            open_blocks[key] = (blk[0], r)
        else:
            if blk:
                done.append((blk[0], blk[1], c1, c2))
            open_blocks[key] = (r, r)
    done.extend((r1, r2, c1, c2) for (c1, c2), (r1, r2) in open_blocks.items())
    for r1, r2, c1, c2 in done:
        yield r1, c1, [[cells[(r, c)] for c in _brange(c1, c2 + 1)] for r in _brange(r1, r2 + 1)]


# ---------------------------------------------------------------- values

_NUMERIC = re.compile(r"^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*%?$")
_DATEISH = re.compile(r"^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$")


def _to_input(v: Any) -> str:
    """Python value -> cell input. Strings starting with '=' are formulas."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v):
            return ""
        if math.isinf(v):
            return "#NUM!"
        return repr(v)
    if _is_numpy_scalar(v):
        return _to_input(v.item())
    if hasattr(v, "isoformat"):  # date / datetime / pandas Timestamp
        return v.isoformat(sep=" ") if hasattr(v, "hour") else v.isoformat()
    s = str(v)
    if s.startswith("="):
        return s
    # Keep text that would otherwise be parsed as a number/boolean/date as text.
    if _NUMERIC.match(s) or s.upper() in ("TRUE", "FALSE") or _DATEISH.match(s) or s.startswith("'"):
        return "'" + s
    return s


def _is_numpy_scalar(v: Any) -> bool:
    return type(v).__module__ == "numpy" and hasattr(v, "item")


def _from_json(v: Any) -> Any:
    if isinstance(v, dict) and "error" in v:
        return CellError(v["error"])
    if isinstance(v, float) and v.is_integer() and abs(v) < 2**53:
        return int(v)
    return v


def _grid(data: Any) -> list[list[Any]]:
    """Normalise a scalar, flat list or list of lists into a 2D list."""
    if hasattr(data, "tolist"):  # numpy array
        data = data.tolist()
    if not isinstance(data, (list, tuple)):
        return [[data]]
    if not data:
        return []
    if not isinstance(data[0], (list, tuple)):
        return [[x] for x in data]
    return [list(r) for r in data]


# ---------------------------------------------------------------- addresses

_A1 = re.compile(r"^\$?([A-Za-z]{1,3})?\$?(\d+)?$")


def _col_number(name: str) -> int:
    n = 0
    for ch in name.upper():
        n = n * 26 + ord(ch) - 64
    return n


def _col_name(col: int) -> str:
    s = ""
    while col > 0:
        col, rem = divmod(col - 1, 26)
        s = chr(65 + rem) + s
    return s


def _parse_ref(ref: str) -> tuple[int, int, int, int]:
    """'A1', 'A1:C3', 'B:B', '2:5' -> (row, col, rows, cols); full rows/cols are unbounded."""
    parts = ref.replace(" ", "").split(":")
    if len(parts) > 2 or not parts[0]:
        raise ValueError(f"Bad range reference: {ref!r}")
    corners = []
    for p in parts:
        m = _A1.match(p)
        if not m or not (m.group(1) or m.group(2)):
            raise ValueError(f"Bad range reference: {ref!r}")
        corners.append((int(m.group(2)) if m.group(2) else None, _col_number(m.group(1)) if m.group(1) else None))
    if len(corners) == 1:
        r, c = corners[0]
        if r is None or c is None:
            raise ValueError(f"Bad cell reference: {ref!r}")
        return r, c, 1, 1
    (r1, c1), (r2, c2) = corners
    r1, r2 = (1, MAX_ROWS) if r1 is None or r2 is None else (min(r1, r2), max(r1, r2))
    c1, c2 = (1, MAX_COLS) if c1 is None or c2 is None else (min(c1, c2), max(c1, c2))
    return r1, c1, r2 - r1 + 1, c2 - c1 + 1


def _split_sheet(ref: str) -> tuple[str | None, str]:
    if "!" not in ref:
        return None, ref
    name, addr = ref.rsplit("!", 1)
    if name.startswith("'") and name.endswith("'"):
        name = name[1:-1].replace("''", "'")
    return name, addr


# ---------------------------------------------------------------- objects


class Sheet:
    def __init__(self, index: int, name: str):
        self.index = index
        self.name = name

    def __repr__(self) -> str:
        return f"<Sheet {self.name!r}>"

    def __getitem__(self, ref: str) -> "Range":
        return self.range(ref)

    def __setitem__(self, ref: str, value: Any) -> None:
        self.range(ref).value = value

    def range(self, ref: str) -> "Range":
        r, c, nr, nc = _parse_ref(ref)
        return Range(self, r, c, nr, nc)

    def cell(self, row: int, col: int) -> "Range":
        return Range(self, row, col, 1, 1)

    @property
    def used_range(self) -> "Range":
        u = _sync("used", sheet=self.index)
        return Range(self, 1, 1, max(1, u["rows"]), max(1, u["cols"]))


class Range:
    def __init__(self, sheet: Sheet, row: int, col: int, rows: int = 1, cols: int = 1):
        if row < 1 or col < 1 or rows < 1 or cols < 1:
            raise ValueError("Rows and columns are 1-based and ranges must be non-empty")
        self.sheet = sheet
        self.row = row
        self.col = col
        self.rows = rows
        self.cols = cols

    def __repr__(self) -> str:
        return f"<Range {self.sheet.name}!{self.address}>"

    @property
    def address(self) -> str:
        tl = f"{_col_name(self.col)}{self.row}"
        if self.rows == 1 and self.cols == 1:
            return tl
        return f"{tl}:{_col_name(self.col + self.cols - 1)}{self.row + self.rows - 1}"

    @property
    def shape(self) -> tuple[int, int]:
        return self.rows, self.cols

    def _bounded(self) -> "Range":
        """Clip whole-row/column ranges to the sheet's used area for reading."""
        if self.rows < MAX_ROWS and self.cols < MAX_COLS:
            return self
        u = _sync("used", sheet=self.sheet.index)
        rows = max(1, min(self.rows, u["rows"] - self.row + 1))
        cols = max(1, min(self.cols, u["cols"] - self.col + 1))
        return Range(self.sheet, self.row, self.col, rows, cols)

    def _args(self) -> dict[str, int]:
        b = self._bounded()
        return {"sheet": b.sheet.index, "row": b.row, "col": b.col, "rows": b.rows, "cols": b.cols}

    # -- values

    @property
    def value(self) -> Any:
        """Value of the top-left cell."""
        return self.cell(1, 1).values[0][0]

    @value.setter
    def value(self, v: Any) -> None:
        if isinstance(v, (list, tuple)) or hasattr(v, "tolist"):
            self.values = v
            return
        s = _to_input(v)
        b = self._bounded()
        _queue(b.sheet.index, b.row, b.col, [[s] * b.cols for _ in _brange(b.rows)])

    @property
    def values(self) -> list[list[Any]]:
        raw = _sync("read", **self._args())
        return [[_from_json(v) for v in row] for row in raw]

    @values.setter
    def values(self, data: Any) -> None:
        """Write a 2D list (or flat list as a column) anchored at this range's top-left."""
        grid = _grid(data)
        _queue(self.sheet.index, self.row, self.col, [[_to_input(v) for v in row] for row in grid])

    @property
    def formulas(self) -> list[list[str]]:
        """Raw cell inputs: formulas for formula cells, typed text otherwise."""
        return _sync("inputs", **self._args())

    @property
    def formula(self) -> str:
        return self.cell(1, 1).formulas[0][0]

    @formula.setter
    def formula(self, f: str) -> None:
        _queue(self.sheet.index, self.row, self.col, [[f]])

    def clear(self) -> None:
        flush()
        _post("clear", **self._args())

    def cell(self, row: int, col: int) -> "Range":
        """Cell at (row, col) relative to this range, 1-based."""
        return Range(self.sheet, self.row + row - 1, self.col + col - 1)

    def offset(self, rows: int = 0, cols: int = 0) -> "Range":
        return Range(self.sheet, self.row + rows, self.col + cols, self.rows, self.cols)

    def resize(self, rows: int | None = None, cols: int | None = None) -> "Range":
        return Range(self.sheet, self.row, self.col, rows or self.rows, cols or self.cols)

    def __iter__(self):
        return iter(self.values)

    # -- pandas

    def to_pandas(self, header: bool = True, index: bool = False):
        import pandas as pd

        vals = self.values
        # Drop fully empty trailing rows (common with whole-column ranges).
        while vals and all(v is None for v in vals[-1]):
            vals.pop()
        if header and vals:
            cols = [str(c) if c is not None else f"col{i + 1}" for i, c in enumerate(vals[0])]
            df = pd.DataFrame(vals[1:], columns=cols)
        else:
            df = pd.DataFrame(vals)
        if index and len(df.columns):
            df = df.set_index(df.columns[0])
        return df

    def from_pandas(self, df, header: bool = True, index: bool = False) -> "Range":
        """Write a DataFrame at this range's top-left; returns the written range."""
        frame = df.reset_index() if index else df
        rows = frame.astype(object).where(frame.notna(), None).values.tolist()
        if header:
            rows = [[str(c) for c in frame.columns]] + rows
        self.values = rows
        return self.resize(len(rows), len(rows[0]) if rows else 1)


# ---------------------------------------------------------------- workbook


def sheets() -> list[Sheet]:
    return [Sheet(s["index"], s["name"]) for s in _sync("sheets")]


def sheet(name_or_index: str | int) -> Sheet:
    all_sheets = sheets()
    if isinstance(name_or_index, int):
        try:
            return all_sheets[name_or_index]
        except IndexError:
            raise KeyError(f"No sheet at index {name_or_index}") from None
    for s in all_sheets:
        if s.name.lower() == name_or_index.lower():
            return s
    raise KeyError(f"No sheet named {name_or_index!r}; sheets are {[s.name for s in all_sheets]}")


def active() -> Sheet:
    return sheet(_sync("active"))


def add_sheet(name: str | None = None) -> Sheet:
    return sheet(_sync("add_sheet", name=name))


def range(ref: str) -> Range:  # noqa: A001 - mirrors the spreadsheet vocabulary
    """Range from a sheet-qualified reference like ``'Data'!A1:C10`` (defaults to the active sheet)."""
    name, addr = _split_sheet(ref)
    return (sheet(name) if name else active()).range(addr)


# ---------------------------------------------------------------- hooks (wired in M6)

_functions: dict[str, Callable[..., Any]] = {}
_edit_handlers: list[tuple[str, Callable[..., Any]]] = []


def function(fn: Callable[..., Any] | None = None, *, name: str | None = None):
    """Register a custom function callable from cells, e.g. ``=DOUBLE(A1)``."""

    def register(f: Callable[..., Any]) -> Callable[..., Any]:
        _functions[(name or f.__name__).upper()] = f
        _post("functions", names=sorted(_functions))
        return f

    return register(fn) if fn else register


def on_edit(ref: str):
    """Run the decorated function after user edits intersecting ``ref`` (e.g. ``'Sheet1!B:B'``)."""

    def register(f: Callable[..., Any]) -> Callable[..., Any]:
        _edit_handlers.append((ref, f))
        _post("edit_handlers", refs=[r for r, _ in _edit_handlers])
        return f

    return register


def _reset_hooks() -> None:
    _functions.clear()
    _edit_handlers.clear()
