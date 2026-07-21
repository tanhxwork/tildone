import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Which worktree is this? scripts/worktree-slug.sh is the single source of
// truth — scripts/e2e-build.sh derives the identifier and target dir from the
// same value, so the harness and the binary can never disagree.
const slug = execFileSync("./scripts/worktree-slug.sh", { encoding: "utf8" }).trim();

const IDENTIFIER = `com.tildone.e2e.${slug}`;
const DATA_DIR = join(homedir(), "Library/Application Support", IDENTIFIER);

// The binary is per-worktree (scripts/e2e-build.sh sets CARGO_TARGET_DIR),
// because the identifier is compiled in: a shared target/debug/tildone hands
// every worktree whoever built last. TAURI_E2E_BINARY still overrides.
function tauriBinary(): string {
  return process.env.TAURI_E2E_BINARY ?? join("./src-tauri/target-e2e", "debug", "tildone");
}

function isPortFree(port: number): boolean {
  try {
    execFileSync("nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
    return false; // something answered
  } catch {
    return true;
  }
}

/**
 * Pick a WebDriver port nothing is listening on.
 *
 * This is the fix for the false-PASS class (TIL-147): @wdio/tauri-service
 * spawns the app and then polls the status URL, but never checks that the
 * responder is the process it just spawned. A leftover debug tildone holding
 * the port answers `ready` instantly, so the whole suite drives the *stale*
 * app and "passes" in about a second with zero real interaction. Meanwhile the
 * app we launched logged a bind failure and kept running — the plugin only
 * warns (server/mod.rs), it does not exit.
 *
 * Starting from a per-worktree base keeps parallel sessions off each other's
 * ports; scanning up past anything already listening means a squatter is
 * impossible by construction rather than merely detected.
 */
function pickWebdriverPort(): number {
  const explicit = process.env.TILDONE_E2E_WEBDRIVER_PORT;
  if (explicit) {
    const port = Number(explicit);
    if (!isPortFree(port)) {
      throw new Error(
        `TILDONE_E2E_WEBDRIVER_PORT=${port} is already in use. Something is listening ` +
          `there — most likely a leftover debug tildone. The run would have driven that ` +
          `process instead of the app it launched. Kill it, or unset the variable to ` +
          `let this config pick a free port.`,
      );
    }
    return port;
  }

  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) % 400;
  const base = 4500 + hash;

  // Ports linger for a moment after the previous spec file's app exits, so
  // stepping past an occupied one is routine rather than a warning sign.
  for (let port = base; port < base + 50; port++) {
    if (isPortFree(port)) return port;
  }
  throw new Error(`No free WebDriver port in ${base}..${base + 49}`);
}

/**
 * The one port for this whole run.
 *
 * This file is imported twice over: once by the launcher, which starts the app
 * in onPrepare, and again by every spec worker. Choosing independently in each
 * process is a bug with a very quiet symptom — the launcher takes P and binds
 * the app there, then each worker re-imports, finds P *occupied by that very
 * app*, and picks P+1. WebDriver still talks to P (the launcher wrote the
 * capabilities), but the service's direct-eval channel reads
 * TAURI_WEBDRIVER_PORT from the worker and so aims at P+1, where nothing is
 * listening. Every command then logs "Failed to get window states: fetch
 * failed", the window is never raised, and WKWebView stops matching
 * :focus-within — which is the Insert-button flake (TIL-147).
 *
 * So the launcher decides, and publishes its choice in the environment; the
 * workers it forks inherit that and take it verbatim, never re-probing.
 */
function resolveWebdriverPort(): number {
  const assigned = process.env.TILDONE_E2E_PORT_ASSIGNED;
  if (assigned) return Number(assigned);
  const port = pickWebdriverPort();
  process.env.TILDONE_E2E_PORT_ASSIGNED = String(port);
  return port;
}

const WEBDRIVER_PORT = resolveWebdriverPort();

// The service resolves its *embedded* port from the `embeddedPort` option, but
// its direct-eval channel reads only TAURI_WEBDRIVER_PORT (default 4445).
process.env.TAURI_WEBDRIVER_PORT = String(WEBDRIVER_PORT);

/**
 * The hashed entry bundle this worktree's `dist/` currently points at.
 *
 * Throws rather than returning null: a guard that quietly disables itself when
 * it cannot read dist/index.html is worse than no guard, because the run still
 * reports green and nobody learns the staleness check never ran.
 */
function expectedBundle(): string {
  let html: string;
  try {
    html = readFileSync("./dist/index.html", "utf8");
  } catch (e) {
    throw new Error(
      `Cannot read ./dist/index.html, so the stale-frontend check cannot run: ${String(e)}. ` +
        `Run \`bun run e2e:build\` (which builds dist/ and the binary together).`,
    );
  }
  const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  if (!src) {
    throw new Error(
      "No <script src> found in ./dist/index.html — the stale-frontend check cannot run. " +
        "If the bundler's output shape changed, update this matcher rather than skipping it.",
    );
  }
  return src.split("/").pop() as string;
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./tests/e2e/**/*.spec.ts"],
  maxInstances: 1,

  // Embedded WebDriver runs inside the debug build (tauri-plugin-wdio-webdriver,
  // registered under cfg(debug_assertions)); no external driver exists for
  // WKWebView on macOS.
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: tauriBinary(),
        driverProvider: "embedded",
        embeddedPort: WEBDRIVER_PORT,
      },
    ],
  ],
  capabilities: [{ browserName: "tauri" }],

  // Per-worktree identifier (scripts/e2e-build.sh), so this wipe can never
  // delete the board a parallel session's run is in the middle of using —
  // which is exactly what happened during the TIL-136 verify (TIL-140).
  onPrepare: () => {
    console.log(`[e2e] ${IDENTIFIER} · webdriver port ${WEBDRIVER_PORT}`);
    rmSync(DATA_DIR, { recursive: true, force: true });
  },

  // Prove the app under test is running THIS worktree's frontend before any
  // spec draws a conclusion from it. Cargo skips the relink when only frontend
  // files changed, so the binary can still embed an older dist/ (TIL-110);
  // e2e-build.sh touches lib.rs to prevent it, and this asserts it worked.
  before: async () => {
    const expected = expectedBundle();
    const loaded = await browser.execute(
      () => document.querySelector("script[src]")?.getAttribute("src") ?? "",
    );
    const loadedFile = String(loaded).split("/").pop();
    if (loadedFile !== expected) {
      throw new Error(
        `The running app is serving ${loadedFile}, but this worktree's dist/ ` +
          `points at ${expected}. The binary embeds a stale frontend — rerun ` +
          `\`bun run e2e:build\`. (Every assertion after this would have been ` +
          `about code that is not in your diff.)`,
      );
    }
  },

  logLevel: "warn",
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60000 },
  waitforTimeout: 10000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 3,
};
