import { format } from "date-fns";
import type { Project, Selection, Task } from "./types";
import { todayStr } from "./utils/dates";
import {
  cardPresence,
  type FallbackPresence,
  type LivePresence,
  type PresenceState,
} from "./utils/presence";

/** How many done cards the board's Done column keeps at most. Everything beyond
 * this — older completions past the fill, and anything manually cleared — lives in
 * the Completed view instead. One-line done cards make a larger window cheap. */
export const DONE_WINDOW_LIMIT = 14;

export interface DoneWindow {
  /** Finished today (local), newest first — always shown, even past the limit. */
  today: Task[];
  /** Older completions backfilled newest-first only up to the limit. */
  earlier: Task[];
  /** Done tasks in this set not on the board (older past the fill, or archived) —
   * i.e. how many more the "in Completed" link leads to. */
  hiddenCount: number;
}

/** Local calendar day of a completion, or "" when unstamped. Local, not UTC, so
 * "today" means what it does on the wall clock at 11pm. */
function completedDay(task: Task): string {
  return task.completed_at ? format(new Date(task.completed_at), "yyyy-MM-dd") : "";
}

/**
 * The recent window for the board's Done column, computed fresh from completed_at
 * (see docs/specs — no stored rollover state). `today` is a local YYYY-MM-DD.
 *
 * Everything finished today stays. If that is under `limit`, the most-recent older
 * completions backfill up to it; if today already meets or exceeds the limit, all of
 * today's still show and nothing backfills. Archived cards are excluded from the
 * window but still counted in `hiddenCount`.
 */
export function doneBoardWindow(
  doneTasks: Task[],
  today: string,
  limit: number = DONE_WINDOW_LIMIT,
): DoneWindow {
  const byRecent = doneTasks
    .filter((t) => t.archived_at === null)
    .sort((a, b) => {
      const ca = a.completed_at ?? "";
      const cb = b.completed_at ?? "";
      if (ca !== cb) return ca < cb ? 1 : -1; // newest completion first
      return b.id - a.id;
    });
  const todays = byRecent.filter((t) => completedDay(t) === today);
  const older = byRecent.filter((t) => completedDay(t) !== today);
  const earlier = todays.length < limit ? older.slice(0, limit - todays.length) : [];
  const shown = todays.length + earlier.length;
  return { today: todays, earlier, hiddenCount: doneTasks.length - shown };
}

export interface Filters {
  search: string;
  activeTagIds: number[];
  priorityFilter: number;
  showCompleted: boolean;
}

/** Tasks that are not in the trash — every view except Trash works on these. */
export function liveTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.deleted_at === null);
}

export function trashedTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.deleted_at !== null);
}

export function taskMatchesFilters(task: Task, filters: Filters): boolean {
  if (!filters.showCompleted && task.status === "done") return false;
  if (filters.priorityFilter && task.priority !== filters.priorityFilter) return false;
  if (
    filters.activeTagIds.length > 0 &&
    !filters.activeTagIds.every((id) => task.tag_ids.includes(id))
  ) {
    return false;
  }
  if (filters.search) {
    const haystack = `${task.title} ${task.notes}`.toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

export function tasksForSelection(tasks: Task[], selection: Selection): Task[] {
  const live = liveTasks(tasks);
  const today = todayStr();
  switch (selection.type) {
    case "today":
      return live.filter((t) => t.due_date !== null && t.due_date <= today);
    case "upcoming":
      return live.filter((t) => t.due_date !== null && t.due_date > today);
    case "inbox":
      return live.filter((t) => t.project_id === null);
    case "all":
    // Pages (week, review, completed) do their own slicing from the full live set.
    case "week":
    case "review":
    case "completed":
      return live;
    case "project":
      return live.filter((t) => t.project_id === selection.projectId);
  }
}

export function visibleTasks(
  tasks: Task[],
  selection: Selection,
  filters: Filters,
): Task[] {
  return tasksForSelection(tasks, selection).filter((t) =>
    taskMatchesFilters(t, filters),
  );
}

// --- The town (ambient agent view) ------------------------------------------
//
// The town re-renders the board's existing presence state as a pixel-art world:
// one room per project, one character per live (or recently-quiet) agent session.
// This selector is the whole mapping — the PixiJS layer is a dumb renderer of its
// output — so the rules that make a card show a presence meter are the rules that
// place a character, by construction: a character is exactly a task whose
// `cardPresence` is non-null. Reusing that resolver is what guarantees the town
// and the cards never disagree about who is working.

/** One agent session as it appears in the town. */
export interface TownCharacter {
  taskId: number;
  /** The live session behind this character — the jump-to-session key. Null when
   *  the character came from the activity fallback, which carries no session id. */
  sessionId: string | null;
  agentName: string | null;
  state: PresenceState;
  /** The agent's last log line — the "what it's doing" shown on hover. */
  lastLog: string | null;
  /** ISO timestamp of the last activity, behind "quiet 25m". */
  at: string;
  /** True when a live heartbeat placed this character, not the age of a write. */
  live: boolean;
}

/** A project's space in the town. `projectId: null` is the Inbox room. */
export interface TownRoom {
  projectId: number | null;
  name: string;
  /** The project's colour dot, for tinting room chrome; null for Inbox. */
  color: string | null;
  characters: TownCharacter[];
}

export interface TownModel {
  rooms: TownRoom[];
}

/**
 * Build the town from live presence over the current tasks.
 *
 * Every project gets a room, always (the town is a fixed map, not auto-spawned),
 * plus an Inbox room for project-less — or orphan-project — tasks. Rooms are
 * ordered by project `position` then id, Inbox last. Within a room characters are
 * ordered newest-activity first so the layout is stable across reloads.
 *
 * Pure: no store, no clock beyond what `cardPresence` already consults for the
 * fallback recency window. Tested in tests/townModel.test.ts.
 */
export function townModel(
  projects: Project[],
  tasks: Task[],
  live: Record<number, LivePresence>,
  fallback: Record<number, FallbackPresence>,
): TownModel {
  const ordered = [...projects].sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );

  const rooms = new Map<number | null, TownRoom>();
  for (const p of ordered) {
    rooms.set(p.id, { projectId: p.id, name: p.name, color: p.color, characters: [] });
  }
  const inbox: TownRoom = { projectId: null, name: "Inbox", color: null, characters: [] };
  rooms.set(null, inbox);

  for (const t of tasks) {
    if (t.deleted_at !== null) continue;
    const presence = cardPresence(t.id, live, fallback);
    if (!presence) continue;
    // An unknown project_id (orphan row) lands in Inbox rather than vanishing.
    const room = rooms.get(t.project_id) ?? inbox;
    room.characters.push({
      taskId: t.id,
      sessionId: live[t.id]?.session_id ?? null,
      agentName: presence.name,
      state: presence.state,
      lastLog: presence.last_log,
      at: presence.at,
      live: presence.live,
    });
  }

  for (const room of rooms.values()) {
    room.characters.sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : a.taskId - b.taskId,
    );
  }

  return { rooms: [...ordered.map((p) => rooms.get(p.id)!), inbox] };
}
