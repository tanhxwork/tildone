import { useStore } from "../store";
import type { Task } from "../types";
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUS_LABELS } from "../types";
import { dueLabel, isOverdue } from "../utils/dates";
import { IconCheck, IconFlag } from "./Icons";
import { TagChip } from "./ui";

export function TaskMeta({
  task,
  showProject,
  hideStatus,
  className = "",
}: {
  task: Task;
  showProject?: boolean;
  hideStatus?: boolean;
  className?: string;
}) {
  const { projects, tags } = useStore();
  const project = showProject
    ? projects.find((p) => p.id === task.project_id)
    : undefined;
  const taskTags = tags.filter((t) => task.tag_ids.includes(t.id));
  const overdue = isOverdue(task);

  const showDoing = task.status === "doing" && !hideStatus;
  const hasMeta =
    task.due_date || task.priority > 0 || taskTags.length > 0 || project || showDoing;
  if (!hasMeta) return null;

  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 ${className}`}>
      {showDoing && (
        <span className="rounded-full border border-doing/45 bg-doing/10 px-1.5 text-[10.5px] font-semibold text-doing">
          {STATUS_LABELS.doing}
        </span>
      )}
      {task.due_date && (
        <span
          className={`rounded-full px-[7px] py-px text-[11px] tabular-nums ${
            overdue ? "bg-danger/10 font-semibold text-danger" : "bg-inset text-ink-muted"
          }`}
        >
          {dueLabel(task.due_date)}
        </span>
      )}
      {task.priority > 0 && (
        <span
          className="inline-flex"
          title={`${PRIORITY_LABELS[task.priority]} priority`}
          style={{ color: PRIORITY_COLORS[task.priority] }}
        >
          <IconFlag size={12} />
        </span>
      )}
      {taskTags.map((tag) => (
        <TagChip key={tag.id} color={tag.color} mini>
          {tag.name}
        </TagChip>
      ))}
      {project && (
        <span className="inline-flex max-w-[140px] items-center gap-[5px] truncate text-[11px] text-ink-faint">
          <span
            className="size-[9px] shrink-0 rounded-full"
            style={{ background: project.color }}
          />
          {project.name}
        </span>
      )}
    </span>
  );
}

export function TaskRow({ task, showProject }: { task: Task; showProject?: boolean }) {
  const { toggleDone, openEditor, editingTaskId } = useStore();
  const done = task.status === "done";

  return (
    <div
      className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] transition-colors ${
        editingTaskId === task.id ? "bg-active" : "hover:bg-hover"
      }`}
      onClick={() => openEditor(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && openEditor(task.id)}
    >
      <button
        className={`inline-flex size-[17px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-accent-contrast transition-colors ${
          done ? "border-accent bg-accent" : "border-edge-strong hover:border-accent"
        }`}
        aria-label={done ? "Mark as not done" : "Mark as done"}
        onClick={(e) => {
          e.stopPropagation();
          toggleDone(task.id);
        }}
      >
        {done && <IconCheck size={11} />}
      </button>
      <span className={`min-w-0 truncate ${done ? "text-ink-faint line-through" : ""}`}>
        {task.title}
      </span>
      <TaskMeta task={task} showProject={showProject} className="ml-auto" />
    </div>
  );
}
