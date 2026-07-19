import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { openUrl } from "@tauri-apps/plugin-opener";
import { format } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { paneHasFocus, usePaneStore } from "../paneStore";
import { DONE_WINDOW_LIMIT, doneBoardWindow, visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Project, Status, Tag, Task, TaskLink } from "../types";
import {
  LINK_KIND_COLORS,
  LINK_KIND_LABELS,
  RESERVED_TAG_LABELS,
  STATUSES,
  STATUS_LABELS,
  asLinkKind,
  isVerifyStep,
  verifyStepLabel,
} from "../types";
import { todayStr } from "../utils/dates";
import { cardPresence } from "../utils/presence";
import { latestLinkPerKind } from "../utils/links";
import { taskRefLabel } from "../utils/ref";
import type { Subtask } from "../types";
import { CompletionFlourish, UnseenMark } from "./Brand";
import { IconAlert, IconCheck, IconChecklist, IconMessage, LinkKindIcon } from "./Icons";
import { prChip } from "./prChip";
import { ProjectGlyph } from "./ProjectGlyph";
import { TaskMeta, reservedState } from "./TaskRow";
import { AgentPresence } from "../agents";

type Columns = Record<Status, number[]>;

interface BoardModel {
  columns: Columns;
  /** Where the "Working" divider falls inside In Progress: the number of
   * needs-review cards grouped above it. 0 means no review section. */
  doingReviewCount: number;
  /** Where the "Earlier" divider falls inside the Done column. */
  doneTodayCount: number;
  /** Done tasks not on the board — the count behind the "in Completed" link. */
  doneHidden: number;
}

const byPosition = (a: Task, b: Task) => a.position - b.position || a.id - b.id;

function computeColumns(tasks: Task[], tags: Tag[], today: string): BoardModel {
  const columns: Columns = { todo: [], doing: [], done: [] };
  columns.todo = tasks.filter((t) => t.status === "todo").sort(byPosition).map((t) => t.id);
  // In Progress groups the review queue above the rest, so "what is waiting on
  // you" is a place on the board rather than a pill to hunt for. This is a
  // *display* order with a split index — exactly what the Done column already
  // does with Today/Earlier below. Nothing here writes `position`: the two
  // halves stay sorted by position within themselves, and the section is a tag
  // being read, never a slot being assigned.
  //
  // Precedence follows reservedState: blocked outranks needs-review, so a task
  // carrying both stays under Working and keeps its alarm rather than being
  // filed into a queue.
  const doing = tasks.filter((t) => t.status === "doing").sort(byPosition);
  const review = doing.filter((t) => reservedState(t, tags) === "needs-review");
  const working = doing.filter((t) => reservedState(t, tags) !== "needs-review");
  columns.doing = [...review, ...working].map((t) => t.id);
  // Done is not the whole pile: it is the recent window (today + backfill to the
  // limit), newest first. The rest lives in Completed.
  const w = doneBoardWindow(tasks.filter((t) => t.status === "done"), today);
  columns.done = [...w.today, ...w.earlier].map((t) => t.id);
  return {
    columns,
    doingReviewCount: review.length,
    doneTodayCount: w.today.length,
    doneHidden: w.hiddenCount,
  };
}

