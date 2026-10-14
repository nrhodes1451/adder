# TODO

## Charts: known limitations

Charts are stored in workbook meta (`ChartSpec` in `src/charts/model.ts`), separately from IronCalc.

- **Row/column inserts and deletes don't move charts.** A chart's source `range` and its `anchor`
  cell stay put, so inserting rows above the data leaves the chart plotting the old cells. The
  engine reports structural edits only as a generic change, so this needs the engine to say what
  moved (sheet, rows/cols, index, count) and then shift `range`/`anchor` the way formulas are
  adjusted.
- **Chart edits aren't undoable.** Inserting, moving, resizing, formatting and deleting a chart
  bypass undo, because only IronCalc keeps history and charts aren't in IronCalc.
- **xlsx import/export ignores charts.** Charts are kept only in Adder's IndexedDB save. Supporting
  `.xlsx` means mapping `ChartSpec` to and from DrawingML chart parts (`xl/charts/chartN.xml`,
  drawings and their relationships). The community SheetJS build Adder uses doesn't write charts,
  so this would need custom XML on export.

## IronCalc number formats round values between -1 and 1 wrongly

Upstream bug in IronCalc's `format_number` (`base/src/formatter/format.rs`), present in
`@ironcalc/wasm` 0.8.4 (the latest as of 2026-10). Found with `=SIN(A10/(14*PI()))` = -0.9988
showing `0.00` instead of `-1.00`.

| Value  | Format | Shows   | Excel   |
|--------|--------|---------|---------|
| 0.996  | `0.00` | `0.00`  | `1.00`  |
| -0.996 | `0.00` | `-0.00` | `-1.00` |
| 0.96   | `0.0`  | `0.0`   | `1.0`   |
| 0.996  | `#.00` | `.00`   | `1.00`  |
| -0.6   | `0`    | `1`     | `-1`    |
| -0.06  | `0.0`  | `0.1`   | `-0.1`  |

Values of 1 or more (9.996 → `10.00`, -12.6 → `-13`), percents and General are fine.

Causes:
- **Lost carry:** the value is rounded to `precision + len(floor(|v|))` significant digits, but for
  |v| < 1 `floor` is `0`, which still counts as a digit, so the value isn't rounded to the format's
  decimals. The integer part is then `floor(0.996) = 0`, and `get_fract_part` formats the fraction as
  `"1.00"` and keeps only what follows `"0."`, dropping the carried 1.
- **Lost sign:** `is_negative = value < -10^-precision` tests the unrounded value, so -0.6 at 0
  decimals (not < -1) and -0.06 at 1 decimal (not < -0.1) lose their minus sign.

Fix sketch (untested): round to `precision` decimals before splitting (for |v| < 1 the integer
digit count is 0, not 1), and compute `is_negative` from the rounded value, e.g.
`value < 0.0 && (value.abs() * 10f64.powi(precision)).round() >= 1.0`.

Adder can't work around this in `IronCalcEngine.getDisplay`: IronCalc only exposes a formula's
formatted text, not its raw value, so a buggy `0.00` (from 0.996) can't be told apart from a real
0.001. Options: report upstream with the table above, or build and vendor a patched wasm (needs
rustup + wasm-pack). Related: 0.995 at `0.00` shows `0.99` (binary rounding) where Excel shows `1.00`.
