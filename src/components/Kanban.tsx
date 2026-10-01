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
import { useSettings } from "../settings";
import { useLightbox } from "../lightbox";
import type { Goal, Project, Selection, Status, Tag, Task, TaskImage, TaskLink } from "../types";
import {
  LINK_KIND_COLORS,
  LINK_KIND_LABELS,
  RESERVED_TAG_LABELS,
  STATUSES,
  STATUS_LABELS,
  asLinkKind,
  isSingleProjectSelection,
  isVerifyStep,
  verifyStepLabel,
} from "../types";
import { timeAgo, todayStr } from "../utils/dates";
import { imageSrc, useImageBase } from "../utils/images";
import { cardPresence } from "../utils/presence";
import { useArtifactStore } from "../artifactStore";
import { latestLinkPerKind } from "../utils/links";
import { taskRefLabel } from "../utils/ref";
import type { Subtask } from "../types";
import { CompletionFlourish, UnseenMark } from "./Brand";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconList,
  IconMessage,
  IconTerminal,
  LinkKindIcon,
} from "./Icons";
import { hostedForTask, resumableForTask, useHostStore } from "../hostStore";
import { prChip } from "./prChip";
import { ProjectGlyph } from "./ProjectGlyph";
import { FromRef, OwnerMark, TaskMeta, reservedState, useClaimLabel } from "./TaskRow";
import { AgentPresence, SecretaryBadge } from "../agents";
import "./kanbanLanes.css";

type Columns = Record<Status, number[]>;

interface BoardModel {
  columns: Columns;
  /** Where the "Working" divider falls inside In Progress: the number of
   * needs-review cards grouped above it. 0 means no review section. */
  doingReviewCount: number;
  /** Pinned human-verify cards at the top of Done — awaiting the user's check. */
  doneVerifyCount: number;
  /** Where the "Earlier" divider falls inside the Done column. */
  doneTodayCount: number;
  /** Done tasks not on the board — the count behind the "in Completed" link. */
  doneHidden: number;
}

/** A board row. Single-project boards split into You (`human`) over Agents
 *  (`agent`); every other board is one `all` row, exactly as before lanes. */
type Lane = "all" | "human" | "agent";
type Lanes = Partial<Record<Lane, BoardModel>>;

/** Droppable ids name a lane and a column, e.g. `agent:doing`. */
const containerId = (lane: Lane, status: Status) => `${lane}:${status}`;

/** The project whose board splits into lanes, or null for a board that stays one
 *  row (Today, Inbox, Upcoming, All). A goal view keys by its goal's project, so
 *  the collapse state is shared across the project and its goals. */
function laneProjectId(selection: Selection, goals: Goal[]): number | null {
  if (selection.type === "project" || selection.type === "ungoaled") return selection.projectId;
  if (selection.type === "goal") {
    return goals.find((g) => g.id === selection.goalId)?.project_id ?? null;
  }
  return null;
}

/** You holds the user's own cards plus agent cards awaiting their check:
 *  reviewing a human-verify card is the user's job whoever did the work. */
function laneOf(task: Task, tags: Tag[]): Lane {
  if (task.owner === "human") return "human";
  const verify = tags.some(
    (t) => t.name.toLowerCase() === "human-verify" && task.tag_ids.includes(t.id),
  );
  return verify ? "human" : "agent";
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
  // Done pins the verify queue first: cards the agent closed with their
  // `verify:` checklist still unticked stay on the board regardless of the
  // window — out of sight is the failure mode this state exists to prevent.
  // Same split-index shape as the review section above.
  const doneTasks = tasks.filter((t) => t.status === "done");
  const verifyQueue = doneTasks
    .filter((t) => reservedState(t, tags) === "human-verify")
    .sort((a, b) => {
      const ca = a.completed_at ?? "";
      const cb = b.completed_at ?? "";
      if (ca !== cb) return ca < cb ? 1 : -1;
      return b.id - a.id;
    });
  const verifyIds = new Set(verifyQueue.map((t) => t.id));
  // The rest is the recent window (today + backfill to the limit), newest
  // first. Everything beyond it lives in Completed.
  const w = doneBoardWindow(doneTasks.filter((t) => !verifyIds.has(t.id)), today);
  columns.done = [...verifyQueue, ...w.today, ...w.earlier].map((t) => t.id);
  return {
    columns,
    doingReviewCount: review.length,
    doneVerifyCount: verifyQueue.length,
    doneTodayCount: w.today.length,
    doneHidden: w.hiddenCount,
  };
}

