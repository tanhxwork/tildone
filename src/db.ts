import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { ActivityEntry, Comment, Project, Status, Subtask, Tag, Task, TaskLink } from "./types";
import { deriveProjectCode, formatRef, INBOX_CODE } from "./utils/ref";

/**
 * Startup breadcrumb into startup-trace.log next to the database (see
 * `debug_trace` in lib.rs). Fire-and-forget: tracing must never be able to
 * break or slow the thing it observes.
 */
export function trace(msg: string): void {
  void invoke("debug_trace", { msg }).catch(() => {});
}

let db: Database | null = null;

/**
 * Warm the connection as its own init step, so the loading screen can say
 * "Opening the database…" while it happens — that is the step that wedged in
 * the stuck-loading incident, and the one place a first load can take seconds.
 */
export async function openDb(): Promise<void> {
  await getDb();
}

async function getDb(): Promise<Database> {
  if (!db) {
    // Seen live: `Database.load` can wedge forever (first load parked the app on
    // the loading screen with no error). The race converts that hang into a
    // rejection so init's retry/error path can act on it; on a timeout `db`
    // stays null, so the next attempt issues a fresh `load` (idempotent on the
    // plugin side — it re-registers the same connection).
    trace("getDb: Database.load starting");
    try {
      db = await Promise.race([
        Database.load("sqlite:tildone.db"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Database.load timed out after 15s")),
            15_000,
          ),
        ),
      ]);
    } catch (err) {
      trace(`getDb: Database.load FAILED: ${String(err)}`);
      throw err;
    }
    trace("getDb: Database.load ok");
  }
  return db;
}

interface TaskRow extends Omit<Task, "tag_ids"> {}

