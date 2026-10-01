import { useMemo, useState, type ReactNode } from "react";
import { format, parseISO } from "date-fns";
import {
  decisionTone,
  defaultObserveId,
  followUpTask,
  meterSquares,
  observeCounts,
  observeGroups,
  observeState,
  yesSummary,
  type ObserveState,
} from "../observeViews";
import { lineageTask } from "../ownerViews";
import { useStore } from "../store";
import type { ObserveCard, ObserveLogLine, Project } from "../types";
import { todayStr } from "../utils/dates";
import { TildoneMark } from "./Brand";
import { IconChevronDown, IconChevronRight } from "./Icons";
import { ObserveDialog } from "./ObserveDialog";

// The Observe page: observe cards grouped Due now / Waiting / Observed on the
// left, the selected card's detail on the right. Sessions append log lines over
// MCP (log_observation); the user decides here. The mockup is
// docs/artifacts/2026-10-01-observe-section.html, variant "A + C".
export function ObserveView() {
  const { observeCards, projects, selection } = useStore();
  const today = todayStr();
  const groups = useMemo(() => observeGroups(observeCards, today), [observeCards, today]);
  const counts = useMemo(() => observeCounts(observeCards, today), [observeCards, today]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const selected =
    observeCards.find((c) => c.task.id === selectedId) ??
    (selection.type === "observe"
      ? observeCards.find((c) => c.task.id === selection.cardId)
      : undefined) ??
    observeCards.find((c) => c.task.id === defaultObserveId(groups)) ??
    null;
  const projectOf = (card: ObserveCard) => projects.find((p) => p.id === card.task.project_id);

  const sections: { key: ObserveState; title: string; cards: ObserveCard[] }[] = [
    { key: "due", title: "Due now", cards: groups.due },
    { key: "waiting", title: "Waiting", cards: groups.waiting },
    { key: "observed", title: "Observed", cards: groups.observed },
  ];

  return (
    <div className="observe-view">
      <div className="observe-toolbar">
        <span className="observe-sub">
          {counts.due} due · {counts.waiting} waiting · {counts.observedThisMonth} observed this
          month
        </span>
        <button className="btn small" onClick={() => setCreating(true)}>
          New observation
        </button>
      </div>

      {observeCards.length === 0 ? (
        <div className="empty-state">
          <TildoneMark width={36} className="empty-mark" />
          <p className="empty-title">Nothing under observation</p>
          <p className="empty-hint">
            New observation, or create_observation from any agent session.
          </p>
        </div>
      ) : (
        <div className="observe-split">
          <div className="observe-list">
            {sections.map(
              (section) =>
                section.cards.length > 0 && (
                  <section key={section.key} data-observe-group={section.key}>
                    <div className="observe-gtitle">
                      {section.title} <span className="observe-gcount">{section.cards.length}</span>
                    </div>
                    {section.cards.map((card) => (
                      <ObserveRow
                        key={card.task.id}
                        card={card}
                        state={section.key}
                        project={projectOf(card)}
                        selected={card.task.id === selected?.task.id}
                        onSelect={() => setSelectedId(card.task.id)}
                      />
                    ))}
                  </section>
                ),
            )}
          </div>
          {selected && (
            <ObserveDetail
              key={selected.task.id}
              card={selected}
              state={observeState(selected, today)}
              project={projectOf(selected)}
            />
          )}
        </div>
      )}

      {creating && (
        <ObserveDialog onClose={() => setCreating(false)} onCreated={(id) => setSelectedId(id)} />
      )}
    </div>
  );
}

function ObserveRow({
  card,
  state,
  project,
  selected,
  onSelect,
}: {
  card: ObserveCard;
  state: ObserveState;
  project: Project | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const eye = state === "due" ? "due" : state === "observed" && card.decision === 0 ? "kept" : "";
  const logged = card.log.length;
  const followUp = state === "observed" ? followUpTask(card, tasks) : null;
  return (
    <div
      className={`observe-row ${state} ${selected ? "selected" : ""}`}
      data-observe-id={card.task.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
    >
      <span className={`observe-eye ${eye}`} aria-hidden="true" />
      <span className="observe-q">{card.task.title}</span>
      {state === "observed" ? (
        <DecisionPill card={card} />
      ) : (
        <span className="observe-trig">
          <Trigger card={card} due={state === "due"} />
        </span>
      )}
      <div className="observe-meta">
        {state === "observed" ? (
          <span>
            {card.task.completed_at && shortDate(card.task.completed_at)}
            {followUp ? (
              <>
                {" "}
                · follow-up <span className="observe-ref">{followUp.ref}</span>
              </>
            ) : (
              yesSummary(card.log) && ` · ${yesSummary(card.log)}`
            )}
          </span>
        ) : (
          <>
            <span className="observe-ref">{card.task.ref}</span>
            <span>
              {project?.name ?? "Inbox"} ·{" "}
              {logged === 0
                ? "nothing logged yet"
                : `${logged} session${logged === 1 ? "" : "s"} logged`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** "Oct 3" for a date trigger; a meter of up to ten squares plus "4/10" for a count. */
function Trigger({ card, due }: { card: ObserveCard; due: boolean }) {
  if (card.trigger_date !== null) return <>{dayLabel(card.trigger_date)}</>;
  const { total, filled } = meterSquares(card);
  return (
    <>
      <span className={`observe-meter ${due ? "due" : ""}`} aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={i < filled ? "f" : ""} />
        ))}
      </span>{" "}
      {card.log.length}/{card.trigger_count}
    </>
  );
}

function DecisionPill({ card, withDate = false }: { card: ObserveCard; withDate?: boolean }) {
  if (card.decision === null) return null;
  const option = card.options[card.decision];
  const tone = decisionTone(card.decision, card.options.length);
  return (
    <span className={`observe-pill ${tone}`}>
      {option?.label ?? "Decided"}
      {withDate && card.task.completed_at && ` · ${shortDate(card.task.completed_at)}`}
    </span>
  );
}

function ObserveDetail({
  card,
  state,
  project,
}: {
  card: ObserveCard;
  state: ObserveState;
  project: Project | undefined;
}) {
  const { tasks, observeCards, decideObservation, watchMore, openFollowUp } = useStore();
  const [logOpen, setLogOpen] = useState(false);
  const origin = lineageTask(card.task, tasks, observeCards);
  const summary = yesSummary(card.log);
  const unit = card.trigger_unit || "checks";
  const progress = `${card.log.length}/${card.trigger_count} ${unit}`;

  let pill = null;
  if (state === "observed") {
    pill = <DecisionPill card={card} withDate />;
  } else if (state === "due") {
    pill = (
      <span className="observe-pill due">
        Due · {card.trigger_date !== null ? `since ${dayLabel(card.trigger_date)}` : progress}
      </span>
    );
  } else {
    pill = (
      <span className="observe-pill">
        Waiting · {card.trigger_date !== null ? `until ${dayLabel(card.trigger_date)}` : progress}
      </span>
    );
  }

  const checkAndLog = (
    <>
      <div className="observe-blk">
        <h4>HOW TO CHECK, EACH SESSION</h4>
        <div className="observe-term">{card.check_text}</div>
      </div>
      <div className="observe-blk">
        <h4>
          OBSERVATION LOG · {card.log.length}
          {card.trigger_count !== null && ` OF ${card.trigger_count}`}
        </h4>
        {card.log.length === 0 ? (
          <p className="observe-empty">Nothing logged yet. Any session can add a line.</p>
        ) : (
          <LogTable log={card.log} />
        )}
        {summary && <div className="observe-summary">{summary}.</div>}
      </div>
    </>
  );

  return (
    <div className="observe-det" data-observe-detail={card.task.id}>
      <div className="observe-det-head">
        <span className="observe-ref">{card.task.ref}</span>
        {pill}
        <span className="observe-proj">
          {project?.name ?? "Inbox"}
          {origin && ` · from ${origin.ref}`}
        </span>
      </div>
      <h3 className="observe-question">{card.task.title}</h3>
      {card.task.notes && <p className="observe-why">{card.task.notes}</p>}

      {state === "observed" ? (
        <ObservedBody
          card={card}
          summary={summary}
          logOpen={logOpen}
          onToggleLog={() => setLogOpen((v) => !v)}
          onFollowUp={() => void openFollowUp(card.task.id)}
        >
          {checkAndLog}
        </ObservedBody>
      ) : (
        checkAndLog
      )}

      {state === "due" && (
        <div className="observe-blk">
          <h4>DECIDE</h4>
          <div
            className="observe-dec"
            style={{ gridTemplateColumns: `repeat(${card.options.length}, 1fr)` }}
          >
            {card.options.map((option, i) => (
              <button
                key={i}
                type="button"
                className="observe-opt"
                onClick={() => void decideObservation(card.task.id, i)}
              >
                <b>{option.label}</b>
                {option.detail && <span>{option.detail}</span>}
              </button>
            ))}
          </div>
          <div className="observe-actions">
            <button className="btn small" onClick={() => void watchMore(card.task.id)}>
              {card.trigger_date !== null ? "Watch 1 more week" : "Watch 3 more"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ObservedBody({
  card,
  summary,
  logOpen,
  onToggleLog,
  onFollowUp,
  children,
}: {
  card: ObserveCard;
  summary: string | null;
  logOpen: boolean;
  onToggleLog: () => void;
  onFollowUp: () => void;
  children: ReactNode;
}) {
  const tasks = useStore((s) => s.tasks);
  const followUp = followUpTask(card, tasks);
  const option = card.decision !== null ? card.options[card.decision] : undefined;
  const n = card.log.length;
  return (
    <>
      <div className="observe-decision">
        <b>Decision:</b> {option?.label ?? "Decided"}.{summary && ` ${summary}.`}
      </div>
      <div className="observe-followup">
        {followUp ? (
          <span>
            Follow-up <span className="observe-ref">{followUp.ref}</span> opened from this
            decision
          </span>
        ) : (
          <button className="btn small" onClick={onFollowUp}>
            Open follow-up task
          </button>
        )}
      </div>
      <button
        type="button"
        className="observe-toggle"
        aria-expanded={logOpen}
        onClick={onToggleLog}
      >
        {logOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        {n} log line{n === 1 ? "" : "s"}
      </button>
      {logOpen && children}
    </>
  );
}

function LogTable({ log }: { log: ObserveLogLine[] }) {
  const verdicts = log.some((l) => l.verdict !== null);
  return (
    <table className="observe-log">
      <tbody>
        {log.map((line) => (
          <tr key={line.id}>
            <td className="observe-log-date">{shortDate(line.at)}</td>
            <td className="observe-log-session">{line.session_id?.slice(0, 4) ?? ""}</td>
            <td>{line.text}</td>
            {verdicts && (
              <td className={line.verdict === null ? "" : line.verdict ? "yes" : "no"}>
                {line.verdict === null ? "" : line.verdict ? "yes" : "no"}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "Oct 3" from a stored timestamp, in local time. */
function shortDate(iso: string): string {
  return format(new Date(iso), "MMM d");
}

/** "Oct 3" from a YYYY-MM-DD trigger date. */
function dayLabel(day: string): string {
  return format(parseISO(day), "MMM d");
}
