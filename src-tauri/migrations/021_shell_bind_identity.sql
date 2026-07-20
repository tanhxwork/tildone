-- Shell binding by pid ancestry (spec 2026-07-20-shell-binding-by-pid-ancestry).
--
-- `cli_session_id` was answering two questions at once: which agent session
-- owns this pane, and which CLI transcript may become `--resume` argv. Only
-- the second can be proven from an artifact, so ownership moves to its own
-- column and `cli_session_id` narrows to "a resumable id, argv-proven".
ALTER TABLE hosted_sessions ADD COLUMN claim_session_id TEXT;

-- Every existing shell value predates the argv-proof rule and is therefore
-- unproven: all sessions for one repo share a slug dir, and a shell's bind
-- only ever checked that *some* CLI ran beneath it — never that the
-- transcript came from that CLI. One row in the wild is known to have taken
-- its id from a foreign concurrent session. Clearing them lets a poisoned
-- row bind correctly on the next claim; a NULL here costs at most one lost
-- resume offer, while a wrong value resumes a stranger's conversation.
UPDATE hosted_sessions SET cli_session_id = NULL WHERE adapter_id = 'shell';
