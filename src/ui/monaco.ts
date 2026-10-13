// Monaco editor core + standard UI contributions + Python highlighting only
// (no bundled TS/CSS/HTML/JSON language services). Loaded lazily by the script panel.
import "monaco-editor/internal/common/workers.js";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/python/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };
