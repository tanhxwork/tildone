import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { E2E_DB } from "./dataDir.js";

/**
 * Per-spec-file state reset.
 *
 * The data dir is wiped once per run (wdio.conf.ts onPrepare), but the app
 * relaunches for every spec file and tildone.db is a file on disk — so without
 * this, spec file N opens on the accumulated output of specs 1..N-1. That was
 * true for the whole suite's life: a full run used to end with six tasks from
 * five different spec files sitting in the board.
 *
 * The cost was not merely a cluttered board. Assertions quietly became
 * order-dependent: humanVerifyGlow counted glowing cards across the *entire*
 * board and was correct only because no earlier spec happened to leave a
 * human-verify card behind, and two spec files carried after() hooks whose only
 * job was to hand the UI back in the state the next spec file expected. Both
 * are the same bug wearing different clothes — a spec that passes because of
 * what ran before it can equally fail because of it, and that failure looks
 * exactly like a real regression in the code under test.
 */

/**
 * Every table holding test-visible state, ordered so that no delete fires a
 * trigger that repopulates a table already emptied.
 *
 * `changes` is last on purpose and must stay there: task_tags and task_images
 * carry AFTER DELETE triggers (changes_task_untagged, changes_task_image_delete)
 * that insert into it, so emptying `changes` first would leave rows behind and
 * the app would open its Activity feed on the previous spec's ghosts.
 *
 * `_sqlx_migrations` is deliberately absent — clearing it would make the app
 * re-run every migration against a live schema on next launch.
 */
const DATA_TABLES = [
  "task_activity",
  "task_links",
  "task_images",
  "task_tags",
  "subtasks",
  "comments",
  "agent_claims",
  "hosted_sessions",
  "tasks",
  "projects",
  "tags",
  "changes",
];

/**
 * Empty the database the app is sitting on.
 *
 * Goes through the sqlite3 CLI rather than the app's own delete paths for the
 * same reason the seeding helpers do: it is a second connection to the same
 * file, so it cannot be fooled by — or accidentally exercise — whatever the UI
 * believes is on screen.
 */
export function wipeDatabase(): void {
  const deletes = DATA_TABLES.map((t) => `DELETE FROM ${t};`).join(" ");
  // One transaction, so a spec can never observe a half-cleared board. Foreign
  // keys off because the delete order above is chosen for triggers, not for FK
  // parentage, and the two orders disagree.
  const script = `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; ${deletes} DELETE FROM sqlite_sequence; COMMIT;`;
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", E2E_DB, script], {
    encoding: "utf8",
  });
}

/** localStorage keys the app persists UI state under (grepped from src/). */
const FIRST_RUN_DISMISSED = "tildone-first-run-dismissed";

/**
 * Reset the webview's own state and re-mount the app on the empty database.
 *
 * localStorage is the *second* leakage channel and the one onPrepare cannot
 * reach: WKWebView keeps it outside the app-data directory, so the nav
 * selection, view mode and first-run dismissal survive not just spec files but
 * whole runs. Clearing it here is what lets the two hand-off after() hooks go.
 *
 * The first-run dismissal is then set back deliberately rather than left
 * cleared. A truly empty localStorage means every spec file opens on the
 * first-run overlay, which would force all seven of them to carry a dismissal
 * dance in before(); pinning it dismissed gives every spec the same known
 * starting screen instead — Today, list view, no overlay.
 */
export async function resetUiState(): Promise<void> {
  await browser.execute((dismissKey: string) => {
    localStorage.clear();
    localStorage.setItem(dismissKey, "1");
  }, FIRST_RUN_DISMISSED);

  // The store read localStorage and loaded the tasks at mount, so both are
  // stale now; a reload is what actually applies the reset to what is on
  // screen. (Emitting agent-db-changed would refresh the data but leave the
  // nav state as the previous spec file left it.)
  //
  // Deferred by a tick so the navigation starts *after* this command has
  // returned its result. Calling location.reload() synchronously tears the
  // document down while the WebDriver command is still in flight, which
  // surfaces as an intermittent "target closed"-class error rather than a
  // clean reload.
  await browser.execute(() => {
    setTimeout(() => location.reload(), 0);
  });

  await browser.waitUntil(
    async () => {
      try {
        // Re-query each poll rather than reusing a handle: the element from
        // before the reload belongs to a document that no longer exists. While
        // the navigation is mid-flight the command itself can fail, and that
        // is an expected state to poll through, not a failure to report — so
        // it counts as "not ready yet" instead of aborting the wait.
        return (
          (await browser.execute(() => !!document.querySelector("#root")?.firstElementChild)) ===
          true
        );
      } catch {
        return false;
      }
    },
    { timeout: 20000, timeoutMsg: "app did not re-mount after the per-spec reset" },
  );
}

/** Empty database + clean UI state, for a spec file to start from. */
export async function resetAppState(): Promise<void> {
  wipeDatabase();
  await resetUiState();
}
