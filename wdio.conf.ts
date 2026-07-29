import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SevereServiceError } from "webdriverio";
import { resetAppState } from "./tests/e2e/support/reset.js";

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

/** The index.html scripts/e2e-build.sh copied beside the binary it embedded. */
const EMBEDDED_INDEX = join("./src-tauri/target-e2e", ".e2e-index.html");

/**
 * The hashed entry bundle the binary under test was built with.
 *
 * Read from the copy e2e-build.sh left beside the binary, NOT from `dist/`.
 * `dist/` is not a record of what the binary embeds: e2e-build.sh writes it
 * with `VITE_E2E=1`, and a later plain `bun run build` rewrites it with a
 * different hash for identical source — so comparing against it accused a
 * perfectly good binary of being stale whenever the VERIFY ladder's own
 * "build clean, then run e2e" order was followed (TIL-196).
 *
 * Throws rather than returning null: a guard that quietly disables itself when
 * it cannot read its reference is worse than no guard, because the run still
 * reports green and nobody learns the staleness check never ran.
 */
function expectedBundle(): string {
  let html: string;
  try {
    html = readFileSync(EMBEDDED_INDEX, "utf8");
  } catch (e) {
    throw new Error(
      `Cannot read ${EMBEDDED_INDEX}, so the stale-frontend check cannot run: ${String(e)}. ` +
        `Run \`bun run e2e:build\` (which builds the binary and records what it embedded).`,
    );
  }
  const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  if (!src) {
    throw new Error(
      `No <script src> found in ${EMBEDDED_INDEX} — the stale-frontend check cannot run. ` +
        "If the bundler's output shape changed, update this matcher rather than skipping it.",
    );
  }
  return src.split("/").pop() as string;
}

/**
 * Refuse to run when the binary predates the source it is supposed to contain.
 *
 * This is the half of staleness that no runtime check can see. `expectedBundle`
 * proves the app serves what the *binary* embedded; it cannot tell you the
 * binary was built before you edited `TownView.tsx`. Comparing against `dist/`
 * used to catch that case by accident — dist would have been rebuilt while the
 * binary was not — but only when something happened to rebuild dist, and at the
 * cost of the false positive in TIL-196. Asking the question directly is both
 * stricter and quieter.
 *
 * Runs in onPrepare, before any app launches, so a stale build aborts the run
 * with one message instead of surfacing as spec failures.
 *
 * Only what is compiled *into* the binary counts: `src/`, `src-tauri/src/` and
 * `index.html`. Specs are read from disk at run time, so editing `tests/` must
 * not demand a rebuild.
 */
function newestSourceMtime(): { path: string; mtimeMs: number } {
  let newest = { path: "", mtimeMs: 0 };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const { mtimeMs } = statSync(full);
        if (mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
      }
    }
  };
  walk("./src");
  walk("./src-tauri/src");
  const index = statSync("./index.html");
  if (index.mtimeMs > newest.mtimeMs) newest = { path: "./index.html", mtimeMs: index.mtimeMs };
  return newest;
}

function assertBinaryNotStale(): void {
  let builtAt: number;
  try {
    builtAt = statSync(EMBEDDED_INDEX).mtimeMs;
  } catch {
    throw new SevereServiceError(
      `No ${EMBEDDED_INDEX} — this worktree has never built its e2e binary. Run \`bun run e2e:build\`.`,
    );
  }
  const newest = newestSourceMtime();
  if (newest.mtimeMs > builtAt) {
    throw new SevereServiceError(
      `${newest.path} changed after the e2e binary was built, so the run would ` +
        `exercise code that is not in your diff. Run \`bun run e2e:build\`.`,
    );
  }
}

/**
 * Refuse a second concurrent run of *this* worktree.
 *
 * Different worktrees are isolated by identifier, port and binary, but two
 * runs of the same one share all three: onPrepare wipes the data dir out from
 * under the other, and both may end up driving one app (TIL-148). Same
 * reasoning as scripts/tauri.sh refusing a second dev instance of a worktree.
 */
const LOCK = join("./src-tauri/target-e2e", ".e2e-run.lock");

