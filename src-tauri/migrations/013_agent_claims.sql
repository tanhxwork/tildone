-- A claim binds one agent SESSION to the task it is working on.
--
-- Keyed on session_id, NOT cwd. cwd looked like the natural key — the project rule
-- is one session, one worktree — but that rule only binds sessions that *edit*.
-- Read-only sessions are told not to isolate, so any number of them share the main
-- checkout's path. Keying on cwd would let one session's heartbeat light up another
-- session's card: a false "working", which is the exact lie this feature exists to
-- remove.
--
-- Durable on purpose. The volatile half — the heartbeat state itself — lives in
-- memory in the agent server and never touches disk, because a beat fires on every
-- tool call of every agent. This table is the other half: written once when the
-- agent moves the task to Doing, and read whenever a beat needs to know which card
-- it belongs to. In-memory claims would blank the board on every app restart, and
-- Tildone restarts constantly while being developed.
CREATE TABLE IF NOT EXISTS agent_claims (
  session_id TEXT PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  cwd        TEXT,
  branch     TEXT,
  agent_name TEXT,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Presence is read per task, and several sessions may legitimately claim one task.
CREATE INDEX IF NOT EXISTS idx_agent_claims_task ON agent_claims(task_id);
