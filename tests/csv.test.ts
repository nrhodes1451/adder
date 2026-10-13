import { describe, expect, it } from "vitest";
import { parseCsv, sniffDelimiter, toCsv } from "../src/io/csv";

describe("csv", () => {
  it("parses quotes, escaped quotes, embedded newlines and CRLF", () => {
    const text = 'a,"b,c","say ""hi"""\r\n1,"line1\nline2",\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "line1\nline2", ""],
    ]);
  });

  it("handles BOM and no trailing newline", () => {
    expect(parseCsv("﻿x,y\n1,2")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });

  it("sniffs delimiters", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\n")).toBe("\t");
    expect(sniffDelimiter("a,b\n")).toBe(",");
  });

  it("round-trips", () => {
    const rows = [
      ["plain", "with,comma", 'q"uote'],
      ["multi\nline", " lead", ""],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
