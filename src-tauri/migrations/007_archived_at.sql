-- The board's Done column is a recent window (today's completions plus a backfill
-- to a fixed limit); everything older lives in the Completed view. That rollover
-- is derived from completed_at and needs no stored state. archived_at is the one
-- exception: the "Move older off board" button stamps it to drop a not-today card
-- out of the window immediately, ahead of the natural next-day rollover. NULL means
-- "still eligible for the board window"; a timestamp means "cleared to Completed only".
-- The task remains fully live — Completed shows it regardless — so this is not a delete.

ALTER TABLE tasks ADD COLUMN archived_at TEXT;
