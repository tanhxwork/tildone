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
  TaskImage,
  TaskLink,
  ViewMode,
} from "./types";
import { COLOR_CHOICES, DONE_CLEARED_TAGS, PRIORITY_LABELS, STATUS_LABELS } from "./types";
import { format } from "date-fns";
import { computeDragUpdates } from "./reorder";
import { dueLabel, todayStr, toIsoUtc } from "./utils/dates";
import { byTask, type LivePresence } from "./utils/presence";
import { deriveLinkKind, deriveLinkLabel, isHttpUrl } from "./utils/links";
import {
  removeImageFile,
  saveImageFile,
  type PendingImage,
} from "./utils/images";

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
  /**
   * Set when the first load exhausts its retries. A swallowed init failure used
   * to leave the app on the loading spinner forever with no way to see why (the
   * `void init()` call discarded the error); surfacing it turns a silent hang
   * into a legible message.
   */
  initError: string | null;
  /**
   * What init is doing right now, narrated on the loading screen. A first load
   * can legitimately take seconds (opening the database races the agent
   * server's own connection, and a wedged load only errors after 15s) — a bare
   * spinner over that window is indistinguishable from a hang, which is
   * exactly how the stuck-loading incident stayed invisible.
   */
  initStatus: string;
  projects: Project[];
  /** Discovered icon per project_id; absent/dataUri-null ⇒ render the colour dot. */
  projectIcons: Record<number, ProjectIcon>;
  tasks: Task[];
  tags: Tag[];
  subtasks: Subtask[];
  /** Repo links per task: links[task_id] = [{id, url, label, kind}]. */
  links: Record<number, TaskLink[]>;
  /** Image attachments per task: images[task_id] = [{id, path, filename, …}]. */
  images: Record<number, TaskImage[]>;
  /** Activity log for the task currently open in the details view. */
  activity: ActivityEntry[];
  /** When the open task's tags last changed — the review band's "flagged" time.
   * Loaded alongside activity; null when unknown (no tag write recorded). */
  reviewFlaggedAt: string | null;
  /** Comment thread for the task currently open in the details view. */
  comments: Comment[];
  /** Comment count per task_id, for the card badge. Bodies load only on open
   * (loadComments); this is refreshed by the same reload every agent write triggers. */
  commentCounts: Record<number, number>;
  /**
   * Newest agent activity per task_id — the FALLBACK half of presence. Derived from
   * task_activity on every load, never stored: a dead session stops writing and its
   * entry simply ages, so nothing is ever cleared.
   *
   * This is only what we can infer from the age of a board write, which is why it can
   * never say "working": an agent grinding for 25 minutes without logging looks
   * identical to one that touched the card once and left. It remains the honest best
   * effort for agents with no heartbeat hook (Codex, Cursor, an unconnected Claude
   * Code). `live` below is the real signal. Merge with `cardPresence()`.
   */
  presence: Record<number, { name: string | null; at: string }>;
  /**
   * Live agent presence per task_id, reported by agents' hooks and resolved in Rust.
   *
   * Kept apart from `presence` on purpose: `reload()` replaces everything `fetchAll()`
   * returns wholesale, so a merged map would let any agent's board write clobber live
   * state until the next poll — cards blinking working→quiet→working. This field is
   * written only by `loadPresence`.
   */
  live: Record<number, LivePresence>;

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
  /**
   * Re-read live agent presence. Cheap by design — one command, one small query —
   * because it is polled: a heartbeat fires on every tool call of every agent, far
   * too chatty to hang the board's full reload on.
   */
  loadPresence: () => Promise<void>;
  select: (selection: Selection) => void;
  setViewMode: (mode: ViewMode) => void;
  setSearch: (search: string) => void;
  toggleTagFilter: (tagId: number) => void;
  setPriorityFilter: (priority: number) => void;
  toggleShowCompleted: () => void;
  openEditor: (taskId: number | null) => void;
  /** Acknowledge an agent's change: clear the unseen mark. Called when the editor
   * leaves a task, not when it opens one. A no-op unless the task is marked. */
  markSeen: (id: number) => Promise<void>;
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

  /** Create a task; resolves to the new task's id so post-creation attachments
   *  (pasted images) have something to land on. */
  addTask: (input: {
    title: string;
    project_id: number | null;
    due_date: string | null;
    priority?: number;
    tag_ids?: number[];
  }) => Promise<number>;
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
  /** Save pending clipboard images to disk and attach them to the task. */
  attachImages: (taskId: number, pending: PendingImage[]) => Promise<void>;
  removeImage: (image: TaskImage) => Promise<void>;
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

