import { useEffect, useState } from "react";
import { aiReady, useAI } from "../ai";
import { useStore } from "../store";
import type { Status } from "../types";
import { PRIORITY_COLORS, PRIORITY_LABELS, STATUSES, STATUS_LABELS } from "../types";
import { IconFlag, IconSparkles, IconTrash, IconX } from "./Icons";
import {
  Button,
  Segmented,
  TagChip,
  field,
  fieldLabel,
  iconBtn,
  inputBase,
  tagDeleteClass,
} from "./ui";

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
    addTask,
  } = useStore();
  const aiConfig = useAI((s) => s.config);
  const chat = useAI((s) => s.chat);

  const task = tasks.find((t) => t.id === editingTaskId);

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes);
      setTagInput("");
      setConfirmDelete(false);
      setAiError("");
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

  async function breakIntoSubtasks() {
    setAiBusy(true);
    setAiError("");
    try {
      const context = task!.notes ? `${task!.title}\n\nNotes: ${task!.notes}` : task!.title;
      const reply = await chat(
        "You break a task into small actionable subtasks. Reply with one subtask per line, 3 to 6 lines. Each line is a short imperative phrase. No numbering, no bullets, no headings, no extra commentary.",
        `Break this task into subtasks:\n\n${context}`,
      );
      const lines = reply
        .split("\n")
        .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
        .filter((l) => l.length > 2)
        .slice(0, 8);
      if (lines.length === 0) {
        setAiError("The AI did not return any subtasks — try again.");
        return;
      }
      for (const line of lines) {
        await addTask({ title: line, project_id: task!.project_id, due_date: null });
      }
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  const taskTags = tags.filter((t) => task.tag_ids.includes(t.id));
  const availableTags = tags.filter((t) => !task.tag_ids.includes(t.id));

  return (
    <aside
      className="flex w-[300px] shrink-0 flex-col border-l border-edge bg-sidebar"
      aria-label="Task details"
    >
      <div className="flex items-center justify-between px-3.5 pb-2 pt-10">
        <span className="text-[11px] font-semibold uppercase tracking-[0.5px] text-ink-faint">
          Details
        </span>
        <button className={iconBtn} aria-label="Close details" onClick={() => openEditor(null)}>
          <IconX />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-3.5">
        <input
          className="w-full rounded-md border border-edge bg-card px-2.5 py-[7px] text-[14px] font-semibold focus:border-accent focus:outline-none"
          value={title}
          aria-label="Task title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />

        <textarea
          className="min-h-[70px] w-full resize-y rounded-md border border-edge bg-card px-2.5 py-[7px] focus:border-accent focus:outline-none"
          value={notes}
          placeholder="Notes…"
          aria-label="Task notes"
          rows={4}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
        />

        {aiReady(aiConfig) && (
          <div className={field}>
            <Button
              variant="accent"
              className="self-start"
              disabled={aiBusy}
              onClick={() => void breakIntoSubtasks()}
            >
              <IconSparkles size={13} />
              {aiBusy ? "Thinking…" : "Break into subtasks"}
            </Button>
            {aiError && (
              <p className="text-[12px] text-danger wrap-anywhere">{aiError}</p>
            )}
          </div>
        )}

        <div className={field}>
          <span className={fieldLabel}>Status</span>
          <Segmented
            full
            value={task.status}
            onChange={(status: Status) => void patchTask(task.id, { status })}
            options={STATUSES.map((status: Status) => ({
              value: status,
              label: STATUS_LABELS[status],
            }))}
          />
        </div>

        <div className={field}>
          <span className={fieldLabel}>Priority</span>
          <Segmented
            full
            value={task.priority}
            onChange={(priority) => void patchTask(task.id, { priority })}
            options={[0, 1, 2, 3].map((priority) => ({
              value: priority,
              label: (
                <>
                  {priority > 0 && (
                    <IconFlag size={11} style={{ color: PRIORITY_COLORS[priority] }} />
                  )}
                  {PRIORITY_LABELS[priority]}
                </>
              ),
            }))}
          />
        </div>

        <label className={field}>
          <span className={fieldLabel}>Due date</span>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              className="flex-1 cursor-pointer rounded-md border border-edge bg-card px-2 py-1 focus:border-accent focus:outline-none"
              value={task.due_date ?? ""}
              onChange={(e) => patchTask(task.id, { due_date: e.target.value || null })}
            />
            {task.due_date && (
              <button
                className={iconBtn}
                aria-label="Clear due date"
                onClick={() => patchTask(task.id, { due_date: null })}
              >
                <IconX size={12} />
              </button>
            )}
          </div>
        </label>

        <label className={field}>
          <span className={fieldLabel}>Project</span>
          <select
            className={`${inputBase} cursor-pointer`}
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

        <div className={field}>
          <span className={fieldLabel}>Tags</span>
          {taskTags.length > 0 && (
            <div className="flex flex-wrap gap-[5px]">
              {taskTags.map((tag) => (
                <TagChip key={tag.id} color={tag.color} active>
                  {tag.name}
                  <button
                    className={tagDeleteClass()}
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
                </TagChip>
              ))}
            </div>
          )}
          <input
            className={inputBase}
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

      <div className="border-t border-edge px-3.5 py-3">
        {confirmDelete ? (
          <Button variant="danger" onClick={() => removeTask(task.id)}>
            Confirm delete
          </Button>
        ) : (
          <Button variant="ghost-danger" onClick={() => setConfirmDelete(true)}>
            <IconTrash size={13} />
            Delete task
          </Button>
        )}
      </div>
    </aside>
  );
}
