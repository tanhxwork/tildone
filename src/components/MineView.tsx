import { useMemo } from "react";
import { mineGroups } from "../ownerViews";
import { useStore } from "../store";
import type { Task } from "../types";
import { TildoneMark } from "./Brand";
import { TaskRow } from "./TaskRow";

// Mine: what waits on the user across every project, most blocking first — a
// question or approval, then agent work to verify, then their own todos. The
// agent queue is one summary line that opens its own view.
export function MineView() {
  const { tasks, tags, select } = useStore();
  const groups = useMemo(() => mineGroups(tasks, tags), [tasks, tags]);
  const { todo, doing, needsApproval } = groups.queueCounts;
  const queueTotal = todo + doing + needsApproval;

  const sections: { key: string; label: string; tasks: Task[] }[] = [
    { key: "answer", label: "Needs your answer", tasks: groups.needsAnswer },
    { key: "verify", label: "To verify", tasks: groups.toVerify },
    { key: "todos", label: "My todos", tasks: groups.myTodos },
  ];
  const empty = sections.every((s) => s.tasks.length === 0);

  return (
    <div className="task-list owner-view">
      {queueTotal > 0 && (
        <button
          type="button"
          className="queue-strip"
          onClick={() => select({ type: "queue" })}
        >
          <span className="owner-glyph" aria-hidden="true">◇</span>
          <span className="queue-strip-label">Agent queue</span>
          <span className="queue-strip-stat">
            <b>{todo}</b> todo
          </span>
          <span className="queue-strip-stat">
            <b>{doing}</b> doing
          </span>
          <span className="queue-strip-stat">
            <b>{needsApproval}</b> needs approval
          </span>
          <span className="queue-strip-open">Open →</span>
        </button>
      )}

      {empty ? (
        <div className="empty-state">
          <TildoneMark width={36} className="empty-mark" />
          <p className="empty-title">Nothing waiting on you</p>
          <p className="empty-hint">Add a todo above, or check the agent queue.</p>
        </div>
      ) : (
        sections.map((section) =>
          section.tasks.length === 0 ? null : (
            <section key={section.key} className="task-group">
              <h2 className="group-label">
                {section.label}
                <span className="group-count">{section.tasks.length}</span>
              </h2>
              {section.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  showProject
                  ownerLabel={section.key === "verify" ? "done by agent" : undefined}
                />
              ))}
            </section>
          ),
        )
      )}
    </div>
  );
}
