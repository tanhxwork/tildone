import { getSettings, setSettings, type AppSettings } from "./settingsFile";

// The write path between the stores and Rust's settings.json. It imports no
// store, so settings.ts and ai.ts can use it and appSettings.ts can import them.

type Handler = (settings: AppSettings) => void;

let handler: Handler = () => {};
let inflight = 0;
let latest: AppSettings | null = null;

/** appSettings.ts registers the function that applies a settings snapshot to the stores. */
export function onSettings(fn: Handler) {
  handler = fn;
}

/**
 * A snapshot from Rust (an event, or the result of a write). While a write of
 * ours is still out, hold it: applying it would put an older value back into a
 * field the user is still typing in. The last write's reply carries everything.
 */
export function receive(settings: AppSettings) {
  latest = settings;
  if (inflight === 0) flush();
}

function flush() {
  if (!latest) return;
  const next = latest;
  latest = null;
  handler(next);
}

/**
 * Send a patch to Rust. The caller has already shown the change in its store;
 * the reply then settles the stores (and runs the side effects) like any other
 * writer's change. A rejection (a value Rust refuses) is logged and the stores
 * are put back to what the file holds.
 */
export function writeSettings(patch: Partial<AppSettings>) {
  inflight++;
  setSettings(patch)
    .then(receive)
    .catch((err) => {
      console.error("tildone: settings change refused:", err);
      return getSettings().then(receive);
    })
    .catch(() => {})
    .finally(() => {
      inflight--;
      if (inflight === 0) flush();
    });
}
