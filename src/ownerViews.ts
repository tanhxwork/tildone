import { liveTasks } from "./selectors";
import type { ObserveCard, Project, Tag, Task } from "./types";
import { compareTasks } from "./utils/dates";

// The two owner pages (spec 2026-10-01 task owner): Mine, the human's cross-
// project inbox of what waits on them, and the Agent queue, what agents may pick
// up next. Pure slicing of the live task set — the views render these groups and
// tests/ownerViews.test.ts pins the rules.

export interface QueueGroups {
  /** Agent tasks an agent is working now. */
  doing: Task[];
  /** Agent follow-ups waiting on the user's yes before anyone may claim them. */
  needsApproval: Task[];
  /** The rest of the open agent work, in pick order. */
  todo: Task[];
}

export interface MineGroups {
  /** Human tasks tagged blocked or needs-approval: a question for the user. */
  needsAnswer: Task[];
  /** Anything tagged human-verify, whoever did it. */
  toVerify: Task[];
  /** Open human tasks not already listed above. */
  myTodos: Task[];
  queueCounts: { todo: number; doing: number; needsApproval: number };
}

/** The lowercased tag names on a task — reserved tags match case-insensitively. */
function tagNames(task: Task, tagById: Map<number, string>): Set<string> {
  const names = new Set<string>();
  for (const id of task.tag_ids) {
    const name = tagById.get(id);
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

export function nameIndex(tags: Tag[]): Map<number, string> {
  return new Map(tags.map((t) => [t.id, t.name]));
}

export type NeedsYouKind = "decide" | "approve" | "verify";

/** What an open task waits on the user for, or null when it waits on nobody:
 *  "decide" a human task tagged blocked or needs-approval, "verify" anything tagged
 *  human-verify, "approve" an agent follow-up tagged needs-approval. First match
 *  wins, in that order. A done task waits on nothing. */
export function needsYouKind(task: Task, tagById: Map<number, string>): NeedsYouKind | null {
  if (task.status === "done") return null;
  const names = tagNames(task, tagById);
  const human = task.owner === "human";
  if (human && (names.has("blocked") || names.has("needs-approval"))) return "decide";
  if (names.has("human-verify")) return "verify";
  if (!human && names.has("needs-approval")) return "approve";
  return null;
}

/** Queue order is next_task's pick order: the Inbox, then projects in sidebar
 *  order (position, id), then the board order inside each (position, id). So the
 *  first Todo row of a project is what next_task(project) returns. */
export function queueGroups(tasks: Task[], tags: Tag[], projects: Project[]): QueueGroups {
  const byId = nameIndex(tags);
  const projectRank = new Map(
    [...projects]
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((p, i) => [p.id, i + 1]),
  );
  const rank = (t: Task) => (t.project_id === null ? 0 : (projectRank.get(t.project_id) ?? 0));
  const open = liveTasks(tasks)
    .filter((t) => t.owner === "agent" && t.status !== "done")
    .sort((a, b) => rank(a) - rank(b) || a.position - b.position || a.id - b.id);
  const groups: QueueGroups = { doing: [], needsApproval: [], todo: [] };
  for (const t of open) {
    if (t.status === "doing") groups.doing.push(t);
    else if (tagNames(t, byId).has("needs-approval")) groups.needsApproval.push(t);
    else groups.todo.push(t);
  }
  return groups;
}

export function mineGroups(tasks: Task[], tags: Tag[]): MineGroups {
  const byId = nameIndex(tags);
  const live = liveTasks(tasks).sort(compareTasks);
  const needsAnswer: Task[] = [];
  const toVerify: Task[] = [];
  const myTodos: Task[] = [];
  for (const t of live) {
    if (needsYouKind(t, byId) === "decide") {
      needsAnswer.push(t);
    } else if (tagNames(t, byId).has("human-verify")) {
      // Unlike needsYouKind, Mine keeps a done task here until it is archived.
      toVerify.push(t);
    } else if (t.owner === "human" && t.status !== "done") {
      myTodos.push(t);
    }
  }
  const queue = queueGroups(tasks, tags, []);
  return {
    needsAnswer,
    toVerify,
    myTodos,
    queueCounts: {
      todo: queue.todo.length,
      doing: queue.doing.length,
      needsApproval: queue.needsApproval.length,
    },
  };
}

/** The task this one came from, when that task still exists and carries a ref —
 *  what "from TIL-205" names. Null hides the lineage line. The origin may be an
 *  observe card (a decision's follow-up), which lives outside `tasks`. */
export function lineageTask(
  task: Task,
  tasks: Task[],
  observeCards: ObserveCard[],
): Task | null {
  if (task.from_task_id === null) return null;
  const origin =
    // A trashed observe card sits in tasks only for Trash; it is no lineage target.
    tasks.find((t) => t.id === task.from_task_id && t.kind === "task") ??
    observeCards.find((c) => c.task.id === task.from_task_id)?.task;
  return origin?.ref ? origin : null;
}
