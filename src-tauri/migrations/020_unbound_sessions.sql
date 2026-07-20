-- Session-first intake (spec 2026-07-20-shell-escape-hatch-session-first-
-- intake): a hosted session may now exist before any card does, so task_id
-- loses NOT NULL. SQLite cannot drop a constraint in place — this is the
-- standard rebuild, as its own migration (018 is immutable history per
-- docs/decisions/2026-07-16-sqlite-migration-safety.md). Unbound rows
-- (task_id IS NULL) never become resumables; the boot sweep deletes them.
CREATE TABLE hosted_sessions_v2 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER,
  task_ref       TEXT,
  adapter_id     TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  cli_session_id TEXT,
  started_at     TEXT NOT NULL,
  live           INTEGER NOT NULL DEFAULT 1
);
INSERT INTO hosted_sessions_v2
  (id, task_id, task_ref, adapter_id, cwd, cli_session_id, started_at, live)
  SELECT id, task_id, task_ref, adapter_id, cwd, cli_session_id, started_at, live
  FROM hosted_sessions;
DROP TABLE hosted_sessions;
ALTER TABLE hosted_sessions_v2 RENAME TO hosted_sessions;
