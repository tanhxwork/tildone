-- Goal names are unique per project — as a database constraint, not just a check
-- in each writer. Both write paths already refuse a duplicate (store.ts addGoal
-- throws, agent.rs create_goal errors), but they check on separate connections
-- and then insert: a UI create and an MCP create racing each other can both see
-- no duplicate and both insert. Found by the Codex verify pass on TIL-204.
--
-- This matters more here than it would elsewhere, because a goal is addressed BY
-- NAME over MCP (`goal: "Ship it"`, resolved within the project). Two goals
-- sharing a name in one project do not merely look untidy — they make every
-- agent-side resolution ambiguous, which is the thing the name rule exists to
-- prevent.
--
-- COLLATE NOCASE so "Ship it" and "ship it" collide, matching what both writers
-- already compare case-insensitively.
--
-- The UPDATE runs FIRST and is not optional. A unique index that fails to build
-- takes the whole migration down, and a migration that fails on startup leaves
-- the user with an app that will not open — a far worse outcome than the race it
-- prevents. Any duplicate that slipped in before this migration is therefore
-- renamed (suffixed with its id, which is unique by construction) rather than
-- allowed to block the index. Keeping the older row's name unchanged means the
-- goal an agent has been referring to keeps resolving.
--
-- In practice this should rename nothing: goals shipped hours ago in migration
-- 025. It exists so that "should" is not load-bearing.

UPDATE goals
   SET name = name || ' (' || id || ')'
 WHERE EXISTS (
         SELECT 1 FROM goals older
          WHERE older.project_id = goals.project_id
            AND older.name = goals.name COLLATE NOCASE
            AND older.id < goals.id
       );

CREATE UNIQUE INDEX idx_goals_project_name ON goals(project_id, name COLLATE NOCASE);
