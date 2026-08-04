-- Correct the 023 backfill: pick the NEWEST claim per task, not an arbitrary one.
--
-- 023's `INSERT OR REPLACE … SELECT` had no ORDER BY, so for a task claimed by
-- several sessions (pairing, or a re-claim after a worktree move) whichever row
-- SQLite happened to visit last won — and a relative evidence path would then
-- resolve against a directory the notes were never written in (found by the
-- Codex verify pass on TIL-203).
--
-- A separate migration rather than an edit to 023: 023 has already been applied
-- on installed copies, and applied migrations are never re-run — editing one
-- only changes what a *fresh* database gets, which is how the two silently
-- diverge.
INSERT OR REPLACE INTO task_cwds (task_id, cwd, updated_at)
SELECT task_id, cwd, claimed_at
  FROM agent_claims
 WHERE cwd IS NOT NULL
 ORDER BY claimed_at ASC;
