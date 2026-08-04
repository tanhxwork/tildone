-- Where a task's work happened, kept after the claim is gone.
--
-- Evidence links resolve a relative path in notes ("screenshots:
-- .test-artifacts/shot.png") against the working directory the task was
-- claimed in. That directory lives in agent_claims — but completing a task
-- releases every claim on it (release_claims_for_task), and a finished card is
-- exactly where an Evidence block ends up. Without this snapshot the links go
-- inert the moment the work is done, which is the one moment they matter
-- (found by the Codex verify pass on TIL-203).
--
-- One row per task, overwritten by the newest claim: a task worked in three
-- worktrees resolves against the last one, and that is the only answer the
-- prose can be read against anyway.
CREATE TABLE IF NOT EXISTS task_cwds (
    task_id    INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    cwd        TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

-- Backfill from the claims that still exist, so tasks in flight today keep
-- their directory when they are completed.
INSERT OR REPLACE INTO task_cwds (task_id, cwd, updated_at)
SELECT task_id, cwd, claimed_at FROM agent_claims WHERE cwd IS NOT NULL;
