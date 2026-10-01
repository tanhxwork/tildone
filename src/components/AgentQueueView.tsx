import { useMemo, type ReactNode } from "react";
import { queueGroups } from "../ownerViews";
import { useStore } from "../store";
import type { Task } from "../types";
import { cardPresence } from "../utils/presence";
import { taskRefLabel } from "../utils/ref";
import { TildoneMark } from "./Brand";
import { ProjectGlyph } from "./ProjectGlyph";
import { FromRef } from "./TaskRow";

// The Agent queue: open agent-owned work in the order agents pick it (next_task
// takes the first Todo of a project). The user steers it from here — approve or dismiss a
// proposed follow-up, or take a card over, which moves it to Mine.
export function AgentQueueView() {
  const { tasks, tags, projects, approveTask, removeTask, patchTask } = useStore();
  const groups = useMemo(() => queueGroups(tasks, tags, projects), [tasks, tags, projects]);

  const takeIt = (task: Task) => (
    <button
      type="button"
      className="btn small"
      onClick={(e) => {
        e.stopPropagation();
        void patchTask(task.id, { owner: "human" });
      }}
    >
      Take it
    </button>
  );

  if (groups.doing.length + groups.needsApproval.length + groups.todo.length === 0) {
    return (
      <div className="empty-state">
        <TildoneMark width={36} className="empty-mark" />
        <p className="empty-title">The agent queue is empty</p>
        <p className="empty-hint">Tasks agents create land here until one claims them.</p>
      </div>
    );
  }

  return (
    <div className="task-list owner-view">
      <p className="queue-lede">Agents take the first Todo in each project.</p>
      <QueueGroup label="Doing" tasks={groups.doing} action={(t) => <ClaimPill task={t} />} />
      <QueueGroup
        label="Waiting for your approval"
        tasks={groups.needsApproval}
        action={(t) => (
          <>
            <button
              type="button"
              className="btn small primary"
              onClick={(e) => {
                e.stopPropagation();
                void approveTask(t.id);
              }}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                void removeTask(t.id);
              }}
            >
              Dismiss
            </button>
          </>
        )}
      />
      <QueueGroup label="Todo" tasks={groups.todo} action={takeIt} />
    </div>
  );
}

function QueueGroup({
  label,
  tasks,
  action,
}: {
  label: string;
  tasks: Task[];
  action: (task: Task) => ReactNode;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="task-group">
      <h2 className="group-label">
        {label}
        <span className="group-count">{tasks.length}</span>
      </h2>
      {tasks.map((task) => (
        <QueueRow key={task.id} task={task} action={action(task)} />
      ))}
    </section>
  );
}

function QueueRow({ task, action }: { task: Task; action: ReactNode }) {
  const { projects, openEditor, editingTaskId } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  return (
    <div
      className={`task-row queue-row ${editingTaskId === task.id ? "editing" : ""}`}
      onClick={() => openEditor(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && openEditor(task.id)}
    >
      <span className="task-id" aria-hidden="true">{taskRefLabel(task)}</span>
      <span className="task-title">{task.title}</span>
      <FromRef task={task} />
      <span className="project-label">
        {project ? (
          <>
            <ProjectGlyph project={project} size={14} />
            {project.name}
          </>
        ) : (
          "Inbox"
        )}
      </span>
      <span className="queue-actions">{action}</span>
    </div>
  );
}

/** Who is on a doing card: the claiming agent's name, else its session, as the
 *  board card's presence reads it. */
function ClaimPill({ task }: { task: Task }) {
  const live = useStore((s) => s.live);
  const fallback = useStore((s) => s.presence);
  const entry = cardPresence(task.id, live, fallback);
  const session = live[task.id]?.session_id;
  const label = entry?.name ?? (session ? `session ${session.slice(0, 4)}` : "doing");
  return <span className="status-pill">{label}</span>;
}
