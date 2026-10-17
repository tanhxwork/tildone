import { needsYouKind, nameIndex, type NeedsYouKind } from "./ownerViews";
import { goalProgress, liveTasks } from "./selectors";
import type { Goal, Project, Tag, Task } from "./types";
import { toIsoUtc } from "./utils/dates";

export type { NeedsYouKind } from "./ownerViews";

// The focus compass (spec focus-compass): where the user is going (goals with a
// recent move), what is moving toward each, and what moves with no goal. Pure
// slicing of the store's tasks, goals, projects and last-activity map — the
// sidebar and the home view render this, tests/focusViews.test.ts pins the rules.

/** A card counts as "moving" when its latest move is this recent. */
export const MOVING_WINDOW_MS = 2 * 86_400_000;
/** A goal or project counts as "in focus" when something in it moved this recently. */
export const FOCUS_WINDOW_MS = 7 * 86_400_000;
/** A doing card with no move for this long is stalled. */
export const STALLED_AFTER_MS = 7 * 86_400_000;

/** Epoch ms of the task's latest move: the newest of its last activity row, its
 *  creation and its completion. Timestamps mix ISO and SQLite's marker-less UTC,
 *  so each goes through toIsoUtc. */
export function lastMoved(task: Task, lastActivity: Record<number, string>): number {
  let latest = 0;
  for (const stamp of [lastActivity[task.id], task.created_at, task.completed_at]) {
    if (!stamp) continue;
    const t = new Date(toIsoUtc(stamp)).getTime();
    if (t > latest) latest = t;
  }
  return latest;
}

export interface MovingCard {
  task: Task;
  movedAt: number;
  needsYou: NeedsYouKind | null;
}

export interface FocusGoal {
  goal: Goal;
  project: Project;
  done: number;
  total: number;
  open: number;
  /** total > 0 and nothing left open: ready to close. */
  finished: boolean;
  /** Newest move over the goal's live cards; 0 when it has none. */
  lastMovedAt: number;
  /** The goal's open cards that wait on the user, newest move first. */
  needsYou: MovingCard[];
  /** The goal's live cards moved within MOVING_WINDOW, newest first. Not sliced:
   *  each view takes the rows it has room for. */
  moving: MovingCard[];
  /** "close it?" when finished, "1 card left" when one is open, else the first
   *  non-empty line of the outcome ("" when there is none). */
  meta: string;
  /** First paragraph of the goal's notes — text up to the first blank line. */
  outcome: string;
}

export interface ProjectMotion {
  project: Project;
  /** Live cards moved within FOCUS_WINDOW. */
  moved: number;
  lastMovedAt: number;
}

export interface FocusModel {
  /** Open goals with a move within FOCUS_WINDOW, newest move first, then
   *  finished-but-open goals with no recent move, newest move first. */
  goals: FocusGoal[];
  /** Doing cards in no goal moved within MOVING_WINDOW, newest first. */
  loose: MovingCard[];
  /** Live cards in no goal moved within FOCUS_WINDOW, per project (null = Inbox):
   *  most first, then project order. */
  looseByProject: { project: Project | null; count: number }[];
  movedThisWeek: number;
  movedNoGoal: number;
  /** Live cards that wait on the user. */
  needsYou: number;
  /** Doing cards with no move for STALLED_AFTER, oldest first. */
  stalled: Task[];
  /** Projects with a move within FOCUS_WINDOW, newest first. */
  active: ProjectMotion[];
  /** Every other project, in sidebar order. */
  quiet: Project[];
}

function firstParagraph(notes: string): string {
  return notes.trim().split(/\n\s*\n/)[0].trim();
}

