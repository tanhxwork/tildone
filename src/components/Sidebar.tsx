import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getName } from "@tauri-apps/api/app";
import { useAI } from "../ai";
import { useSettings } from "../settings";
import { useStore } from "../store";
import type { Project, Selection } from "../types";
import { todayStr } from "../utils/dates";
import { TildoneMark } from "./Brand";
import {
  IconArchive,
  IconCalendar,
  IconChart,
  IconChevronDown,
  IconChevronRight,
  IconColumns,
  IconInbox,
  IconLayers,
  IconPencil,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconStar,
  IconTag,
  IconX,
} from "./Icons";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectGlyph } from "./ProjectGlyph";

function isSelected(a: Selection, b: Selection): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "project" && b.type === "project") {
    return a.projectId === b.projectId;
  }
  return true;
}

export function Sidebar() {
  const {
    projects,
    tasks,
    tags,
    selection,
    select,
    activeTagIds,
    toggleTagFilter,
    removeTag,
  } = useStore();
  const [dialog, setDialog] = useState<Project | "new" | null>(null);
  const aiMode = useAI((s) => s.config.mode);
  const openAISettings = useAI((s) => s.openSettings);
  const openSettings = useSettings((s) => s.openSettings);
  const tagsCollapsed = useSettings((s) => s.tagsCollapsed);
  const setTagsCollapsed = useSettings((s) => s.setTagsCollapsed);
  const setTagManagerOpen = useStore((s) => s.setTagManagerOpen);
  const [confirmTagId, setConfirmTagId] = useState<number | null>(null);
  // Dev builds run as "Tildone Dev — <worktree>" (scripts/tauri.sh); show
  // that worktree in the sidebar so the window says which task it belongs to.
  const [devSlug, setDevSlug] = useState<string | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    getName()
      .then((name) => {
        const match = name.match(/^Tildone Dev — (.+)$/);
        if (match) setDevSlug(match[1]);
      })
      .catch(() => {});
  }, []);

  const counts = useMemo(() => {
    const today = todayStr();
    const open = tasks.filter((t) => t.status !== "done" && t.deleted_at === null);
    const byProject = new Map<number, number>();
    for (const t of open) {
      if (t.project_id !== null) {
        byProject.set(t.project_id, (byProject.get(t.project_id) ?? 0) + 1);
      }
    }
    const byTag = new Map<number, number>();
    for (const t of open) {
      for (const tagId of t.tag_ids) {
        byTag.set(tagId, (byTag.get(tagId) ?? 0) + 1);
      }
    }
    return {
      today: open.filter((t) => t.due_date !== null && t.due_date <= today).length,
      upcoming: open.filter((t) => t.due_date !== null && t.due_date > today).length,
      inbox: open.filter((t) => t.project_id === null).length,
      all: open.length,
      byProject,
      byTag,
    };
  }, [tasks]);

  const smartLists: { sel: Selection; label: string; icon: ReactNode; count: number }[] = [
    { sel: { type: "today" }, label: "Today", icon: <IconStar />, count: counts.today },
    { sel: { type: "upcoming" }, label: "Upcoming", icon: <IconCalendar />, count: counts.upcoming },
    { sel: { type: "inbox" }, label: "Inbox", icon: <IconInbox />, count: counts.inbox },
    { sel: { type: "all" }, label: "All Tasks", icon: <IconLayers />, count: counts.all },
  ];

  const pages: { sel: Selection; label: string; icon: ReactNode }[] = [
    { sel: { type: "week" }, label: "My Week", icon: <IconColumns /> },
    { sel: { type: "review" }, label: "Review", icon: <IconChart /> },
    { sel: { type: "completed" }, label: "Completed", icon: <IconArchive /> },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar" data-tauri-drag-region />
      <div className="sidebar-brand" data-tauri-drag-region>
        <TildoneMark className="sidebar-brand-mark" />
        Tildone
      </div>

      <div className="sidebar-scroll">
      <nav className="sidebar-section">
        {smartLists.map((item) => (
          <button
            key={item.label}
            className={`nav-item ${isSelected(selection, item.sel) ? "active" : ""}`}
            onClick={() => select(item.sel)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
            {item.count > 0 && <span className="nav-count">{item.count}</span>}
          </button>
        ))}
      </nav>

      <nav className="sidebar-section">
        <div className="section-header">
          <span>Plan</span>
        </div>
        {pages.map((item) => (
          <button
            key={item.label}
            className={`nav-item ${isSelected(selection, item.sel) ? "active" : ""}`}
            onClick={() => select(item.sel)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-section">
        <div className="section-header">
          <span>Projects</span>
          <button
            className="icon-btn"
            aria-label="New project"
            title="New project"
            onClick={() => setDialog("new")}
          >
            <IconPlus size={14} />
          </button>
        </div>
        {projects.map((project) => {
          const sel: Selection = { type: "project", projectId: project.id };
          return (
            <div
              key={project.id}
              className={`nav-item nav-project ${isSelected(selection, sel) ? "active" : ""}`}
              onClick={() => select(sel)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && select(sel)}
            >
              <ProjectGlyph project={project} size={16} />
              <span className="nav-label">{project.name}</span>
              <button
                className="icon-btn row-action"
                aria-label={`Edit ${project.name}`}
                title="Edit project"
                onClick={(e) => {
                  e.stopPropagation();
                  setDialog(project);
                }}
              >
                <IconPencil size={13} />
              </button>
              {(counts.byProject.get(project.id) ?? 0) > 0 && (
                <span className="nav-count">{counts.byProject.get(project.id)}</span>
              )}
            </div>
          );
        })}
        {projects.length === 0 && (
          <p className="sidebar-hint">No projects yet — create one with +</p>
        )}
      </div>

      {tags.length > 0 && (
        <div className="sidebar-section">
          <button
            className="section-header section-toggle"
            aria-expanded={!tagsCollapsed}
            onClick={() => setTagsCollapsed(!tagsCollapsed)}
          >
            <span className="section-toggle-label">
              {tagsCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
              Tags
            </span>
            {tagsCollapsed && activeTagIds.length > 0 && (
              <span className="section-badge">{activeTagIds.length}</span>
            )}
          </button>
          {!tagsCollapsed && (
          <div className="tag-cloud">
            {tags.map((tag) => (
              <span
                key={tag.id}
                className={`tag-chip ${activeTagIds.includes(tag.id) ? "active" : ""}`}
                style={{ ["--tag-color" as string]: tag.color }}
                onClick={() => {
                  setConfirmTagId(null);
                  toggleTagFilter(tag.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && toggleTagFilter(tag.id)}
              >
                {tag.name}
                {(counts.byTag.get(tag.id) ?? 0) > 0 && (
                  <span className="tag-count">{counts.byTag.get(tag.id)}</span>
                )}
                {confirmTagId === tag.id ? (
                  <button
                    className="tag-delete confirm"
                    aria-label={`Confirm delete tag ${tag.name}`}
                    title="Click again to delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTag(tag.id);
                      setConfirmTagId(null);
                    }}
                  >
                    <IconTrashTiny />
                  </button>
                ) : (
                  <button
                    className="tag-delete"
                    aria-label={`Delete tag ${tag.name}`}
                    title="Delete tag"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmTagId(tag.id);
                    }}
                  >
                    <IconX size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
          )}
        </div>
      )}
      </div>

      <div className="sidebar-footer">
        <button className="nav-item" onClick={openAISettings}>
          <span className="nav-icon">
            <IconSparkles />
          </span>
          <span className="nav-label">AI Assistant</span>
          <span className={`ai-dot ${aiMode !== "off" ? "on" : ""}`} />
        </button>
        <button className="nav-item" onClick={() => setTagManagerOpen(true)}>
          <span className="nav-icon">
            <IconTag />
          </span>
          <span className="nav-label">Tags & projects</span>
        </button>
        <button className="nav-item" onClick={openSettings}>
          <span className="nav-icon">
            <IconSettings />
          </span>
          <span className="nav-label">Settings</span>
        </button>
        {devSlug && (
          <div className="dev-badge" title={`Dev build — worktree ${devSlug}`}>
            DEV · {devSlug}
          </div>
        )}
      </div>

      {dialog !== null && (
        <ProjectDialog
          project={dialog === "new" ? null : dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </aside>
  );
}

function IconTrashTiny() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
