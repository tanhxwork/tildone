import type { KeyboardEvent, ReactNode } from "react";
import type { FocusGoal, MovingCard, NeedsYouKind } from "../focusViews";
import { NOT_AVAILABLE, useOffline } from "../offline";
import { useStore } from "../store";
import type { Project, Task } from "../types";
import { IconBot } from "./Icons";

// The bands of the home view (spec focus-compass, mockup E): one per focus goal,
// then the loose-work band. Pure rendering of focusModel; GoalsView owns the model.

const MOVED_ROWS = 5;
const LOOSE_ROWS = 2;

/** An element that acts like a button without nesting buttons inside a row. */
function press(act: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: act,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter") act();
    },
  };
}

function Dot({ project }: { project: Project | null }) {
  return (
    <span
      className="compass-dot"
      style={project ? { background: project.color } : undefined}
    />
  );
}

const KIND_PILL: Record<NeedsYouKind, string> = {
  decide: "needs-approval",
  approve: "needs-approval",
  verify: "human-verify",
};

function Row({ task, children }: { task: Task; children: ReactNode }) {
  const openEditor = useStore((s) => s.openEditor);
  return (
    <div
      className="compass-row"
      data-compass-card={task.id}
      {...press(() => openEditor(task.id))}
    >
      {children}
    </div>
  );
}

/** Who the row's card waits on: an agent's bot icon with its status word, else "you". */
function Owner({ task, word }: { task: Task; word?: string }) {
  if (task.owner === "agent") {
    return (
      <span className="compass-own">
        <IconBot size={12} className="owner-glyph" />
        {word && ` ${word}`}
      </span>
    );
  }
  return <span className="compass-you">you</span>;
}

function StatusMark({ status }: { status: Task["status"] }) {
  if (status === "doing") return <span className="compass-pulse" />;
  if (status === "done") return <span className="compass-tick done">✓</span>;
  return <span className="compass-tick">○</span>;
}

const STATUS_WORD: Record<Task["status"], string> = {
  done: "done",
  doing: "doing",
  todo: "queued",
};

function NeedsRow({ card }: { card: MovingCard }) {
  return (
    <Row task={card.task}>
      <span className="compass-ref">{card.task.ref}</span>
      <span className="compass-card-title">{card.task.title}</span>
      {card.needsYou && (
        <span className={`state-pill ${KIND_PILL[card.needsYou]}`}>
          {card.needsYou}
        </span>
      )}
    </Row>
  );
}

function MovedRow({ card }: { card: MovingCard }) {
  const { task } = card;
  return (
    <Row task={task}>
      <StatusMark status={task.status} />
      <span className="compass-ref">{task.ref}</span>
      <span className="compass-card-title">{task.title}</span>
      <Owner task={task} word={STATUS_WORD[task.status]} />
    </Row>
  );
}

function GoalBandView({ entry }: { entry: FocusGoal }) {
  const select = useStore((s) => s.select);
  const setGoalCompleted = useStore((s) => s.setGoalCompleted);
  const offline = useOffline((s) => s.offline);
  const { goal, project, done, total, finished } = entry;
  const moved = entry.moving.filter((c) => c.needsYou === null);
  const shown = moved.slice(0, MOVED_ROWS);
  const open = () => select({ type: "goal", goalId: goal.id });
  return (
    <section className="compass-band" data-compass-goal={goal.id}>
      <div className="compass-top">
        <button className="compass-name" onClick={open}>
          {goal.name}
        </button>
        <span className="compass-proj">
          <Dot project={project} />
          {project.name}
        </span>
        <span className="compass-spacer" />
        {finished ? (
          <span className="compass-ok">
            {done} of {total} ✓
          </span>
        ) : (
          <span className="compass-count">
            {done} of {total}
          </span>
        )}
      </div>
      {entry.outcome && <div className="compass-outcome">{entry.outcome}</div>}
      <div className={`goal-row-bar compass-bar ${finished ? "finished" : ""}`}>
        <span
          className="goal-row-bar-fill"
          style={{ transform: `scaleX(${total > 0 ? done / total : 0})` }}
        />
      </div>
      {finished ? (
        <div className="compass-finish">
          <span>All cards done.</span>
          <button
            className="btn small"
            disabled={offline}
            title={offline ? NOT_AVAILABLE : undefined}
            onClick={() => void setGoalCompleted(goal.id, true)}
          >
            Close goal
          </button>
        </div>
      ) : (
        <>
          {entry.needsYou.length > 0 && (
            <>
              <div className="compass-lane">NEEDS YOU</div>
              {entry.needsYou.map((c) => (
                <NeedsRow key={c.task.id} card={c} />
              ))}
            </>
          )}
          {shown.length > 0 && (
            <>
              <div className="compass-lane">MOVED · NEXT</div>
              {shown.map((c) => (
                <MovedRow key={c.task.id} card={c} />
              ))}
              {moved.length > shown.length && (
                <div className="compass-row compass-more" {...press(open)}>
                  +{moved.length - shown.length} more
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function LooseBand({
  loose,
  byProject,
  movedNoGoal,
  movedThisWeek,
}: {
  loose: MovingCard[];
  byProject: { project: Project | null; count: number }[];
  movedNoGoal: number;
  movedThisWeek: number;
}) {
  const select = useStore((s) => s.select);
  if (movedNoGoal === 0) return null;
  return (
    <section className="compass-band" data-compass-loose>
      <div className="compass-top">
        <span className="compass-name warn">Moving with no goal</span>
        <span className="compass-spacer" />
        <span className="compass-count">
          {movedNoGoal} of {movedThisWeek} this week
        </span>
      </div>
      <div className="compass-chips">
        {byProject.map(({ project, count }) => {
          const label = (
            <>
              <Dot project={project} />
              {project ? project.name : "Inbox"}
              <span className="compass-chip-n">{count}</span>
            </>
          );
          return project ? (
            <button
              key={project.id}
              className="compass-chip"
              data-compass-chip={project.id}
              onClick={() =>
                select({ type: "ungoaled", projectId: project.id })
              }
            >
              {label}
            </button>
          ) : (
            <span
              key="inbox"
              className="compass-chip static"
              data-compass-chip="inbox"
            >
              {label}
            </span>
          );
        })}
      </div>
      {loose.slice(0, LOOSE_ROWS).map((c) => (
        <Row key={c.task.id} task={c.task}>
          <span className="compass-pulse" />
          <span className="compass-ref">{c.task.ref}</span>
          <span className="compass-card-title">{c.task.title}</span>
          <Owner task={c.task} />
        </Row>
      ))}
      {loose.length > LOOSE_ROWS && (
        <div className="compass-more-text">
          +{loose.length - LOOSE_ROWS} more doing
        </div>
      )}
    </section>
  );
}

export function GoalBands({ goals }: { goals: FocusGoal[] }) {
  return (
    <>
      {goals.map((entry) => (
        <GoalBandView key={entry.goal.id} entry={entry} />
      ))}
    </>
  );
}