export function Kanban() {
  const paneOpenTaskId = usePaneStore((s) => s.target?.taskId ?? null);
  const {
    tasks,
    tags,
    selection,
    search,
    activeTagIds,
    priorityFilter,
    applyDrag,
    openEditor,
    select,
  } = useStore();

  // The board always shows the Done column, independent of the list-view toggle.
  const visible = useMemo(
    () =>
      visibleTasks(tasks, selection, {
        search,
        activeTagIds,
        priorityFilter,
        showCompleted: true,
      }),
    [tasks, selection, search, activeTagIds, priorityFilter],
  );

  const taskById = useMemo(() => new Map(visible.map((t) => [t.id, t])), [visible]);

  const [columns, setColumns] = useState<Columns>({ todo: [], doing: [], done: [] });
  const [reviewCount, setReviewCount] = useState(0);
  const [doneMeta, setDoneMeta] = useState<{ today: number; hidden: number }>({
    today: 0,
    hidden: 0,
  });
  const [activeId, setActiveId] = useState<number | null>(null);
  // A card that just landed in Done, to overlay the wave-to-check flourish on.
  // `key` bumps per completion so re-completing the same card replays it.
  const [celebrate, setCelebrate] = useState<{ id: number; key: number } | null>(null);
  const dragFromStatus = useRef<Status | null>(null);
  const flourishSeq = useRef(0);
  // A card whose unseen mark is settling into its check, because you just came
  // back from reading it. Same shape as `celebrate`: the store clears the fact
  // immediately, so this keeps the mark mounted long enough to finish drawing.
  const [settle, setSettle] = useState<{ id: number; key: number } | null>(null);
  const settleSeq = useRef(0);

  useEffect(() => {
    if (activeId === null) {
      const model = computeColumns(visible, tags, todayStr());
      setColumns(model.columns);
      setReviewCount(model.doingReviewCount);
      setDoneMeta({ today: model.doneTodayCount, hidden: model.doneHidden });
    }
  }, [visible, tags, activeId]);

  // Acknowledge on the way out, not on the way in: the editor covers the card,
  // so a mark cleared on open would settle where you cannot see it. Any move off
  // a task counts — closing the editor, or jumping straight to another card.
  const editingTaskId = useStore((s) => s.editingTaskId);
  const markSeen = useStore((s) => s.markSeen);
  const wasEditing = useRef<number | null>(null);
  useEffect(() => {
    const left = wasEditing.current;
    wasEditing.current = editingTaskId;
    if (left === null || left === editingTaskId) return;
    if (tasks.find((t) => t.id === left)?.unseen_at == null) return;
    settleSeq.current += 1;
    setSettle({ id: left, key: settleSeq.current });
    void markSeen(left);
  }, [editingTaskId, tasks, markSeen]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function findColumn(id: UniqueIdentifier): Status | null {
    if (typeof id === "string" && STATUSES.includes(id as Status)) {
      return id as Status;
    }
    for (const status of STATUSES) {
      if (columns[status].includes(id as number)) return status;
    }
    return null;
  }

  function onDragStart(event: DragStartEvent) {
    const id = event.active.id as number;
    // Remember where the card started so onDragEnd can tell a genuine
    // completion (moved into Done) from a reorder within Done.
    dragFromStatus.current = taskById.get(id)?.status ?? null;
    setActiveId(id);
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const from = findColumn(active.id);
    const to = findColumn(over.id);
    if (!from || !to || from === to) return;

    setColumns((cols) => {
      const fromIds = cols[from].filter((id) => id !== active.id);
      const toIds = [...cols[to]];
      const overIndex = toIds.indexOf(over.id as number);
      const insertAt = overIndex >= 0 ? overIndex : toIds.length;
      toIds.splice(insertAt, 0, active.id as number);
      return { ...cols, [from]: fromIds, [to]: toIds };
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    let next = columns;
    if (over) {
      const from = findColumn(active.id);
      const to = findColumn(over.id);
      if (from && to && from === to) {
        const ids = columns[from];
        const oldIndex = ids.indexOf(active.id as number);
        const overIndex = ids.indexOf(over.id as number);
        if (oldIndex >= 0 && overIndex >= 0 && oldIndex !== overIndex) {
          next = { ...columns, [from]: arrayMove(ids, oldIndex, overIndex) };
          setColumns(next);
        }
      }
    }
    // Fire the flourish only on a real completion: the card ended in Done and
    // did not start there.
    const landedId = active.id as number;
    const landedDone = next.done.includes(landedId);
    if (landedDone && dragFromStatus.current !== "done") {
      flourishSeq.current += 1;
      setCelebrate({ id: landedId, key: flourishSeq.current });
    }
    dragFromStatus.current = null;

    setActiveId(null);
    void applyDrag(active.id as number, next);
  }

  const activeTask = activeId !== null ? taskById.get(activeId) : undefined;
  // Keep the drag overlay in the same form as the resting card: today's done
  // cards (the first `doneMeta.today` in the Done column) drag as full, not compact.
  const activeFull =
    activeId !== null && columns.done.slice(0, doneMeta.today).includes(activeId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className={paneOpenTaskId !== null ? "board pane-focus" : "board"}>
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            ids={columns[status]}
            taskById={taskById}
            onOpen={openEditor}
            celebrate={celebrate}
            onFlourishDone={() => setCelebrate(null)}
            settle={settle}
            onSettleDone={() => setSettle(null)}
            reviewCount={reviewCount}
            doneTodayCount={doneMeta.today}
            doneHidden={doneMeta.hidden}
            onSeeAll={() => select({ type: "completed" })}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? <CardContent task={activeTask} overlay full={activeFull} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  status,
  ids,
  taskById,
  onOpen,
  celebrate,
  onFlourishDone,
  settle,
  onSettleDone,
  reviewCount,
  doneTodayCount,
  doneHidden,
  onSeeAll,
}: {
  status: Status;
  ids: number[];
  taskById: Map<number, Task>;
  onOpen: (id: number) => void;
  celebrate: { id: number; key: number } | null;
  onFlourishDone: () => void;
  settle: { id: number; key: number } | null;
  onSettleDone: () => void;
  reviewCount: number;
  doneTodayCount: number;
  doneHidden: number;
  onSeeAll: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: status });
  const isDone = status === "done";
  const isDoing = status === "doing";

  // `full` keeps a done card in its full form instead of collapsing to one line —
  // used for today's completions, which are still fresh enough to want the detail.
  const card = (id: number, full = false, inSection = false) => {
    const task = taskById.get(id);
    return task ? (
      <Card
        key={id}
        task={task}
        full={full}
        inSection={inSection}
        onOpen={onOpen}
        flourishKey={celebrate?.id === id ? celebrate.key : null}
        onFlourishDone={onFlourishDone}
        settleKey={settle?.id === id ? settle.key : null}
        onSettleDone={onSettleDone}
      />
    ) : null;
  };

  // The Done column groups its window into Today / Earlier; the split index is where
  // the backfilled older cards begin. Other columns render a flat list.
  const todayCount = Math.min(doneTodayCount, ids.length);
  const hasEarlier = isDone && ids.length > todayCount;

  // In Progress groups the review queue above the rest, on the same split-index
  // shape. The dividers only appear when there is something on both sides: a
  // column that is all review needs no "Working" heading over nothing, and a
  // column with none needs no section at all.
  const reviewSplit = Math.min(reviewCount, ids.length);
  const hasReview = isDoing && reviewSplit > 0;
  const hasWorking = isDoing && ids.length > reviewSplit;
  // While the session pane is open, the board strip shows only the jumped
  // card's column — the whole board can't fit beside a ¾ pane, and the
  // pane's entire point is "this card, that session, side by side"
  // (user review finding, 2026-07-19).
  const paneTaskId = usePaneStore((s) => s.target?.taskId ?? null);
  const holdsPaneSrc = paneTaskId !== null && ids.includes(paneTaskId);

  return (
    <div className={holdsPaneSrc ? "board-column pane-src-col" : "board-column"}>
      <div className={`column-header ${status}`}>
        <span className="column-dot" />
        {STATUS_LABELS[status]}
        <span className="column-count">{ids.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {isDone ? (
            <>
              {todayCount > 0 && <div className="col-divider">Today</div>}
              {ids.slice(0, todayCount).map((id) => card(id, true))}
              {hasEarlier && (
                <div className="col-divider">
                  Earlier
                  <span className="backfill-tag">fills to {DONE_WINDOW_LIMIT}</span>
                </div>
              )}
              {ids.slice(todayCount).map((id) => card(id))}
            </>
          ) : hasReview ? (
            <>
              <div className="col-divider review-queue">Needs review · {reviewSplit}</div>
              {/* The heading says the state, so the cards under it stop repeating
                  it — that is the whole reason this is a section. */}
              {ids.slice(0, reviewSplit).map((id) => card(id, false, true))}
              {hasWorking && <div className="col-divider">Working</div>}
              {ids.slice(reviewSplit).map((id) => card(id))}
            </>
          ) : (
            ids.map((id) => card(id))
          )}
          {ids.length === 0 && (
            <div className="column-empty">
              {isDone ? "Nothing finished yet" : "Drop tasks here"}
            </div>
          )}
        </div>
      </SortableContext>
      {isDone && doneHidden > 0 && (
        <button type="button" className="see-all" onClick={onSeeAll}>
          {doneHidden} more in Completed →
        </button>
      )}
    </div>
  );
}

function Card({
  task,
  full,
  inSection,
  onOpen,
  flourishKey,
  onFlourishDone,
  settleKey,
  onSettleDone,
}: {
  task: Task;
  full?: boolean;
  /** Rendered under a divider that already names its state, so the card drops
   *  the redundant pill. */
  inSection?: boolean;
  onOpen: (id: number) => void;
  flourishKey: number | null;
  onFlourishDone: () => void;
  settleKey: number | null;
  onSettleDone: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : undefined,
      }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(task.id)}
    >
      <CardContent
        task={task}
        full={full}
        inSection={inSection}
        flourishKey={flourishKey}
        onFlourishDone={onFlourishDone}
        settleKey={settleKey}
        onSettleDone={onSettleDone}
      />
    </div>
  );
}

/** The short label a card chip shows inline: a PR number or a 7-char SHA. Long
 *  names (branch, worktree) are icon-only, so this returns null for them. */
function cardLinkShort(link: TaskLink): string | null {
  const kind = asLinkKind(link.kind);
  if (kind === "pr") {
    const m = link.label.match(/\d+/);
    return m ? `#${m[0]}` : null;
  }
  if (kind === "commit") {
    const m = link.label.match(/[0-9a-f]{7,40}/i);
    return (m ? m[0] : link.label).slice(0, 7);
  }
  return null;
}

/** The door chip's label: "PR #55" when a number is findable, else "PR". */
function prDoorLabel(link: TaskLink): string {
  const short = cardLinkShort(link);
  return short ? `PR ${short}` : "PR";
}

/** The board's verify surface: the counter opens this anchored popover so the
 *  steps can be read and ticked without opening the editor. A tick here is the
 *  same store write the editor makes. Every pointer event stops at the popover —
 *  it must neither drag the card under it nor open that card's editor. */
function VerifyPopover({
  steps,
  prLink,
  onClose,
}: {
  steps: Subtask[];
  prLink: TaskLink | null;
  onClose: () => void;
}) {
  const toggleSubtask = useStore((s) => s.toggleSubtask);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The counter button stops its own pointerdown, so a click on it never
    // reaches this listener — toggling stays a clean open/close.
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      // Esc inside the session pane is the TUI's cancel key, not ours.
      if (paneHasFocus()) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const done = steps.filter((s) => s.done).length;
  // Same review-door as the card strip, so a stamped PR carries its merge badge
  // here too (TIL-88).
  const pr = prLink ? prChip(prLink) : null;
  return (
    <div
      ref={ref}
      className="verify-popover"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="verify-popover-head">
        Verify
        <span className="verify-popover-count">
          {done} of {steps.length}
        </span>
      </div>
      <ul className="verify-list">
        {steps.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={`verify-item ${s.done ? "done" : ""}`}
              onClick={() => void toggleSubtask(s.id)}
            >
              <span className="verify-box">{s.done && <IconCheck size={10} />}</span>
              <span className="verify-text">{verifyStepLabel(s)}</span>
            </button>
          </li>
        ))}
      </ul>
      {prLink && (
        <button
          type="button"
          className="card-link review-door"
          title={`${LINK_KIND_LABELS.pr} · ${prLink.label}${pr ? ` · ${pr.title}` : ""} · ${prLink.url}`}
          onClick={() => void openUrl(prLink.url)}
        >
          <LinkKindIcon kind="pr" size={13} />
          {prDoorLabel(prLink)}
          {pr?.suffix}
        </button>
      )}
    </div>
  );
}

