-- Hosted-session persistence (spec 2026-07-19-anycli-workspace-v2, F3): the
-- resume key survives the app. Rows are written by host.rs, never by the
-- frontend. live=1 rows found at boot are the sessions that died with the
-- previous app instance — resumable iff cli_session_id was bound and the
-- adapter supports resume; everything else is swept.
--
-- Additive only (docs/decisions/2026-07-16-sqlite-migration-safety.md). No FK
-- on task_id: task_links learned in 016 that a cascade inside the plugin's
-- migration transaction is a trap, and a dangling row is harmlessly swept at
-- the next boot.
CREATE TABLE IF NOT EXISTS hosted_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL,
  task_ref       TEXT,
  adapter_id     TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  cli_session_id TEXT,
  started_at     TEXT NOT NULL,
  live           INTEGER NOT NULL DEFAULT 1
);

-- F4 (same branch): CI rollup for the PR chip tooltip. Nullable like
-- pr_state; vocabulary {pending, passing, failing} validated at the write
-- boundary in forge.rs, no CHECK for the same rebuild-avoidance reason as 016.
ALTER TABLE task_links ADD COLUMN pr_checks TEXT;
