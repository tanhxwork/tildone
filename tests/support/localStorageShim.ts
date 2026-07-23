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

const g = globalThis as unknown as {
  window?: { localStorage: MemoryStorage };
  localStorage?: MemoryStorage;
};
g.localStorage = memoryStorage;
g.window = { ...(g.window ?? {}), localStorage: memoryStorage };
