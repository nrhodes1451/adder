import { useRef, useState } from "react";
import { baseName, download, exportCsv, importCsv, readXlsx, xlsxBlob } from "../io/files";
import type { ExportOptions } from "../io/xlsx";
import { Workbook } from "./workbook";

interface Props {
  workbook: Workbook;
  sheet: number;
  exportOptions?: () => ExportOptions;
  onOpenWorkbook: (wb: Promise<Workbook>) => void;
  onSheetAdded: (sheet: number) => void;
}

export function FileMenu({ workbook, sheet, exportOptions, onOpenWorkbook, onSheetAdded }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setError(null);
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const engine = await readXlsx(file);
        onOpenWorkbook(Workbook.create(baseName(file.name), engine));
      } else {
        onSheetAdded(importCsv(workbook.engine, await file.text(), baseName(file.name)));
      }
    } catch (e) {
      setError(`Couldn't import ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onAction = async (action: string) => {
    setError(null);
    try {
      if (action === "import") input.current?.click();
      if (action === "xlsx") download(await xlsxBlob(workbook.engine, exportOptions?.()), `${workbook.name}.xlsx`);
      if (action === "csv") {
        const name = workbook.engine.sheets()[sheet]?.name ?? "Sheet";
        download(new Blob([exportCsv(workbook.engine, sheet)], { type: "text/csv" }), `${workbook.name} - ${name}.csv`);
      }
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      <select aria-label="File" value="" onChange={(e) => void onAction(e.target.value)}>
        <option value="">File…</option>
        <option value="import">Import .xlsx / .csv…</option>
        <option value="xlsx">Download as .xlsx</option>
        <option value="csv">Download sheet as .csv</option>
      </select>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,.tsv,.txt"
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void onFile(f);
        }}
      />
      {error && (
        <span className="toolbar-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
