ALTER TABLE tasks ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_tasks_deleted ON tasks(deleted_at);
