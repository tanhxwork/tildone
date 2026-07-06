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
import { addMonths, format, isSameMonth, parseISO } from "date-fns";
import { useMemo, useState } from "react";
import { useSettings } from "../settings";
import { visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Task } from "../types";
import { PRIORITY_COLORS } from "../types";
import { compareTasks, isOverdue, monthGrid, todayStr } from "../utils/dates";
import { IconChevronLeft, IconChevronRight } from "./Icons";

const VISIBLE_PER_DAY = 3;

export function CalendarView() {
  const {
    tasks,
    projects,
    selection,
    search,
    activeTagIds,
    priorityFilter,
    showCompleted,
    patchTask,
    openEditor,
  } = useStore();
  const weekStart = useSettings((s) => s.weekStart);
  const [anchor, setAnchor] = useState(() => new Date());
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);

  const byDate = useMemo(() => {
    const visible = visibleTasks(tasks, selection, {
      search,
      activeTagIds,
      priorityFilter,
      showCompleted,
    }).sort(compareTasks);
    const map = new Map<string, Task[]>();
    for (const t of visible) {
      if (!t.due_date) continue;
      const list = map.get(t.due_date) ?? [];
      list.push(t);
      map.set(t.due_date, list);
    }
    return map;
  }, [tasks, selection, search, activeTagIds, priorityFilter, showCompleted]);

  const weeks = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const weekdayLabels = useMemo(
    () =>
      weeks[0].map((date) => format(parseISO(date), "EEE").toUpperCase()),
    [weeks],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const date = String(over.id);
    const task = tasks.find((t) => t.id === active.id);
    if (task && task.due_date !== date) {
      void patchTask(task.id, { due_date: date });
    }
  }

  const activeTask = activeId !== null ? tasks.find((t) => t.id === activeId) : undefined;
  const today = todayStr();
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return (
    <div className="calendar">
      <div className="calendar-toolbar">
        <span className="calendar-month">{format(anchor, "MMMM yyyy")}</span>
        <div className="calendar-nav">
          <button
            className="icon-btn"
            aria-label="Previous month"
            onClick={() => setAnchor((d) => addMonths(d, -1))}
          >
            <IconChevronLeft size={15} />
          </button>
          <button className="btn small" onClick={() => setAnchor(new Date())}>
            Today
          </button>
          <button
            className="icon-btn"
            aria-label="Next month"
            onClick={() => setAnchor((d) => addMonths(d, 1))}
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
        <div className="calendar-weekdays">
          {weekdayLabels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="calendar-grid" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
          {weeks.flat().map((date) => (
            <CalendarDay
              key={date}
              date={date}
              isToday={date === today}
              outsideMonth={!isSameMonth(parseISO(date), anchor)}
              tasks={byDate.get(date) ?? []}
              expanded={expandedDay === date}
              onToggleExpand={() =>
                setExpandedDay((cur) => (cur === date ? null : date))
              }
              onOpen={openEditor}
              projectColor={(t) =>
                t.project_id !== null ? projectById.get(t.project_id)?.color : undefined
              }
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div className="calendar-chip overlay">{activeTask.title}</div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function CalendarDay({
  date,
  isToday,
  outsideMonth,
  tasks,
  expanded,
  onToggleExpand,
  onOpen,
  projectColor,
}: {
  date: string;
  isToday: boolean;
  outsideMonth: boolean;
  tasks: Task[];
  expanded: boolean;
  onToggleExpand: () => void;
  onOpen: (id: number) => void;
  projectColor: (t: Task) => string | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: date });
  const shown = expanded ? tasks : tasks.slice(0, VISIBLE_PER_DAY);
  const hidden = tasks.length - shown.length;

  return (
    <div
      ref={setNodeRef}
      className={`calendar-day ${outsideMonth ? "outside" : ""} ${isOver ? "drop-target" : ""} ${expanded ? "expanded" : ""}`}
    >
      <span className={`calendar-daynum ${isToday ? "today" : ""}`}>
        {Number(date.slice(8))}
      </span>
      <div className="calendar-day-tasks">
        {shown.map((task) => (
          <CalendarChip
            key={task.id}
            task={task}
            color={projectColor(task)}
            onOpen={onOpen}
          />
        ))}
        {hidden > 0 && (
          <button className="calendar-more" onClick={onToggleExpand}>
            +{hidden} more
          </button>
        )}
        {expanded && hidden <= 0 && tasks.length > VISIBLE_PER_DAY && (
          <button className="calendar-more" onClick={onToggleExpand}>
            show less
          </button>
        )}
      </div>
    </div>
  );
}

function CalendarChip({
  task,
  color,
  onOpen,
}: {
  task: Task;
  color: string | undefined;
  onOpen: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });
  const overdue = isOverdue(task);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`calendar-chip ${task.status === "done" ? "done" : ""} ${overdue ? "overdue" : ""}`}
      style={{ opacity: isDragging ? 0.35 : undefined }}
      onClick={() => onOpen(task.id)}
      title={task.title}
    >
      <span
        className="calendar-chip-dot"
        style={{
          background:
            task.priority > 0 ? PRIORITY_COLORS[task.priority] : (color ?? "var(--text-faint)"),
        }}
      />
      <span className="calendar-chip-title">{task.title}</span>
    </div>
  );
}
