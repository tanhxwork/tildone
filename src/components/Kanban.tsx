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
import { TaskMeta } from "./TaskRow";

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
      <div className="flex min-h-full items-start gap-3.5 pt-2">
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
    <div className="min-w-[210px] max-w-[340px] flex-1 rounded-[10px] border border-edge bg-inset p-2">
      <div className="flex items-center gap-[7px] px-1.5 pb-2 pt-1 text-[12px] font-semibold">
        <span
          className={`size-2 rounded-full ${
            status === "doing" ? "bg-doing" : status === "done" ? "bg-success" : "bg-ink-faint"
          }`}
        />
        {STATUS_LABELS[status]}
        <span className="ml-auto text-[11px] font-medium tabular-nums text-ink-faint">
          {ids.length}
        </span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex min-h-[60px] flex-col gap-[7px]">
          {ids.map((id) => {
            const task = taskById.get(id);
            return task ? <Card key={id} task={task} onOpen={onOpen} /> : null;
          })}
          {ids.length === 0 && (
            <div className="flex min-h-[60px] items-center justify-center rounded-lg border-[1.5px] border-dashed border-edge-strong text-[12px] text-ink-faint">
              Drop tasks here
            </div>
          )}
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
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg border border-edge bg-card px-[11px] py-[9px] transition-colors hover:border-edge-strong ${
        overlay ? "rotate-2 cursor-grabbing shadow-pop" : "cursor-grab shadow-card"
      }`}
    >
      <span
        className={`font-medium wrap-anywhere ${
          task.status === "done" ? "text-ink-faint line-through" : ""
        }`}
      >
        {task.title}
      </span>
      <TaskMeta task={task} showProject hideStatus className="flex-wrap" />
    </div>
  );
}
