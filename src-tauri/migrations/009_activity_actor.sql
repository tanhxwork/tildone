-- Who wrote each activity row.
--
-- Until now the feed was anonymous: the Rust MCP server and the React UI both
-- INSERT hand-matched label strings ("Status changed to Done"), so a row the user
-- made and a row an agent made were byte-identical. The card could not tell you
-- which was which.
--
-- Two columns, not one. A single `actor` column would need 'user' as a sentinel
-- value, and an agent whose MCP client name happened to be "user" would then
-- silently impersonate the user. Splitting kind from name makes that impossible.
--
--   actor_kind  'user' | 'agent' | NULL   NULL = written before this migration
--   actor_name  the agent's raw MCP client name, e.g. 'claude-code'.
--               NULL for user writes and for legacy rows.
--
-- `actor_name` stores the client's name verbatim rather than a normalised enum:
-- the name is ground truth reported by the client, and normalising at write time
-- would throw away the one thing we cannot recover later. Presentation (icon,
-- display name) maps over it in the UI, where being wrong is cosmetic and fixable.
--
-- Deliberately NO CHECK constraint on either column. Adding a CHECK means a table
-- rebuild, and a rebuild fires ON DELETE CASCADE inside a transaction where
-- `foreign_keys=off` is a no-op (see docs/decisions/2026-07-16-sqlite-migration-safety.md)
-- — it would silently delete activity. Values are validated at the write boundary.
--
-- Both statements are ALTER TABLE ... ADD COLUMN: additive, no rebuild, and every
-- existing row keeps its data with the new columns NULL.

ALTER TABLE task_activity ADD COLUMN actor_kind TEXT;
ALTER TABLE task_activity ADD COLUMN actor_name TEXT;

-- Presence is a read over this index, not a stored flag: "is an agent on task T?"
-- is answered by the newest agent-written row for T. Nothing needs clearing when a
-- session dies, because nothing was set — the row just stops being recent.
CREATE INDEX idx_activity_actor ON task_activity(task_id, actor_kind, id DESC);
