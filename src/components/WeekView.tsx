import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { addWeeks, format, parseISO } from "date-fns";
import { useMemo, useState } from "react";
import { liveTasks } from "../selectors";
import { useSettings } from "../settings";
import { useStore } from "../store";
import type { Task } from "../types";
import { PRIORITY_COLORS } from "../types";
import { compareTasks, isOverdue, todayStr, weekDates } from "../utils/dates";
import { IconChevronLeft, IconChevronRight } from "./Icons";

const UNSCHEDULED = "unscheduled";

export function WeekView() {
  const { tasks, projects, patchTask, openEditor } = useStore();
  const weekStart = useSettings((s) => s.weekStart);
  const [weekOffset, setWeekOffset] = useState(0);
  const [activeId, setActiveId] = useState<number | null>(null);

  const dates = useMemo(
    () => weekDates(addWeeks(new Date(), weekOffset), weekStart),
    [weekOffset, weekStart],
  );

  const live = useMemo(() => liveTasks(tasks), [tasks]);
  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const date of dates) map.set(date, []);
    for (const t of live) {
      if (t.due_date && map.has(t.due_date)) map.get(t.due_date)!.push(t);
    }
    for (const list of map.values()) list.sort(compareTasks);
    return map;
  }, [live, dates]);

  const unscheduled = useMemo(
    () => live.filter((t) => t.due_date === null && t.status !== "done").sort(compareTasks),
    [live],
  );

  const planned = dates.reduce(
    (sum, d) => sum + (byDate.get(d)?.filter((t) => t.status !== "done").length ?? 0),
    0,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const task = live.find((t) => t.id === active.id);
    if (!task) return;
    const target = String(over.id);
    const due_date = target === UNSCHEDULED ? null : target;
    if (task.due_date !== due_date) {
      void patchTask(task.id, { due_date });
    }
  }

  const activeTask = activeId !== null ? live.find((t) => t.id === activeId) : undefined;
  const today = todayStr();
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const rangeLabel = `${format(parseISO(dates[0]), "MMM d")} – ${format(parseISO(dates[6]), "MMM d")}`;

  return (
    <div className="week-view">
      <div className="week-toolbar">
        <div>
          <span className="week-range">{rangeLabel}</span>
          <span className="week-summary">
            {planned} planned · {unscheduled.length} unscheduled
          </span>
        </div>
        <div className="calendar-nav">
          <button
            className="icon-btn"
            aria-label="Previous week"
            onClick={() => setWeekOffset((v) => v - 1)}
          >
            <IconChevronLeft size={15} />
          </button>
          <button className="btn small" onClick={() => setWeekOffset(0)}>
            This week
          </button>
          <button
            className="icon-btn"
            aria-label="Next week"
            onClick={() => setWeekOffset((v) => v + 1)}
          >
            <IconChevronRight size={15} />
          </button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={(e) => setActiveId(e.active.id as number)}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="week-columns">
          {dates.map((date) => (
            <WeekDay
              key={date}
              date={date}
              isToday={date === today}
              tasks={byDate.get(date) ?? []}
              onOpen={openEditor}
              projectColor={(t) =>
                t.project_id !== null ? projectById.get(t.project_id)?.color : undefined
              }
            />
          ))}
        </div>

        <UnscheduledRail
          tasks={unscheduled}
          onOpen={openEditor}
          projectColor={(t) =>
            t.project_id !== null ? projectById.get(t.project_id)?.color : undefined
          }
        />

        <DragOverlay>
          {activeTask ? <div className="week-card overlay">{activeTask.title}</div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function WeekDay({
  date,
  isToday,
  tasks,
  onOpen,
  projectColor,
}: {
  date: string;
  isToday: boolean;
  tasks: Task[];
  onOpen: (id: number) => void;
  projectColor: (t: Task) => string | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: date });
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <div
      ref={setNodeRef}
      className={`week-day ${isToday ? "today" : ""} ${isOver ? "drop-target" : ""}`}
    >
      <div className="week-day-header">
        <span className="week-day-name">{format(parseISO(date), "EEE").toUpperCase()}</span>
        <span className="week-day-num">{Number(date.slice(8))}</span>
        {open.length > 0 && <span className="week-day-count">{open.length}</span>}
      </div>
      <div className="week-day-body">
        {open.map((task) => (
          <WeekCard key={task.id} task={task} color={projectColor(task)} onOpen={onOpen} />
        ))}
        {done.map((task) => (
          <WeekCard key={task.id} task={task} color={projectColor(task)} onOpen={onOpen} />
        ))}
        {tasks.length === 0 && <div className="week-day-empty">–</div>}
      </div>
    </div>
  );
}

function UnscheduledRail({
  tasks,
  onOpen,
  projectColor,
}: {
  tasks: Task[];
  onOpen: (id: number) => void;
  projectColor: (t: Task) => string | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULED });

  return (
    <div ref={setNodeRef} className={`week-unscheduled ${isOver ? "drop-target" : ""}`}>
      <div className="week-unscheduled-header">
        Unscheduled
        <span className="week-day-count">{tasks.length}</span>
        <span className="week-unscheduled-hint">drag onto a day</span>
      </div>
      <div className="week-unscheduled-body">
        {tasks.map((task) => (
          <WeekCard key={task.id} task={task} color={projectColor(task)} onOpen={onOpen} />
        ))}
        {tasks.length === 0 && (
          <span className="week-day-empty">Everything has a day 🎉</span>
        )}
      </div>
    </div>
  );
}

function WeekCard({
  task,
  color,
  onOpen,
}: {
  task: Task;
  color: string | undefined;
  onOpen: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  const overdue = isOverdue(task);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`week-card ${task.status === "done" ? "done" : ""}`}
      style={{ opacity: isDragging ? 0.35 : undefined }}
      onClick={() => onOpen(task.id)}
    >
      <span
        className="calendar-chip-dot"
        style={{
          background:
            task.priority > 0 ? PRIORITY_COLORS[task.priority] : (color ?? "var(--text-faint)"),
        }}
      />
      <span className="week-card-title">{task.title}</span>
      {overdue && <span className="week-card-overdue">overdue</span>}
    </div>
  );
}
