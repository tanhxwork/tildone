import { $, browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { E2E_ATTACHMENTS, E2E_DB } from "./dataDir.js";

/**
 * Per-spec-file state reset.
 *
 * The data dir is wiped once per run (wdio.conf.ts onPrepare), but the app
 * relaunches for every spec file and tildone.db is a file on disk — so without
 * this, spec file N opens on the accumulated output of specs 1..N-1. That was
 * true for the whole suite's life: a full run used to end with seven tasks from
 * six different spec files sitting in the board.
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

/** Tables that must survive the wipe. */
const KEEP = new Set(["_sqlx_migrations"]);

/**
 * Every table holding test-visible state, read from the live schema.
 *
 * Deliberately *not* a hardcoded list. The first version of this file carried
 * one, transcribed from a `.tables` dump — of a database belonging to an older
 * worktree, which predated migration 022. The result shipped with
 * `secretary_offsets` missing from the wipe, so the board secretary's
 * per-session transcript cursors still leaked between spec files. A literal
 * list is a standing invitation for the next migration to reopen that hole in
 * silence; asking the database what tables exist cannot go stale.
 *
 * `changes` is forced last and must stay there: task_tags and task_images carry
 * AFTER DELETE triggers (changes_task_untagged in 015_task_tags_changes.sql,
 * changes_task_image_delete in 019_task_images.sql) that insert into it, so
 * emptying it earlier would leave rows behind and the app would open its
 * Activity feed on the previous spec's ghosts.
 */
function dataTables(): string[] {
  const raw = sqlite(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
  );
  const tables = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name && !KEEP.has(name));

  if (tables.length === 0) {
    throw new Error(
      `No data tables found in ${E2E_DB}. Either the app has not created its ` +
        `schema yet or the query is wrong — wiping nothing while reporting ` +
        `success is exactly the silent failure this reset exists to prevent.`,
    );
  }

  return [...tables.filter((t) => t !== "changes"), ...tables.filter((t) => t === "changes")];
}

function sqlite(statement: string): string {
  return execFileSync("sqlite3", ["-cmd", ".timeout 5000", E2E_DB, statement], {
    encoding: "utf8",
  }).trim();
}

/**
 * Empty the database the app is sitting on, and drop its attachment files.
 *
 * Goes through the sqlite3 CLI rather than the app's own delete paths for the
 * same reason the seeding helpers do: it is a second connection to the same
 * file, so it cannot be fooled by — or accidentally exercise — whatever the UI
 * believes is on screen.
 */
export function wipeDatabase(): void {
  const deletes = dataTables()
    .map((t) => `DELETE FROM ${t};`)
    .join(" ");
  // One transaction, so a spec can never observe a half-cleared board. Foreign
  // keys off because the delete order above is chosen for triggers, not for FK
  // parentage, and the two orders disagree.
  //
  // sqlite_sequence is unguarded on purpose: 001_init.sql creates AUTOINCREMENT
  // tables, so SQLite has always materialised it by the time a spec runs. (On a
  // schema with no AUTOINCREMENT table at all this would fail loudly, which is
  // the right outcome — it would mean the schema is not the one we think.)
  sqlite(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; ${deletes} DELETE FROM sqlite_sequence; COMMIT;`);

  // Attachment blobs live on disk beside the DB, so row-only wiping would leave
  // orphans piling up across spec files. attachmentCleanup.spec.ts is immune
  // either way (it counts relative to a baseline it captures itself), but
  // "isolated" should mean the filesystem too, not just sqlite.
  rmSync(E2E_ATTACHMENTS, { recursive: true, force: true });
}

/**
 * The localStorage key FirstRun.tsx reads to decide whether to show the
 * onboarding overlay. Duplicated from src/components/FirstRun.tsx — if that
 * constant is ever renamed this copy goes stale, so resetUiState() asserts the
 * overlay is actually gone rather than trusting the write to have worked.
 */
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
 * first-run overlay, which would force all eight of them to carry a dismissal
 * dance in before(); pinning it dismissed gives every spec the same known
 * starting screen instead — Today, list view, no overlay.
 */
export async function resetUiState(): Promise<void> {
  await browser.execute((dismissKey: string) => {
    localStorage.clear();
    localStorage.setItem(dismissKey, "1");
    // Marks THIS document. It cannot survive a reload — a fresh document gets a
    // fresh global — so its absence is positive proof the navigation happened,
    // which "#root has children" is not: that is already true right now, before
    // the reload, and a poll racing the deferred navigation below could
    // otherwise satisfy itself against the pre-reload page and return having
    // applied nothing at all.
    (window as unknown as Record<string, unknown>).__tildoneAwaitingReload = true;
    // Deferred by a tick so the navigation starts *after* this command has
    // returned its result. Reloading synchronously tears the document down
    // while the WebDriver command is still in flight, which surfaces as an
    // intermittent "target closed"-class error rather than a clean reload.
    setTimeout(() => location.reload(), 0);
  }, FIRST_RUN_DISMISSED);

  let lastError: unknown = null;
  try {
    await browser.waitUntil(
      async () => {
        try {
          // Re-query each poll rather than reusing a handle: the element from
          // before the reload belongs to a document that no longer exists.
          return (
            (await browser.execute(() => {
              const reloaded = !(window as unknown as Record<string, unknown>)
                .__tildoneAwaitingReload;
              return reloaded && !!document.querySelector("#root")?.firstElementChild;
            })) === true
          );
        } catch (e) {
          // The command genuinely does fail while the navigation is in flight,
          // so this cannot simply rethrow. But swallowing outright would let a
          // real fault (dead session, script error) masquerade as "app did not
          // re-mount", so the last one is kept and reported if we time out.
          lastError = e;
          return false;
        }
      },
      { timeout: 20000, timeoutMsg: "app did not re-mount after the per-spec reset" },
    );
  } catch (e) {
    throw new Error(
      `${String(e)}${lastError ? `\nLast error while polling: ${String(lastError)}` : ""}`,
    );
  }

  // Prove the dismissal key actually suppressed onboarding. Every spec dropped
  // its own overlay-dismissal block on the strength of this, so if the constant
  // in FirstRun.tsx is renamed the specs must fail *here*, naming the cause,
  // rather than eight files away with "element not found".
  if (await $(".firstrun-overlay").isExisting()) {
    throw new Error(
      `The first-run overlay is showing after the reset, so "${FIRST_RUN_DISMISSED}" is no ` +
        `longer the key src/components/FirstRun.tsx reads. Update the copy in this file — ` +
        `every spec relies on it to open on a usable screen.`,
    );
  }
}

/** Empty database + clean UI state, for a spec file to start from. */
export async function resetAppState(): Promise<void> {
  wipeDatabase();
  await resetUiState();
}
