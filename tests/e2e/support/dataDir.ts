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

export const E2E_DATA_DIR = join(
  homedir(),
  "Library/Application Support",
  `com.tildone.e2e.${slug}`,
);

export const E2E_DB = join(E2E_DATA_DIR, "tildone.db");
export const E2E_ATTACHMENTS = join(E2E_DATA_DIR, "attachments");
