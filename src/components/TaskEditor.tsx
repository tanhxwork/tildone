import { useCallback, useEffect, useRef, useState } from "react";
import { format, parseISO } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { aiReady, useAI } from "../ai";
import { usePaneStore } from "../paneStore";
import { useStore } from "../store";
import type { Status, TaskImage, TaskLink } from "../types";
import {
  LINK_KIND_COLORS,
  LINK_KIND_LABELS,
  PRIORITY_LABELS,
  STATUSES,
  STATUS_LABELS,
  asLinkKind,
  isVerifyStep,
  verifyStepLabel,
} from "../types";
import { relativeDueLabel, timeAgo } from "../utils/dates";
import {
  formatImageBytes,
  imageAbsPath,
  imageSrc,
  imagesFromClipboardRead,
  imagesFromDataTransfer,
  imagesFromPaths,
  releasePending,
  useImageBase,
} from "../utils/images";
import { useDropTarget } from "../fileDrop";
import { isFileEvidence, isHttpUrl, isRevealOnlyEvidence } from "../utils/links";
import { imageEmbedMarkdown } from "../utils/markdownTaskRefs";
import { useLightbox } from "../lightbox";
import {
  FileEvidenceIcon,
  IconAlert,
  IconCheck,
  IconFileText,
  IconFolderOpen,
  IconGitBranch,
  IconLink,
  IconMaximize,
  IconMessage,
  IconMinimize,
  IconPlus,
  IconSparkles,
  IconTerminal,
  IconTrash,
  IconX,
  LinkKindIcon,
} from "./Icons";
import { adapterMark, agentIdentity } from "../agents";
import { useArtifactStore } from "../artifactStore";
import {
  hostedForTask,
  resumableForTask,
  useHostStore,
  type HostSession,
  type Resumable,
} from "../hostStore";
import { Markdown } from "./Markdown";
import { NotesView } from "./NotesView";
import { prChip } from "./prChip";
import { ProjectGlyph } from "./ProjectGlyph";
import { reservedState } from "./TaskRow";

/** Labels the MCP server writes for structural edits (status, subtasks, links,
 *  dates, moves). Anything else from an agent in the feed is its own
 *  log_progress prose — the evidence the review band quotes. */
const STRUCTURAL_ACTIVITY =
  /^(Task created$|Status changed to |Priority set to |Priority cleared$|Due date set to |Due date cleared$|Moved to |Subtask (added|renamed|removed|completed|reopened): |Link (added|removed): )/;

// Expanded-card preference survives relaunch, like the nav selection does.
const EXPANDED_STORAGE_KEY = "tildone.detail-expanded";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistExpanded(expanded: boolean) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // ignore quota/serialization errors — persistence is best-effort
  }
}

