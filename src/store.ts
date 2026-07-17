import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import * as db from "./db";
import type {
  ActivityEntry,
  Comment,
  LinkKind,
  Project,
  ProjectIcon,
  Selection,
  Status,
  Subtask,
  Tag,
  Task,
  TaskLink,
  ViewMode,
} from "./types";
import { COLOR_CHOICES, PRIORITY_LABELS, STATUS_LABELS } from "./types";
import { format } from "date-fns";
import { computeDragUpdates } from "./reorder";
import { dueLabel, todayStr, toIsoUtc } from "./utils/dates";
import { deriveLinkKind, deriveLinkLabel, isHttpUrl } from "./utils/links";

export interface ImportedTask {
  title: string;
  notes?: string;
  status?: Status;
  priority?: number;
  due_date?: string | null;
  completed_at?: string | null;
  created_at?: string;
  project?: string | null;
  tags?: string[];
}

interface Store {
  loaded: boolean;
  projects: Project[];
  /** Discovered icon per project_id; absent/dataUri-null ⇒ render the colour dot. */
  projectIcons: Record<number, ProjectIcon>;
  tasks: Task[];
  tags: Tag[];
  subtasks: Subtask[];
  /** Repo links per task: links[task_id] = [{id, url, label, kind}]. */
  links: Record<number, TaskLink[]>;
  /** Activity log for the task currently open in the details view. */
  activity: ActivityEntry[];
  /** Comment thread for the task currently open in the details view. */
  comments: Comment[];
  /** Comment count per task_id, for the card badge. Bodies load only on open
   * (loadComments); this is refreshed by the same reload every agent write triggers. */
  commentCounts: Record<number, number>;
  /**
   * Newest agent activity per task_id — this is presence. Derived from
   * task_activity on every load, never stored: a dead session stops writing and
   * its entry simply ages, so nothing is ever cleared. `at` is an ISO timestamp;
   * the card decides how fresh is fresh.
   */
  presence: Record<number, { name: string | null; at: string }>;

  selection: Selection;
  viewMode: ViewMode;
  search: string;
  activeTagIds: number[];
  priorityFilter: number; // 0 = any
  showCompleted: boolean;
  editingTaskId: number | null;
  paletteOpen: boolean;
  tagManagerOpen: boolean;

