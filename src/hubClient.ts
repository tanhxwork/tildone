import { invoke } from "@tauri-apps/api/core";

/**
 * Client mode: the board lives on another Tildone (the hub). Active when the
 * `board_hub_url` setting is non-empty. Rust does the HTTP (src-tauri/src/hubclient.rs);
 * these wrap its commands. Shapes match what the local commands return.
 */

/** Rust emits this about the hub connection. */
export const HUB_STATUS = "hub-status";
export interface HubStatus {
  state: "connected" | "error" | "schema-mismatch";
  message: string;
}

export interface ExecuteResult {
  rowsAffected: number;
  lastInsertId: number;
}

/** Check the hub's schema and start following its changes (re-emitted as agent-db-changed). */
export const hubConnect = () => invoke<{ version: number }>("hub_connect");

/** Stop following a hub (no-op when not following); called when this window uses its own board. */
export const hubDisconnect = () => invoke<void>("hub_disconnect");

export const hubSelect = <T>(sql: string, params: unknown[] = []) =>
  invoke<T>("hub_sql", { kind: "select", sql, params });

/** `op` is an idempotency key: the hub runs a write with a key it has already run once and returns the stored result. */
export const hubExecute = (sql: string, params: unknown[] = [], op?: string) =>
  invoke<ExecuteResult>("hub_sql", { kind: "execute", sql, params, ...(op ? { op } : {}) });

export const hubPresence = <T>() => invoke<T>("hub_presence");
export const hubClaimCwds = () => invoke<string[]>("hub_claim_cwds");
export const hubGitRemote = (cwd: string) => invoke<string | null>("hub_git_remote", { cwd });
export const hubFile = (path: string) => invoke<ArrayBuffer>("hub_file", { path });

/**
 * Store an image on the hub; resolves to its path relative to the hub's app data
 * (`attachments/<task>/<name>`, as a local attachment is stored) for db.insertImage.
 * The bytes go as a raw IPC body, not a JSON array.
 */
export const hubImagePut = (taskId: number, name: string, bytes: Uint8Array) =>
  invoke<string>("hub_image_put", bytes, {
    headers: { "x-task-id": String(taskId), "x-name": encodeURIComponent(name) },
  });

/** This machine's hub token (Settings → Agent access), created on first use. */
export const hubToken = () => invoke<string>("hub_token");
