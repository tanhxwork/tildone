-- Comments on a task: a channel back to an agent. A blocked agent asks a question
-- as a comment, the user answers with another, and the agent — parked in
-- list_changes on that task — wakes and reads the thread. This is the return leg
-- of the loop the change feed (migration 005) opened.
-- See docs/specs/2026-07-16-agent-comments.md.
--
-- actor_kind + actor_name, NOT a single `actor` string. The spec first proposed one
-- `actor TEXT` where 'user' is a value; migration 009 (task_activity) rejected exactly
-- that shape, because an agent whose MCP client name is "user" would then silently
-- impersonate the person. Splitting kind from name makes that impossible, and it lets
-- a comment's author render through the very same agentIdentity() mapping the activity
-- feed already uses — one author chip, not two.
--   actor_kind  'user' | 'agent'   — who wrote it. NOT NULL: every comment is authored
--                                     at write time by a caller that knows which it is.
--   actor_name  the agent's raw MCP client name (e.g. 'claude-code'); NULL for the user.
--
-- Additive only: CREATE TABLE/INDEX/TRIGGER. No rebuild of `tasks`, so no
-- ON DELETE CASCADE on tasks fires inside the plugin's migration transaction
-- (docs/decisions/2026-07-16-sqlite-migration-safety.md).
--
-- Deliberately NO CHECK on actor_kind: a CHECK is a table rebuild waiting to happen,
-- and a rebuild fires ON DELETE CASCADE inside a transaction where foreign_keys=off is
-- a no-op. The two allowed values are enforced at the write boundary (agent.rs, db.ts).
--
-- created_at uses strftime('%Y-%m-%dT%H:%M:%fZ') to match now_iso() (agent.rs) and JS
-- toISOString() — the ISO-UTC-with-Z format migration 004 standardised on.

CREATE TABLE comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    actor_kind TEXT    NOT NULL,   -- 'user' | 'agent'
    actor_name TEXT,               -- agent's MCP client name; NULL for the user
    created_at TEXT    NOT NULL
);

CREATE INDEX idx_comments_task ON comments(task_id);

-- Feed the change feed (migration 005): an agent parked in list_changes on a task
-- wakes the instant a comment is added to it — this is what closes the ask->answer
-- loop. entity='task' because the agent parks on a TASK, not a comment ("task 7
-- changed, kind=comment" is the useful address, so it get_task(7)s and reads the
-- thread); kind='comment'. Mirrors the changes_task_* triggers, strftime timestamp
-- and all. Additive DDL, so it clears the migration-safety bar.
CREATE TRIGGER changes_comment_added AFTER INSERT ON comments
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.task_id, 'comment', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
