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
import { DONE_WINDOW_LIMIT, doneBoardWindow, visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Project, Status, Task, TaskLink } from "../types";
import {
  LINK_KIND_COLORS,
  LINK_KIND_LABELS,
  STATUSES,
  STATUS_LABELS,
  asLinkKind,
} from "../types";
import { todayStr } from "../utils/dates";
import { cardPresence } from "../utils/presence";
import { latestLinkPerKind } from "../utils/links";
import { taskRefLabel } from "../utils/ref";
import { CompletionFlourish } from "./Brand";
import { IconCheck, IconMessage, LinkKindIcon } from "./Icons";
import { ProjectGlyph } from "./ProjectGlyph";
import { TaskMeta, reservedState } from "./TaskRow";
import { AgentPresence } from "../agents";

type Columns = Record<Status, number[]>;

interface BoardModel {
  columns: Columns;
  /** Where the "Earlier" divider falls inside the Done column. */
  doneTodayCount: number;
  /** Done tasks not on the board — the count behind the "in Completed" link. */
  doneHidden: number;
}

const byPosition = (a: Task, b: Task) => a.position - b.position || a.id - b.id;

function computeColumns(tasks: Task[], today: string): BoardModel {
  const columns: Columns = { todo: [], doing: [], done: [] };
  columns.todo = tasks.filter((t) => t.status === "todo").sort(byPosition).map((t) => t.id);
  columns.doing = tasks.filter((t) => t.status === "doing").sort(byPosition).map((t) => t.id);
  // Done is not the whole pile: it is the recent window (today + backfill to the
  // limit), newest first. The rest lives in Completed.
  const w = doneBoardWindow(tasks.filter((t) => t.status === "done"), today);
  columns.done = [...w.today, ...w.earlier].map((t) => t.id);
  return { columns, doneTodayCount: w.today.length, doneHidden: w.hiddenCount };
}

export function Kanban() {
  const {
    tasks,
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

  useEffect(() => {
    if (activeId === null) {
      const model = computeColumns(visible, todayStr());
      setColumns(model.columns);
      setDoneMeta({ today: model.doneTodayCount, hidden: model.doneHidden });
    }
  }, [visible, activeId]);

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
      <div className="board">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            ids={columns[status]}
            taskById={taskById}
            onOpen={openEditor}
            celebrate={celebrate}
            onFlourishDone={() => setCelebrate(null)}
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
  doneTodayCount: number;
  doneHidden: number;
  onSeeAll: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: status });
  const isDone = status === "done";

  // `full` keeps a done card in its full form instead of collapsing to one line —
  // used for today's completions, which are still fresh enough to want the detail.
  const card = (id: number, full = false) => {
    const task = taskById.get(id);
    return task ? (
      <Card
        key={id}
        task={task}
        full={full}
        onOpen={onOpen}
        flourishKey={celebrate?.id === id ? celebrate.key : null}
        onFlourishDone={onFlourishDone}
      />
    ) : null;
  };

  // The Done column groups its window into Today / Earlier; the split index is where
  // the backfilled older cards begin. Other columns render a flat list.
  const todayCount = Math.min(doneTodayCount, ids.length);
  const hasEarlier = isDone && ids.length > todayCount;

  return (
    <div className="board-column">
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
  onOpen,
  flourishKey,
  onFlourishDone,
}: {
  task: Task;
  full?: boolean;
  onOpen: (id: number) => void;
  flourishKey: number | null;
  onFlourishDone: () => void;
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
      <CardContent task={task} full={full} flourishKey={flourishKey} onFlourishDone={onFlourishDone} />
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

function CardContent({
  task,
  overlay,
  full,
  flourishKey = null,
  onFlourishDone,
}: {
  task: Task;
  overlay?: boolean;
  full?: boolean;
  flourishKey?: number | null;
  onFlourishDone?: () => void;
}) {
  const subtasks = useStore((s) => s.subtasks);
  const tags = useStore((s) => s.tags);
  const links = useStore((s) => s.links);
  const projects = useStore((s) => s.projects);
  const selection = useStore((s) => s.selection);
  const commentCount = useStore((s) => s.commentCounts[task.id] ?? 0);
  const mine = subtasks.filter((s) => s.task_id === task.id);
  const cardLinks = links[task.id] ?? [];
  const done = mine.filter((s) => s.done).length;
  const state = reservedState(task, tags);
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
      className={[
        "board-card",
        task.status === "done" ? "done" : "",
        overlay ? "overlay" : "",
        state ? `state-${state}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="card-title">
        <span className="card-id" aria-hidden="true">{taskRefLabel(task)}</span> {task.title}
      </span>
      {mine.length > 0 && (
        <span
          className="card-progress"
          title={`${done} of ${mine.length} subtasks done`}
        >
          <span className="card-progress-bar">
            <span
              className="card-progress-fill"
              style={{ transform: `scaleX(${done / mine.length})` }}
            />
          </span>
          <span className="card-progress-count">
            {done}/{mine.length}
          </span>
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
      <TaskMeta task={task} hideStatus />
      <CardProvenance task={task} project={showProject ? project : undefined} links={cardLinks} />
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
}: {
  task: Task;
  project: Project | undefined;
  links: TaskLink[];
}) {
  const live = useStore((s) => s.live);
  const fallback = useStore((s) => s.presence);
  const entry = cardPresence(task.id, live, fallback);
  if (!project && links.length === 0 && !entry) return null;
  // The agent's worktree, from its claim. Suppressed when the task already carries a
  // hand-attached worktree link, which is a real URL and therefore strictly more
  // useful than a bare name.
  const branch =
    entry?.branch && !links.some((l) => asLinkKind(l.kind) === "worktree")
      ? entry.branch
      : null;
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
          <span className="card-link-label">{branch}</span>
        </span>
      )}
      {links.length > 0 && (
        <span className="card-links">
          {latestLinkPerKind(links).map(({ link, total }) => {
            const kind = asLinkKind(link.kind);
            const short = cardLinkShort(link);
            const older = total > 1 ? ` · latest of ${total}` : "";
            return (
              <button
                key={link.id}
                className="card-link"
                style={{ ["--link-color" as string]: LINK_KIND_COLORS[kind] }}
                title={`${LINK_KIND_LABELS[kind]} · ${link.label}${older} · ${link.url}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void openUrl(link.url);
                }}
              >
                <LinkKindIcon kind={link.kind} size={13} />
                {short && <span className="card-link-label">{short}</span>}
              </button>
            );
          })}
        </span>
      )}
      <AgentPresence taskId={task.id} />
    </span>
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