export async function fetchAll(): Promise<{
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  subtasks: Subtask[];
  presence: Record<number, { name: string | null; at: string }>;
  links: Record<number, TaskLink[]>;
  commentCounts: Record<number, number>;
}> {
  const d = await getDb();
  const subtaskRows = await d.select<(Omit<Subtask, "done"> & { done: number })[]>(
    "SELECT id, task_id, title, done, position FROM subtasks ORDER BY position, id",
  );
  const subtasks = subtaskRows.map((s) => ({ ...s, done: s.done !== 0 }));
  const projects = await d.select<Project[]>(
    "SELECT id, name, color, position, folder_path, code FROM projects ORDER BY position, id",
  );
  const tags = await d.select<Tag[]>(
    "SELECT id, name, color FROM tags ORDER BY name",
  );
  const rows = await d.select<TaskRow[]>(
    "SELECT id, project_id, title, notes, status, priority, due_date, position, created_at, completed_at, deleted_at, archived_at, number, ref, unseen_at FROM tasks",
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
  const presence = await fetchAgentPresence();
  const linkRows = await d.select<TaskLink[]>(
    "SELECT id, task_id, url, label, kind FROM task_links ORDER BY id",
  );
  const linksByTask: Record<number, TaskLink[]> = {};
  for (const row of linkRows) {
    (linksByTask[row.task_id] ??= []).push(row);
  }
  // Card badge needs a count, not the bodies — the thread loads only when a task
  // opens (fetchComments). A comment insert/delete fires the change feed, so this
  // count refreshes on the same reload every agent write already triggers.
  const countRows = await d.select<{ task_id: number; n: number }[]>(
    "SELECT task_id, COUNT(*) AS n FROM comments GROUP BY task_id",
  );
  const commentCounts: Record<number, number> = {};
  for (const row of countRows) commentCounts[row.task_id] = row.n;
  return { projects, tasks, tags, subtasks, presence, links: linksByTask, commentCounts };
}

// Mirror image of agent.rs add_comment: a comment written through the app is always
// the user's, so actor_kind is hard-coded 'user' and actor_name stays NULL. Neither
// writer can mislabel the other's rows.
export async function insertComment(taskId: number, body: string): Promise<Comment> {
  const d = await getDb();
  const created_at = new Date().toISOString();
  const result = await d.execute(
    "INSERT INTO comments (task_id, body, actor_kind, actor_name, created_at) VALUES ($1, $2, 'user', NULL, $3)",
    [taskId, body, created_at],
  );
  return {
    id: result.lastInsertId ?? 0,
    task_id: taskId,
    body,
    actor_kind: "user",
    actor_name: null,
    created_at,
  };
}

export async function fetchComments(taskId: number): Promise<Comment[]> {
  const d = await getDb();
  return d.select<Comment[]>(
    "SELECT id, task_id, body, actor_kind, actor_name, created_at FROM comments WHERE task_id = $1 ORDER BY id",
    [taskId],
  );
}

export async function addLink(
  taskId: number,
  url: string,
  label: string,
  kind: string,
): Promise<TaskLink> {
  const d = await getDb();
  const result = await d.execute(
    "INSERT INTO task_links (task_id, url, label, kind, created_at) VALUES ($1, $2, $3, $4, $5)",
    [taskId, url, label, kind, new Date().toISOString()],
  );
  return { id: result.lastInsertId ?? 0, task_id: taskId, url, label, kind };
}

export async function deleteLink(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("DELETE FROM task_links WHERE id = $1", [id]);
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

// actor_kind is hard-coded 'user' here for the same reason agent.rs hard-codes
// 'agent': every write through this module came from the person using the app.
// The two writers are mirror images, and neither can mislabel the other's rows.
export async function insertActivity(taskId: number, label: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO task_activity (task_id, label, created_at, actor_kind) VALUES ($1, $2, $3, 'user')",
    [taskId, label, new Date().toISOString()],
  );
}

export async function fetchActivity(taskId: number): Promise<ActivityEntry[]> {
  const d = await getDb();
  return d.select<ActivityEntry[]>(
    "SELECT id, task_id, label, created_at, actor_kind, actor_name FROM task_activity WHERE task_id = $1 ORDER BY id DESC LIMIT 50",
    [taskId],
  );
}

// Newest agent activity per task — the read that *is* presence. "An agent is on
// this task" = this timestamp is recent; a dead session simply stops writing and
// the value ages on its own, so nothing is ever stored or cleared. Returns a map
// of task_id -> { name, at } for tasks touched by an agent.
export async function fetchAgentPresence(): Promise<
  Record<number, { name: string | null; at: string }>
> {
  const d = await getDb();
  const rows = await d.select<
    { task_id: number; actor_name: string | null; at: string }[]
  >(
    `SELECT task_id, actor_name, MAX(created_at) AS at
       FROM task_activity
      WHERE actor_kind = 'agent'
      GROUP BY task_id`,
  );
  const out: Record<number, { name: string | null; at: string }> = {};
  for (const r of rows) out[r.task_id] = { name: r.actor_name, at: r.at };
  return out;
}

export async function insertProject(
  name: string,
  color: string,
): Promise<{ id: number; code: string }> {
  const d = await getDb();
  const max = await d.select<{ p: number | null }[]>(
    "SELECT MAX(position) AS p FROM projects",
  );
  const position = (max[0]?.p ?? -1) + 1;
  const code = await nextProjectCode(d, name);
  const result = await d.execute(
    "INSERT INTO projects (name, color, position, created_at, code) VALUES ($1, $2, $3, $4, $5)",
    [name, color, position, new Date().toISOString(), code],
  );
  return { id: result.lastInsertId ?? 0, code };
}

/** A unique project code for `name`, derived against the codes already in the DB
 * (the authoritative set — the UNIQUE index on projects.code is the backstop).
 * INBOX_CODE is reserved for the Inbox and never handed to a real project. */
async function nextProjectCode(d: Database, name: string): Promise<string> {
  const rows = await d.select<{ code: string | null }[]>(
    "SELECT code FROM projects WHERE code IS NOT NULL",
  );
  const taken = new Set<string>([INBOX_CODE]);
  for (const r of rows) if (r.code) taken.add(r.code);
  return deriveProjectCode(name, taken);
}

export async function updateProject(
  id: number,
  name: string,
  color: string,
  folderPath: string | null,
): Promise<void> {
  const d = await getDb();
  await d.execute(
    "UPDATE projects SET name = $1, color = $2, folder_path = $3 WHERE id = $4",
    [name, color, folderPath, id],
  );
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
}): Promise<{ id: number; number: number; ref: string }> {
  const d = await getDb();
  const code = await codeForProject(d, task.project_id);
  const number = await nextTaskNumber(d, code);
  const ref = formatRef(code, number);
  const result = await d.execute(
    "INSERT INTO tasks (project_id, title, due_date, status, position, priority, notes, completed_at, created_at, number, ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
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
      number,
      ref,
    ],
  );
  return { id: result.lastInsertId ?? 0, number, ref };
}

