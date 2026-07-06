import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Status } from "../types";
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUSES, STATUS_LABELS } from "../types";
import { IconFlag, IconTrash, IconX } from "./Icons";

export function TaskEditor() {
  const {
    tasks,
    projects,
    tags,
    editingTaskId,
    openEditor,
    patchTask,
    removeTask,
    addTag,
    assignTags,
  } = useStore();

  const task = tasks.find((t) => t.id === editingTaskId);

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes);
      setTagInput("");
      setConfirmDelete(false);
    }
    // Re-sync local fields only when switching to a different task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  if (!task) return null;

  function commitTitle() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== task!.title) {
      void patchTask(task!.id, { title: trimmed });
    } else {
      setTitle(task!.title);
    }
  }

  function commitNotes() {
    if (notes !== task!.notes) {
      void patchTask(task!.id, { notes });
    }
  }

  async function addTagFromInput() {
    const name = tagInput.trim();
    if (!name) return;
    const id = await addTag(name);
    if (!task!.tag_ids.includes(id)) {
      await assignTags(task!.id, [...task!.tag_ids, id]);
    }
    setTagInput("");
  }

  const taskTags = tags.filter((t) => task.tag_ids.includes(t.id));
  const availableTags = tags.filter((t) => !task.tag_ids.includes(t.id));

  return (
    <aside className="editor" aria-label="Task details">
      <div className="editor-header">
        <span className="editor-heading">Details</span>
        <button className="icon-btn" aria-label="Close details" onClick={() => openEditor(null)}>
          <IconX />
        </button>
      </div>

      <div className="editor-body">
        <input
          className="editor-title"
          value={title}
          aria-label="Task title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />

        <textarea
          className="editor-notes"
          value={notes}
          placeholder="Notes…"
          aria-label="Task notes"
          rows={4}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
        />

        <div className="field">
          <span className="field-label">Status</span>
          <div className="segmented full">
            {STATUSES.map((status: Status) => (
              <button
                key={status}
                className={task.status === status ? "active" : ""}
                onClick={() => patchTask(task.id, { status })}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Priority</span>
          <div className="segmented full">
            {[0, 1, 2, 3].map((priority) => (
              <button
                key={priority}
                className={task.priority === priority ? "active" : ""}
                onClick={() => patchTask(task.id, { priority })}
              >
                {priority > 0 && (
                  <IconFlag size={11} style={{ color: PRIORITY_COLORS[priority] }} />
                )}
                {PRIORITY_LABELS[priority]}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field-label">Due date</span>
          <div className="date-row">
            <input
              type="date"
              value={task.due_date ?? ""}
              onChange={(e) => patchTask(task.id, { due_date: e.target.value || null })}
            />
            {task.due_date && (
              <button
                className="icon-btn"
                aria-label="Clear due date"
                onClick={() => patchTask(task.id, { due_date: null })}
              >
                <IconX size={12} />
              </button>
            )}
          </div>
        </label>

        <label className="field">
          <span className="field-label">Project</span>
          <select
            value={task.project_id ?? ""}
            onChange={(e) =>
              patchTask(task.id, {
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
        </label>

        <div className="field">
          <span className="field-label">Tags</span>
          <div className="editor-tags">
            {taskTags.map((tag) => (
              <span
                key={tag.id}
                className="tag-chip active"
                style={{ ["--tag-color" as string]: tag.color }}
              >
                {tag.name}
                <button
                  className="tag-delete"
                  aria-label={`Remove tag ${tag.name}`}
                  onClick={() =>
                    assignTags(
                      task.id,
                      task.tag_ids.filter((id) => id !== tag.id),
                    )
                  }
                >
                  <IconX size={11} />
                </button>
              </span>
            ))}
          </div>
          <input
            value={tagInput}
            placeholder="Add tag and press Enter…"
            aria-label="Add tag"
            list="tag-options"
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTagFromInput()}
          />
          <datalist id="tag-options">
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="editor-footer">
        {confirmDelete ? (
          <button className="btn danger" onClick={() => removeTask(task.id)}>
            Confirm delete
          </button>
        ) : (
          <button className="btn ghost-danger" onClick={() => setConfirmDelete(true)}>
            <IconTrash size={13} />
            Delete task
          </button>
        )}
      </div>
    </aside>
  );
}
