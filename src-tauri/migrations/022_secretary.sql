-- The board secretary's per-session transcript cursors (spec
-- 2026-07-21-local-ai-board-secretary). Two cursors, not one: the scan
-- cursor feeds the deterministic evidence lane and always advances; the
-- decide cursor feeds the engine lane and freezes while the engine is
-- unavailable, so the backlog can be re-read from the transcript file
-- itself when it comes back — no raw transcript text is ever queued in
-- this database.
--
-- Rows key on the claim's session_id and are bookkeeping, not history:
-- a session that vanishes from agent_claims just leaves a dead row, and
-- dead rows are swept opportunistically by the secretary loop.
CREATE TABLE IF NOT EXISTS secretary_offsets (
    session_id    TEXT    PRIMARY KEY,
    scan_offset   INTEGER NOT NULL DEFAULT 0,
    decide_offset INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT    NOT NULL
);
