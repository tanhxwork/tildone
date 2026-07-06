import { create } from "zustand";
import * as db from "./db";
import type { Project, Selection, Status, Tag, Task, ViewMode } from "./types";
import { COLOR_CHOICES } from "./types";

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

  init: () => Promise<void>;
  select: (selection: Selection) => void;
  setViewMode: (mode: ViewMode) => void;
  setSearch: (search: string) => void;
  toggleTagFilter: (tagId: number) => void;
  setPriorityFilter: (priority: number) => void;
  toggleShowCompleted: () => void;
  openEditor: (taskId: number | null) => void;

  addProject: (name: string, color: string) => Promise<void>;
  editProject: (id: number, name: string, color: string) => Promise<void>;
  removeProject: (id: number) => Promise<void>;

  addTask: (input: {
    title: string;
    project_id: number | null;
    due_date: string | null;
  }) => Promise<void>;
  patchTask: (
    id: number,
    patch: Partial<Omit<Task, "id" | "tag_ids" | "created_at">>,
  ) => Promise<void>;
  toggleDone: (id: number) => Promise<void>;
  removeTask: (id: number) => Promise<void>;
  applyPositions: (
    updates: { id: number; status: Status; position: number }[],
  ) => Promise<void>;

  addTag: (name: string) => Promise<number>;
  removeTag: (id: number) => Promise<void>;
  assignTags: (taskId: number, tagIds: number[]) => Promise<void>;
}

function colorForName(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLOR_CHOICES[Math.abs(hash) % COLOR_CHOICES.length];
}

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

  init: async () => {
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

  addTask: async ({ title, project_id, due_date }) => {
    const { tasks } = get();
    const position =
      tasks
        .filter((t) => t.project_id === project_id && t.status === "todo")
        .reduce((max, t) => Math.max(max, t.position), -1) + 1;
    const id = await db.insertTask({ project_id, title, due_date, status: "todo", position });
    const task: Task = {
      id,
      project_id,
      title,
      notes: "",
      status: "todo",
      priority: 0,
      due_date,
      position,
      created_at: new Date().toISOString(),
      completed_at: null,
      tag_ids: [],
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
    await db.deleteTask(id);
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      editingTaskId: s.editingTaskId === id ? null : s.editingTaskId,
    }));
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

  assignTags: async (taskId, tagIds) => {
    await db.setTaskTags(taskId, tagIds);
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, tag_ids: tagIds } : t)),
    }));
  },
}));