/**
 * The tag ids a task keeps when it lands in Done, or null when nothing changes.
 * Landing in Done retires `blocked` / `needs-review` (see DONE_CLEARED_TAGS) —
 * without this the user completes a reviewed card and then has to x the stale
 * "Needs review" pill off by hand. Mirrored by apply_task_update in
 * src-tauri/src/agent.rs, the database's other writer.
 */
function tagIdsAfterDone(task: Task, tags: Tag[]): number[] | null {
  const cleared = new Set(
    tags
      .filter((t) =>
        (DONE_CLEARED_TAGS as readonly string[]).includes(t.name.toLowerCase()),
      )
      .map((t) => t.id),
  );
  const kept = task.tag_ids.filter((id) => !cleared.has(id));
  return kept.length === task.tag_ids.length ? null : kept;
}

export const useStore = create<Store>()((set, get) => ({
  loaded: false,
  initError: null,
  initStatus: "Loading…",
  projects: [],
  projectIcons: {},
  tasks: [],
  tags: [],
  subtasks: [],
  links: {},
  images: {},
  activity: [],
  reviewFlaggedAt: null,
  comments: [],
  commentCounts: {},
  presence: {},
  live: {},

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
    // The first DB touch races the agent server opening its own connection to the
    // same file, so a cold start can hit SQLITE_BUSY. Retry with backoff — every
    // step here is idempotent (a DELETE of already-gone rows, an idempotent
    // backfill, a read), so a repeat is harmless. Without this a single transient
    // lock left the app on the spinner forever, because `void init()` swallowed
    // the rejection.
    const backoffMs = [200, 400, 800, 1600, 3000];
    let lastErr: unknown;
    // Narrate every step on the loading screen AND into startup-trace.log. The
    // screen is for the user (a visible step distinguishes "slow" from "hung");
    // the file is for diagnosis after the window is gone.
    const step = (label: string, traceMsg: string) => {
      set({ initStatus: label });
      db.trace(traceMsg);
    };
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      const nth = attempt > 0 ? ` (attempt ${attempt + 1})` : "";
      try {
        step(`Opening the database…${nth}`, `init: attempt ${attempt} openDb`);
        await db.openDb();
        step(`Cleaning up old trash…${nth}`, `init: attempt ${attempt} purge`);
        await db.purgeTrashedBefore(cutoff);
        // Give pre-migration-010 projects/tasks their code/number/ref before the
        // first read, so nothing ever renders the raw #id fallback. Idempotent.
        step(`Checking task references…${nth}`, `init: attempt ${attempt} backfillRefs`);
        await db.backfillRefs();
        step(`Loading your board…${nth}`, `init: attempt ${attempt} fetchAll`);
        const data = await db.fetchAll();
        db.trace(`init: attempt ${attempt} loaded ok`);
        set({ ...data, loaded: true, initError: null });
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
        return;
      } catch (err) {
        lastErr = err;
        db.trace(`init: attempt ${attempt} FAILED: ${String(err)}`);
        if (attempt < backoffMs.length) {
          // Say what went wrong while we retry, not just that we're busy — the
          // user watching this screen is the diagnostic of last resort.
          set({
            initStatus: `Hit a snag — retrying… (${String(err)})`,
          });
          await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        }
      }
    }
    // Out of retries: surface the reason instead of spinning silently forever.
    const message =
      lastErr instanceof Error
        ? (lastErr.stack ?? lastErr.message)
        : String(lastErr);
    console.error("tildone: init failed after retries:", lastErr);
    set({ initError: message });
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
    // A claim may have just landed with that write, so refresh the live view too.
    // Cheap, and it makes a card light up on the claim rather than on the next tick.
    void get().loadPresence();
  },

  loadPresence: async () => {
    try {
      const entries = await invoke<LivePresence[]>("agent_presence");
      set({ live: byTask(entries) });
    } catch {
      // The agent server may simply not be running — that is a normal state, not an
      // error, and it means there is no live presence to show. Cards fall back to the
      // activity-derived entry on their own. Swallowing this keeps a stopped server
      // from spamming the console every poll.
      set({ live: {} });
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
    set({ editingTaskId, activity: [], comments: [], reviewFlaggedAt: null });
    if (editingTaskId !== null) {
      void get().loadActivity(editingTaskId);
      void get().loadComments(editingTaskId);
    }
  },

  /** Acknowledge an agent's change to a task you have finished looking at.
   *
   * Called when the editor LEAVES a task, not when it opens one. Opening covers
   * the card with the editor, so clearing there would settle the mark into its
   * check behind a modal — the one moment of the whole feature, played where
   * nobody can see it. Leaving puts you back on the board with the card in
   * front of you, which is where the check belongs.
   *
   * Guarded on the task actually being marked: without that, closing any editor
   * writes a row for nothing. Optimistic, and deliberately silent to the changes
   * feed (no trigger watches unseen_at; see 014_unseen_at.sql). */
  markSeen: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || task.unseen_at === null) return;
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, unseen_at: null } : t)),
    }));
    await db.updateTask(id, { unseen_at: null });
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
      // You just typed this task in. There is nothing here you have not seen.
      unseen_at: null,
      tag_ids,
    };
    set((s) => ({ tasks: [...s.tasks, task] }));
    return id;
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

    if (patch.status === "done" && current.status !== "done") {
      const kept = tagIdsAfterDone(current, get().tags);
      if (kept) {
        await db.setTaskTags(id, kept);
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, tag_ids: kept } : t)),
        }));
      }
    }

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
    // Clearing unseen_at here is how a Done mark expires: an overnight completion
    // is worth seeing on the board, but once the card ages off the window it must
    // not be left waiting to be opened one by one.
    for (const t of targets)
      await db.updateTask(t.id, { archived_at: now, unseen_at: null });
    set((s) => ({
      tasks: s.tasks.map((t) =>
        ids.has(t.id) ? { ...t, archived_at: now, unseen_at: null } : t,
      ),
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
      if (u.status === "done" && prev.status !== "done") {
        const kept = tagIdsAfterDone(prev, get().tags);
        if (kept) {
          await db.setTaskTags(u.id, kept);
          set((s) => ({
            tasks: s.tasks.map((t) =>
              t.id === u.id ? { ...t, tag_ids: kept } : t,
            ),
          }));
        }
      }
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

  attachImages: async (taskId, pending) => {
    if (pending.length === 0) return;
    const saved: TaskImage[] = [];
    for (const image of pending) {
      const file = await saveImageFile(taskId, image);
      saved.push(await db.insertImage(taskId, file));
    }
    set((s) => ({
      images: { ...s.images, [taskId]: [...(s.images[taskId] ?? []), ...saved] },
    }));
    void recordActivity(
      taskId,
      saved.length === 1 ? "Image attached" : `${saved.length} images attached`,
    );
  },

  removeImage: async (image) => {
    await db.deleteImage(image.id);
    // The row is the source of truth; a file that outlives a failed remove is
    // orphaned disk, not a broken card, so the delete is best-effort.
    void removeImageFile(image).catch(() => {});
    set((s) => ({
      images: {
        ...s.images,
        [image.task_id]: (s.images[image.task_id] ?? []).filter((x) => x.id !== image.id),
      },
    }));
    void recordActivity(image.task_id, "Image removed");
  },

  loadActivity: async (taskId) => {
    const [activity, reviewFlaggedAt] = await Promise.all([
      db.fetchActivity(taskId),
      db.fetchLastTagChange(taskId),
    ]);
    // The user may have switched tasks while we were fetching.
    if (get().editingTaskId === taskId) set({ activity, reviewFlaggedAt });
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