function firstLine(notes: string): string {
  return notes.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

const byProjectOrder = (a: Project, b: Project) => a.position - b.position || a.id - b.id;

export function focusModel(input: {
  tasks: Task[];
  goals: Goal[];
  projects: Project[];
  tags: Tag[];
  lastActivity: Record<number, string>;
  now: number;
}): FocusModel {
  const { goals, projects, lastActivity, now } = input;
  const tagById = nameIndex(input.tags);
  const live = liveTasks(input.tasks).filter((t) => t.kind === "task");
  const within = (movedAt: number, window: number) => now - movedAt <= window;
  const cards: MovingCard[] = live
    .map((task) => ({
      task,
      movedAt: lastMoved(task, lastActivity),
      needsYou: needsYouKind(task, tagById),
    }))
    .sort((a, b) => b.movedAt - a.movedAt || a.task.id - b.task.id);
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const focusGoals: { entry: FocusGoal; recent: boolean }[] = [];
  for (const goal of goals) {
    if (goal.completed_at !== null) continue;
    const project = projectById.get(goal.project_id);
    if (!project) continue;
    const mine = cards.filter((c) => c.task.goal_id === goal.id);
    const { done, total, open } = goalProgress(live, goal.id);
    const finished = total > 0 && open === 0;
    const lastMovedAt = mine.reduce((m, c) => Math.max(m, c.movedAt), 0);
    const recent = mine.length > 0 && within(lastMovedAt, FOCUS_WINDOW_MS);
    if (!recent && !finished) continue;
    focusGoals.push({
      recent,
      entry: {
        goal,
        project,
        done,
        total,
        open,
        finished,
        lastMovedAt,
        needsYou: mine.filter((c) => c.needsYou !== null),
        moving: mine.filter((c) => within(c.movedAt, MOVING_WINDOW_MS)),
        meta: finished ? "close it?" : open === 1 ? "1 card left" : firstLine(goal.notes),
        outcome: firstParagraph(goal.notes),
      },
    });
  }
  focusGoals.sort(
    (a, b) =>
      Number(b.recent) - Number(a.recent) || b.entry.lastMovedAt - a.entry.lastMovedAt,
  );

  const recentCards = cards.filter((c) => within(c.movedAt, FOCUS_WINDOW_MS));
  const noGoal = recentCards.filter((c) => c.task.goal_id === null);

  const perProject = new Map<number | null, number>();
  for (const c of noGoal) {
    perProject.set(c.task.project_id, (perProject.get(c.task.project_id) ?? 0) + 1);
  }
  const looseByProject = [...perProject]
    .map(([id, count]) => ({ project: id === null ? null : (projectById.get(id) ?? null), count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.project ? a.project.position : -1) - (b.project ? b.project.position : -1) ||
        (a.project?.id ?? 0) - (b.project?.id ?? 0),
    );

  const motion = new Map<number, ProjectMotion>();
  for (const c of cards) {
    const project = c.task.project_id === null ? undefined : projectById.get(c.task.project_id);
    if (!project) continue;
    const entry = motion.get(project.id) ?? { project, moved: 0, lastMovedAt: 0 };
    entry.lastMovedAt = Math.max(entry.lastMovedAt, c.movedAt);
    if (within(c.movedAt, FOCUS_WINDOW_MS)) entry.moved += 1;
    motion.set(project.id, entry);
  }
  const active = [...motion.values()]
    .filter((m) => m.moved > 0)
    .sort((a, b) => b.lastMovedAt - a.lastMovedAt || byProjectOrder(a.project, b.project));
  const activeIds = new Set(active.map((m) => m.project.id));

  return {
    goals: focusGoals.map((g) => g.entry),
    loose: cards.filter(
      (c) =>
        c.task.status === "doing" &&
        c.task.goal_id === null &&
        within(c.movedAt, MOVING_WINDOW_MS),
    ),
    looseByProject,
    movedThisWeek: recentCards.length,
    movedNoGoal: noGoal.length,
    needsYou: cards.filter((c) => c.needsYou !== null).length,
    stalled: cards
      .filter((c) => c.task.status === "doing" && now - c.movedAt > STALLED_AFTER_MS)
      .sort((a, b) => a.movedAt - b.movedAt || a.task.id - b.task.id)
      .map((c) => c.task),
    active,
    quiet: projects.filter((p) => !activeIds.has(p.id)).sort(byProjectOrder),
  };
}
