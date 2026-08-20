-- Invariant 2 as a database rule: a task's goal always belongs to the task's own
-- project. Until now this lived only in the two writers (db.ts effectiveTaskPatch
-- and apply_task_update in agent.rs), which is not enough for the same reason the
-- change feed is trigger-driven — there are two independent writers on two
-- connections, and any check-then-write pair can be interleaved:
--
--   writer A moves task 10 to project 2   |
--                                         | writer B sets task 10's goal to a
--                                         | goal in project 1 (still true when
--                                         | B checked)
--   -> task 10 ends up in project 2 holding a goal from project 1.
--
-- Found by the Codex verify pass on the TIL-204 fix-forward, which also caught
-- that `insertTask` accepted goal_id with no ownership check at all.
--
-- These triggers HEAL rather than ABORT. RAISE(ABORT) would surface a SQL error
-- in whichever writer lost the race — including the UI, mid-drag — for a state
-- the user did nothing wrong to reach. Nulling the goal is exactly what both
-- writers already do when a task moves, so healing produces the state the code
-- intended, and the task keeps its data either way: only the pairing is dropped.
--
-- SQLite runs triggers with recursive_triggers OFF by default, so the corrective
-- UPDATE does not re-enter. It would be harmless if it did — the second pass
-- finds goal_id already NULL and the WHEN no longer matches.
--
-- An Inbox task (project_id NULL) can hold no goal at all: `NEW.project_id IS
-- NULL` is covered by the IS NOT comparison, since NULL IS NOT <any project id>.

CREATE TRIGGER tasks_goal_must_match_project_ins
AFTER INSERT ON tasks
WHEN NEW.goal_id IS NOT NULL
 AND NEW.project_id IS NOT (SELECT project_id FROM goals WHERE id = NEW.goal_id)
BEGIN
    UPDATE tasks SET goal_id = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_goal_must_match_project_upd
AFTER UPDATE OF project_id, goal_id ON tasks
WHEN NEW.goal_id IS NOT NULL
 AND NEW.project_id IS NOT (SELECT project_id FROM goals WHERE id = NEW.goal_id)
BEGIN
    UPDATE tasks SET goal_id = NULL WHERE id = NEW.id;
END;
