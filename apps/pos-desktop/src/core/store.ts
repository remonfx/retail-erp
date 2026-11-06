/**
 * Local durable store abstraction for the POS.
 *  - TauriStore: SQLite (WAL, synchronous=FULL) in the Rust core — production desktop.
 *  - IdbStore:   IndexedDB — browser/dev mode and fallback.
 *  - MemoryStore: tests.
 * All multi-table writes that must be atomic (sale + outbox item) go through `tx()`.
 */
export type Table = 'variants' | 'barcodes' | 'prices' | 'promotions' | 'users' | 'taxes' | 'assortment' | 'customers' | 'orders' | 'outbox' | 'meta' | 'sessions' | 'cash_movements';
export const TABLES: Table[] = ['variants', 'barcodes', 'prices', 'promotions', 'users', 'taxes', 'assortment', 'customers', 'orders', 'outbox', 'meta', 'sessions', 'cash_movements'];

export interface TxOp { table: Table; op: 'put' | 'delete'; key: string; value?: unknown }

export interface PosStore {
  get<T>(table: Table, key: string): Promise<T | undefined>;
  all<T>(table: Table): Promise<T[]>;
  tx(ops: TxOp[]): Promise<void>;
  clear(table: Table): Promise<void>;
}

export const put = (table: Table, key: string, value: unknown): TxOp => ({ table, op: 'put', key, value });
export const del = (table: Table, key: string): TxOp => ({ table, op: 'delete', key });

export class MemoryStore implements PosStore {
  data = new Map<Table, Map<string, string>>(TABLES.map((t) => [t, new Map()]));
  failNextTx = false;
  async get<T>(table: Table, key: string) { const v = this.data.get(table)!.get(key); return v === undefined ? undefined : (JSON.parse(v) as T); }
  async all<T>(table: Table) { return [...this.data.get(table)!.values()].map((v) => JSON.parse(v) as T); }
  async tx(ops: TxOp[]) {
    if (this.failNextTx) { this.failNextTx = false; throw new Error('SIMULATED_POWER_LOSS'); }
    // stage then apply: all-or-nothing
    const staged = ops.map((o) => ({ ...o, json: o.op === 'put' ? JSON.stringify(o.value) : undefined }));
    for (const o of staged) { if (o.op === 'put') this.data.get(o.table)!.set(o.key, o.json!); else this.data.get(o.table)!.delete(o.key); }
  }
  async clear(table: Table) { this.data.get(table)!.clear(); }
}

export class IdbStore implements PosStore {
  private dbp: Promise<IDBDatabase>;
  constructor(name = 'retailcore-pos', factory: IDBFactory = indexedDB) {
    this.dbp = new Promise((resolve, reject) => {
      const req = factory.open(name, 2);
      req.onupgradeneeded = () => { for (const t of TABLES) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async run<T>(tables: Table[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
    const db = await this.dbp;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(tables, mode, { durability: 'strict' } as IDBTransactionOptions);
      let out: T;
      Promise.resolve(fn(tx)).then((v) => { out = v; }, reject);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    });
  }
  get<T>(table: Table, key: string) { return this.run([table], 'readonly', (tx) => new Promise<T | undefined>((res, rej) => { const r = tx.objectStore(table).get(key); r.onsuccess = () => res(r.result as T | undefined); r.onerror = () => rej(r.error); })); }
  all<T>(table: Table) { return this.run([table], 'readonly', (tx) => new Promise<T[]>((res, rej) => { const r = tx.objectStore(table).getAll(); r.onsuccess = () => res(r.result as T[]); r.onerror = () => rej(r.error); })); }
  tx(ops: TxOp[]) {
    const tables = [...new Set(ops.map((o) => o.table))];
    if (!tables.length) return Promise.resolve();
    return this.run(tables, 'readwrite', (tx) => { for (const o of ops) { const s = tx.objectStore(o.table); if (o.op === 'put') s.put(o.value, o.key); else s.delete(o.key); } });
  }
  clear(table: Table) { return this.run([table], 'readwrite', (tx) => { tx.objectStore(table).clear(); }); }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
/** Rust/SQLite-backed store (see src-tauri + crates/pos-store). */
export class TauriStore implements PosStore {
  constructor(private invoke: Invoke) {}
  async get<T>(table: Table, key: string) { const v = await this.invoke<string | null>('kv_get', { table, key }); return v === null ? undefined : (JSON.parse(v) as T); }
  async all<T>(table: Table) { return (await this.invoke<string[]>('kv_all', { table })).map((v) => JSON.parse(v) as T); }
  tx(ops: TxOp[]) { return this.invoke<void>('kv_tx', { ops: ops.map((o) => ({ table: o.table, op: o.op, key: o.key, value: o.op === 'put' ? JSON.stringify(o.value) : null })) }); }
  clear(table: Table) { return this.invoke<void>('kv_clear', { table }); }
}

export async function createStore(): Promise<PosStore> {
  const w = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
  if (w.__TAURI_INTERNALS__?.invoke) return new TauriStore(w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__));
  return new IdbStore();
}
