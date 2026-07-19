-- Image attachments on a task: screenshots pasted into Quick Add or the task
-- detail. The image bytes live as files under <app-data>/attachments/<task_id>/
-- (blobs in SQLite would bloat the DB and slow every board query); `path` is
-- RELATIVE to the app-data dir so the row stays valid if the app-data location
-- moves (dev builds use com.tildone.dev, release com.tildone.desktop).
-- See docs/specs/2026-07-19-task-image-paste.md.
--
-- Additive only: CREATE TABLE/INDEX/TRIGGER. No rebuild of `tasks`, so no
-- ON DELETE CASCADE on tasks fires inside the plugin's migration transaction
-- (docs/decisions/2026-07-16-sqlite-migration-safety.md).
--
-- created_at uses strftime('%Y-%m-%dT%H:%M:%fZ') to match now_iso() (agent.rs)
-- and JS toISOString() — the ISO-UTC-with-Z format migration 004 standardised on.

CREATE TABLE task_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    path       TEXT    NOT NULL,   -- relative to app-data, e.g. attachments/12/img-....png
    filename   TEXT    NOT NULL,   -- display name, e.g. "Pasted image" or the dropped file's name
    bytes      INTEGER NOT NULL,
    width      INTEGER,
    height     INTEGER,
    created_at TEXT    NOT NULL
);

CREATE INDEX idx_task_images_task ON task_images(task_id);

-- Feed the change feed (migration 005): an agent parked in list_changes on a task
-- wakes when an image lands on or leaves it. entity='task' (the agent parks on a
-- TASK), kind='image'. Mirrors changes_task_link. Additive DDL, so it clears the
-- migration-safety bar. The delete trigger exists because a removed screenshot
-- changes what the card shows — the other side of the shared desk must see it.
CREATE TRIGGER changes_task_image AFTER INSERT ON task_images
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.task_id, 'image', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_task_image_delete AFTER DELETE ON task_images
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', OLD.task_id, 'image', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
