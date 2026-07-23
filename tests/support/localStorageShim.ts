// paneStore reads `window.localStorage` at import time (storedFraction /
// storedRailCollapsed run inside the zustand create() call). `bun test` has no
// DOM, so importing the store bare throws. Import THIS module before paneStore
// to install a minimal in-memory localStorage on globalThis/window — enough to
// exercise the store's read/write persistence without a full DOM.

class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

export const memoryStorage = new MemoryStorage();

// Bun runs every test file in one shared global scope, so a bare
// `globalThis.window = …` would leak into files that load after this one
// (Codex verify, 2026-07-23). Capture what was there, install the shim, and
// expose a restore the importing file MUST run in afterAll — so `window` /
// `localStorage` exist only while paneStore's own tests run, never after.
const g = globalThis as unknown as {
  window?: unknown;
  localStorage?: unknown;
};
const hadWindow = "window" in g;
const hadLocalStorage = "localStorage" in g;
const prevWindow = g.window;
const prevLocalStorage = g.localStorage;

g.localStorage = memoryStorage;
g.window = { ...((prevWindow as object | undefined) ?? {}), localStorage: memoryStorage };

/** Undo the shim, restoring the pre-import globals exactly (deleting the keys
 *  if they were absent before). Call from the test file's afterAll. */
export function restoreStorageShim(): void {
  if (hadLocalStorage) g.localStorage = prevLocalStorage;
  else delete g.localStorage;
  if (hadWindow) g.window = prevWindow;
  else delete g.window;
}
