import { useState } from "react";
import { goalProgress } from "../selectors";
import { useStore } from "../store";
import { dueLabel, todayStr } from "../utils/dates";
import { IconPencil } from "./Icons";
import { GoalDialog } from "./GoalDialog";

/**
 * The band above the board when a goal is selected: name, outcome, count,
 * target date, progress bar. The pencil opens GoalDialog, which is also where
 * the goal is closed/reopened and deleted — the same "edit dialog owns
 * lifecycle" pattern ProjectDialog already uses for projects.
 */
export function GoalBand({ goalId }: { goalId: number }) {
  const goals = useStore((s) => s.goals);
  const tasks = useStore((s) => s.tasks);
  const goal = goals.find((g) => g.id === goalId);
  const [editing, setEditing] = useState(false);

  // A concurrent delete (another window, an agent) can race the selection
  // guard in store.init/removeGoal — render nothing rather than crash.
  if (!goal) return null;

  const { done, total } = goalProgress(tasks, goal.id);
  const overdue =
    goal.completed_at === null && goal.target_date !== null && goal.target_date < todayStr();

  return (
    <div className="goal-band">
      <div className="goal-band-row">
        <span className="goal-glyph goal-band-glyph" style={{ color: goal.color }} aria-hidden="true" />
        <div className="goal-band-main">
          <div className="goal-band-name">
            {goal.name}
            {goal.completed_at !== null && <span className="goal-band-closed">Closed</span>}
          </div>
          {goal.notes && <div className="goal-band-outcome">{goal.notes}</div>}
        </div>
        <div className="goal-band-meta">
          <span className="goal-band-count">
            {total > 0 ? `${done} / ${total}` : "No tasks yet"}
          </span>
          {goal.target_date && (
            <span className={`goal-band-date ${overdue ? "overdue" : ""}`}>
              {dueLabel(goal.target_date)}
            </span>
          )}
          <button className="icon-btn" aria-label="Edit goal" title="Edit goal" onClick={() => setEditing(true)}>
            <IconPencil size={13} />
          </button>
        </div>
      </div>
      <div className="goal-band-bar">
        <span
          className="goal-band-bar-fill"
          style={{ transform: `scaleX(${total > 0 ? done / total : 0})` }}
        />
      </div>
      {editing && (
        <GoalDialog goal={goal} projectId={goal.project_id} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}