function CardContent({
  task,
  overlay,
  full,
  inSection,
  flourishKey = null,
  onFlourishDone,
  settleKey = null,
  onSettleDone,
}: {
  task: Task;
  overlay?: boolean;
  full?: boolean;
  inSection?: boolean;
  flourishKey?: number | null;
  onFlourishDone?: () => void;
  settleKey?: number | null;
  onSettleDone?: () => void;
}) {
  const subtasks = useStore((s) => s.subtasks);
  const tags = useStore((s) => s.tags);
  const links = useStore((s) => s.links);
  const projects = useStore((s) => s.projects);
  const selection = useStore((s) => s.selection);
  const commentCount = useStore((s) => s.commentCounts[task.id] ?? 0);
  const paneTaskId = usePaneStore((s) => s.target?.taskId ?? null);
  const mine = subtasks.filter((s) => s.task_id === task.id);
  const cardLinks = links[task.id] ?? [];
  const state = reservedState(task, tags);
  // Verify steps ("verify: …" subtasks) leave the build checklist only while the
  // task is actually in review — the tag coming off mid-flight folds them back
  // into plain subtasks rather than orphaning them out of every count.
  const inReview = state === "needs-review";
  const verifySteps = inReview ? mine.filter(isVerifyStep) : [];
  const build = inReview ? mine.filter((s) => !isVerifyStep(s)) : mine;
  const done = build.filter((s) => s.done).length;
  const verifyDone = verifySteps.filter((s) => s.done).length;
  const prLink =
    latestLinkPerKind(cardLinks).find(({ link }) => asLinkKind(link.kind) === "pr")?.link ??
    null;
  const [verifyOpen, setVerifyOpen] = useState(false);
  // The mark outlives the fact by exactly one animation: `settling` is set as you
  // leave the card, markSeen clears unseen_at immediately, and the check needs to
  // still be on screen to land. Never on the drag overlay — a card in your hand
  // is one you have plainly seen.
  const settling = settleKey !== null;
  const showMark = !overlay && (task.unseen_at !== null || settling);
  // Inside a single-project board (or the Inbox), every card carries the same
  // project — the chip is noise. Match the list view's rule (TaskList.tsx).
  const showProject = selection.type !== "project" && selection.type !== "inbox";
  const project =
    task.project_id !== null ? projects.find((p) => p.id === task.project_id) : undefined;

  // A finished card is history, not work in flight: collapse it to one line —
  // check, strikethrough title, project dot, completion time. The full meta
  // (subtask bar, due date, priority, tags) only matters while a task is live —
  // except for today's completions (`full`), which stay full so the day's work
  // keeps its detail; older done cards still collapse.
  if (task.status === "done" && !full) {
    const time = task.completed_at ? format(new Date(task.completed_at), "h:mm a") : "";
    return (
      <div className={["board-card", "done", "compact", overlay ? "overlay" : ""].filter(Boolean).join(" ")}>
        <span className="done-check" aria-hidden="true">
          <IconCheck size={10} />
        </span>
        <span className="done-title">
          <span className="card-id" aria-hidden="true">{taskRefLabel(task)}</span> {task.title}
        </span>
        <span className="done-meta">
          {/* A collapsed done card is history — except when it still carries an
              open loop. `needs-landing` (an unmerged PR) earns the one pill the
              compact form otherwise omits, so a done card can't hide a branch
              that never landed (TIL-84). */}
          {state && (
            <span className={`state-pill ${state}`}>{RESERVED_TAG_LABELS[state]}</span>
          )}
          {showProject && project && (
            <span className="project-label" title={project.name}>
              <ProjectGlyph project={project} size={12} />
            </span>
          )}
          {time && <span className="done-time">{time}</span>}
        </span>
        {flourishKey !== null && <CompletionFlourish key={flourishKey} onDone={onFlourishDone} />}
      </div>
    );
  }

  // Today's done cards reach here (`full`): the full layout, but with the `done`
  // class so the title strikes through and the subtask bar goes green — the same
  // done vocabulary as the compact card, just not collapsed.
  return (
    <div
      // The session pane centers this card in the board strip by this id and
      // rings it while its session is attached (spec 2026-07-19).
      data-task-id={task.id}
      className={[
        "board-card",
        task.status === "done" ? "done" : "",
        overlay ? "overlay" : "",
        state ? `state-${state}` : "",
        // Yields the top-right corner to the mark, so it never lands on the title.
        showMark ? "unseen" : "",
        paneTaskId === task.id ? "pane-src" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* An agent changed this and you have not looked yet. `settling` outlives
          the fact by one animation: markSeen has already cleared unseen_at, and
          this is the check landing as you come back to the board. */}
      {showMark && (
        <UnseenMark key={settleKey ?? "unseen"} settling={settling} onDone={onSettleDone} />
      )}
      <span className="card-title">
        <span className="card-id" aria-hidden="true">{taskRefLabel(task)}</span> {task.title}
      </span>
      {(build.length > 0 || verifySteps.length > 0) && (
        <span
          className="card-progress"
          title={build.length > 0 ? `${done} of ${build.length} subtasks done` : undefined}
        >
          {build.length > 0 && (
            <>
              <span className="card-progress-bar">
                <span
                  className="card-progress-fill"
                  style={{ transform: `scaleX(${done / build.length})` }}
                />
              </span>
              <span className="card-progress-count">
                {done}/{build.length}
              </span>
            </>
          )}
          {verifySteps.length > 0 && (
            // The card's whole verify surface: how much checking awaits, and the
            // door to it. stopPropagation twins card-link's — the counter must
            // neither start a drag nor open the editor.
            <span className="card-verify-anchor">
              <button
                type="button"
                className="card-verify-count"
                title={`${verifyDone} of ${verifySteps.length} verify steps checked`}
                aria-expanded={verifyOpen}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setVerifyOpen((v) => !v);
                }}
              >
                <IconChecklist size={12} />
                {verifyDone}/{verifySteps.length}
              </button>
              {verifyOpen && !overlay && (
                <VerifyPopover
                  steps={verifySteps}
                  prLink={prLink}
                  onClose={() => setVerifyOpen(false)}
                />
              )}
            </span>
          )}
        </span>
      )}
      {inSection && !prLink && verifySteps.length === 0 && (
        // The protocol violation, stated where it matters: this card asked for
        // review and brought nothing to review. Words in the warn ink, not a
        // tint — `blocked` keeps its monopoly on alarm fills.
        <span className="card-review-missing">
          <IconAlert size={12} />
          In review with no PR and no verify steps
        </span>
      )}
      {commentCount > 0 && (
        <span
          className="card-comments"
          title={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
          aria-label={`${commentCount} comment${commentCount === 1 ? "" : "s"}`}
        >
          <IconMessage size={12} />
          {commentCount}
        </span>
      )}
      <TaskMeta task={task} hideStatus hideState={inSection} />
      <CardProvenance
        task={task}
        project={showProject ? project : undefined}
        links={cardLinks}
        door={inSection}
      />
      {flourishKey !== null && (
        <CompletionFlourish key={flourishKey} onDone={onFlourishDone} />
      )}
    </div>
  );
}