  init: () => Promise<void>;
  /** Re-read everything from SQLite, e.g. after an external agent writes. */
  reload: () => Promise<void>;
  select: (selection: Selection) => void;
  setViewMode: (mode: ViewMode) => void;
  setSearch: (search: string) => void;
  toggleTagFilter: (tagId: number) => void;
  setPriorityFilter: (priority: number) => void;
  toggleShowCompleted: () => void;
  openEditor: (taskId: number | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setTagManagerOpen: (open: boolean) => void;

  addProject: (name: string, color: string) => Promise<void>;
  editProject: (
    id: number,
    name: string,
    color: string,
    folderPath: string | null,
  ) => Promise<void>;
  removeProject: (id: number) => Promise<void>;
  moveProject: (id: number, delta: -1 | 1) => Promise<void>;
  /** Discover one project's icon from disk (Rust); merge into projectIcons. */
  loadProjectIcon: (project: Project) => Promise<void>;
  /** Discover every project's icon; called after each full data load. */
  loadProjectIcons: () => Promise<void>;

  addTask: (input: {
    title: string;
    project_id: number | null;
    due_date: string | null;
    priority?: number;
    tag_ids?: number[];
  }) => Promise<void>;
  patchTask: (
    id: number,
    patch: Partial<Omit<Task, "id" | "tag_ids" | "created_at">>,
  ) => Promise<void>;
  toggleDone: (id: number) => Promise<void>;
  removeTask: (id: number) => Promise<void>;
  restoreTask: (id: number) => Promise<void>;
  destroyTask: (id: number) => Promise<void>;
  emptyTrash: () => Promise<void>;
  /** Drop every not-today done card out of the board's Done window now, ahead of
   * the natural next-day rollover. They stay live in Completed. */
  archiveOlderDone: () => Promise<void>;
  applyDrag: (
    activeId: number,
    columns: Record<Status, number[]>,
  ) => Promise<void>;

  addSubtask: (taskId: number, title: string) => Promise<void>;
  toggleSubtask: (id: number) => Promise<void>;
  renameSubtask: (id: number, title: string) => Promise<void>;
  removeSubtask: (id: number) => Promise<void>;
  addLink: (taskId: number, url: string, label?: string, kind?: LinkKind) => Promise<void>;
  removeLink: (taskId: number, linkId: number) => Promise<void>;
  loadActivity: (taskId: number) => Promise<void>;
  addComment: (taskId: number, body: string) => Promise<void>;
  loadComments: (taskId: number) => Promise<void>;

  addTag: (name: string) => Promise<number>;
  removeTag: (id: number) => Promise<void>;
  updateTagMeta: (id: number, name: string, color: string) => Promise<void>;
  mergeTags: (fromId: number, toId: number) => Promise<void>;
  assignTags: (taskId: number, tagIds: number[]) => Promise<void>;

  importData: (input: { projects?: { name: string; color?: string }[]; tasks: ImportedTask[] }) => Promise<number>;
}

function colorForName(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLOR_CHOICES[Math.abs(hash) % COLOR_CHOICES.length];
}

const TRASH_RETENTION_DAYS = 30;

/**
 * Last-viewed selection + view mode, persisted so relaunch lands where the user
 * left off instead of resetting to Today/list. A project selection is validated
 * against the loaded projects in `init` — a deleted project falls back to Today.
 */
const NAV_STORAGE_KEY = "tildone-nav";
const VIEW_MODES: ViewMode[] = ["list", "board", "table", "calendar"];
const SELECTION_TYPES: Selection["type"][] = [
  "today",
  "upcoming",
  "inbox",
  "all",
  "week",
  "review",
  "completed",
  "project",
];

function loadNav(): { selection: Selection; viewMode: ViewMode } {
  const fallback = { selection: { type: "today" } as Selection, viewMode: "list" as ViewMode };
  try {
    const raw = localStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const viewMode: ViewMode = VIEW_MODES.includes(parsed.viewMode)
      ? parsed.viewMode
      : "list";
    const sel = parsed.selection;
    let selection: Selection = fallback.selection;
    if (sel && SELECTION_TYPES.includes(sel.type)) {
      if (sel.type === "project") {
        if (typeof sel.projectId === "number") selection = { type: "project", projectId: sel.projectId };
      } else {
        selection = { type: sel.type };
      }
    }
    return { selection, viewMode };
  } catch {
    return fallback;
  }
}

function persistNav(selection: Selection, viewMode: ViewMode) {
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ selection, viewMode }));
  } catch {
    // ignore quota/serialization errors — persistence is best-effort
  }
}

/**
 * The slot a task takes when it lands in the (project_id, status) group.
 * Mirrors `Store::group_slot` in src-tauri/src/agent.rs — the Rust MCP server and
 * this store both write `tasks` directly, so the rule has to exist in both.
 *
 * `done` inserts at the top (MIN-1) so the newest completion reads first; the rest
 * append at the bottom (MAX+1). Top-insert does not renumber the group: Done grows
 * without bound and shifting every card down on each completion would get slower
 * the longer it gets, and fire a `changes_task_moved` per card. Positions only have
 * to be distinct and ordered within the group, never a dense index — so `done` is
 * simply allowed to drift negative.
 */
export function groupSlot(
  tasks: Task[],
  project_id: number | null,
  status: Status,
): number {
  const group = tasks.filter(
    (t) =>
      t.deleted_at === null && t.status === status && t.project_id === project_id,
  );
  if (group.length === 0) return 0;
  const positions = group.map((t) => t.position);
  return status === "done" ? Math.min(...positions) - 1 : Math.max(...positions) + 1;
}

