import { useMemo, useState, type ReactNode } from "react";
import { useAI } from "../ai";
import { useStore } from "../store";
import type { Project, Selection } from "../types";
import { todayStr } from "../utils/dates";
import {
  IconCalendar,
  IconInbox,
  IconLayers,
  IconPencil,
  IconPlus,
  IconSparkles,
  IconStar,
  IconX,
} from "./Icons";
import { ProjectDialog } from "./ProjectDialog";
import { TagChip, iconBtn, tagDeleteClass } from "./ui";

function isSelected(a: Selection, b: Selection): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "project" && b.type === "project") {
    return a.projectId === b.projectId;
  }
  return true;
}

function navItemClass(active: boolean): string {
  return `flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left transition-colors ${
    active ? "bg-active font-semibold text-accent" : "hover:bg-hover"
  }`;
}

function navIconClass(active: boolean): string {
  return `flex ${active ? "text-accent" : "text-ink-muted"}`;
}

const navLabel = "min-w-0 flex-1 truncate";
const navCount = "text-[11px] tabular-nums text-ink-faint";
const sectionHeader =
  "mb-1 flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-[0.5px] text-ink-faint";

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
  const [confirmTagId, setConfirmTagId] = useState<number | null>(null);

  const counts = useMemo(() => {
    const today = todayStr();
    const open = tasks.filter((t) => t.status !== "done");
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

  return (
    <aside className="flex w-[232px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-sidebar px-2.5 pb-4">
      <div className="h-[34px] shrink-0" data-tauri-drag-region />
      <div className="px-2 pb-2.5 text-[14px] font-bold tracking-[-0.2px]" data-tauri-drag-region>
        Tildone
      </div>

      <nav className="mb-[18px]">
        {smartLists.map((item) => {
          const active = isSelected(selection, item.sel);
          return (
            <button
              key={item.label}
              className={navItemClass(active)}
              onClick={() => select(item.sel)}
            >
              <span className={navIconClass(active)}>{item.icon}</span>
              <span className={navLabel}>{item.label}</span>
              {item.count > 0 && <span className={navCount}>{item.count}</span>}
            </button>
          );
        })}
      </nav>

      <div className="mb-[18px]">
        <div className={sectionHeader}>
          <span>Projects</span>
          <button
            className={iconBtn}
            aria-label="New project"
            title="New project"
            onClick={() => setDialog("new")}
          >
            <IconPlus size={14} />
          </button>
        </div>
        {projects.map((project) => {
          const sel: Selection = { type: "project", projectId: project.id };
          const active = isSelected(selection, sel);
          return (
            <div
              key={project.id}
              className={`group ${navItemClass(active)}`}
              onClick={() => select(sel)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && select(sel)}
            >
              <span
                className="size-[9px] shrink-0 rounded-full"
                style={{ background: project.color }}
              />
              <span className={navLabel}>{project.name}</span>
              <button
                className={`${iconBtn} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
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
                <span className={navCount}>{counts.byProject.get(project.id)}</span>
              )}
            </div>
          );
        })}
        {projects.length === 0 && (
          <p className="px-2 py-0.5 text-[12px] text-ink-faint">
            No projects yet — create one with +
          </p>
        )}
      </div>

      {tags.length > 0 && (
        <div className="mb-[18px]">
          <div className={sectionHeader}>
            <span>Tags</span>
          </div>
          <div className="flex flex-wrap gap-[5px] px-2 py-0.5">
            {tags.map((tag) => (
              <TagChip
                key={tag.id}
                color={tag.color}
                active={activeTagIds.includes(tag.id)}
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
                  <span className="text-[10px] tabular-nums text-ink-faint">
                    {counts.byTag.get(tag.id)}
                  </span>
                )}
                {confirmTagId === tag.id ? (
                  <button
                    className={tagDeleteClass(true)}
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
                    className={tagDeleteClass()}
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
              </TagChip>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto border-t border-edge pt-2.5">
        <button className={navItemClass(false)} onClick={openAISettings}>
          <span className={navIconClass(false)}>
            <IconSparkles />
          </span>
          <span className={navLabel}>AI Assistant</span>
          <span
            className={`size-[7px] shrink-0 rounded-full ${
              aiMode !== "off" ? "bg-success" : "bg-ink-faint"
            }`}
          />
        </button>
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
