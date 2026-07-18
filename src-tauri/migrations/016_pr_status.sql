-- PR merge status for the card's PR chip (TIL-84). A task can be done yet still
-- carry an unmerged PR — a draft, or a branch behind main — and the chip must say
-- which, so a done card never reads as shipped while a branch is still in flight.
-- The agent computes the state with `gh` (state / isDraft / behind_by) and writes
-- it via set_pr_status; the card renders it. A snapshot, not a live read: the UI
-- shows what was last pushed, it cannot poll GitHub itself.
--
-- Additive ALTER TABLE ADD COLUMN only — no rebuild of task_links, so no
-- ON DELETE CASCADE fires inside the plugin's migration transaction where
-- PRAGMA foreign_keys is a no-op (docs/decisions/2026-07-16-sqlite-migration-safety.md).
--
-- NO CHECK on pr_state. Same reasoning as task_links.kind: a CHECK is a rebuild
-- waiting to happen. The set {merged, open, draft} is validated at the write
-- boundary in agent.rs instead. Both columns are nullable: existing PR links and
-- every non-PR link simply have no status, and the chip falls back to its plain
-- open-PR form.

ALTER TABLE task_links ADD COLUMN pr_state TEXT;     -- merged | open | draft (PR links only)
ALTER TABLE task_links ADD COLUMN pr_behind INTEGER; -- commits behind main, open PRs only