export function TaskEditor() {
  const {
    tasks,
    projects,
    tags,
    subtasks,
    activity,
    reviewFlaggedAt,
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
    images,
    attachImages,
    removeImage,
    comments,
    addComment,
    live,
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
  const [linkError, setLinkError] = useState("");
  const [commentInput, setCommentInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [jumpMiss, setJumpMiss] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  // The disarm timer for "stop for sure?" — held so a task switch or rearm
  // clears it; TaskEditor is one persistent instance across tasks, and an
  // orphaned timer would disarm the NEXT task's fresh confirm early.
  const killDisarmRef = useRef<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const hostSessions = useHostStore((s) => s.sessions);
  const hostAdapters = useHostStore((s) => s.adapters);
  const lightboxOpen = useLightbox((s) => s.open);
  useImageBase();

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes);
      setTagInput("");
      setSubtaskInput("");
      setLinkInput("");
      setLinkError("");
      setCommentInput("");
      setConfirmDelete(false);
      setAiError("");
      setJumpMiss(false);
      setConfirmKill(false);
      if (killDisarmRef.current) {
        window.clearTimeout(killDisarmRef.current);
        killDisarmRef.current = null;
      }
      setStarting(false);
      setSessionError("");
      setEditingNotes(false);
    }
    // Re-sync local fields only when switching to a different task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // Focus the notes textarea the moment it swaps in for the rendered view.
  useEffect(() => {
    if (editingNotes) notesRef.current?.focus();
  }, [editingNotes]);

  // Dropping image files anywhere on the open card attaches them straight away —
  // the task already exists, so unlike Quick Add there is nothing to hold.
  const dropTaskId = task?.id;
  const onDropFiles = useCallback(
    (paths: string[]) => {
      if (dropTaskId === undefined) return;
      void imagesFromPaths(paths).then(async ({ images: dropped }) => {
        if (dropped.length === 0) return;
        try {
          await attachImages(dropTaskId, dropped);
        } finally {
          releasePending(dropped);
        }
      });
    },
    [dropTaskId, attachImages],
  );
  const { isOver, dropProps } = useDropTarget("task-editor", onDropFiles);

  if (!task) return null;

  const project = projects.find((p) => p.id === task.project_id);
  const taskSubtasks = subtasks.filter((s) => s.task_id === task.id);
  // Verify steps split out of the build checklist only while the task is in
  // review — same rule and reason as the board card (Kanban.tsx): the tag coming
  // off must fold them back into plain subtasks, not orphan them.
  const inReview = reservedState(task, tags) === "needs-review";
  const verifySteps = inReview ? taskSubtasks.filter(isVerifyStep) : [];
  const buildSubtasks = inReview
    ? taskSubtasks.filter((s) => !isVerifyStep(s))
    : taskSubtasks;
  const doneCount = buildSubtasks.filter((s) => s.done).length;
  const taskTags = tags.filter((t) => task.tag_ids.includes(t.id));
  const availableTags = tags.filter((t) => !task.tag_ids.includes(t.id));
  const taskLinks = links[task.id] ?? [];
  const taskImages = images[task.id] ?? [];
  // The band quotes what the agent asserted: its most recent log_progress lines
  // (structural rows and user rows filtered out), oldest first.
  const evidence = inReview
    ? activity
        .filter((a) => a.actor_kind === "agent" && !STRUCTURAL_ACTIVITY.test(a.label))
        .slice(0, 3)
        .reverse()
    : [];
  const prLinks = taskLinks.filter((l) => asLinkKind(l.kind) === "pr");
  const prLink = inReview && prLinks.length > 0 ? prLinks[prLinks.length - 1] : null;
  // Live presence only — the fallback (age of the last board write) names no
  // session and so has nothing an Agent row could say beyond what the card does.
  const presence = live[task.id];
  const presenceAgent = presence ? agentIdentity(presence.agent_name) : null;
  const presenceCwdBase = presence?.cwd ? presence.cwd.split("/").filter(Boolean).pop() : null;
  // The board-hosted session on this task, if any (spec
  // 2026-07-19-hosted-agent-sessions). Independent of `presence`: aliveness
  // here is owned-process fact, not a heartbeat.
  const hosted = hostedForTask(hostSessions, task.id);
  const HostedMark = hosted ? adapterMark(hosted.adapter_id) : null;
  // F3: a dead-but-resumable session from a previous run. Only offered when
  // no current session exists — a live one always wins the row.
  const hostResumables = useHostStore((s) => s.resumables);
  const resumable = hosted ? null : resumableForTask(hostResumables, task.id);
  const ResumableMark = resumable ? adapterMark(resumable.adapter_id) : null;
  // Artifact digest (F1): durable-trace facts for this task, if any exist.
  const artifacts = useArtifactStore((s) => s.facts[task.id]);

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

  /** Append an inline embed of an attached image to the notes. Writes through
   *  patchTask rather than only the local `notes` state, so the ref survives
   *  whether or not the notes textarea is currently open. */
  function insertImageInNotes(img: TaskImage) {
    const ref = imageEmbedMarkdown(img.id, img.filename);
    const next = notes.trim() ? `${notes.replace(/\s+$/, "")}\n\n${ref}` : ref;
    setNotes(next);
    void patchTask(task!.id, { notes: next });
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
    const value = linkInput.trim();
    if (!isHttpUrl(value) && !isFileEvidence(value)) {
      if (value) {
        setLinkError("Add an http(s) link, or an absolute path to a document or image.");
      }
      return;
    }
    setLinkError("");
    await addLink(task!.id, value);
    setLinkInput("");
  }

  // A file opens in its default app (openPath); a URL opens in the browser. A
  // moved or deleted file surfaces an inline message rather than a dead click.
  // HTML/SVG would run script if handed to the browser, so those reveal in
  // Finder instead — the user opens them deliberately if they trust the source.
  async function openLink(link: TaskLink) {
    if (asLinkKind(link.kind) === "file") {
      if (isRevealOnlyEvidence(link.url)) {
        void revealItemInDir(link.url);
        return;
      }
      try {
        await openPath(link.url);
        setLinkError("");
      } catch {
        setLinkError(`Can't find ${link.label} — was it moved?`);
      }
    } else {
      void openUrl(link.url);
    }
  }

  // Board → session, routed by where the session lives (spec
  // 2026-07-19-embedded-attach-pane): a terminal-hosted session gets its
  // window raised; a background session gets the embedded attach pane. Every
  // "cannot" — headless raise, unknown session, Automation denied — answers
  // with the same quiet inline note, never an error dialog: an unreachable
  // session is a fact about where it runs, not a failure of the click.
  async function jumpToSession() {
    if (!presence || !task) return;
    // Routing order (spec 2026-07-19-hosted-agent-sessions): a live hosted
    // session on this task always wins — the app owns it, so the landing is
    // deterministic; the daemon arms below are for sessions born elsewhere.
    if (hosted && !hosted.exited) {
      openHostedPane(hosted);
      return;
    }
    let ok = false;
    try {
      if (presence.reachable) {
        ok = await invoke<boolean>("focus_session", { sessionId: presence.session_id });
      } else if (presence.attachable) {
        const shortId = await invoke<string | null>("attach_target", {
          sessionId: presence.session_id,
        });
        if (shortId) {
          usePaneStore.getState().openPane({
            kind: "attach",
            sessionId: presence.session_id,
            shortId,
            taskRef: task.ref,
            taskId: task.id,
            name: presence.agent_name,
          });
          // The pane needs the board strip beside it — the modal editor
          // would cover both.
          openEditor(null);
          ok = true;
        }
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      setJumpMiss(true);
      window.setTimeout(() => setJumpMiss(false), 2500);
    }
  }

  /** Show a hosted session in the pane — the start's first landing and every
   *  re-jump alike. The pane's mount runs `host_attach`, replaying the
   *  buffer, so nothing more is needed here. */
  function openHostedPane(session: HostSession) {
    usePaneStore.getState().openPane({
      kind: "hosted",
      hostId: session.id,
      sessionId: `hosted-${session.id}`,
      taskRef: task!.ref,
      taskId: task!.id,
      name: session.adapter_name,
    });
    openEditor(null);
  }

  async function startHostedSession(adapterId: string) {
    if (!task || starting) return;
    setStarting(true);
    setSessionError("");
    try {
      // 80×24 is only the spawn size; the pane's first attach resizes the
      // PTY to its real dimensions and the TUI reflows via SIGWINCH.
      const id = await invoke<number>("host_start", {
        taskId: task.id,
        taskRef: task.ref,
        adapterId,
        claimCwd: presence?.cwd ?? null,
        projectName: project?.name ?? null,
        prompt: task.ref,
        cols: 80,
        rows: 24,
      });
      openHostedPane({
        id,
        task_id: task.id,
        task_ref: task.ref,
        adapter_id: adapterId,
        adapter_name: hostAdapters.find((a) => a.id === adapterId)?.name ?? adapterId,
        exited: false,
        waiting: false,
        bound: false,
      });
    } catch (e) {
      setSessionError(String(e));
    } finally {
      setStarting(false);
    }
  }

  // F3: bring a previous run's session back on a fresh PTY via the adapter's
  // resume argv. The row is consumed server-side; host-changed refreshes the
  // store with the real new session.
  async function resumeHostedSession(r: Resumable) {
    setStarting(true);
    setSessionError("");
    try {
      const id = await invoke<number>("host_resume", {
        rowId: r.row_id,
        cols: 80,
        rows: 24,
      });
      openHostedPane({
        id,
        task_id: r.task_id,
        task_ref: r.task_ref,
        adapter_id: r.adapter_id,
        adapter_name: r.adapter_name,
        exited: false,
        waiting: false,
        bound: false,
      });
    } catch (e) {
      setSessionError(String(e));
    } finally {
      setStarting(false);
    }
  }

  /** Stop (two-step confirm) a live hosted session, or dismiss an exited one
   *  — same command; a dead child makes the kill half a no-op. */
  async function killHostedSession(session: HostSession) {
    try {
      await invoke("host_kill", { sessionId: session.id });
    } catch (e) {
      setSessionError(String(e));
    }
    setConfirmKill(false);
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

  /** ⌘V anywhere in the open card attaches clipboard images to this task. Text
   *  pastes fall through untouched — only image items are intercepted, so the
   *  notes/title/tag inputs keep their normal paste behavior. */
  function onEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const data = e.clipboardData;
    if (!data || !task) return;
    const hasImage = Array.from(data.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (!hasImage) return;
    // Pasting a mixed clipboard (image + text) into the title or notes keeps
    // its text half: default paste inserts the text, the image still attaches.
    const editable =
      e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (!(editable && data.types.includes("text/plain"))) e.preventDefault();
    const taskId = task.id;
    void imagesFromDataTransfer(data).then(async ({ images: pasted }) => {
      if (pasted.length === 0) return;
      try {
        await attachImages(taskId, pasted);
      } finally {
        releasePending(pasted);
      }
    });
  }

  /** The Images row's add tile. clipboard.read may be unavailable or denied in
   *  the webview — then the tile stays a ⌘V signpost and the click is a no-op. */
  async function pasteImageFromClipboard() {
    if (!task) return;
    try {
      const { images: pasted } = await imagesFromClipboardRead();
      if (pasted.length === 0) return;
      try {
        await attachImages(task.id, pasted);
      } finally {
        releasePending(pasted);
      }
    } catch {
      // No clipboard access: ⌘V (onEditorPaste) remains the way in.
    }
  }

  function toggleExpanded() {
    setExpanded((prev) => {
      persistExpanded(!prev);
      return !prev;
    });
  }

  return (
    <div className="modal-overlay detail-overlay" onClick={() => openEditor(null)}>
      <div
        className={`detail-card ${expanded ? "expanded" : ""}${isOver ? " drop-over" : ""}`}
        role="dialog"
        aria-label="Task details"
        onClick={(e) => e.stopPropagation()}
        onPaste={onEditorPaste}
        {...dropProps}
      >
        <div className="detail-topbar">
          <span className="detail-breadcrumb">
            {project ? (
              <>
                <ProjectGlyph project={project} size={14} />
                {project.name}
              </>
            ) : (
              "Inbox"
            )}
            <span className="detail-breadcrumb-sep">/</span>
            <span className="detail-breadcrumb-task">{task.title}</span>
          </span>
          <span className="detail-topbar-actions">
            <button
              className="icon-btn"
              aria-label={expanded ? "Collapse details" : "Expand details"}
              title={expanded ? "Collapse" : "Expand"}
              onClick={toggleExpanded}
            >
              {expanded ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
            </button>
            <button className="icon-btn" aria-label="Close details" onClick={() => openEditor(null)}>
              <IconX size={14} />
            </button>
          </span>
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

            <span className="detail-prop-label">Images</span>
            <span className="detail-images">
              {taskImages.map((img, i) => {
                const src = imageSrc(img);
                return (
                  <span key={img.id} className="detail-image">
                    <button
                      type="button"
                      className="detail-image-thumb"
                      title={`${img.filename} · ${formatImageBytes(img.bytes)}`}
                      onClick={() => lightboxOpen(taskImages, i)}
                    >
                      {src && <img src={src} alt={img.filename} loading="lazy" />}
                    </button>
                    <span className="detail-image-actions">
                      <button
                        type="button"
                        aria-label={`Reveal ${img.filename} in Finder`}
                        title="Reveal in Finder"
                        onClick={() => {
                          const abs = imageAbsPath(img);
                          if (abs) void revealItemInDir(abs);
                        }}
                      >
                        <IconFolderOpen size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Insert ${img.filename} in notes`}
                        title="Insert in notes"
                        onClick={() => insertImageInNotes(img)}
                      >
                        <IconFileText size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${img.filename}`}
                        title="Remove image"
                        onClick={() => void removeImage(img)}
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  </span>
                );
              })}
              <button
                type="button"
                className="detail-image-add"
                title="⌘V pastes a clipboard image onto this task"
                onClick={() => void pasteImageFromClipboard()}
              >
                <IconPlus size={13} />
                Paste image
              </button>
            </span>

            <span className="detail-prop-label">Created</span>
            <span className="detail-created">{createdLabel}</span>

            {/* Board-hosted session (spec 2026-07-19-hosted-agent-sessions):
                the task's own terminal. Either the session that exists — with
                its open and stop/dismiss controls — or the launcher: one
                button per installed CLI, launching in the task's directory
                with the ref as the opening prompt. */}
            {(hosted || hostAdapters.length > 0) && (
              <>
                <span className="detail-prop-label">Session</span>
                <span className="detail-session">
                  {hosted ? (
                    <>
                      <span
                        className={`hosted-chip${hosted.exited ? " exited" : ""}${
                          !hosted.exited && hosted.waiting ? " waiting" : ""
                        }`}
                        title={
                          !hosted.exited && hosted.waiting
                            ? "Looks idle at a prompt — a heuristic read of its screen"
                            : undefined
                        }
                      >
                        {HostedMark && <HostedMark size={12} />}
                        {hosted.adapter_name}
                        <span className="hosted-chip-state">
                          {hosted.exited ? "exited" : hosted.waiting ? "waiting ❯" : "live"}
                        </span>
                      </span>
                      {!hosted.exited && (
                        <button
                          className="detail-agent-jump"
                          title="Open the session pane"
                          aria-label="Open the session pane"
                          onClick={() => openHostedPane(hosted)}
                        >
                          <IconTerminal size={13} />
                        </button>
                      )}
                      <button
                        className="session-stop-btn"
                        title={
                          hosted.exited
                            ? "Dismiss this exited session"
                            : "Stop the session — it cannot be resumed"
                        }
                        onClick={() => {
                          if (hosted.exited || confirmKill) {
                            void killHostedSession(hosted);
                            return;
                          }
                          // Armed state disarms itself — an armed "stop"
                          // forgotten minutes ago must not kill on a later
                          // stray click (codex verify note, 2026-07-19).
                          setConfirmKill(true);
                          if (killDisarmRef.current) {
                            window.clearTimeout(killDisarmRef.current);
                          }
                          killDisarmRef.current = window.setTimeout(() => {
                            killDisarmRef.current = null;
                            setConfirmKill(false);
                          }, 3000);
                        }}
                      >
                        {hosted.exited ? "dismiss" : confirmKill ? "stop for sure?" : "stop"}
                      </button>
                    </>
                  ) : resumable ? (
                    // F3: a session from the previous app run, offered back —
                    // manual, per card, never automatic.
                    <button
                      className="session-start-btn"
                      disabled={starting}
                      title={`Resume the ${resumable.adapter_name} session from the last run — continues its conversation`}
                      onClick={() => void resumeHostedSession(resumable)}
                    >
                      {ResumableMark && <ResumableMark size={12} />}
                      Resume {resumable.adapter_name}
                    </button>
                  ) : (
                    // Icon-only launchers: the brand mark is the label; the
                    // name survives on hover (title) and for assistive tech.
                    hostAdapters.map((a) => {
                      const Mark = adapterMark(a.id);
                      return (
                        <button
                          key={a.id}
                          className="session-start-btn session-start-btn--mark"
                          disabled={!a.available || starting}
                          aria-label={`Start a ${a.name} session on this task`}
                          title={
                            a.available
                              ? `Start a ${a.name} session on this task`
                              : `${a.name} CLI not found on this machine`
                          }
                          onClick={() => void startHostedSession(a.id)}
                        >
                          <Mark size={14} />
                        </button>
                      );
                    })
                  )}
                  {sessionError && (
                    <span className="detail-agent-miss" role="status">
                      {sessionError}
                    </span>
                  )}
                </span>
              </>
            )}

            {presence && presenceAgent && (
              <>
                <span className="detail-prop-label">Agent</span>
                <span className="detail-agent">
                  <span
                    className="detail-agent-id"
                    style={{ ["--agent-color" as string]: presenceAgent.color }}
                  >
                    <presenceAgent.Mark size={13} />
                    {presenceAgent.label}
                  </span>
                  <span className={`detail-agent-state ${presence.state}`}>
                    {presence.state}
                  </span>
                  {presence.branch && (
                    <span
                      className="detail-agent-fact"
                      title={`Branch · ${presence.branch}`}
                    >
                      <IconGitBranch size={12} />
                      {presence.branch}
                    </span>
                  )}
                  {presenceCwdBase && (
                    <span
                      className="detail-agent-fact"
                      title={`Working directory · ${presence.cwd}`}
                    >
                      <IconFolderOpen size={12} />
                      {presenceCwdBase}
                    </span>
                  )}
                  {/* Reachability, not busyness (TIL-99): the user reaches for
                      this exactly when the session already sits idle at its
                      prompt — state `quiet`, but the process is alive and one
                      keystroke away. `reachable` is the Rust-side check: live
                      claude pid AND a terminal window to raise — a headless
                      background session never shows a button that could only
                      answer "not reachable". */}
                  {(presence.reachable || presence.attachable) && (
                    <button
                      className="detail-agent-jump"
                      title={
                        presence.reachable
                          ? "Jump to session — bring its terminal window to the front"
                          : "Jump to session — open it in a terminal pane"
                      }
                      aria-label="Jump to session"
                      onClick={() => void jumpToSession()}
                    >
                      <IconTerminal size={13} />
                    </button>
                  )}
                  {jumpMiss && (
                    <span className="detail-agent-miss" role="status">
                      Session not reachable
                    </span>
                  )}
                </span>
              </>
            )}
          </div>

          {artifacts && (artifacts.last_message || artifacts.commit_subjects.length > 0) && (
            // The artifact digest (F1): what the session last said and what
            // landed on the branch — read off durable traces, so it still
            // answers after the session is gone. A lens over the filesystem,
            // not a store; no seen/unseen bookkeeping by design.
            <div className="detail-artifacts">
              <div className="detail-artifacts-head">
                While you were away
                {artifacts.last_active && (
                  <span className="detail-artifacts-when">
                    last activity {timeAgo(artifacts.last_active)}
                  </span>
                )}
              </div>
              {artifacts.last_message && (
                <p className="detail-artifacts-msg">{artifacts.last_message}</p>
              )}
              {artifacts.commit_subjects.length > 0 && (
                <ul className="detail-artifacts-commits">
                  {artifacts.commit_subjects.map((s, i) => (
                    <li key={i}>
                      <IconGitBranch size={11} />
                      <span>{s}</span>
                    </li>
                  ))}
                  {artifacts.commits_ahead > artifacts.commit_subjects.length && (
                    <li className="detail-artifacts-more">
                      +{artifacts.commits_ahead - artifacts.commit_subjects.length} more ahead
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {inReview && (
            // The review brief, leading the editor while the tag is on: what the
            // agent asserts (evidence), what the user confirms (verify steps),
            // and the doors (links). A lens over existing data, not a store —
            // remove the tag and the editor below is exactly the plain editor.
            <div className="review-band">
              <div className="review-band-head">
                Ready for review
                {reviewFlaggedAt && (
                  <span className="review-band-when">flagged {timeAgo(reviewFlaggedAt)}</span>
                )}
              </div>
              {evidence.length > 0 && (
                <ul className="review-band-evidence">
                  {evidence.map((a) => (
                    <li key={a.id}>{a.label}</li>
                  ))}
                </ul>
              )}
              {verifySteps.length > 0 && (
                <>
                  <p className="review-band-sub">
                    Verify · {verifySteps.filter((s) => s.done).length} of {verifySteps.length}
                  </p>
                  <ul className="verify-list">
                    {verifySteps.map((sub) => (
                      // The step text must stay selectable/copyable, and WebKit
                      // refuses to drag-select text inside a <button> — so the
                      // button is only the checkbox, and the text is a sibling.
                      <li key={sub.id} className={`verify-item ${sub.done ? "done" : ""}`}>
                        <button
                          type="button"
                          className="verify-box"
                          aria-label={`${sub.done ? "Untick" : "Tick"} ${verifyStepLabel(sub)}`}
                          onClick={() => void toggleSubtask(sub.id)}
                        >
                          {sub.done && <IconCheck size={10} />}
                        </button>
                        <span
                          className="verify-text"
                          onClick={(e) => {
                            // Clicking the label still toggles, but a click that
                            // ends a drag-select over this text must not — only
                            // a selection inside this step blocks the toggle.
                            const sel = window.getSelection();
                            if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) {
                              return;
                            }
                            void toggleSubtask(sub.id);
                          }}
                        >
                          {verifyStepLabel(sub)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!prLink && verifySteps.length === 0 && (
                <span className="card-review-missing">
                  <IconAlert size={12} />
                  In review with no PR and no verify steps
                </span>
              )}
              {taskLinks.length > 0 && (
                <div className="review-band-links">
                  {taskLinks.map((link) => {
                    const kind = asLinkKind(link.kind);
                    const isDoor = link === prLink;
                    // A stamped PR carries its merge badge here too — as the
                    // review-door (badge only) or a plain chip (full tint) —
                    // matching the card strip (TIL-88).
                    const pr = prChip(link);
                    const color = pr && !isDoor ? pr.color : LINK_KIND_COLORS[kind];
                    return (
                      <button
                        key={link.id}
                        type="button"
                        className={
                          isDoor ? "card-link review-door" : `card-link${pr ? ` ${pr.cls}` : ""}`
                        }
                        style={{ ["--link-color" as string]: color }}
                        title={`${LINK_KIND_LABELS[kind]} · ${link.label}${pr ? ` · ${pr.title}` : ""} · ${link.url}`}
                        onClick={() => void openLink(link)}
                      >
                        {kind === "file" ? (
                          <FileEvidenceIcon path={link.url} size={13} />
                        ) : (
                          <LinkKindIcon kind={link.kind} size={13} />
                        )}
                        <span className="card-link-label">{link.label}</span>
                        {pr?.suffix}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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
            <NotesView
              taskId={task.id}
              source={notes}
              onStartEdit={() => setEditingNotes(true)}
            />
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
              {buildSubtasks.length > 0 && (
                <span className="detail-section-count">
                  {doneCount} of {buildSubtasks.length}
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
              {buildSubtasks.map((sub) => (
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
              Evidence &amp; links
              {taskLinks.length > 0 && (
                <span className="detail-section-count">{taskLinks.length}</span>
              )}
            </h3>
            <div className="detail-links">
              {taskLinks.map((link) => {
                const kind = asLinkKind(link.kind);
                const isFile = kind === "file";
                // A stamped PR carries its merge status here too — a green /
                // amber / faint chip plus the ✓ / ↓N / draft badge — so it reads
                // the same as on the card and in the review band (TIL-88).
                const pr = prChip(link);
                return (
                  <span
                    key={link.id}
                    className="link-chip"
                    style={{
                      ["--link-color" as string]: pr ? pr.color : LINK_KIND_COLORS[kind],
                    }}
                  >
                    <button
                      className="link-chip-open"
                      title={
                        isFile
                          ? isRevealOnlyEvidence(link.url)
                            ? `${link.url} — reveals in Finder (HTML/SVG can run scripts in a browser)`
                            : link.url
                          : `${LINK_KIND_LABELS[kind]} · ${link.url}${pr ? ` · ${pr.title}` : ""}`
                      }
                      onClick={() => void openLink(link)}
                    >
                      {isFile ? (
                        <FileEvidenceIcon path={link.url} size={13} />
                      ) : (
                        <LinkKindIcon kind={link.kind} size={13} />
                      )}
                      <span className="link-chip-label">{link.label}</span>
                      {pr?.suffix}
                    </button>
                    {isFile && (
                      <button
                        className="link-reveal"
                        aria-label={`Reveal ${link.label} in Finder`}
                        title="Reveal in Finder"
                        onClick={() => void revealItemInDir(link.url)}
                      >
                        <IconFolderOpen size={12} />
                      </button>
                    )}
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
                  placeholder="Paste a URL or an absolute file path"
                  aria-label="Add a link or a file path"
                  onChange={(e) => {
                    setLinkInput(e.target.value);
                    if (linkError) setLinkError("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void addLinkFromInput()}
                />
              </div>
            </div>
            {linkError && <p className="detail-link-error">{linkError}</p>}
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
