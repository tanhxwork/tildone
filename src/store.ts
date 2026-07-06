import { create } from "zustand";
import * as db from "./db";
import type { Project, Selection, Status, Tag, Task, ViewMode } from "./types";
import { COLOR_CHOICES } from "./types";

export interface ImportedTask {
  title: string;
  notes?: string;
  status?: Status;
  priority?: number;
  due_date?: string | null;
  completed_at?: string | null;
  project?: string | null;
  tags?: string[];
}

interface Store {
  loaded: boolean;
  projects: Project[];
  tasks: Task[];
  tags: Tag[];

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
  editProject: (id: number, name: string, color: string) => Promise<void>;
  removeProject: (id: number) => Promise<void>;
  moveProject: (id: number, delta: -1 | 1) => Promise<void>;

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
  applyPositions: (
    updates: { id: number; status: Status; position: number }[],
  ) => Promise<void>;

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

export const useStore = create<Store>()((set, get) => ({
  loaded: false,
  projects: [],
  tasks: [],
  tags: [],

  selection: { type: "today" },
  viewMode: "list",
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
    const data = await db.fetchAll();
    set({ ...data, loaded: true });
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
  openEditor: (editingTaskId) => set({ editingTaskId }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTagManagerOpen: (tagManagerOpen) => set({ tagManagerOpen }),

  addProject: async (name, color) => {
    const id = await db.insertProject(name, color);
    set((s) => ({
      projects: [...s.projects, { id, name, color, position: s.projects.length }],
      selection: { type: "project", projectId: id },
    }));
  },

  editProject: async (id, name, color) => {
    await db.updateProject(id, name, color);
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name, color } : p)),
    }));
  },

  removeProject: async (id) => {
    await db.deleteProject(id);
    set((s) => {
      const selection =
        s.selection.type === "project" && s.selection.projectId === id
          ? ({ type: "today" } as Selection)
          : s.selection;
      return {
        projects: s.projects.filter((p) => p.id !== id),
        tasks: s.tasks.filter((t) => t.project_id !== id),
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
    const position =
      tasks
        .filter((t) => t.project_id === project_id && t.status === "todo")
        .reduce((max, t) => Math.max(max, t.position), -1) + 1;
    const id = await db.insertTask({
      project_id,
      title,
      due_date,
      status: "todo",
      position,
      priority,
    });
    if (tag_ids.length > 0) await db.setTaskTags(id, tag_ids);
    const task: Task = {
      id,
      project_id,
      title,
      notes: "",
      status: "todo",
      priority,
      due_date,
      position,
      created_at: new Date().toISOString(),
      completed_at: null,
      deleted_at: null,
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
    }
    await db.updateTask(id, full);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...full } : t)),
    }));
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
    await db.updateTask(id, { deleted_at: null });
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, deleted_at: null } : t)),
    }));
  },

  destroyTask: async (id) => {
    await db.deleteTask(id);
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      editingTaskId: s.editingTaskId === id ? null : s.editingTaskId,
    }));
  },

  emptyTrash: async () => {
    await db.deleteAllTrashed();
    set((s) => ({ tasks: s.tasks.filter((t) => t.deleted_at === null) }));
  },

  applyPositions: async (updates) => {
    const now = new Date().toISOString();
    const byId = new Map(get().tasks.map((t) => [t.id, t]));
    const resolved = updates
      .filter((u) => byId.has(u.id))
      .map((u) => {
        const prev = byId.get(u.id)!;
        const completed_at =
          u.status === prev.status
            ? prev.completed_at
            : u.status === "done"
              ? now
              : null;
        return { ...u, completed_at };
      });
    set((s) => ({
      tasks: s.tasks.map((t) => {
        const u = resolved.find((x) => x.id === t.id);
        return u
          ? { ...t, status: u.status, position: u.position, completed_at: u.completed_at }
          : t;
      }),
    }));
    for (const u of resolved) {
      await db.updateTask(u.id, {
        status: u.status,
        position: u.position,
        completed_at: u.completed_at,
      });
    }
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
      const id = await db.insertProject(p.name.trim(), p.color ?? colorForName(p.name));
      projectIdByName.set(key, id);
    }
    // Project names referenced only by tasks are created on the fly too.
    for (const t of incomingTasks) {
      const name = t.project?.trim();
      if (name && !projectIdByName.has(name.toLowerCase())) {
        const id = await db.insertProject(name, colorForName(name));
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
      const id = await db.insertTask({
        project_id,
        title,
        due_date: t.due_date ?? null,
        status,
        position: imported,
        priority: Math.min(3, Math.max(0, t.priority ?? 0)),
        notes: t.notes ?? "",
        completed_at: status === "done" ? (t.completed_at ?? new Date().toISOString()) : null,
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
