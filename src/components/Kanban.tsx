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
import { useEffect, useMemo, useState } from "react";
import { visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Status, Task } from "../types";
import { STATUSES, STATUS_LABELS } from "../types";
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
    applyPositions,
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
    setActiveId(event.active.id as number);
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
    const updates = STATUSES.flatMap((status) =>
      next[status].map((id, index) => ({ id, status, position: index })),
    );
    setActiveId(null);
    void applyPositions(updates);
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
}: {
  status: Status;
  ids: number[];
  taskById: Map<number, Task>;
  onOpen: (id: number) => void;
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
            return task ? <Card key={id} task={task} onOpen={onOpen} /> : null;
          })}
          {ids.length === 0 && <div className="column-empty">Drop tasks here</div>}
        </div>
      </SortableContext>
    </div>
  );
}

function Card({ task, onOpen }: { task: Task; onOpen: (id: number) => void }) {
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
      <CardContent task={task} />
    </div>
  );
}

function CardContent({ task, overlay }: { task: Task; overlay?: boolean }) {
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
      <span className="card-title">{task.title}</span>
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
    </div>
  );
}
