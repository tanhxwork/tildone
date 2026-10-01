-- A project's environment: the look of its island in Town (meadow, city, desert,
-- snow, autumn). New projects get the first environment no project uses, else
-- the one at (project count % 5) — src/utils/environment.ts and create_project in
-- src-tauri/src/agent.rs. Applied to existing rows in (position, id) order that
-- rule gives the k-th project (0-based) environment k % 5, which the backfill
-- writes directly.
--
-- Additive only (docs/decisions/2026-07-16-sqlite-migration-safety.md).
ALTER TABLE projects ADD COLUMN environment TEXT NOT NULL DEFAULT 'meadow';

UPDATE projects SET environment = CASE (
    SELECT COUNT(*) FROM projects AS earlier
    WHERE earlier.position < projects.position
       OR (earlier.position = projects.position AND earlier.id < projects.id)
) % 5
    WHEN 0 THEN 'meadow'
    WHEN 1 THEN 'city'
    WHEN 2 THEN 'desert'
    WHEN 3 THEN 'snow'
    ELSE 'autumn'
END;