/**
 * The card's provenance footer: project · repo links · which agent last touched it.
 *
 * Separated from the classification row (state / priority / tags) by a hairline so
 * the two never blur together — human labels above, tooling facts below. Renders
 * nothing when the task has no project, no links, and no recent agent presence.
 */
function CardProvenance({
  task,
  project,
  links,
  door,
}: {
  task: Task;
  project: Project | undefined;
  links: TaskLink[];
  /** Inside the review section the latest PR chip steps up to a bordered "door"
   *  with its number spelled out — review starts at the diff, so the way in must
   *  not need hunting for. Everywhere else the chip keeps its compact form. */
  door?: boolean;
}) {
  const live = useStore((s) => s.live);
  const fallback = useStore((s) => s.presence);
  const entry = cardPresence(task.id, live, fallback);
  // File evidence lives in the task detail's Evidence section, never as a card
  // chip — the card carries only the git-workflow "state of play".
  const chipLinks = links.filter((l) => asLinkKind(l.kind) !== "file");
  if (!project && chipLinks.length === 0 && !entry) return null;
  // The agent's worktree, from its claim. Suppressed when the task already carries a
  // hand-attached worktree link, which is a real URL and therefore strictly more
  // useful than a bare name.
  const branch =
    entry?.branch && !links.some((l) => asLinkKind(l.kind) === "worktree")
      ? entry.branch
      : null;
  // Every name-bearing chip renders icon-only in the strip (a long branch name
  // used to wrap it into three ragged rows); the names come back complete — never
  // truncated, no ellipsis — in a quiet overlay row while the card is hovered or
  // focused. Overlay, not growth: cards below must not shift as the pointer
  // sweeps the column.
  const revealNames: { kind: string; name: string }[] = [
    ...(branch ? [{ kind: "worktree", name: branch }] : []),
    ...links
      .filter((l) => {
        const kind = asLinkKind(l.kind);
        return kind === "branch" || kind === "worktree";
      })
      .map((l) => ({ kind: asLinkKind(l.kind), name: l.label })),
  ];
  return (
    <>
    <span className="card-provenance">
      {project && (
        <span className="project-label" title={project.name}>
          <ProjectGlyph project={project} size={14} />
          {project.name}
        </span>
      )}
      {branch && (
        // Not a button: there is nothing to open. It borrows the chip's look so the
        // strip reads as one row, but must not offer a hover or a focus stop that
        // leads nowhere.
        <span
          className="card-link"
          style={{ ["--link-color" as string]: LINK_KIND_COLORS.worktree }}
          title={`${LINK_KIND_LABELS.worktree} · ${branch}`}
        >
          <LinkKindIcon kind="worktree" size={13} />
        </span>
      )}
      {chipLinks.length > 0 && (
        <span className="card-links">
          {latestLinkPerKind(chipLinks).map(({ link, total }) => {
            const kind = asLinkKind(link.kind);
            const isDoor = door && kind === "pr";
            const short = isDoor ? prDoorLabel(link) : cardLinkShort(link);
            const older = total > 1 ? ` · latest of ${total}` : "";
            // A stamped PR shows its merge status everywhere. Outside the review
            // section it becomes a full chip — tint, class and trailing badge.
            // As the review-door it keeps its own frame, icon and label, and the
            // status rides along as just the trailing badge (✓ / ↓N / draft), so
            // a merged PR on a card in review reads as landed, not an open loop.
            const pr = prChip(link);
            const color = pr && !isDoor ? pr.color : LINK_KIND_COLORS[kind];
            const stateTitle = pr ? ` · ${pr.title}` : "";
            return (
              <button
                key={link.id}
                className={
                  isDoor ? "card-link review-door" : `card-link${pr ? ` ${pr.cls}` : ""}`
                }
                style={{ ["--link-color" as string]: color }}
                title={`${LINK_KIND_LABELS[kind]} · ${link.label}${older}${stateTitle} · ${link.url}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void openUrl(link.url);
                }}
              >
                <LinkKindIcon kind={link.kind} size={13} />
                {short && <span className="card-link-label">{short}</span>}
                {pr?.suffix}
              </button>
            );
          })}
        </span>
      )}
      <AgentPresence taskId={task.id} />
    </span>
    {revealNames.length > 0 && (
      <span className="card-reveal" aria-hidden="true">
        {revealNames.map((r, i) => (
          <span key={i} className="card-reveal-name">
            <LinkKindIcon kind={r.kind} size={11} />
            <span>{r.name}</span>
          </span>
        ))}
      </span>
    )}
    {entry?.last_log && (
      // Its own row, below the strip. It cannot share it: inline, a log line consumes
      // the full width and evicts the worktree chip — the approved fixture compared
      // both and this is the one that keeps all three signals.
      <span className="card-log" title={entry.last_log}>
        {entry.last_log}
      </span>
    )}
    </>
  );
}