/** Is `pid` a live process? Never treat 0 as live — `kill(0, 0)` signals the
 *  whole process group and would always "succeed", turning an unreadable lock
 *  into a permanent false refusal. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function takeRunLock(): void {
  mkdirSync(dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" is the whole point: create-or-fail is atomic, so two launchers
      // starting at the same instant cannot both believe they hold the lock.
      // Reading first and writing second — which this used to do — is a race
      // that loses exactly when it matters.
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      return;
    } catch {
      let holder = 0;
      try {
        holder = Number(readFileSync(LOCK, "utf8").trim());
      } catch {
        holder = 0;
      }
      if (pidAlive(holder)) {
        throw new Error(
          `Another e2e run for this worktree is already in flight (pid ${holder}). ` +
            `They share the identifier ${IDENTIFIER}, the data dir and the port, so ` +
            `running both corrupts each other. Wait for it, or delete ${LOCK} if you ` +
            `are sure it is dead.`,
        );
      }
      // Left behind by a killed run (or still being written): clear and retry
      // once. If the retry also loses, the winner is a live run and the next
      // pass through the loop refuses properly.
      rmSync(LOCK, { force: true });
    }
  }
  throw new SevereServiceError(`Could not take the e2e run lock at ${LOCK}`);
}

function releaseRunLock(): void {
  rmSync(LOCK, { force: true });
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
    assertBinaryNotStale();
    takeRunLock();
    console.log(`[e2e] ${IDENTIFIER} · webdriver port ${WEBDRIVER_PORT}`);
    rmSync(DATA_DIR, { recursive: true, force: true });
  },

  onComplete: () => {
    releaseRunLock();
  },

  // Prove the app under test is running THIS worktree's frontend before any
  // spec draws a conclusion from it. Cargo skips the relink when only frontend
  // files changed, so the binary can still embed an older dist/ (TIL-110);
  // e2e-build.sh touches lib.rs to prevent it, and this asserts it worked.
  before: async () => {
    // Prove the app answering us is the one THIS worktree built. Port
    // selection probes for a free port but cannot reserve it, so two runs can
    // in principle pick the same one and the loser would silently drive the
    // winner's app (TIL-150). The app's own data dir carries the per-worktree
    // identifier, which makes that impossible to miss.
    const appDataDir = await browser.executeAsync((done: (v: unknown) => void) => {
      const tauri = (window as never as { __TAURI__?: { path: { appDataDir: () => Promise<string> } } })
        .__TAURI__;
      if (!tauri) return done("(no __TAURI__)");
      tauri.path.appDataDir().then(done, (e: unknown) => done(`(error: ${String(e)})`));
    });
    if (!String(appDataDir).includes(IDENTIFIER)) {
      throw new Error(
        `The app answering on port ${WEBDRIVER_PORT} reports its data dir as ` +
          `"${String(appDataDir)}", which is not ${IDENTIFIER}. This run is driving ` +
          `another worktree's app — its results would be meaningless.`,
      );
    }

    // Hand this spec file an empty board and a known screen. This hook runs
    // once per spec file (each gets its own worker session and its own app
    // launch), which is exactly the granularity the leak has: the data dir is
    // wiped once per *run*, but tildone.db outlives every relaunch inside it.
    // Doing it here rather than in each spec keeps isolation a property of the
    // harness — a new spec file cannot forget to opt in.
    // Unconditional on purpose — no env switch to turn isolation off. The
    // proof that this is load-bearing: seed a stray human-verify done card in a
    // spec file that sorts earlier, and humanVerifyGlow fails on "Verify · 1"
    // (it counts 2) without this line, passes with it.
    //
    // Ordered ABOVE the stale-frontend check and BELOW the identity check, and
    // both halves of that matter. Below, because wiping the board of an app
    // that turned out to belong to another worktree would destroy a parallel
    // run's state. Above, because when the frontend check does fail it must be
    // the *only* thing that fails: with the reset stranded behind it, a stale
    // bundle silently skipped isolation too, and the run reported four
    // unrelated specs failing on missing tasks while nine passed — which reads
    // as state pollution and sends you hunting the wrong bug (TIL-196).
    await resetAppState();

    const expected = expectedBundle();
    const loaded = await browser.execute(
      () => document.querySelector("script[src]")?.getAttribute("src") ?? "",
    );
    const loadedFile = String(loaded).split("/").pop();
    if (loadedFile !== expected) {
      throw new Error(
        `The running app is serving ${loadedFile}, but the binary this worktree ` +
          `built embedded ${expected}. Rerun \`bun run e2e:build\`. (Every ` +
          `assertion after this would have been about code that is not in your ` +
          `diff.)`,
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
