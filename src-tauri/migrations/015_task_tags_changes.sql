-- Tag changes reach the change feed. Since the needs-review tag started driving
-- a board section, tagging/untagging is a real board event — but task_tags had
-- no triggers, so an agent parked in list_changes never woke for it.
--
-- Same shape as 008/012: AFTER INSERT/DELETE on the child table emitting a
-- change on the TASK (entity_id = task_id), because agents park on tasks, not
-- on tag rows. One kind, 'tag', for both directions — the feed says THAT the
-- tag set changed; get_task says what it now is.
--
-- Phantom-change guard (005's WHEN lesson, applied at the writer): both
-- writers used to rewrite the full tag set as DELETE-all + re-INSERT, which
-- under these triggers would emit changes for a tag set that never changed.
-- set_tags (agent.rs) and setTaskTags (db.ts) are diff-aware from this
-- migration on — they only delete removed rows and INSERT OR IGNORE additions,
-- so an identical rewrite touches no rows and these triggers stay silent.
-- Row-level triggers fire only on rows actually touched, so no WHEN is needed.
--
-- created_at uses strftime('%Y-%m-%dT%H:%M:%fZ') to match now_iso() (agent.rs)
-- and JS toISOString() — the ISO-UTC-with-Z format migration 004 standardised on.
--
-- Additive only: CREATE TRIGGER. No table rebuild, so no ON DELETE CASCADE
-- fires inside the plugin's migration transaction
-- (docs/decisions/2026-07-16-sqlite-migration-safety.md).

CREATE TRIGGER changes_task_tagged AFTER INSERT ON task_tags
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.task_id, 'tag', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_task_untagged AFTER DELETE ON task_tags
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', OLD.task_id, 'tag', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