/** The code that mints refs for a task in `project_id` (INBOX_CODE for the Inbox).
 * A project that somehow still lacks a code — a race ahead of the startup backfill
 * — gets one minted and persisted here so its tasks never fall back to `#id`. */
async function codeForProject(d: Database, project_id: number | null): Promise<string> {
  if (project_id === null) return INBOX_CODE;
  const rows = await d.select<{ name: string; code: string | null }[]>(
    "SELECT name, code FROM projects WHERE id = $1",
    [project_id],
  );
  const row = rows[0];
  if (!row) return INBOX_CODE;
  if (row.code) return row.code;
  const code = await nextProjectCode(d, row.name);
  await d.execute("UPDATE projects SET code = $1 WHERE id = $2", [code, project_id]);
  return code;
}

/** Next per-code counter: one past the highest `number` any task with this code's
 * ref has ever held — trashed rows included, so a number within a code is never
 * reused. Scoped by the frozen ref prefix, not project_id, so a task moved between
 * projects keeps counting against the code it was born in. */
async function nextTaskNumber(d: Database, code: string): Promise<number> {
  const rows = await d.select<{ m: number | null }[]>(
    "SELECT MAX(number) AS m FROM tasks WHERE ref LIKE $1",
    [`${code}-%`],
  );
  return (rows[0]?.m ?? 0) + 1;
}

/** One-time backfill for rows that predate migration 010: give every code-less
 * project a code and every ref-less task a number + frozen ref. Idempotent — only
 * NULLs are touched — so it is safe to run on every startup. */
export async function backfillRefs(): Promise<void> {
  const d = await getDb();

  // 1. Project codes, in creation order, unique against whatever already exists.
  const codeless = await d.select<{ id: number; name: string }[]>(
    "SELECT id, name FROM projects WHERE code IS NULL ORDER BY id",
  );
  if (codeless.length > 0) {
    const existing = await d.select<{ code: string }[]>(
      "SELECT code FROM projects WHERE code IS NOT NULL",
    );
    const taken = new Set<string>([INBOX_CODE]);
    for (const r of existing) taken.add(r.code);
    for (const p of codeless) {
      const code = deriveProjectCode(p.name, taken);
      taken.add(code);
      await d.execute("UPDATE projects SET code = $1 WHERE id = $2", [code, p.id]);
    }
  }

  // 2. Task numbers + refs. Every project now has a code; Inbox (NULL) uses
  //    INBOX_CODE. Assign in (created_at, id) order so the oldest task in each code
  //    is #1, continuing past any number already issued (so a re-run resumes).
  const refless = await d.select<{ id: number; project_id: number | null }[]>(
    "SELECT id, project_id FROM tasks WHERE ref IS NULL ORDER BY created_at, id",
  );
  if (refless.length === 0) return;
  const projects = await d.select<{ id: number; code: string }[]>(
    "SELECT id, code FROM projects WHERE code IS NOT NULL",
  );
  const codeByProject = new Map<number, string>();
  for (const p of projects) codeByProject.set(p.id, p.code);

  // High-water mark per code from already-assigned refs (CODE-N; codes never
  // contain '-', so split on the last dash).
  const counters = new Map<string, number>();
  const assigned = await d.select<{ ref: string }[]>(
    "SELECT ref FROM tasks WHERE ref IS NOT NULL",
  );
  for (const row of assigned) {
    const dash = row.ref.lastIndexOf("-");
    const code = row.ref.slice(0, dash);
    const n = Number(row.ref.slice(dash + 1));
    if (Number.isFinite(n)) counters.set(code, Math.max(counters.get(code) ?? 0, n));
  }

  for (const t of refless) {
    const code =
      t.project_id === null ? INBOX_CODE : codeByProject.get(t.project_id) ?? INBOX_CODE;
    const number = (counters.get(code) ?? 0) + 1;
    counters.set(code, number);
    await d.execute("UPDATE tasks SET number = $1, ref = $2 WHERE id = $3", [
      number,
      formatRef(code, number),
      t.id,
    ]);
  }
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
  // Writable from here so the UI can CLEAR the mark (open a card, archive it).
  // Setting it is the agent server's job alone — see 014_unseen_at.sql.
  "unseen_at",
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