export const useStore = create<Store>()((set, get) => ({
  loaded: false,
  projects: [],
  projectIcons: {},
  tasks: [],
  tags: [],
  subtasks: [],
  links: {},
  activity: [],
  comments: [],
  commentCounts: {},
  presence: {},

  ...loadNav(),
  search: "",
  activeTagIds: [],
  priorityFilter: 0,
  showCompleted: false,
  editingTaskId: null,
  paletteOpen: false,
  tagManagerOpen: false,

  init: async () => {
    const cutoff = new Date(
      Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    await db.purgeTrashedBefore(cutoff);
    // Give pre-migration-010 projects/tasks their code/number/ref before the first
    // read, so nothing ever renders the raw #id fallback. Idempotent.
    await db.backfillRefs();
    const data = await db.fetchAll();
    set({ ...data, loaded: true });
    // A restored project selection may point at a project deleted in another
    // session; fall back to Today so we never land on a dead view.
    const { selection } = get();
    if (
      selection.type === "project" &&
      !data.projects.some((p) => p.id === selection.projectId)
    ) {
      set({ selection: { type: "today" } });
    }
    // Icons resolve async off the main load — the dot shows until they land.
    void get().loadProjectIcons();
  },

  reload: async () => {
    const data = await db.fetchAll();
    set({ ...data });
    void get().loadProjectIcons();
    // fetchAll has no activity or comment bodies in it, so an open task's log and
    // thread would sit frozen while an agent writes to them — the one place the user
    // is actually watching, and the whole point of comments (the agent's answer must
    // appear live).
    const { editingTaskId } = get();
    if (editingTaskId !== null) {
      await get().loadActivity(editingTaskId);
      await get().loadComments(editingTaskId);
    }
  },

  select: (selection) => set({ selection, editingTaskId: null }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSearch: (search) => set({ search }),
  toggleTagFilter: (tagId) =>
    set((s) => ({
      activeTagIds: s.activeTagIds.includes(tagId)
        ? s.activeTagIds.filter((id) => id !== tagId)
        : [...s.activeTagIds, tagId],
    })),
  setPriorityFilter: (priorityFilter) => set({ priorityFilter }),
  toggleShowCompleted: () => set((s) => ({ showCompleted: !s.showCompleted })),
  openEditor: (editingTaskId) => {
    set({ editingTaskId, activity: [], comments: [] });
    if (editingTaskId !== null) {
      void get().loadActivity(editingTaskId);
      void get().loadComments(editingTaskId);
    }
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTagManagerOpen: (tagManagerOpen) => set({ tagManagerOpen }),

  addProject: async (name, color) => {
    const { id, code } = await db.insertProject(name, color);
    const project: Project = {
      id,
      name,
      color,
      position: get().projects.length,
      folder_path: null,
      code,
    };
    set((s) => ({
      projects: [...s.projects, project],
      selection: { type: "project", projectId: id },
    }));
    void get().loadProjectIcon(project);
  },

  editProject: async (id, name, color, folderPath) => {
    await db.updateProject(id, name, color, folderPath);
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, name, color, folder_path: folderPath } : p,
      ),
    }));
    const updated = get().projects.find((p) => p.id === id);
    if (updated) void get().loadProjectIcon(updated);
  },

  loadProjectIcon: async (project) => {
    // "" is an explicit opt-out: never scan, never show an icon.
    if (project.folder_path === "") {
      set((s) => {
        const next = { ...s.projectIcons };
        delete next[project.id];
        return { projectIcons: next };
      });
      return;
    }
    try {
      const icon = await invoke<ProjectIcon>("discover_project_icon", {
        name: project.name,
        folder: project.folder_path ?? null,
      });
      set((s) => ({ projectIcons: { ...s.projectIcons, [project.id]: icon } }));
    } catch {
      // Discovery is best-effort; on any failure the colour dot stands in.
    }
  },

  loadProjectIcons: async () => {
    await Promise.all(get().projects.map((p) => get().loadProjectIcon(p)));
  },

  removeProject: async (id) => {
    await db.deleteProject(id);
    set((s) => {
      const selection =
        s.selection.type === "project" && s.selection.projectId === id
          ? ({ type: "today" } as Selection)
          : s.selection;
      const removedTaskIds = new Set(
        s.tasks.filter((t) => t.project_id === id).map((t) => t.id),
      );
      return {
        projects: s.projects.filter((p) => p.id !== id),
        tasks: s.tasks.filter((t) => t.project_id !== id),
        subtasks: s.subtasks.filter((x) => !removedTaskIds.has(x.task_id)),
        selection,
      };
    });
  },

  moveProject: async (id, delta) => {
    const { projects } = get();
    const index = projects.findIndex((p) => p.id === id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= projects.length) return;
    const reordered = [...projects];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const updates = reordered.map((p, i) => ({ id: p.id, position: i }));
    set({ projects: reordered.map((p, i) => ({ ...p, position: i })) });
    await db.updateProjectPositions(updates);
  },

  addTask: async ({ title, project_id, due_date, priority = 0, tag_ids = [] }) => {
    const { tasks } = get();
    const position = groupSlot(tasks, project_id, "todo");
    const created_at = new Date().toISOString();
    const { id, number, ref } = await db.insertTask({
      project_id,
      title,
      due_date,
      status: "todo",
      position,
      priority,
      created_at,
    });
    if (tag_ids.length > 0) await db.setTaskTags(id, tag_ids);
    void recordActivity(id, "Task created");
    const task: Task = {
      id,
      project_id,
      title,
      notes: "",
      status: "todo",
      priority,
      due_date,
      position,
      created_at,
      completed_at: null,
      deleted_at: null,
      archived_at: null,
      number,
      ref,
      tag_ids,
    };
    set((s) => ({ tasks: [...s.tasks, task] }));
  },

  patchTask: async (id, patch) => {
    const current = get().tasks.find((t) => t.id === id);
    if (!current) return;
    const full = { ...patch };
    if (patch.status && patch.status !== current.status) {
      full.completed_at = patch.status === "done" ? new Date().toISOString() : null;
      // Any status change makes the card boardable again: a fresh completion belongs
      // in the Done window, and leaving Done clears a stale "cleared off board" mark.
      full.archived_at = null;
    }
    // Changing group without a fresh slot would carry the old position into the new
    // group and collide with whatever already sits there, dropping the column back
    // to sorting by id. A drag doesn't come through here — it calls applyDrag
    // with positions of its own — so recomputing whenever the group moved is safe.
    const destStatus = patch.status ?? current.status;
    const destProject =
      patch.project_id !== undefined ? patch.project_id : current.project_id;
    if (destStatus !== current.status || destProject !== current.project_id) {
      full.position = groupSlot(get().tasks, destProject, destStatus);
    }
    await db.updateTask(id, full);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...full } : t)),
    }));

    const labels: string[] = [];
    if (patch.status && patch.status !== current.status) {
      labels.push(`Status changed to ${STATUS_LABELS[patch.status]}`);
    }
    if (patch.priority !== undefined && patch.priority !== current.priority) {
      labels.push(
        patch.priority > 0
          ? `Priority set to ${PRIORITY_LABELS[patch.priority]}`
          : "Priority cleared",
      );
    }
    if (patch.due_date !== undefined && patch.due_date !== current.due_date) {
      labels.push(
        patch.due_date ? `Due date set to ${dueLabel(patch.due_date)}` : "Due date cleared",
      );
    }
    if (patch.project_id !== undefined && patch.project_id !== current.project_id) {
      const project = get().projects.find((p) => p.id === patch.project_id);
      labels.push(project ? `Moved to ${project.name}` : "Moved to Inbox");
    }
    for (const label of labels) void recordActivity(id, label);
  },

  toggleDone: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await get().patchTask(id, { status: task.status === "done" ? "todo" : "done" });
  },

  removeTask: async (id) => {
    // Soft delete — the task moves to Trash and can be restored for 30 days.
    const deleted_at = new Date().toISOString();
    await db.updateTask(id, { deleted_at });
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, deleted_at } : t)),
      editingTaskId: s.editingTaskId === id ? null : s.editingTaskId,
    }));
  },

  restoreTask: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    // Coming back from the trash is a group change too: the task has been out of
    // its (project, status) group long enough for its old slot to be taken, so it
    // needs a fresh one like any other arrival.
    const position = groupSlot(get().tasks, task.project_id, task.status);
    await db.updateTask(id, { deleted_at: null, position });
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, deleted_at: null, position } : t,
      ),
    }));
  },

  destroyTask: async (id) => {
    await db.deleteTask(id);
    set((s) => {
      const links = { ...s.links };
      delete links[id];
      return {
        tasks: s.tasks.filter((t) => t.id !== id),
        subtasks: s.subtasks.filter((x) => x.task_id !== id),
        links,
        editingTaskId: s.editingTaskId === id ? null : s.editingTaskId,
      };
    });
  },

  emptyTrash: async () => {
    await db.deleteAllTrashed();
    set((s) => {
      const trashedIds = new Set(
        s.tasks.filter((t) => t.deleted_at !== null).map((t) => t.id),
      );
      return {
        tasks: s.tasks.filter((t) => t.deleted_at === null),
        subtasks: s.subtasks.filter((x) => !trashedIds.has(x.task_id)),
      };
    });
  },

  archiveOlderDone: async () => {
    const today = todayStr();
    const now = new Date().toISOString();
    const targets = get().tasks.filter(
      (t) =>
        t.deleted_at === null &&
        t.status === "done" &&
        t.archived_at === null &&
        t.completed_at !== null &&
        format(new Date(t.completed_at), "yyyy-MM-dd") !== today,
    );
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    for (const t of targets) await db.updateTask(t.id, { archived_at: now });
    set((s) => ({
      tasks: s.tasks.map((t) => (ids.has(t.id) ? { ...t, archived_at: now } : t)),
    }));
  },

  applyDrag: async (activeId, columns) => {
    const now = new Date().toISOString();
    const updates = computeDragUpdates(
      get().tasks,
      get().selection,
      activeId,
      columns,
      now,
    );
    if (updates.length === 0) return;

    const byId = new Map(get().tasks.map((t) => [t.id, t]));
    set((s) => ({
      tasks: s.tasks.map((t) => {
        const u = updates.find((x) => x.id === t.id);
        return u
          ? { ...t, status: u.status, position: u.position, completed_at: u.completed_at }
          : t;
      }),
    }));
    // Only write rows that actually changed. A precise reorder dense-renumbers a whole
    // group in memory but usually shifts only the cards between source and destination;
    // the change-feed trigger already suppresses the no-op feed row, this skips the
    // UPDATE that would have fired it.
    for (const u of updates) {
      const prev = byId.get(u.id)!;
      if (
        u.status === prev.status &&
        u.position === prev.position &&
        u.completed_at === prev.completed_at
      ) {
        continue;
      }
      await db.updateTask(u.id, {
        status: u.status,
        position: u.position,
        completed_at: u.completed_at,
      });
    }
  },

  addSubtask: async (taskId, title) => {
    const position =
      get()
        .subtasks.filter((s) => s.task_id === taskId)
        .reduce((max, s) => Math.max(max, s.position), -1) + 1;
    const id = await db.insertSubtask(taskId, title, position);
    set((s) => ({
      subtasks: [...s.subtasks, { id, task_id: taskId, title, done: false, position }],
    }));
  },

  toggleSubtask: async (id) => {
    const sub = get().subtasks.find((s) => s.id === id);
    if (!sub) return;
    await db.updateSubtask(id, { done: !sub.done });
    set((s) => ({
      subtasks: s.subtasks.map((x) => (x.id === id ? { ...x, done: !sub.done } : x)),
    }));
  },

  renameSubtask: async (id, title) => {
    await db.updateSubtask(id, { title });
    set((s) => ({
      subtasks: s.subtasks.map((x) => (x.id === id ? { ...x, title } : x)),
    }));
  },

  removeSubtask: async (id) => {
    await db.deleteSubtask(id);
    set((s) => ({ subtasks: s.subtasks.filter((x) => x.id !== id) }));
  },

  addLink: async (taskId, url, label, kind) => {
    const trimmed = url.trim();
    if (!isHttpUrl(trimmed)) return;
    const k = kind ?? deriveLinkKind(trimmed);
    const l = (label ?? "").trim() || deriveLinkLabel(trimmed, k);
    const link = await db.addLink(taskId, trimmed, l, k);
    set((s) => ({
      links: { ...s.links, [taskId]: [...(s.links[taskId] ?? []), link] },
    }));
  },

  removeLink: async (taskId, linkId) => {
    await db.deleteLink(linkId);
    set((s) => ({
      links: {
        ...s.links,
        [taskId]: (s.links[taskId] ?? []).filter((x) => x.id !== linkId),
      },
    }));
  },

  loadActivity: async (taskId) => {
    const activity = await db.fetchActivity(taskId);
    // The user may have switched tasks while we were fetching.
    if (get().editingTaskId === taskId) set({ activity });
  },

  addComment: async (taskId, body) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const comment = await db.insertComment(taskId, trimmed);
    set((s) => ({
      comments: s.editingTaskId === taskId ? [...s.comments, comment] : s.comments,
      commentCounts: {
        ...s.commentCounts,
        [taskId]: (s.commentCounts[taskId] ?? 0) + 1,
      },
    }));
  },

  loadComments: async (taskId) => {
    const comments = await db.fetchComments(taskId);
    // The user may have switched tasks while we were fetching.
    if (get().editingTaskId === taskId) set({ comments });
  },

  addTag: async (name) => {
    const existing = get().tags.find(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) return existing.id;
    const color = colorForName(name);
    const id = await db.insertTag(name, color);
    set((s) => ({
      tags: [...s.tags, { id, name, color }].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
    return id;
  },

  removeTag: async (id) => {
    await db.deleteTag(id);
    set((s) => ({
      tags: s.tags.filter((t) => t.id !== id),
      tasks: s.tasks.map((t) =>
        t.tag_ids.includes(id)
          ? { ...t, tag_ids: t.tag_ids.filter((x) => x !== id) }
          : t,
      ),
      activeTagIds: s.activeTagIds.filter((x) => x !== id),
    }));
  },

  updateTagMeta: async (id, name, color) => {
    await db.updateTag(id, name, color);
    set((s) => ({
      tags: s.tags
        .map((t) => (t.id === id ? { ...t, name, color } : t))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  },

  mergeTags: async (fromId, toId) => {
    if (fromId === toId) return;
    await db.mergeTags(fromId, toId);
    set((s) => ({
      tags: s.tags.filter((t) => t.id !== fromId),
      tasks: s.tasks.map((t) => {
        if (!t.tag_ids.includes(fromId)) return t;
        const tag_ids = t.tag_ids.filter((x) => x !== fromId);
        if (!tag_ids.includes(toId)) tag_ids.push(toId);
        return { ...t, tag_ids };
      }),
      activeTagIds: s.activeTagIds.filter((x) => x !== fromId),
    }));
  },

  assignTags: async (taskId, tagIds) => {
    await db.setTaskTags(taskId, tagIds);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, tag_ids: tagIds } : t)),
    }));
  },

  importData: async ({ projects: incomingProjects = [], tasks: incomingTasks }) => {
    const state = get();
    const projectIdByName = new Map(
      state.projects.map((p) => [p.name.toLowerCase(), p.id]),
    );
    for (const p of incomingProjects) {
      const key = p.name.trim().toLowerCase();
      if (!key || projectIdByName.has(key)) continue;
      const { id } = await db.insertProject(p.name.trim(), p.color ?? colorForName(p.name));
      projectIdByName.set(key, id);
    }
    // Project names referenced only by tasks are created on the fly too.
    for (const t of incomingTasks) {
      const name = t.project?.trim();
      if (name && !projectIdByName.has(name.toLowerCase())) {
        const { id } = await db.insertProject(name, colorForName(name));
        projectIdByName.set(name.toLowerCase(), id);
      }
    }
    const tagIdByName = new Map(state.tags.map((t) => [t.name.toLowerCase(), t.id]));
    let imported = 0;
    for (const t of incomingTasks) {
      const title = t.title?.trim();
      if (!title) continue;
      const project_id = t.project
        ? (projectIdByName.get(t.project.trim().toLowerCase()) ?? null)
        : null;
      const status: Status =
        t.status === "done" || t.status === "doing" ? t.status : "todo";
      const { id } = await db.insertTask({
        project_id,
        title,
        due_date: t.due_date ?? null,
        status,
        position: imported,
        priority: Math.min(3, Math.max(0, t.priority ?? 0)),
        notes: t.notes ?? "",
        completed_at: status === "done" ? (t.completed_at ?? new Date().toISOString()) : null,
        // Older exports predate the field; those tasks start life now.
        created_at: t.created_at ? toIsoUtc(t.created_at) : new Date().toISOString(),
      });
      const tag_ids: number[] = [];
      for (const rawName of t.tags ?? []) {
        const name = rawName.trim();
        if (!name) continue;
        let tagId = tagIdByName.get(name.toLowerCase());
        if (tagId === undefined) {
          tagId = await db.insertTag(name, colorForName(name));
          tagIdByName.set(name.toLowerCase(), tagId);
        }
        tag_ids.push(tagId);
      }
      if (tag_ids.length > 0) await db.setTaskTags(id, tag_ids);
      imported += 1;
    }
    const data = await db.fetchAll();
    set({ ...data });
    return imported;
  },
}));

// Persist the last-viewed selection + view mode whenever either changes, so a
// relaunch lands where the user left off (validated in `init`).
let lastSelection = useStore.getState().selection;
let lastViewMode = useStore.getState().viewMode;
useStore.subscribe((state) => {
  if (state.selection !== lastSelection || state.viewMode !== lastViewMode) {
    lastSelection = state.selection;
    lastViewMode = state.viewMode;
    persistNav(state.selection, state.viewMode);
  }
});

/** Persist an activity entry and refresh the log if that task's details are open. */
async function recordActivity(taskId: number, label: string): Promise<void> {
  await db.insertActivity(taskId, label);
  const s = useStore.getState();
  if (s.editingTaskId === taskId) await s.loadActivity(taskId);
}
