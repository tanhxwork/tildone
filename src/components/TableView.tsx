import { useMemo, useState } from "react";
import { useSettings } from "../settings";
import { visibleTasks } from "../selectors";
import { useStore } from "../store";
import type { Status, Task } from "../types";
import { PRIORITY_LABELS, STATUSES, STATUS_LABELS } from "../types";
import { isOverdue } from "../utils/dates";
import { format, parseISO } from "date-fns";
import { IconCheck, IconPencil, IconPlus } from "./Icons";

type SortKey = "title" | "project" | "priority" | "due" | "status" | "created";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Task" },
  { key: "project", label: "Project" },
  { key: "priority", label: "Priority" },
  { key: "due", label: "Due" },
  { key: "status", label: "Status" },
  { key: "created", label: "Created" },
];

export function TableView() {
  const {
    tasks,
    projects,
    selection,
    search,
    activeTagIds,
    priorityFilter,
    showCompleted,
    patchTask,
    toggleDone,
    addTask,
    openEditor,
  } = useStore();
  const defaultProjectId = useSettings((s) => s.defaultProjectId);
  const [sortKey, setSortKey] = useState<SortKey>("due");
  const [sortAsc, setSortAsc] = useState(true);
  const [newTitle, setNewTitle] = useState("");

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const rows = useMemo(() => {
    const visible = visibleTasks(tasks, selection, {
      search,
      activeTagIds,
      priorityFilter,
      showCompleted,
    });
    const dir = sortAsc ? 1 : -1;
    const name = (t: Task) =>
      t.project_id !== null ? (projectById.get(t.project_id)?.name ?? "") : "";
    return [...visible].sort((a, b) => {
      switch (sortKey) {
        case "title":
          return a.title.localeCompare(b.title) * dir;
        case "project":
          return name(a).localeCompare(name(b)) * dir;
        case "priority":
          return (a.priority - b.priority) * dir;
        case "due": {
          const da = a.due_date ?? "9999-12-31";
          const db = b.due_date ?? "9999-12-31";
          return da === db ? 0 : (da < db ? -1 : 1) * dir;
        }
        case "status":
          return (STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)) * dir;
        case "created":
          return (a.created_at < b.created_at ? -1 : 1) * dir;
      }
    });
  }, [tasks, selection, search, activeTagIds, priorityFilter, showCompleted, sortKey, sortAsc, projectById]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  async function submitNewRow() {
    const title = newTitle.trim();
    if (!title) return;
    await addTask({
      title,
      project_id:
        selection.type === "project" ? selection.projectId : defaultProjectId,
      due_date: null,
    });
    setNewTitle("");
  }

  return (
    <div className="table-view">
      <table className="task-table">
        <thead>
          <tr>
            <th className="col-check" />
            {COLUMNS.map((col) => (
              <th key={col.key}>
                <button className="table-sort" onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key && (
                    <span className="sort-arrow">{sortAsc ? "↑" : "↓"}</span>
                  )}
                </button>
              </th>
            ))}
            <th className="col-open" />
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => (
            <TableRow
              key={task.id}
              task={task}
              projectName={
                task.project_id !== null
                  ? (projectById.get(task.project_id)?.name ?? "")
                  : ""
              }
              projectColor={
                task.project_id !== null
                  ? projectById.get(task.project_id)?.color
                  : undefined
              }
              projects={projects}
              onPatch={patchTask}
              onToggle={toggleDone}
              onOpen={openEditor}
            />
          ))}
          <tr className="table-new-row">
            <td className="col-check">
              <IconPlus size={13} />
            </td>
            <td colSpan={COLUMNS.length + 1}>
              <input
                value={newTitle}
                placeholder="New row — type a title and press Enter"
                aria-label="New task title"
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submitNewRow()}
              />
            </td>
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="table-empty">No tasks match — add one below or clear filters.</p>
      )}
    </div>
  );
}

function TableRow({
  task,
  projectName,
  projectColor,
  projects,
  onPatch,
  onToggle,
  onOpen,
}: {
  task: Task;
  projectName: string;
  projectColor: string | undefined;
  projects: { id: number; name: string }[];
  onPatch: (id: number, patch: Partial<Omit<Task, "id" | "tag_ids" | "created_at">>) => Promise<void>;
  onToggle: (id: number) => Promise<void>;
  onOpen: (id: number) => void;
}) {
  const done = task.status === "done";
  const [title, setTitle] = useState(task.title);
  const [editingTitle, setEditingTitle] = useState(false);

  function commitTitle() {
    setEditingTitle(false);
    const trimmed = title.trim();
    if (trimmed && trimmed !== task.title) {
      void onPatch(task.id, { title: trimmed });
    } else {
      setTitle(task.title);
    }
  }

  return (
    <tr className={done ? "done" : ""}>
      <td className="col-check">
        <button
          className={`task-check ${done ? "checked" : ""}`}
          aria-label={done ? "Mark as not done" : "Mark as done"}
          onClick={() => void onToggle(task.id)}
        >
          {done && <IconCheck size={11} />}
        </button>
      </td>
      <td className="col-title">
        {editingTitle ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitle(task.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span
            className="table-title"
            onDoubleClick={() => setEditingTitle(true)}
            title="Double-click to rename"
          >
            {task.title}
          </span>
        )}
      </td>
      <td>
        <select
          className="table-select"
          value={task.project_id ?? ""}
          aria-label="Project"
          onChange={(e) =>
            void onPatch(task.id, {
              project_id: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        >
          <option value="">Inbox</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {projectColor && (
          <span className="project-dot table-dot" style={{ background: projectColor }} />
        )}
        <span className="visually-hidden">{projectName}</span>
      </td>
      <td>
        <select
          className="table-select"
          value={task.priority}
          aria-label="Priority"
          onChange={(e) => void onPatch(task.id, { priority: Number(e.target.value) })}
        >
          {[0, 1, 2, 3].map((p) => (
            <option key={p} value={p}>
              {p === 0 ? "—" : PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="date"
          className={`table-date ${isOverdue(task) ? "overdue" : ""}`}
          value={task.due_date ?? ""}
          aria-label="Due date"
          onChange={(e) => void onPatch(task.id, { due_date: e.target.value || null })}
        />
      </td>
      <td>
        <select
          className="table-select"
          value={task.status}
          aria-label="Status"
          onChange={(e) => void onPatch(task.id, { status: e.target.value as Status })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </td>
      {/* created_at may use SQLite's space-separated datetime, so parse the date part only */}
      <td className="col-created">{format(parseISO(task.created_at.slice(0, 10)), "MMM d")}</td>
      <td className="col-open">
        <button
          className="icon-btn"
          aria-label="Open task details"
          title="Open details"
          onClick={() => onOpen(task.id)}
        >
          <IconPencil size={13} />
        </button>
      </td>
    </tr>
  );
}
