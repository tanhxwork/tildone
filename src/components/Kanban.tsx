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
import { useEffect, useMemo, useRef, useState } from "react";
import { visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Status, Task } from "../types";
import { STATUSES, STATUS_LABELS } from "../types";
import { CompletionFlourish } from "./Brand";
import { TaskMeta, reservedState } from "./TaskRow";

type Columns = Record<Status, number[]>;

function computeColumns(tasks: Task[]): Columns {
  const columns: Columns = { todo: [], doing: [], done: [] };
  for (const status of STATUSES) {
    columns[status] = tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((t) => t.id);
  }
  return columns;
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
  const [activeId, setActiveId] = useState<number | null>(null);
  // A card that just landed in Done, to overlay the wave-to-check flourish on.
  // `key` bumps per completion so re-completing the same card replays it.
  const [celebrate, setCelebrate] = useState<{ id: number; key: number } | null>(null);
  const dragFromStatus = useRef<Status | null>(null);
  const flourishSeq = useRef(0);

  useEffect(() => {
    if (activeId === null) {
      setColumns(computeColumns(visible));
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
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? <CardContent task={activeTask} overlay /> : null}
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
}: {
  status: Status;
  ids: number[];
  taskById: Map<number, Task>;
  onOpen: (id: number) => void;
  celebrate: { id: number; key: number } | null;
  onFlourishDone: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: status });

  return (
    <div className="board-column">
      <div className={`column-header ${status}`}>
        <span className="column-dot" />
        {STATUS_LABELS[status]}
        <span className="column-count">{ids.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {ids.map((id) => {
            const task = taskById.get(id);
            return task ? (
              <Card
                key={id}
                task={task}
                onOpen={onOpen}
                flourishKey={celebrate?.id === id ? celebrate.key : null}
                onFlourishDone={onFlourishDone}
              />
            ) : null;
          })}
          {ids.length === 0 && <div className="column-empty">Drop tasks here</div>}
        </div>
      </SortableContext>
    </div>
  );
}

function Card({
  task,
  onOpen,
  flourishKey,
  onFlourishDone,
}: {
  task: Task;
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
      <CardContent task={task} flourishKey={flourishKey} onFlourishDone={onFlourishDone} />
    </div>
  );
}

function CardContent({
  task,
  overlay,
  flourishKey = null,
  onFlourishDone,
}: {
  task: Task;
  overlay?: boolean;
  flourishKey?: number | null;
  onFlourishDone?: () => void;
}) {
  const subtasks = useStore((s) => s.subtasks);
  const tags = useStore((s) => s.tags);
  const mine = subtasks.filter((s) => s.task_id === task.id);
  const done = mine.filter((s) => s.done).length;
  const state = reservedState(task, tags);

  return (
    <div
      className={[
        "board-card",
        overlay ? "overlay" : "",
        task.status === "done" ? "done" : "",
        state ? `state-${state}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="card-title">
        <span className="card-id" aria-hidden="true">#{task.id}</span> {task.title}
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
      <TaskMeta task={task} showProject hideStatus />
      {flourishKey !== null && (
        <CompletionFlourish key={flourishKey} onDone={onFlourishDone} />
      )}
    </div>
  );
}
