import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The cargo target dir may live outside the worktree (e.g. a global
// build.target-dir shared across worktrees), so ask cargo instead of
// assuming ./src-tauri/target. TAURI_E2E_BINARY overrides.
function tauriBinary(): string {
  if (process.env.TAURI_E2E_BINARY) return process.env.TAURI_E2E_BINARY;
  try {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
        cwd: "./src-tauri",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    return join(meta.target_directory, "debug", "tildone");
  } catch {
    return "./src-tauri/target/debug/tildone";
  }
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
      },
    ],
  ],
  capabilities: [{ browserName: "tauri" }],

  // The e2e binary is built with identifier com.tildone.e2e
  // (src-tauri/tauri.e2e.conf.json), so it has its own data dir and can never
  // touch the real board. Wipe it for a deterministic empty start.
  onPrepare: () => {
    rmSync(join(homedir(), "Library/Application Support/com.tildone.e2e"), {
      recursive: true,
      force: true,
    });
  },

  logLevel: "warn",
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60000 },
  waitforTimeout: 10000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 3,
};
