-- Who works a task: the user ('human') or an agent ('agent'). The Mine view and
-- the project board's You lane show human tasks; the agent queue and next_task
-- serve agent tasks. Every existing row becomes 'human': it was on the user's
-- board before this column existed, and telling old agent-made cards apart
-- would need a heuristic.
--
-- from_task_id is lineage: the task whose work spawned this one, shown as
-- "from TIL-205". SET NULL on delete keeps the follow-up when its parent is
-- purged from the trash.
ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'human' CHECK (owner IN ('human', 'agent'));
ALTER TABLE tasks ADD COLUMN from_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
