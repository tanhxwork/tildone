import { useEffect, useRef, useState } from "react";
import { format, parseISO } from "date-fns";
import { openUrl } from "@tauri-apps/plugin-opener";
import { aiReady, useAI } from "../ai";
import { useStore } from "../store";
import type { Status } from "../types";
import {
  LINK_KIND_COLORS,
  LINK_KIND_LABELS,
  PRIORITY_LABELS,
  STATUSES,
  STATUS_LABELS,
  asLinkKind,
} from "../types";
import { relativeDueLabel, timeAgo } from "../utils/dates";
import { isHttpUrl } from "../utils/links";
import {
  IconCheck,
  IconLink,
  IconMessage,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconX,
  LinkKindIcon,
} from "./Icons";
import { agentIdentity } from "../agents";
import { Markdown } from "./Markdown";

export function TaskEditor() {
  const {
    tasks,
    projects,
    tags,
    subtasks,
    activity,
    editingTaskId,
    openEditor,
    patchTask,
    removeTask,
    toggleDone,
    addTag,
    assignTags,
    addSubtask,
    toggleSubtask,
    removeSubtask,
    links,
    addLink,
    removeLink,
    comments,
    addComment,
  } = useStore();
  const aiConfig = useAI((s) => s.config);
  const chat = useAI((s) => s.chat);

  const task = tasks.find((t) => t.id === editingTaskId);

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [tagInput, setTagInput] = useState("");
  const [subtaskInput, setSubtaskInput] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [commentInput, setCommentInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes);
      setTagInput("");
      setSubtaskInput("");
      setLinkInput("");
      setCommentInput("");
      setConfirmDelete(false);
      setAiError("");
      setEditingNotes(false);
    }
    // Re-sync local fields only when switching to a different task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // Focus the notes textarea the moment it swaps in for the rendered view.
  useEffect(() => {
    if (editingNotes) notesRef.current?.focus();
  }, [editingNotes]);

  if (!task) return null;

  const project = projects.find((p) => p.id === task.project_id);
  const taskSubtasks = subtasks.filter((s) => s.task_id === task.id);
  const doneCount = taskSubtasks.filter((s) => s.done).length;
  const taskTags = tags.filter((t) => task.tag_ids.includes(t.id));
  const availableTags = tags.filter((t) => !task.tag_ids.includes(t.id));
  const taskLinks = links[task.id] ?? [];

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

  async function addSubtaskFromInput() {
    const value = subtaskInput.trim();
    if (!value) return;
    await addSubtask(task!.id, value);
    setSubtaskInput("");
  }

  async function addLinkFromInput() {
    const url = linkInput.trim();
    if (!isHttpUrl(url)) return;
    await addLink(task!.id, url);
    setLinkInput("");
  }

  async function addCommentFromInput() {
    const body = commentInput.trim();
    if (!body) return;
    await addComment(task!.id, body);
    setCommentInput("");
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
        await addSubtask(task!.id, line);
      }
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  const createdLabel = format(parseISO(task.created_at), "MMMM d, yyyy");

  return (
    <div className="modal-overlay detail-overlay" onClick={() => openEditor(null)}>
      <div
        className="detail-card"
        role="dialog"
        aria-label="Task details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="detail-topbar">
          <span className="detail-breadcrumb">
            {project ? (
              <>
                <span className="project-dot" style={{ background: project.color }} />
                {project.name}
              </>
            ) : (
              "Inbox"
            )}
            <span className="detail-breadcrumb-sep">/</span>
            <span className="detail-breadcrumb-task">{task.title}</span>
          </span>
          <button className="icon-btn" aria-label="Close details" onClick={() => openEditor(null)}>
            <IconX size={14} />
          </button>
        </div>

        <div className="detail-body">
          <div className="detail-title-row">
            <button
              className={`detail-check ${task.status === "done" ? "checked" : ""}`}
              aria-label={task.status === "done" ? "Mark as not done" : "Mark as done"}
              onClick={() => void toggleDone(task.id)}
            >
              {task.status === "done" && <IconCheck size={12} />}
            </button>
            <textarea
              className="detail-title"
              value={title}
              // field-sizing:content handles growth where supported; rows is the fallback
              rows={Math.max(1, Math.ceil(title.length / 42))}
              aria-label="Task title"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
            />
          </div>

          <div className="detail-props">
            <span className="detail-prop-label">Status</span>
            <span>
              <select
                className={`detail-status ${task.status}`}
                value={task.status}
                aria-label="Status"
                onChange={(e) => void patchTask(task.id, { status: e.target.value as Status })}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </span>

            <span className="detail-prop-label">Priority</span>
            <span>
              <select
                className={`detail-value-select ${task.priority > 0 ? `prio-${task.priority}` : "empty"}`}
                value={task.priority}
                aria-label="Priority"
                onChange={(e) => void patchTask(task.id, { priority: Number(e.target.value) })}
              >
                {[0, 1, 2, 3].map((p) => (
                  <option key={p} value={p}>
                    {p === 0 ? "None" : PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </span>

            <span className="detail-prop-label">Due date</span>
            <span className="detail-due">
              <input
                type="date"
                className="detail-value-select"
                value={task.due_date ?? ""}
                aria-label="Due date"
                onChange={(e) => void patchTask(task.id, { due_date: e.target.value || null })}
              />
              {task.due_date && (
                <>
                  <span className="detail-due-relative">· {relativeDueLabel(task.due_date)}</span>
                  <button
                    className="icon-btn detail-due-clear"
                    aria-label="Clear due date"
                    onClick={() => void patchTask(task.id, { due_date: null })}
                  >
                    <IconX size={11} />
                  </button>
                </>
              )}
            </span>

            <span className="detail-prop-label">Project</span>
            <span>
              <select
                className="detail-value-select"
                value={task.project_id ?? ""}
                aria-label="Project"
                onChange={(e) =>
                  void patchTask(task.id, {
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
            </span>

            <span className="detail-prop-label">Tags</span>
            <span className="detail-tags">
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
              <input
                className="detail-tag-add"
                value={tagInput}
                placeholder="+ Add"
                aria-label="Add tag"
                list="tag-options"
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addTagFromInput()}
              />
              <datalist id="tag-options">
                {availableTags.map((tag) => (
                  <option key={tag.id} value={tag.name} />
                ))}
              </datalist>
            </span>

            <span className="detail-prop-label">Created</span>
            <span className="detail-created">{createdLabel}</span>
          </div>

          {editingNotes ? (
            <textarea
              ref={notesRef}
              className="detail-notes"
              value={notes}
              placeholder="Add notes…"
              aria-label="Task notes"
              rows={Math.max(3, notes.split("\n").length + 1)}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                commitNotes();
                setEditingNotes(false);
              }}
            />
          ) : notes.trim() ? (
            <div
              className="detail-notes detail-notes-rendered"
              tabIndex={0}
              aria-label="Task notes, click to edit"
              onClick={() => setEditingNotes(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditingNotes(true);
                }
              }}
            >
              <Markdown>{notes}</Markdown>
            </div>
          ) : (
            <div
              className="detail-notes detail-notes-empty"
              role="button"
              tabIndex={0}
              aria-label="Add notes"
              onClick={() => setEditingNotes(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditingNotes(true);
                }
              }}
            >
              Add notes…
            </div>
          )}

          <section className="detail-section">
            <h3 className="detail-section-title">
              Subtasks
              {taskSubtasks.length > 0 && (
                <span className="detail-section-count">
                  {doneCount} of {taskSubtasks.length}
                </span>
              )}
              {aiReady(aiConfig) && (
                <button
                  className="btn small ai-action detail-ai"
                  disabled={aiBusy}
                  onClick={() => void breakIntoSubtasks()}
                >
                  <IconSparkles size={12} />
                  {aiBusy ? "Thinking…" : "Break it down"}
                </button>
              )}
            </h3>
            {aiError && <p className="ai-error">{aiError}</p>}
            <div className="detail-subtasks">
              {taskSubtasks.map((sub) => (
                <div key={sub.id} className={`detail-subtask ${sub.done ? "done" : ""}`}>
                  <button
                    className={`detail-subcheck ${sub.done ? "checked" : ""}`}
                    aria-label={sub.done ? "Mark subtask as not done" : "Mark subtask as done"}
                    onClick={() => void toggleSubtask(sub.id)}
                  >
                    {sub.done && <IconCheck size={10} />}
                  </button>
                  <span className="detail-subtask-title">{sub.title}</span>
                  <button
                    className="icon-btn detail-subtask-remove"
                    aria-label={`Delete subtask ${sub.title}`}
                    onClick={() => void removeSubtask(sub.id)}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              ))}
              <div className="detail-subtask-add">
                <IconPlus size={12} />
                <input
                  value={subtaskInput}
                  placeholder="Add subtask"
                  aria-label="Add subtask"
                  onChange={(e) => setSubtaskInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addSubtaskFromInput()}
                />
              </div>
            </div>
          </section>

          <section className="detail-section">
            <h3 className="detail-section-title">
              Links
              {taskLinks.length > 0 && (
                <span className="detail-section-count">{taskLinks.length}</span>
              )}
            </h3>
            <div className="detail-links">
              {taskLinks.map((link) => {
                const kind = asLinkKind(link.kind);
                return (
                  <span
                    key={link.id}
                    className="link-chip"
                    style={{ ["--link-color" as string]: LINK_KIND_COLORS[kind] }}
                  >
                    <button
                      className="link-chip-open"
                      title={`${LINK_KIND_LABELS[kind]} · ${link.url}`}
                      onClick={() => void openUrl(link.url)}
                    >
                      <LinkKindIcon kind={link.kind} size={13} />
                      <span className="link-chip-label">{link.label}</span>
                    </button>
                    <button
                      className="link-delete"
                      aria-label={`Remove link ${link.label}`}
                      onClick={() => void removeLink(task.id, link.id)}
                    >
                      <IconX size={11} />
                    </button>
                  </span>
                );
              })}
              <div className="detail-link-add">
                <IconLink size={12} />
                <input
                  value={linkInput}
                  placeholder="Paste a PR, branch, or commit URL"
                  aria-label="Add link"
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addLinkFromInput()}
                />
              </div>
            </div>
          </section>

          <section className="detail-section">
            <h3 className="detail-section-title">
              Comments
              {comments.length > 0 && (
                <span className="detail-section-count">{comments.length}</span>
              )}
            </h3>
            <div className="detail-comments">
              {comments.map((c) => {
                // Every comment is authored (migration 012 makes actor_kind NOT NULL),
                // so — unlike the activity feed's legacy rows — there is always an
                // author to show. Agents render through the same identity mapping the
                // activity feed uses; the user is simply "You".
                const agent = c.actor_kind === "agent" ? agentIdentity(c.actor_name) : null;
                return (
                  <div key={c.id} className="detail-comment">
                    <div className="detail-comment-head">
                      {agent ? (
                        <span
                          className="detail-comment-author agent"
                          style={{ ["--agent-color" as string]: agent.color }}
                        >
                          <agent.Mark size={13} />
                          {agent.label}
                        </span>
                      ) : (
                        <span className="detail-comment-author">You</span>
                      )}
                      <span className="detail-comment-time">{timeAgo(c.created_at)}</span>
                    </div>
                    <div className="detail-comment-body">
                      <Markdown>{c.body}</Markdown>
                    </div>
                  </div>
                );
              })}
              <div className="detail-comment-add">
                <IconMessage size={13} />
                <input
                  value={commentInput}
                  placeholder="Write a comment — an agent watching this task will see it"
                  aria-label="Add comment"
                  onChange={(e) => setCommentInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addCommentFromInput()}
                />
              </div>
            </div>
          </section>

          {activity.length > 0 && (
            <section className="detail-section">
              <h3 className="detail-section-title">Activity</h3>
              <div className="detail-activity">
                {activity.map((entry) => {
                  // Legacy rows (pre-006) have no actor and render as before — no
                  // mark, so an unknown author is shown as unknown, not guessed.
                  const agent =
                    entry.actor_kind === "agent"
                      ? agentIdentity(entry.actor_name)
                      : null;
                  return (
                    <div key={entry.id} className="detail-activity-row">
                      <span className="detail-activity-time">
                        {timeAgo(entry.created_at)}
                      </span>
                      {agent && (
                        <span
                          className="detail-activity-actor"
                          style={{ ["--agent-color" as string]: agent.color }}
                          title={`${agent.label} (agent)`}
                        >
                          <agent.Mark size={12} />
                        </span>
                      )}
                      <span className="detail-activity-label">
                        <Markdown inline>{entry.label}</Markdown>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <div className="detail-footer">
          {confirmDelete ? (
            <button className="btn small danger" onClick={() => void removeTask(task.id)}>
              Move to trash?
            </button>
          ) : (
            <button className="btn small ghost-danger" onClick={() => setConfirmDelete(true)}>
              <IconTrash size={12} />
              Delete task
            </button>
          )}
          <span className="detail-footer-hint">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
