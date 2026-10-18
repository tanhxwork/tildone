import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The app-data directory of the e2e build under test.
 *
 * The identifier is per-worktree (com.tildone.e2e.<slug>) so parallel sessions
 * cannot wipe each other's run — see scripts/e2e-build.sh and TIL-140. Specs
 * that assert on files must therefore derive the path rather than hard-code it;
 * scripts/worktree-slug.sh stays the single source of the slug for the build,
 * the wdio config and these specs alike.
 */
const slug = execFileSync("./scripts/worktree-slug.sh", { encoding: "utf8" }).trim();

/** Tauri's appDataDir root (attachments): ~/Library/Application Support on macOS, $XDG_DATA_HOME on Linux. */
export const APP_DATA_ROOT =
  process.platform === "darwin"
    ? join(homedir(), "Library/Application Support")
    : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"));

/** Tauri's appConfigDir root (tildone.db, via tauri-plugin-sql): the same folder on macOS, $XDG_CONFIG_HOME on Linux. */
export const APP_CONFIG_ROOT =
  process.platform === "darwin"
    ? join(homedir(), "Library/Application Support")
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));

export const E2E_DATA_DIR = join(APP_DATA_ROOT, `com.tildone.e2e.${slug}`);
export const E2E_CONFIG_DIR = join(APP_CONFIG_ROOT, `com.tildone.e2e.${slug}`);

export const E2E_DB = join(E2E_CONFIG_DIR, "tildone.db");
export const E2E_ATTACHMENTS = join(E2E_DATA_DIR, "attachments");
