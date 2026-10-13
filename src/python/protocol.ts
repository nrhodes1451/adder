import type { ChannelBuffers } from "./channel";

export const PYODIDE_VERSION = "314.0.7"; // keep in sync with the `pyodide` devDependency
export const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export type PyStatus = "idle" | "loading" | "ready" | "running";
export type Stream = "stdout" | "stderr" | "info";

export type ToWorker =
  | { type: "init"; channel: ChannelBuffers; interrupt: SharedArrayBuffer }
  | { type: "run"; id: number; code: string }
  | { type: "call"; id: number; name: string; args: unknown[] }
  | { type: "edit"; id: number; ref: string; event: EditEvent };

export type FromWorker =
  | { type: "status"; status: PyStatus }
  | { type: "output"; stream: Stream; text: string }
  | { type: "done"; id: number; error?: string }
  | { type: "call-result"; id: number; value?: unknown; error?: string }
  | { type: "sync"; op: string; args: string }
  | { type: "sync-next" }
  | { type: "post"; op: string; args: string };

export interface EditEvent {
  sheet: string;
  range: string;
  row: number;
  col: number;
  rows: number;
  cols: number;
  values: unknown[][];
}
