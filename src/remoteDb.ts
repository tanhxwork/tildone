import { hubExecute, hubSelect } from "./hubClient";

/** The two calls db.ts makes on a connection; tauri-plugin-sql's Database has them too. */
export interface Db {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

let replayKey: { key: string; n: number } | null = null;

/**
 * Run `fn` with each write it makes sent to the hub under the key `${key}:${n}`, so a
 * write the hub already ran (its response lost) is not run twice when `fn` is retried.
 * Only the offline replay uses it, and it is safe because writes during a replay are
 * held in the queue: nothing else can send a write while the key is set.
 */
export async function withOpKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  replayKey = { key, n: 0 };
  try {
    return await fn();
  } finally {
    replayKey = null;
  }
}

/** The hub's SQLite behind the same select/execute the local connection offers. */
export const remoteDb: Db = {
  select: <T>(sql: string, params: unknown[] = []) => hubSelect<T>(sql, params),
  execute: (sql, params = []) =>
    hubExecute(sql, params, replayKey ? `${replayKey.key}:${replayKey.n++}` : undefined),
};
