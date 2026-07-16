-- One-off repair of `position`, which has been accumulating duplicates since the
-- beginning.
--
-- `position` is an ordinal within one (project, status) group (agent.rs), but
-- next_position() was only ever called by create_task. Every status or project
-- change wrote the new group and carried the OLD position along, so a task
-- created at todo/0 and completed landed at done/0 — on top of whatever was
-- already there. On the author's board this had reached EIGHT tasks sharing
-- done/position 0. Duplicates make the Kanban's `position, id` sort fall through
-- to the id tiebreak, so the user's manual order was silently discarded.
--
-- The writers are fixed (Store::group_slot + apply_task_update in agent.rs,
-- groupSlot + patchTask in store.ts). This repairs what they already wrote.
--
-- Renumbers to a dense 0..N-1 per group. Note that dense is NOT an invariant the
-- app maintains — completing a card inserts at MIN-1 and lets `done` drift
-- negative rather than renumber a growing column. Dense is just the tidiest
-- starting point, and the values only ever have to be distinct and ordered.
--
-- UPDATE only: no table rebuild, so no ON DELETE CASCADE fires inside the
-- plugin's migration transaction (docs/decisions/2026-07-16-sqlite-migration-safety.md).
--
-- Accepted cost: this fires `changes_task_moved` (migration 005) once per repaired
-- row, so the first launch after upgrading pushes a burst into the change feed and
-- wakes any parked agent with a large batch. It is one-time, it is honest — the
-- rows really did move — and suppressing it would mean dropping and recreating the
-- triggers around the UPDATE, which is a worse trade than one noisy upgrade.

-- todo / doing: preserve the order the board is currently rendering, which is
-- exactly `position, id` (the same sort computeColumns uses, id breaking ties).
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY project_id, status
               ORDER BY position, id
           ) - 1 AS rn
    FROM tasks
    WHERE deleted_at IS NULL AND status IN ('todo', 'doing')
)
UPDATE tasks
SET position = (SELECT rn FROM ranked WHERE ranked.id = tasks.id)
WHERE id IN (SELECT id FROM ranked)
  AND position IS NOT (SELECT rn FROM ranked WHERE ranked.id = tasks.id);

-- done: newest completion first, which is what the column is fixed to read from
-- now on. The old order here is not worth preserving — it was the id tiebreak,
-- i.e. creation order, which is not an order anybody chose. NULL completed_at
-- sorts last under DESC in SQLite, so undated completions sink to the bottom.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY project_id, status
               ORDER BY completed_at DESC, id DESC
           ) - 1 AS rn
    FROM tasks
    WHERE deleted_at IS NULL AND status = 'done'
)
UPDATE tasks
SET position = (SELECT rn FROM ranked WHERE ranked.id = tasks.id)
WHERE id IN (SELECT id FROM ranked)
  AND position IS NOT (SELECT rn FROM ranked WHERE ranked.id = tasks.id);
