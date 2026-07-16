-- A short, stable, agent-friendly reference for each task: `CODE-N`, where CODE
-- is a per-project short code (TIL, ZEN, BH) and N counts tasks within that code
-- from 1. The card shows this instead of the raw global AUTOINCREMENT id, which
-- climbs fast and gaps out because it is shared across every project and never
-- reused. The global `id` stays the hidden DB key — nothing that references a
-- task internally (activity, links, subtasks, MCP back-compat) changes.
-- See docs/specs/2026-07-16-per-project-task-ref.md.
--
-- Three columns, all nullable, all additive ALTER TABLE ... ADD COLUMN — no table
-- rebuild, so no ON DELETE CASCADE fires inside the plugin's migration transaction
-- where PRAGMA foreign_keys is a no-op (docs/decisions/2026-07-16-sqlite-migration-safety.md).
--
--   projects.code   short unique code, e.g. 'TIL'. Derived from the name at
--                   creation, digit-suffixed on collision. NULL until backfilled.
--   tasks.number    per-code counter, 1..N. Assigned once at creation, immutable.
--   tasks.ref       frozen 'CODE-N' string. Assigned once, immutable — a task
--                   born in one project keeps its ref even after moving to
--                   another (the move-stable choice), so a quoted reference
--                   always keeps resolving.
--
-- NO backfill and NO derivation here. Deriving a unique code from a name (initials,
-- collision suffix) is impractical in pure SQL and would diverge from the JS/Rust
-- derivation used for newly-created projects. The app process owns the MCP server,
-- so it is always running before any agent can call in; the frontend backfills
-- code/number/ref for pre-existing rows once, on startup (backfillRefs in db.ts),
-- and both write paths (frontend store + MCP create_*) mint them for new rows.
--
-- NO CHECK constraints (a CHECK forces a rebuild on any later widening). Shape is
-- validated at the write boundary in agent.rs and db.ts.
--
-- Unique indexes, not inline UNIQUE: SQLite cannot ADD COLUMN with a UNIQUE
-- constraint, and a UNIQUE index treats NULLs as distinct, so the many NULL
-- codes/refs that exist between this migration and the first backfill coexist
-- freely and only become unique once populated.

ALTER TABLE projects ADD COLUMN code TEXT;
ALTER TABLE tasks    ADD COLUMN number INTEGER;
ALTER TABLE tasks    ADD COLUMN ref TEXT;

CREATE UNIQUE INDEX idx_projects_code ON projects(code);
CREATE UNIQUE INDEX idx_tasks_ref     ON tasks(ref);