export function Kanban() {
  // Only narrow the board to the attached card's column while the terminal is
  // actually taking horizontal space. A collapsed pane is just the slim docked
  // rail, so the middle shows the original full board — all three columns, not
  // only the parked session's column (TIL-159 follow-up).
  const paneOpenTaskId = usePaneStore((s) => (s.collapsed ? null : (s.target?.taskId ?? null)));
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

  const goals = useStore((s) => s.goals);
  const patchTask = useStore((s) => s.patchTask);
  const laneProject = laneProjectId(selection, goals);
  const agentsCollapsed = useSettings(
    (s) => laneProject !== null && !!s.agentLaneCollapsed[laneProject],
  );
  const setAgentLaneCollapsed = useSettings((s) => s.setAgentLaneCollapsed);

  const [lanes, setLanes] = useState<Lanes>({});
  const [activeId, setActiveId] = useState<number | null>(null);
  // Holds the board still between a cross-lane drop and its owner write, so the
  // card does not flash back into the lane it left while the two writes land.
  const [syncing, setSyncing] = useState(false);
  // A card that just landed in Done, to overlay the wave-to-check flourish on.
  // `key` bumps per completion so re-completing the same card replays it.
  const [celebrate, setCelebrate] = useState<{ id: number; key: number } | null>(null);
  const dragFrom = useRef<{ lane: Lane; status: Status } | null>(null);
  const flourishSeq = useRef(0);
  // A card whose unseen mark is settling into its check, because you just came
  // back from reading it. Same shape as `celebrate`: the store clears the fact
  // immediately, so this keeps the mark mounted long enough to finish drawing.
  const [settle, setSettle] = useState<{ id: number; key: number } | null>(null);
  const settleSeq = useRef(0);

  useEffect(() => {
    if (activeId !== null || syncing) return;
    const today = todayStr();
    if (laneProject === null) {
      setLanes({ all: computeColumns(visible, tags, today) });
      return;
    }
    // Each lane is a whole board model of its own: the review split, the pinned
    // verify queue and the Done window all apply per lane.
    setLanes({
      human: computeColumns(
        visible.filter((t) => laneOf(t, tags) === "human"),
        tags,
        today,
      ),
      agent: computeColumns(
        visible.filter((t) => laneOf(t, tags) === "agent"),
        tags,
        today,
      ),
    });
  }, [visible, tags, activeId, syncing, laneProject]);

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

  function findContainer(
    id: UniqueIdentifier,
    ls: Lanes = lanes,
  ): { lane: Lane; status: Status } | null {
    if (typeof id === "string") {
      const [lane, status] = id.split(":") as [Lane, Status];
      return ls[lane] && STATUSES.includes(status) ? { lane, status } : null;
    }
    for (const [lane, model] of Object.entries(ls) as [Lane, BoardModel][]) {
      for (const status of STATUSES) {
        if (model.columns[status].includes(id as number)) return { lane, status };
      }
    }
    return null;
  }

  function onDragStart(event: DragStartEvent) {
    const id = event.active.id as number;
    // Remember where the card started so onDragEnd can tell a genuine
    // completion (moved into Done) from a reorder within Done, and a lane
    // change from a move within one lane.
    dragFrom.current = findContainer(id);
    setActiveId(id);
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const from = findContainer(active.id);
    const to = findContainer(over.id);
    if (!from || !to || (from.lane === to.lane && from.status === to.status)) return;

    setLanes((ls) => {
      const src = ls[from.lane]!;
      const next: Lanes = {
        ...ls,
        [from.lane]: {
          ...src,
          columns: {
            ...src.columns,
            [from.status]: src.columns[from.status].filter((id) => id !== active.id),
          },
        },
      };
      const dst = next[to.lane]!;
      const toIds = [...dst.columns[to.status]];
      const overIndex = toIds.indexOf(over.id as number);
      toIds.splice(overIndex >= 0 ? overIndex : toIds.length, 0, active.id as number);
      next[to.lane] = { ...dst, columns: { ...dst.columns, [to.status]: toIds } };
      return next;
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const id = active.id as number;
    let next = lanes;
    if (over) {
      const from = findContainer(id);
      const to = findContainer(over.id);
      if (from && to && from.lane === to.lane && from.status === to.status) {
        const model = lanes[from.lane]!;
        const ids = model.columns[from.status];
        const oldIndex = ids.indexOf(id);
        const overIndex = ids.indexOf(over.id as number);
        if (oldIndex >= 0 && overIndex >= 0 && oldIndex !== overIndex) {
          next = {
            ...lanes,
            [from.lane]: {
              ...model,
              columns: { ...model.columns, [from.status]: arrayMove(ids, oldIndex, overIndex) },
            },
          };
          setLanes(next);
        }
      }
    }
    const start = dragFrom.current;
    dragFrom.current = null;
    const landed = findContainer(id, next);
    // Fire the flourish only on a real completion: the card ended in Done and
    // did not start there.
    if (landed?.status === "done" && start?.status !== "done") {
      flourishSeq.current += 1;
      setCelebrate({ id, key: flourishSeq.current });
    }

    setActiveId(null);
    if (!landed) return;
    // The lane's own columns: the reorder anchors to the card above it in the
    // lane it landed in, and the other lane's cards keep their places.
    const columns = next[landed.lane]!.columns;
    // Owner follows the lane only when the card crosses lanes, so an agent's
    // human-verify card (shown in You) stays agent-owned when moved within You.
    const owner = landed.lane !== "all" && start && start.lane !== landed.lane ? landed.lane : null;
    if (owner === null || taskById.get(id)?.owner === owner) {
      void applyDrag(id, columns);
      return;
    }
    setSyncing(true);
    void (async () => {
      try {
        await applyDrag(id, columns);
        await patchTask(id, { owner });
      } finally {
        setSyncing(false);
      }
    })();
  }

  const activeTask = activeId !== null ? taskById.get(activeId) : undefined;
  // Keep the drag overlay in the same form as the resting card: the pinned
  // verify queue (the first `verify` in a Done column) drags as full, not compact.
  const activeFull =
    activeId !== null &&
    Object.values(lanes).some((m) =>
      m.columns.done.slice(0, m.doneVerifyCount).includes(activeId),
    );

  const column = (lane: Lane, status: Status, showHeader = true) => {
    const model = lanes[lane];
    if (!model) return null;
    return (
      <Column
        key={containerId(lane, status)}
        lane={lane}
        status={status}
        showHeader={showHeader}
        ids={model.columns[status]}
        taskById={taskById}
        onOpen={openEditor}
        celebrate={celebrate}
        onFlourishDone={() => setCelebrate(null)}
        settle={settle}
        onSettleDone={() => setSettle(null)}
        reviewCount={model.doingReviewCount}
        doneVerifyCount={model.doneVerifyCount}
        doneTodayCount={model.doneTodayCount}
        doneHidden={model.doneHidden}
        onSeeAll={() => select({ type: "completed" })}
      />
    );
  };
  // A lane's count is its open work, todo plus doing, like the mockup's lane label.
  const openCount = (lane: Lane) => {
    const m = lanes[lane];
    return m ? m.columns.todo.length + m.columns.doing.length : 0;
  };
  const boardClass = paneOpenTaskId !== null ? "board pane-focus" : "board";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {laneProject === null ? (
        <div className={boardClass}>{STATUSES.map((status) => column("all", status))}</div>
      ) : (
        <div className={`${boardClass} board-lanes`}>
          <div className="lane" data-lane="human">
            <div className="lane-who">
              <span className="lane-name">You</span>
              <span className="lane-count">{openCount("human")}</span>
            </div>
            {STATUSES.map((status) => column("human", status))}
          </div>
          <div
            className={agentsCollapsed ? "lane agents collapsed" : "lane agents"}
            data-lane="agent"
          >
            <div className="lane-who">
              <span className="lane-name">Agents</span>
              <span className="lane-count">{openCount("agent")}</span>
              <button
                type="button"
                className="lane-toggle"
                aria-expanded={!agentsCollapsed}
                aria-label={agentsCollapsed ? "Expand agents lane" : "Collapse agents lane"}
                onClick={() => setAgentLaneCollapsed(laneProject, !agentsCollapsed)}
              >
                {agentsCollapsed ? "expand" : "collapse"}
                {agentsCollapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
              </button>
            </div>
            {!agentsCollapsed && STATUSES.map((status) => column("agent", status, false))}
          </div>
        </div>
      )}
      <DragOverlay>
        {activeTask ? <CardContent task={activeTask} overlay full={activeFull} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  lane,
  status,
  showHeader,
  ids,
  taskById,
  onOpen,
  celebrate,
  onFlourishDone,
  settle,
  onSettleDone,
  reviewCount,
  doneVerifyCount,
  doneTodayCount,
  doneHidden,
  onSeeAll,
}: {
  lane: Lane;
  status: Status;
  /** The Agents lane sits under the You lane's headers and repeats none. */
  showHeader: boolean;
  ids: number[];
  taskById: Map<number, Task>;
  onOpen: (id: number) => void;
  celebrate: { id: number; key: number } | null;
  onFlourishDone: () => void;
  settle: { id: number; key: number } | null;
  onSettleDone: () => void;
  reviewCount: number;
  doneVerifyCount: number;
  doneTodayCount: number;
  doneHidden: number;
  onSeeAll: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: containerId(lane, status) });
  const isDone = status === "done";
  const isDoing = status === "doing";

  // `full` keeps a done card in its full form instead of collapsing to one line —
  // used for the verify queue, whose steps the user still has to read.
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

  // The Done column stacks its splits: the pinned verify queue first, then the
  // window grouped into Today / Earlier. Other columns render a flat list.
  const verifyCount = Math.min(doneVerifyCount, ids.length);
  const todayCount = Math.min(doneTodayCount, ids.length - verifyCount);
  const hasEarlier = isDone && ids.length > verifyCount + todayCount;

  // In Progress groups the review queue above the rest, on the same split-index
  // shape. The dividers only appear when there is something on both sides: a
  // column that is all review needs no "Working" heading over nothing, and a
  // column with none needs no section at all.
  const reviewSplit = Math.min(reviewCount, ids.length);
  const hasReview = isDoing && reviewSplit > 0;
  const hasWorking = isDoing && ids.length > reviewSplit;
  // The column that holds the pane's bound card. Unguarded by collapse on
  // purpose (unlike paneOpenTaskId above): it drives the card accent ring, the
  // "this card owns the docked session" cue that stays useful on the collapsed
  // full board. (The old ¾-pane single-column narrowing it also fed is now
  // superseded by the context rail — TIL-160.)
  const paneTaskId = usePaneStore((s) => s.target?.taskId ?? null);
  const holdsPaneSrc = paneTaskId !== null && ids.includes(paneTaskId);

  return (
    <div
      className={holdsPaneSrc ? "board-column pane-src-col" : "board-column"}
      data-status={status}
    >
      {showHeader && (
        <div className={`column-header ${status}`}>
          <span className="column-dot" />
          {STATUS_LABELS[status]}
          <span className="column-count">{ids.length}</span>
        </div>
      )}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {isDone ? (
            <>
              {/* The verify queue: shipped, AI-verified, awaiting your check.
                  Full cards, so the verify counter and its popover are in reach
                  without opening the editor. */}
              {verifyCount > 0 && (
                <div className="col-divider verify-queue">Verify · {verifyCount}</div>
              )}
              {ids.slice(0, verifyCount).map((id) => card(id, true, true))}
              {todayCount > 0 && <div className="col-divider">Today</div>}
              {ids.slice(verifyCount, verifyCount + todayCount).map((id) => card(id))}
              {hasEarlier && (
                <div className="col-divider">
                  Earlier
                  <span className="backfill-tag">fills to {DONE_WINDOW_LIMIT}</span>
                </div>
              )}
              {ids.slice(verifyCount + todayCount).map((id) => card(id))}
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
        Steps for human verify
        <span className="verify-popover-count">{steps.length}</span>
      </div>
      <ol className="verify-list">
        {steps.map((s, i) => (
          <li key={s.id} className="verify-item">
            <span className="verify-num">{i + 1}</span>
            <span className="verify-text">{verifyStepLabel(s)}</span>
          </li>
        ))}
      </ol>
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
  const images = useStore((s) => s.images);
  const projects = useStore((s) => s.projects);
  const goals = useStore((s) => s.goals);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const commentCount = useStore((s) => s.commentCounts[task.id] ?? 0);
  const paneTaskId = usePaneStore((s) => s.target?.taskId ?? null);
  const mine = subtasks.filter((s) => s.task_id === task.id);
  const cardLinks = links[task.id] ?? [];
  const cardImages = images[task.id] ?? [];
  const state = reservedState(task, tags);
  // Agent work back for the user's check says so in words, as Mine's To verify
  // does; a held agent card names the agent holding it, as the queue's Doing row does.
  const claimLabel = useClaimLabel(task);
  const ownerLabel =
    state === "human-verify"
      ? "done by agent"
      : task.owner === "agent" && task.status === "doing"
        ? (claimLabel ?? undefined)
        : undefined;
  // Verify steps ("verify: …" subtasks) leave the build checklist only while the
  // task is actually in review — the tag coming off mid-flight folds them back
  // into plain subtasks rather than orphaning them out of every count. Both
  // review states count: needs-review (doing, pre-hand-off) and human-verify
  // (done, awaiting the user's check).
  const inReview = state === "needs-review" || state === "human-verify";
  const verifySteps = inReview ? mine.filter(isVerifyStep) : [];
  const build = inReview ? mine.filter((s) => !isVerifyStep(s)) : mine;
  const done = build.filter((s) => s.done).length;
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
  const showProject = !isSingleProjectSelection(selection);
  const project =
    task.project_id !== null ? projects.find((p) => p.id === task.project_id) : undefined;
  // Same suppression rule as TaskMeta's goal chip: noise inside the goal it names.
  const goal = task.goal_id !== null ? goals.find((g) => g.id === task.goal_id) : undefined;
  const showGoalChip =
    goal !== undefined && !(selection.type === "goal" && selection.goalId === goal.id);

  // A finished card is history, not work in flight: collapse it to one line —
  // check, strikethrough title, project dot, completion time. The full meta
  // (subtask bar, due date, priority, tags) only matters while a task is live —
  // except for the verify queue (`full`), whose steps the user still has to
  // read. Today's completions collapse too; the unseen mark rides inline.
  if (task.status === "done" && !full) {
    const time = task.completed_at ? format(new Date(task.completed_at), "h:mm a") : "";
    return (
      <div
        className={["board-card", "done", "compact", overlay ? "overlay" : "", showMark ? "unseen" : ""]
          .filter(Boolean)
          .join(" ")}
      >
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
          {showGoalChip && goal && (
            <button
              type="button"
              className="goal-chip mini"
              style={{ ["--goal-color" as string]: goal.color }}
              title={`Goal: ${goal.name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                select({ type: "goal", goalId: goal.id });
              }}
            >
              <span className="goal-chip-glyph" aria-hidden="true" />
              <span className="goal-chip-label">{goal.name}</span>
            </button>
          )}
          {showProject && project && (
            <span className="project-label" title={project.name}>
              <ProjectGlyph project={project} size={12} />
            </span>
          )}
          <OwnerMark task={task} label={ownerLabel} />
          <FromRef task={task} />
          {time && <span className="done-time">{time}</span>}
        </span>
        {showMark && (
          <UnseenMark key={settleKey ?? "unseen"} settling={settling} onDone={onSettleDone} />
        )}
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
      {cardImages.length > 0 && <CardThumbs images={cardImages} />}
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
            // door to it. A count of steps, not a fraction — nothing here ticks,
            // so a numerator would sit at 0 forever and read as work abandoned.
            // stopPropagation twins card-link's — the counter must neither start
            // a drag nor open the editor.
            <span className="card-verify-anchor">
              <button
                type="button"
                className="card-verify-count"
                title={`${verifySteps.length} step${verifySteps.length === 1 ? "" : "s"} for you to verify`}
                aria-expanded={verifyOpen}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setVerifyOpen((v) => !v);
                }}
              >
                <IconList size={12} />
                {verifySteps.length} step{verifySteps.length === 1 ? "" : "s"}
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
      <TaskMeta task={task} hideStatus hideState={inSection} showOwner ownerLabel={ownerLabel} />
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
 * The card's screenshot strip: up to three small thumbnails under the title,
 * "+N" past that — never a Notion-style cover, so image cards keep the same
 * visual weight as text cards. A thumb opens the lightbox directly, without
 * opening the task (mirrors card-link's stopPropagation pair).
 */
function CardThumbs({ images }: { images: TaskImage[] }) {
  const open = useLightbox((s) => s.open);
  useImageBase();
  const shown = images.slice(0, 3);
  const extra = images.length - shown.length;
  return (
    <span className="card-thumbs">
      {shown.map((img, i) => {
        const src = imageSrc(img);
        return (
          <button
            key={img.id}
            type="button"
            className="card-thumb"
            title={img.filename}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              open(images, i);
            }}
          >
            {src && <img src={src} alt={img.filename} loading="lazy" />}
          </button>
        );
      })}
      {extra > 0 && (
        <button
          type="button"
          className="card-thumb card-thumb-more"
          title={`${images.length} images`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            open(images, shown.length);
          }}
        >
          +{extra}
        </button>
      )}
    </span>
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
  const hostSessions = useHostStore((s) => s.sessions);
  const entry = cardPresence(task.id, live, fallback);
  // The board-hosted session on this card, if any — aliveness as owned-process
  // fact (spec 2026-07-19-hosted-agent-sessions), independent of heartbeats.
  const hosted = hostedForTask(hostSessions, task.id);
  // F3: a previous run's session, offered back — visible only while nothing
  // current occupies the slot.
  const hostResumables = useHostStore((s) => s.resumables);
  const resumable = hosted ? null : resumableForTask(hostResumables, task.id);
  // Artifact facts (F1): durable-trace truths — transcript activity, commits
  // ahead — that survive the session which produced them.
  const facts = useArtifactStore((s) => s.facts[task.id]);
  // File evidence lives in the task detail's Evidence section, never as a card
  // chip — the card carries only the git-workflow "state of play".
  const chipLinks = links.filter((l) => asLinkKind(l.kind) !== "file");
  if (!project && chipLinks.length === 0 && !entry && !hosted && !resumable && !facts)
    return null;
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
      {hosted && (
        // Not a button: the way in is the editor's Session row (and the jump
        // routing); the card chip only *states* that this task has its own
        // terminal here, live or exited.
        <span
          className={`card-hosted${hosted.exited ? " exited" : ""}${
            !hosted.exited && hosted.waiting ? " waiting" : ""
          }`}
          title={
            !hosted.exited && hosted.waiting
              ? `Hosted session · ${hosted.adapter_name} · looks idle at a prompt (heuristic)`
              : `Hosted session · ${hosted.adapter_name} · ${hosted.exited ? "exited" : "running"}`
          }
        >
          <IconTerminal size={12} />
          {hosted.exited
            ? "exited"
            : hosted.waiting
              ? "waiting ❯"
              : hosted.adapter_name}
        </span>
      )}
      {resumable && (
        // F3: dead with the last app run, but its conversation can continue —
        // the way in is the editor's Resume button.
        <span
          className="card-hosted exited"
          title={`Hosted session from the last run · ${resumable.adapter_name} · resume from the task editor`}
        >
          <IconTerminal size={12} />
          resumable
        </span>
      )}
      <SecretaryBadge taskId={task.id} />
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
    {facts && (facts.last_active || facts.commits_ahead > 0) && (
      // The artifact trail (F1): stable truths read off the filesystem, so a
      // card can still answer "when did anything last happen" after every
      // process and heartbeat is gone. Quiet by design — pure meta.
      <span
        className="card-artifacts"
        title="Artifact trail — transcript activity and commits, survives the session"
      >
        {[
          facts.last_active ? timeAgo(facts.last_active) : null,
          facts.turns > 0 ? `${facts.turns} turns` : null,
          facts.commits_ahead > 0 ? `${facts.commits_ahead}↑` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    )}
    </>
  );
}
