-- Repo links attached to a task: a branch, PR, commit, or worktree URL the agent
-- (or the user) records, rendered clickable on the card. The agent supplies the
-- URL — a branch name or a SHA is not an address, and only the caller standing in
-- the checkout knows the remote, the host convention, and which repo. So `label`
-- is what to show and `url` is where to go; the caller decides both.
-- See docs/specs/2026-07-16-task-repo-links.md.
--
-- Additive only: CREATE TABLE/INDEX/TRIGGER. No rebuild of `tasks`, so no
-- ON DELETE CASCADE on tasks fires inside the plugin's migration transaction
-- (docs/decisions/2026-07-16-sqlite-migration-safety.md).
--
-- NO CHECK on `kind`. A CHECK is a rebuild waiting to happen — widening the
-- allowed set later forces recreating the table, and a table rebuild fires
-- ON DELETE CASCADE inside a transaction where PRAGMA foreign_keys is a no-op.
-- Kinds (pr | branch | commit | worktree | other) are validated at the write
-- boundary in agent.rs and db.ts instead.
--
-- created_at uses strftime('%Y-%m-%dT%H:%M:%fZ') to match now_iso() (agent.rs)
-- and JS toISOString() — the ISO-UTC-with-Z format migration 004 standardised on;
-- datetime('now') would emit the marker-less string consumers misread as local.

CREATE TABLE task_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    url        TEXT    NOT NULL,
    label      TEXT    NOT NULL,
    kind       TEXT    NOT NULL,   -- pr | branch | commit | worktree | other
    created_at TEXT    NOT NULL
);

CREATE INDEX idx_task_links_task ON task_links(task_id);

-- Feed the change feed (migration 005): an agent parked in list_changes on a task
-- wakes the instant a link is attached to it. entity='task' because the agent
-- parks on a TASK, not a link ("task 7 changed, kind=link" is the useful address);
-- kind='link'. Mirrors the changes_task_* triggers exactly, including the
-- strftime timestamp. Additive DDL, so it clears the migration-safety bar.
CREATE TRIGGER changes_task_link AFTER INSERT ON task_links
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.task_id, 'link', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
