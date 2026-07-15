-- created_at was always filled by SQLite's `DEFAULT (datetime('now'))`, which
-- emits "YYYY-MM-DD HH:MM:SS": UTC, but with no timezone marker. Consumers
-- (JS `new Date(...)`, agents doing date maths) read that as *local* time and
-- land hours off. completed_at has always been ISO-8601 with a Z, so the same
-- row returned two different formats.
--
-- Normalise created_at to match completed_at. Writers now pass created_at
-- explicitly, so the column DEFAULT is only a fallback.
--
-- strftime returns NULL for an unparseable input; the IS NOT NULL guard keeps
-- such a row unchanged rather than failing the NOT NULL constraint and taking
-- the whole migration down with it.

UPDATE projects
   SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
 WHERE created_at NOT LIKE '%Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL;

UPDATE tasks
   SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
 WHERE created_at NOT LIKE '%Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL;

UPDATE task_activity
   SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
 WHERE created_at NOT LIKE '%Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL;
