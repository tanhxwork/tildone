import { lineageTask } from "../ownerViews";
import { useStore } from "../store";
import type { ReservedTag, Tag, Task } from "../types";
import {
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  RESERVED_TAGS,
  RESERVED_TAG_LABELS,
  STATUS_LABELS,
} from "../types";
import { dueLabel, isOverdue } from "../utils/dates";
import { cardPresence } from "../utils/presence";
import { taskRefLabel } from "../utils/ref";
import { IconCheck, IconFlag } from "./Icons";
import { ProjectGlyph } from "./ProjectGlyph";

const isReserved = (name: string): name is ReservedTag =>
  (RESERVED_TAGS as readonly string[]).includes(name.toLowerCase());

/** The reserved state a task is in, or null. Blocked outranks needs-review. */
export function reservedState(task: Task, tags: Tag[]): ReservedTag | null {
  const names = new Set(
    tags
      .filter((t) => task.tag_ids.includes(t.id))
      .map((t) => t.name.toLowerCase()),
  );
  return RESERVED_TAGS.find((r) => names.has(r)) ?? null;
}

export function TaskMeta({
  task,
  showProject,
  hideStatus,
  hideState,
  showOwner,
  ownerLabel,
}: {
  task: Task;
  showProject?: boolean;
  hideStatus?: boolean;
  /** Drop the reserved-state pill because something else already says it — the
   *  board's "Needs review" divider heads a whole section of them, and a pill
   *  under that heading is the same fact twice. Everywhere without a section
   *  (To Do, Done, the list views) leaves this off: there the pill is the only
   *  thing carrying the state. */
  hideState?: boolean;
  /** Lead the row with the agent ◇ and "from TIL-xxx" — the board card folds
   *  them into its meta line instead of a line of their own. */
  showOwner?: boolean;
  /** Visible text beside the ◇ (see OwnerMark). */
  ownerLabel?: string;
}) {
  const { projects, tags, goals, tasks, selection, select } = useStore();
  const project = showProject
    ? projects.find((p) => p.id === task.project_id)
    : undefined;
  // Reserved tags leave the chip list — they read as a state pill instead.
  const state = hideState ? null : reservedState(task, tags);
  const taskTags = tags.filter(
    (t) => task.tag_ids.includes(t.id) && !isReserved(t.name),
  );
  const overdue = isOverdue(task);
  // The chip is noise inside the goal it names — suppressed only there (spec
  // "Instead of surface B", the goal chip's whole reason for existing).
  const goal = task.goal_id !== null ? goals.find((g) => g.id === task.goal_id) : undefined;
  const showGoalChip =
    goal !== undefined && !(selection.type === "goal" && selection.goalId === goal.id);

  const showDoing = task.status === "doing" && !hideStatus;
  const origin = showOwner ? lineageTask(task, tasks) : null;
  const ownerLead = showOwner && (task.owner === "agent" || origin !== null);
  const hasMeta =
    ownerLead ||
    task.due_date ||
    task.priority > 0 ||
    taskTags.length > 0 ||
    project ||
    showDoing ||
    state ||
    showGoalChip;
  if (!hasMeta) return null;

  return (
    <span className="task-meta">
      {ownerLead && <OwnerMark task={task} label={ownerLabel} />}
      {origin && <span className="from-ref">from {origin.ref}</span>}
      {state && (
        <span className={`state-pill ${state}`}>{RESERVED_TAG_LABELS[state]}</span>
      )}
      {showDoing && <span className="status-pill">{STATUS_LABELS.doing}</span>}
      {showGoalChip && goal && (
        <button
          type="button"
          className="goal-chip"
          style={{ ["--goal-color" as string]: goal.color }}
          title={`Goal: ${goal.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            select({ type: "goal", goalId: goal.id });
          }}
        >
          <span className="goal-chip-glyph" aria-hidden="true" />
          <span className="goal-chip-label">{goal.name}</span>
        </button>
      )}
      {task.due_date && (
        <span className={`due-chip ${overdue ? "overdue" : ""}`}>
          {dueLabel(task.due_date)}
        </span>
      )}
      {task.priority > 0 && (
        <span
          className="priority-flag"
          title={`${PRIORITY_LABELS[task.priority]} priority`}
          style={{ color: PRIORITY_COLORS[task.priority] }}
        >
          <IconFlag size={12} />
        </span>
      )}
      {taskTags.map((tag) => (
        <span
          key={tag.id}
          className="tag-chip mini"
          style={{ ["--tag-color" as string]: tag.color }}
        >
          {tag.name}
        </span>
      ))}
      {project && (
        <span className="project-label">
          <ProjectGlyph project={project} size={14} />
          {project.name}
        </span>
      )}
    </span>
  );
}

/** The neutral ◇ an agent-owned task carries on every surface. `label` spells it
 *  out where the bare glyph would be ambiguous ("done by agent" under To verify). */
export function OwnerMark({ task, label }: { task: Task; label?: string }) {
  if (task.owner !== "agent") return null;
  return (
    <span className="owner-mark" title="Owned by an agent">
      <span className="owner-glyph">◇</span>
      {label}
    </span>
  );
}

/** Who holds a doing card: the agent's presence name, else its session id, else
 *  null. The queue's Doing pill and the board's agent card both say it. */
export function useClaimLabel(task: Task): string | null {
  const live = useStore((s) => s.live);
  const fallback = useStore((s) => s.presence);
  const entry = cardPresence(task.id, live, fallback);
  const session = live[task.id]?.session_id;
  return entry?.name ?? (session ? `session ${session.slice(0, 4)}` : null);
}

/** "from TIL-205": the task whose work spawned this one. Renders nothing when
 *  there is no lineage or the origin is gone. */
export function FromRef({ task }: { task: Task }) {
  const tasks = useStore((s) => s.tasks);
  const origin = lineageTask(task, tasks);
  if (!origin) return null;
  return <span className="from-ref">from {origin.ref}</span>;
}

export function TaskRow({
  task,
  showProject,
  ownerLabel,
  awaitingCheck,
}: {
  task: Task;
  showProject?: boolean;
  /** Visible text beside the agent marker; the glyph alone otherwise. */
  ownerLabel?: string;
  /** Mine's To verify: done work still waiting on the user's check. The title
   *  stays live (no strikethrough); the checkbox still reflects and toggles done. */
  awaitingCheck?: boolean;
}) {
  const { toggleDone, openEditor, editingTaskId } = useStore();
  const done = task.status === "done";

  return (
    <div
      className={`task-row ${done && !awaitingCheck ? "done" : ""} ${editingTaskId === task.id ? "editing" : ""}`}
      onClick={() => openEditor(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && openEditor(task.id)}
    >
      <button
        className={`task-check ${done ? "checked" : ""}`}
        aria-label={done ? "Mark as not done" : "Mark as done"}
        onClick={(e) => {
          e.stopPropagation();
          toggleDone(task.id);
        }}
      >
        {done && <IconCheck size={11} />}
      </button>
      <span className="task-id" aria-hidden="true">{taskRefLabel(task)}</span>
      <span className="task-title">{task.title}</span>
      <OwnerMark task={task} label={ownerLabel} />
      <FromRef task={task} />
      <TaskMeta task={task} showProject={showProject} />
    </div>
  );
}
