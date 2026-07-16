-- An append-only feed of board changes, so an agent can ask "what happened
-- since cursor N" instead of re-listing every task on a timer.
--
-- Written by TRIGGERS, deliberately, not by the application. tildone has two
-- independent writers of this database — the Rust MCP server (agent.rs) and the
-- TS store (store.ts) — and keeping a log in sync by hand across both has
-- already failed once: Kanban drag goes through applyPositions (store.ts:319),
-- which writes status straight to the row and records no task_activity, so the
-- single most common board gesture was invisible to the activity log. A trigger
-- fires for whoever writes, including a writer that forgets it exists.
--
-- created_at uses strftime('%Y-%m-%dT%H:%M:%fZ') and NOT datetime('now'):
-- %f yields SS.SSS, so this matches now_iso() (agent.rs) and JS toISOString().
-- datetime('now') would emit "YYYY-MM-DD HH:MM:SS" — the marker-less format
-- migration 004 existed to remove, which consumers misread as local time.
--
-- Additive only: CREATE TABLE/INDEX/TRIGGER. No rebuild of `tasks`, so no
-- ON DELETE CASCADE fires inside the plugin's migration transaction
-- (docs/decisions/2026-07-16-sqlite-migration-safety.md).

CREATE TABLE changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity     TEXT    NOT NULL,
    entity_id  INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);

CREATE INDEX idx_changes_id ON changes(id);

CREATE TRIGGER changes_task_created AFTER INSERT ON tasks
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'created', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- `AFTER UPDATE OF status` fires whenever `status` appears in the SET list even
-- if the value is identical, and applyPositions rewrites status+position for
-- EVERY card in a column on any drag. Without the WHEN guard, dragging one card
-- into a 5-card column would report 5 status changes and wake an agent 5 times
-- for 4 cards that never moved. The guard is load-bearing, not defensive.
CREATE TRIGGER changes_task_status AFTER UPDATE OF status ON tasks
WHEN OLD.status IS NOT NEW.status
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'status', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_task_moved AFTER UPDATE OF position ON tasks
WHEN OLD.position IS NOT NEW.position
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'moved', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_task_trashed AFTER UPDATE OF deleted_at ON tasks
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'trashed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_task_restored AFTER UPDATE OF deleted_at ON tasks
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'restored', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_task_edited
AFTER UPDATE OF title, notes, priority, due_date, project_id ON tasks
WHEN OLD.title IS NOT NEW.title
   OR OLD.notes IS NOT NEW.notes
   OR OLD.priority IS NOT NEW.priority
   OR OLD.due_date IS NOT NEW.due_date
   OR OLD.project_id IS NOT NEW.project_id
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.id, 'edited', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
