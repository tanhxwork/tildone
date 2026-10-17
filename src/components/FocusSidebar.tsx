import { useState } from "react";
import type { FocusGoal, FocusModel, MovingCard } from "../focusViews";
import { useStore } from "../store";
import type { Task } from "../types";
import { IconChevronDown, IconChevronRight } from "./Icons";
import { OwnerMark } from "./TaskRow";

// The sidebar's compass (spec focus-compass, mockup D): the goals that moved
// this week with the cards moving toward each, then the loose work, then the
// two rows that ask for attention. The model does the slicing; this only draws it.

const CARDS_PER_GOAL = 3;

/** One card line: marker, ref, title, who owns it. Opens the editor. `idle` is a
 *  stalled card: a muted dot instead of the pulse, and no owner. */
function CardLine({
  task,
  done,
  loose,
  idle = false,
}: {
  task: Task;
  done: boolean;
  loose: boolean;
  idle?: boolean;
}) {
  const openEditor = useStore((s) => s.openEditor);
  return (
    <button
      className={`focus-card ${loose ? "loose" : ""}`}
      data-focus-card={task.id}
      data-focus-stalled={idle ? task.id : undefined}
      onClick={(e) => {
        e.stopPropagation();
        openEditor(task.id);
      }}
    >
      {done ? (
        <span className="focus-tick" aria-hidden="true">✓</span>
      ) : idle ? (
        <span className="focus-idle" aria-hidden="true" />
      ) : (
        <span className="focus-pulse" aria-hidden="true" />
      )}
      <span className="focus-ref">{task.ref}</span>
      <span className="focus-card-title">{task.title}</span>
      {!idle &&
        (task.owner === "human" ? <span className="focus-you">you</span> : <OwnerMark task={task} />)}
    </button>
  );
}

function GoalBlock({ entry }: { entry: FocusGoal }) {
  const select = useStore((s) => s.select);
  const selected = useStore(
    (s) => s.selection.type === "goal" && s.selection.goalId === entry.goal.id,
  );
  const shown = entry.moving.slice(0, CARDS_PER_GOAL);
  const more = entry.moving.length - shown.length;
  const pct = entry.total > 0 ? (entry.done / entry.total) * 100 : 0;
  return (
    <div
      className={`focus-goal ${entry.finished ? "finished" : ""} ${selected ? "active" : ""}`}
      data-focus-goal={entry.goal.id}
      onClick={() => select({ type: "goal", goalId: entry.goal.id })}
    >
      <button className="focus-goal-head" aria-label={`Open goal ${entry.goal.name}`}>
        <span className="focus-goal-top">
          <span className="focus-goal-name">{entry.goal.name}</span>
          {entry.needsYou.length > 0 && (
            <span className="focus-you" data-focus-needs>{entry.needsYou.length}</span>
          )}
          <span className="focus-count">
            {entry.done}/{entry.total}
            {entry.finished ? " ✓" : ""}
          </span>
        </span>
        <span className="focus-goal-meta">
          <span className="focus-dot" style={{ background: entry.project.color }} />
          <span className="focus-goal-meta-text">
            {entry.project.name}
            {entry.meta ? ` · ${entry.meta}` : ""}
          </span>
        </span>
        <span className="goal-row-bar focus-bar">
          <span className="goal-row-bar-fill" style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
      </button>
      {shown.map((c: MovingCard) => (
        <CardLine key={c.task.id} task={c.task} done={c.task.status === "done"} loose={false} />
      ))}
      {more > 0 && <div className="focus-more">+{more} more</div>}
    </div>
  );
}

export function FocusSection({ model }: { model: FocusModel }) {
  const select = useStore((s) => s.select);
  const [stalledOpen, setStalledOpen] = useState(false);
  const goalCount = model.goals.length;
  return (
    <div className="sidebar-section focus-section">
        <div className="section-header">
          <span>Focus</span>
          {goalCount > 0 && (
            <span className="focus-header-n">
              {goalCount} {goalCount === 1 ? "goal" : "goals"}
            </span>
          )}
        </div>
        {goalCount === 0 ? (
          <p className="sidebar-hint" data-focus-empty>
            {model.loose.length === 0 ? "Nothing moved this week" : "No goal moved this week"}
          </p>
        ) : (
          model.goals.map((entry) => <GoalBlock key={entry.goal.id} entry={entry} />)
        )}

        {model.loose.length > 0 && (
          <>
            <div className="section-header focus-subheader">
              <span>Not in a goal</span>
              <span className="focus-header-n">{model.loose.length} moving</span>
            </div>
            {model.loose.map((c) => (
              <CardLine key={c.task.id} task={c.task} done={false} loose />
            ))}
          </>
        )}

        <div className="focus-divider" />
        <button
          className="nav-item focus-fold"
          data-nav="needs-you"
          onClick={() => select({ type: "mine" })}
        >
          <span className="nav-chevron-spacer focus-fold-chevron" aria-hidden="true">
            <IconChevronRight size={11} />
          </span>
          <span className="nav-label">Needs you</span>
          {model.needsYou > 0 && <span className="focus-you">{model.needsYou}</span>}
        </button>
        {model.stalled.length > 0 && (
          <>
            <button
              className="nav-item focus-fold quiet"
              data-nav="stalled"
              aria-expanded={stalledOpen}
              onClick={() => setStalledOpen(!stalledOpen)}
            >
              <span className="nav-chevron-spacer focus-fold-chevron" aria-hidden="true">
                {stalledOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
              </span>
              <span className="nav-label">Stalled · no move in 7d</span>
              <span className="nav-count">{model.stalled.length}</span>
            </button>
            {stalledOpen &&
              model.stalled.map((task) => (
                <CardLine key={task.id} task={task} done={false} loose idle />
              ))}
          </>
        )}
    </div>
  );
}
