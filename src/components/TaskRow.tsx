import { useStore } from "../store";
import type { Task } from "../types";
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUS_LABELS } from "../types";
import { dueLabel, isOverdue } from "../utils/dates";
import { IconCheck, IconFlag } from "./Icons";

export function TaskMeta({
  task,
  showProject,
  hideStatus,
}: {
  task: Task;
  showProject?: boolean;
  hideStatus?: boolean;
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
    <span className="task-meta">
      {showDoing && <span className="status-pill">{STATUS_LABELS.doing}</span>}
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
          <span className="project-dot" style={{ background: project.color }} />
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
      className={`task-row ${done ? "done" : ""} ${editingTaskId === task.id ? "editing" : ""}`}
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
      <span className="task-title">{task.title}</span>
      <TaskMeta task={task} showProject={showProject} />
    </div>
  );
}
