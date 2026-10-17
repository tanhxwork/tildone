import { useMemo, useState } from "react";
import { FOCUS_WINDOW_MS, focusModel } from "../focusViews";
import { goalProgress, goalsPageOrder } from "../selectors";
import { useStore } from "../store";
import { dueLabel, todayStr } from "../utils/dates";
import { TildoneMark } from "./Brand";
import { GoalBands, LooseBand } from "./CompassBand";
import { GoalDialog } from "./GoalDialog";
import { IconPlus } from "./Icons";
import "./compass.css";

type Filter = "open" | "all";

/**
 * The home view. On top, "Where you're going": a band per goal that moved this
 * week, what needs the user, what is moving, and the work moving with no goal
 * (spec focus-compass). Below, "All goals": every goal across every project, one
 * row each — the "what am I actually pushing this month" answer no other view
 * gives (spec 2026-08-20-goals-inside-projects.md). Ordering is goalsPageOrder:
 * overdue first, then target date, undated last, completed last (only reachable
 * under All).
 */
export function GoalsView() {
  const goals = useStore((s) => s.goals);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const tags = useStore((s) => s.tags);
  const lastActivity = useStore((s) => s.lastActivity);
  const select = useStore((s) => s.select);
  const [filter, setFilter] = useState<Filter>("open");
  // The page used to send you back to the sidebar to create a goal — an empty
  // state whose only instruction is "go somewhere else". GoalDialog picks the
  // project itself here, since this is the one place with none in context.
  const [creating, setCreating] = useState(false);
  const today = todayStr();

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const { model, goalsMoved } = useMemo(() => {
    const now = Date.now();
    const model = focusModel({
      tasks,
      goals,
      projects,
      tags,
      lastActivity,
      now,
    });
    return {
      model,
      goalsMoved: model.goals.filter(
        (g) => now - g.lastMovedAt <= FOCUS_WINDOW_MS,
      ).length,
    };
  }, [tasks, goals, projects, tags, lastActivity]);
  const needsYou = model.needsYou;

  const visible = useMemo(() => {
    const base =
      filter === "open" ? goals.filter((g) => g.completed_at === null) : goals;
    return goalsPageOrder(base, projects, today);
  }, [goals, projects, filter, today]);

  return (
    <div className="goals-view">
      <p className="compass-sub">
        {goalsMoved} {goalsMoved === 1 ? "goal" : "goals"} moved this week ·{" "}
        {needsYou} {needsYou === 1 ? "card needs" : "cards need"} you
      </p>
      {model.goals.length === 0 && model.movedNoGoal === 0 ? (
        <div className="compass-empty">Nothing moved this week</div>
      ) : (
        <>
          <GoalBands goals={model.goals} />
          <LooseBand
            loose={model.loose}
            byProject={model.looseByProject}
            movedNoGoal={model.movedNoGoal}
            movedThisWeek={model.movedThisWeek}
          />
        </>
      )}

      <div className="goals-toolbar compass-all">
        <h2 className="compass-all-title">All goals</h2>
        <div className="segmented" role="group" aria-label="Open or all goals">
          <button
            className={filter === "open" ? "active" : ""}
            onClick={() => setFilter("open")}
          >
            Open
          </button>
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            All
          </button>
        </div>
        <button
          className="btn small primary goals-new"
          disabled={projects.length === 0}
          title={projects.length === 0 ? "Create a project first" : "New goal"}
          onClick={() => setCreating(true)}
        >
          <IconPlus size={12} />
          New goal
        </button>
      </div>

      {visible.length === 0 && (
        <div className="empty-state">
          <TildoneMark width={36} className="empty-mark" />
          <p className="empty-title">
            {filter === "open" ? "No open goals" : "No goals yet"}
          </p>
          <p className="empty-hint">
            {projects.length === 0
              ? "Create a project first — a goal always lives inside one."
              : "New goal, or the + on any project in the sidebar."}
          </p>
        </div>
      )}

      {visible.map((goal) => {
        const project = projectById.get(goal.project_id);
        const { done, total } = goalProgress(tasks, goal.id);
        const overdue =
          goal.completed_at === null &&
          goal.target_date !== null &&
          goal.target_date < today;
        return (
          <div
            key={goal.id}
            className="goal-row"
            onClick={() => select({ type: "goal", goalId: goal.id })}
            role="button"
            tabIndex={0}
            onKeyDown={(e) =>
              e.key === "Enter" && select({ type: "goal", goalId: goal.id })
            }
          >
            <div className="goal-row-main">
              <div className="goal-row-name">
                {goal.name}
                {goal.completed_at !== null && (
                  <span className="goal-band-closed">Closed</span>
                )}
              </div>
              {goal.notes && (
                <div className="goal-row-outcome">{goal.notes}</div>
              )}
              {project && (
                <div className="goal-row-project">
                  <span
                    className="goal-row-project-dot"
                    style={{ background: project.color }}
                  />
                  {project.name}
                </div>
              )}
            </div>
            <div className="goal-row-right">
              <div className="goal-row-num">
                {total > 0 ? (
                  <>
                    {done}
                    <small> / {total}</small>
                  </>
                ) : (
                  <small>No tasks yet</small>
                )}
              </div>
              <div className="goal-row-bar">
                <span
                  className="goal-row-bar-fill"
                  style={{
                    transform: `scaleX(${total > 0 ? done / total : 0})`,
                  }}
                />
              </div>
              <div className={`goal-row-when ${overdue ? "late" : ""}`}>
                {goal.target_date ? dueLabel(goal.target_date) : "No target"}
              </div>
            </div>
          </div>
        );
      })}

      {creating && (
        <GoalDialog
          goal={null}
          projectId={null}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
