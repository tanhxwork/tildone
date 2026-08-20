-- Goals: the level between a project and a task. A goal is a named outcome that
-- owns tasks and tracks progress toward it — the thing `[[TIL-nn]]` refs written
-- into notes were faking, with no rollup and nothing to close.
-- See docs/specs/2026-08-20-goals-inside-projects.md.
--
-- Additive only — one CREATE TABLE and one ADD COLUMN — so no table rebuild, and
-- therefore none of the hazard in docs/decisions/2026-07-16-sqlite-migration-safety.md
-- (foreign keys are a no-op inside the plugin's migration transaction; only a
-- rebuild's implicit drop would care). SQLite permits a REFERENCES clause on
-- ADD COLUMN precisely because the new column defaults to NULL.
--
-- Two cascades, deliberately different:
--
--   goals.project_id  ON DELETE CASCADE   a project's goals die with it, as its
--                                         tasks already do.
--   tasks.goal_id     ON DELETE SET NULL  deleting a goal NEVER deletes tasks —
--                                         they return to "No goal". That is what
--                                         makes delete_goal safe to hand an agent,
--                                         unlike delete_project.
--
-- Both are real at runtime: sqlx (the plugin-sql backend) enables foreign_keys by
-- default, and agent.rs sets the pragma explicitly on its own connection.
--
-- No CHECK constraints — a CHECK forces a rebuild on any later widening. Shape is
-- validated at the write boundary in db.ts and agent.rs, as migration 011 chose.
--
-- created_at is written explicitly as ISO-8601 with a Z by both write paths
-- (migration 004); the column default is a fallback for hand-inserted rows only.
--
-- Progress is NOT stored. It is derived (done / total over the goal's non-trashed
-- tasks) so it can never drift from the tasks it describes. completed_at is the
-- only completion state, and it is set by hand — a goal does not close itself when
-- its last task lands.

CREATE TABLE goals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    notes        TEXT    NOT NULL DEFAULT '',
    color        TEXT    NOT NULL DEFAULT '#5645d4',
    position     INTEGER NOT NULL DEFAULT 0,
    target_date  TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

ALTER TABLE tasks ADD COLUMN goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL;

CREATE INDEX idx_goals_project ON goals(project_id);
CREATE INDEX idx_tasks_goal    ON tasks(goal_id);

-- The change feed (migration 005) is written by TRIGGERS, never by the
-- application: tildone has two independent writers of this database — agent.rs
-- and store.ts — and a hand-kept log across both has already failed once. Goals
-- get the same treatment, so a goal written from either side shows up in
-- list_changes without either writer knowing the feed exists.
--
-- Two entities, deliberately, following what 008/012/015/019 established:
--
--   a task's goal_id changing is a change TO THE TASK ('task'/'edited'), so an
--   agent parked on that task wakes — the same reason a link or a comment is
--   logged against its task rather than as itself.
--
--   the goal row's own life (renamed, retargeted, closed, deleted) is not any
--   one task's business, so it is logged as 'goal'. list_changes reads entity as
--   an opaque string (agent.rs), so a new entity needs no Rust change.
--
-- changes_task_edited must be recreated rather than altered — SQLite has no
-- ALTER TRIGGER. Dropping and recreating a trigger touches no table, so this
-- stays additive in the sense that matters (no rebuild, no implicit cascade).

DROP TRIGGER changes_task_edited;

CREATE TRIGGER changes_task_edited
AFTER UPDATE OF title, notes, priority, due_date, project_id, goal_id ON tasks
WHEN OLD.title IS NOT NEW.title
   OR OLD.notes IS NOT NEW.notes
   OR OLD.priority IS NOT NEW.priority
   OR OLD.due_date IS NOT NEW.due_date
   OR OLD.project_id IS NOT NEW.project_id
   OR OLD.goal_id IS NOT NEW.goal_id
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'edited', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_goal_created AFTER INSERT ON goals
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('goal', NEW.id, 'created', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Split from 'edited' because closing a goal is the event anyone watching a goal
-- actually waits for, and it must stay legible without re-reading the row.
CREATE TRIGGER changes_goal_completed AFTER UPDATE OF completed_at ON goals
WHEN OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('goal', NEW.id, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_goal_reopened AFTER UPDATE OF completed_at ON goals
WHEN OLD.completed_at IS NOT NULL AND NEW.completed_at IS NULL
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('goal', NEW.id, 'reopened', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- position is excluded on purpose: reordering the sidebar is not news, and
-- including it would wake every watcher on a drag (the lesson the WHEN guard on
-- changes_task_status was added for).
CREATE TRIGGER changes_goal_edited
AFTER UPDATE OF name, notes, color, target_date ON goals
WHEN OLD.name IS NOT NEW.name
   OR OLD.notes IS NOT NEW.notes
   OR OLD.color IS NOT NEW.color
   OR OLD.target_date IS NOT NEW.target_date
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('goal', NEW.id, 'edited', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_goal_deleted AFTER DELETE ON goals
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('goal', OLD.id, 'deleted', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
