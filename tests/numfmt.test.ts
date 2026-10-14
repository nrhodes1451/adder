import { describe, expect, it } from "vitest";
import { adjustDecimals } from "../src/engine/numfmt";

describe("adjustDecimals", () => {
  it("starts General formats from the decimals on show", () => {
    expect(adjustDecimals("general", 1, "1234.5")).toBe("0.00");
    expect(adjustDecimals("general", -1, "1234.5")).toBe("0");
    expect(adjustDecimals("general", 1, "7")).toBe("0.0");
    expect(adjustDecimals("general", -1, "7")).toBeNull();
    expect(adjustDecimals("general", 1, "hello")).toBeNull();
  });

  it("adds and removes decimals in number formats", () => {
    expect(adjustDecimals("#,##0.00", 1, "")).toBe("#,##0.000");
    expect(adjustDecimals("#,##0.00", -1, "")).toBe("#,##0.0");
    expect(adjustDecimals("#,##0.0", -1, "")).toBe("#,##0");
    expect(adjustDecimals("#,##0", -1, "")).toBeNull();
    expect(adjustDecimals("#,##0", 1, "")).toBe("#,##0.0");
    expect(adjustDecimals("0%", 1, "")).toBe("0.0%");
    expect(adjustDecimals("0.00E+00", -1, "")).toBe("0.0E+00");
  });

  it("changes every section and leaves literals alone", () => {
    expect(adjustDecimals("#,##0.00;(#,##0.00);-", 1, "")).toBe("#,##0.000;(#,##0.000);-");
    expect(adjustDecimals('"Q0" 0.0', 1, "")).toBe('"Q0" 0.00');
    expect(adjustDecimals('[Red]"$"#,##0.00', -1, "")).toBe('[Red]"$"#,##0.0');
  });

  it("leaves dates and times alone", () => {
    expect(adjustDecimals("d-mmm-yy", 1, "15-Mar-23")).toBeNull();
    expect(adjustDecimals("hh:mm:ss.000", 1, "")).toBeNull();
  });
});
