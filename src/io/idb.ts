// Workbook persistence in IndexedDB. Engine state is stored as IronCalc bytes;
// Adder-specific state (scripts, custom-function bookkeeping) lives in `meta`.

export interface Script {
  name: string;
  code: string;
}

export interface WorkbookMeta {
  scripts: Script[];
  /** Original formula text for cells rewritten by custom functions (M6). */
  customFormulas?: Record<string, string>;
}

export interface WorkbookRecord {
  id: string;
  name: string;
  bytes: Uint8Array;
  meta: WorkbookMeta;
  updatedAt: number;
}

export type WorkbookSummary = Pick<WorkbookRecord, "id" | "name" | "updatedAt">;

const DB_NAME = "adder";
const STORE = "workbooks";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listWorkbooks(): Promise<WorkbookSummary[]> {
  const all = await tx<WorkbookRecord[]>("readonly", (s) => s.getAll());
  return all.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadWorkbook(id: string): Promise<WorkbookRecord | undefined> {
  return tx<WorkbookRecord | undefined>("readonly", (s) => s.get(id));
}

export async function saveWorkbook(rec: WorkbookRecord): Promise<void> {
  await tx("readwrite", (s) => s.put(rec));
}

export async function deleteWorkbook(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** Test hook: forget the cached connection. */
export function _resetDb(): void {
  dbPromise = null;
}
