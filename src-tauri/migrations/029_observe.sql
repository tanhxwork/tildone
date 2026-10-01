-- Observe cards: a question checked across many sessions before the user decides
-- on it. An observe card IS a task row (kind = 'observe'), so it gets a ref, a
-- project, the trash and the changes feed for free; the UI loads it into its own
-- slice, and list_tasks / next_task skip it. Title = the question, notes = why.
-- Status stays 'todo' until the user decides; deciding sets 'done' + completed_at.
--
-- Due / Waiting / Observed is derived, never stored: Observed once decision is
-- set, Due when the log has >= trigger_count lines or today >= trigger_date.
--
-- Additive only: ADD COLUMN and CREATE TABLE/TRIGGER, no rebuild of `tasks`
-- (docs/decisions/2026-07-16-sqlite-migration-safety.md).
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'observe'));

-- Exactly one trigger: a date (YYYY-MM-DD) or a count of log lines with its unit
-- ("deliveries"). options is a JSON array of 2-3 {label, detail}, written at
-- creation; decision is the chosen option's 0-based index, NULL until decided.
CREATE TABLE observe_cards (
    task_id       INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    check_text    TEXT    NOT NULL,
    trigger_date  TEXT,
    trigger_count INTEGER CHECK (trigger_count IS NULL OR trigger_count > 0),
    trigger_unit  TEXT,
    options       TEXT    NOT NULL,
    decision      INTEGER,
    CHECK ((trigger_date IS NULL) <> (trigger_count IS NULL))
);

-- One line per session that ran the check. verdict: 1 yes, 0 no, NULL none.
CREATE TABLE observe_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at         TEXT    NOT NULL,
    session_id TEXT,
    text       TEXT    NOT NULL,
    verdict    INTEGER CHECK (verdict IS NULL OR verdict IN (0, 1))
);

CREATE INDEX idx_observe_log_task ON observe_log(task_id);

CREATE TRIGGER changes_observe_logged AFTER INSERT ON observe_log
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.task_id, 'observed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER changes_observe_edited AFTER UPDATE ON observe_cards
BEGIN
    INSERT INTO changes (entity, entity_id, kind, created_at)
    VALUES ('task', NEW.task_id, 'edited', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
