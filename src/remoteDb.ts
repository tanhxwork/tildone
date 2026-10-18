import { hubExecute, hubSelect } from "./hubClient";

/** The two calls db.ts makes on a connection; tauri-plugin-sql's Database has them too. */
export interface Db {
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

/** The hub's SQLite behind the same select/execute the local connection offers. */
export const remoteDb: Db = {
  select: <T>(sql: string, params: unknown[] = []) => hubSelect<T>(sql, params),
  execute: (sql, params = []) => hubExecute(sql, params),
};
