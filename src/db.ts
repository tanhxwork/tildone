import Database from "@tauri-apps/plugin-sql";
import type { ActivityEntry, Project, Status, Subtask, Tag, Task } from "./types";

let db: Database | null = null;

async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:tildone.db");
  }
  return db;
}

interface TaskRow extends Omit<Task, "tag_ids"> {}

export async function fetchAll(): Promise<{
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  subtasks: Subtask[];
}> {
  const d = await getDb();
  const subtaskRows = await d.select<(Omit<Subtask, "done"> & { done: number })[]>(
    "SELECT id, task_id, title, done, position FROM subtasks ORDER BY position, id",
  );
  const subtasks = subtaskRows.map((s) => ({ ...s, done: s.done !== 0 }));
  const projects = await d.select<Project[]>(
    "SELECT id, name, color, position FROM projects ORDER BY position, id",
  );
  const tags = await d.select<Tag[]>(
    "SELECT id, name, color FROM tags ORDER BY name",
  );
  const rows = await d.select<TaskRow[]>(
    "SELECT id, project_id, title, notes, status, priority, due_date, position, created_at, completed_at, deleted_at, archived_at FROM tasks",
  );
  const links = await d.select<{ task_id: number; tag_id: number }[]>(
    "SELECT task_id, tag_id FROM task_tags",
  );
  const tagsByTask = new Map<number, number[]>();
  for (const link of links) {
    const list = tagsByTask.get(link.task_id) ?? [];
    list.push(link.tag_id);
    tagsByTask.set(link.task_id, list);
  }
  const tasks = rows.map((row) => ({
    ...row,
    tag_ids: tagsByTask.get(row.id) ?? [],
  }));
  return { projects, tasks, tags, subtasks };
}

export async function insertSubtask(taskId: number, title: string, position: number): Promise<number> {
  const d = await getDb();
  const result = await d.execute(
    "INSERT INTO subtasks (task_id, title, position) VALUES ($1, $2, $3)",
    [taskId, title, position],
  );
  return result.lastInsertId ?? 0;
}

export async function updateSubtask(
  id: number,
  patch: { title?: string; done?: boolean; position?: number },
): Promise<void> {
  const d = await getDb();
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key], i) => `${key} = $${i + 1}`).join(", ");
  const values = entries.map(([, value]) => (typeof value === "boolean" ? (value ? 1 : 0) : value));
  await d.execute(`UPDATE subtasks SET ${sets} WHERE id = $${entries.length + 1}`, [
    ...values,
    id,
  ]);
}

export async function deleteSubtask(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM subtasks WHERE id = $1", [id]);
}

export async function insertActivity(taskId: number, label: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO task_activity (task_id, label, created_at) VALUES ($1, $2, $3)",
    [taskId, label, new Date().toISOString()],
  );
}

export async function fetchActivity(taskId: number): Promise<ActivityEntry[]> {
  const d = await getDb();
  return d.select<ActivityEntry[]>(
    "SELECT id, task_id, label, created_at FROM task_activity WHERE task_id = $1 ORDER BY id DESC LIMIT 50",
    [taskId],
  );
}

export async function insertProject(name: string, color: string): Promise<number> {
  const d = await getDb();
  const max = await d.select<{ p: number | null }[]>(
    "SELECT MAX(position) AS p FROM projects",
  );
  const position = (max[0]?.p ?? -1) + 1;
  const result = await d.execute(
    "INSERT INTO projects (name, color, position, created_at) VALUES ($1, $2, $3, $4)",
    [name, color, position, new Date().toISOString()],
  );
  return result.lastInsertId ?? 0;
}

export async function updateProject(id: number, name: string, color: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE projects SET name = $1, color = $2 WHERE id = $3", [
    name,
    color,
    id,
  ]);
}

export async function updateProjectPositions(
  updates: { id: number; position: number }[],
): Promise<void> {
  const d = await getDb();
  for (const u of updates) {
    await d.execute("UPDATE projects SET position = $1 WHERE id = $2", [u.position, u.id]);
  }
}

export async function deleteProject(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM projects WHERE id = $1", [id]);
}

export async function insertTask(task: {
  project_id: number | null;
  title: string;
  due_date: string | null;
  status: Status;
  position: number;
  priority: number;
  notes?: string;
  completed_at?: string | null;
  created_at: string;
}): Promise<number> {
  const d = await getDb();
  const result = await d.execute(
    "INSERT INTO tasks (project_id, title, due_date, status, position, priority, notes, completed_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      task.project_id,
      task.title,
      task.due_date,
      task.status,
      task.position,
      task.priority,
      task.notes ?? "",
      task.completed_at ?? null,
      task.created_at,
    ],
  );
  return result.lastInsertId ?? 0;
}

const TASK_COLUMNS = new Set([
  "project_id",
  "title",
  "notes",
  "status",
  "priority",
  "due_date",
  "position",
  "completed_at",
  "deleted_at",
  "archived_at",
]);

export async function updateTask(
  id: number,
  patch: Partial<Omit<Task, "id" | "tag_ids" | "created_at">>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) => TASK_COLUMNS.has(key));
  if (entries.length === 0) return;
  const d = await getDb();
  const sets = entries.map(([key], i) => `${key} = $${i + 1}`).join(", ");
  const values = entries.map(([, value]) => value);
  await d.execute(`UPDATE tasks SET ${sets} WHERE id = $${entries.length + 1}`, [
    ...values,
    id,
  ]);
}

export async function deleteTask(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM tasks WHERE id = $1", [id]);
}

export async function deleteAllTrashed(): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL");
}

/** Hard-delete trashed tasks older than the cutoff (ISO timestamp). */
export async function purgeTrashedBefore(cutoff: string): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < $1", [
    cutoff,
  ]);
}

export async function insertTag(name: string, color: string): Promise<number> {
  const d = await getDb();
  const result = await d.execute("INSERT INTO tags (name, color) VALUES ($1, $2)", [
    name,
    color,
  ]);
  return result.lastInsertId ?? 0;
}

export async function updateTag(id: number, name: string, color: string): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE tags SET name = $1, color = $2 WHERE id = $3", [name, color, id]);
}

export async function deleteTag(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM tags WHERE id = $1", [id]);
}

/** Re-point every task from one tag to another, then drop the source tag. */
export async function mergeTags(fromId: number, toId: number): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT task_id, $1 FROM task_tags WHERE tag_id = $2",
    [toId, fromId],
  );
  await d.execute("DELETE FROM task_tags WHERE tag_id = $1", [fromId]);
  await d.execute("DELETE FROM tags WHERE id = $1", [fromId]);
}

export async function setTaskTags(taskId: number, tagIds: number[]): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM task_tags WHERE task_id = $1", [taskId]);
  for (const tagId of tagIds) {
    await d.execute("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)", [
      taskId,
      tagId,
    ]);
  }
}
