import { liveTasks } from "./selectors";
import type { Tag, Task } from "./types";
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

function nameIndex(tags: Tag[]): Map<number, string> {
  return new Map(tags.map((t) => [t.id, t.name]));
}

export function queueGroups(tasks: Task[], tags: Tag[]): QueueGroups {
  const byId = nameIndex(tags);
  const open = liveTasks(tasks)
    .filter((t) => t.owner === "agent" && t.status !== "done")
    .sort(compareTasks);
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
    const names = tagNames(t, byId);
    const human = t.owner === "human";
    if (human && t.status !== "done" && (names.has("blocked") || names.has("needs-approval"))) {
      needsAnswer.push(t);
    } else if (names.has("human-verify")) {
      toVerify.push(t);
    } else if (human && t.status !== "done") {
      myTodos.push(t);
    }
  }
  const queue = queueGroups(tasks, tags);
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
 *  what "from TIL-205" names. Null hides the lineage line. */
export function lineageTask(task: Task, tasks: Task[]): Task | null {
  if (task.from_task_id === null) return null;
  const origin = tasks.find((t) => t.id === task.from_task_id);
  return origin?.ref ? origin : null;
}
