import type { RefObject } from "react";
import { useStore } from "../store";
import {
  IconBoard,
  IconEye,
  IconEyeOff,
  IconList,
  IconSearch,
  IconX,
} from "./Icons";
import { Segmented, TagChip, iconBtn } from "./ui";

export function Header({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  const {
    projects,
    tags,
    selection,
    viewMode,
    setViewMode,
    search,
    setSearch,
    priorityFilter,
    setPriorityFilter,
    showCompleted,
    toggleShowCompleted,
    activeTagIds,
    toggleTagFilter,
  } = useStore();

  let title = "";
  let dotColor: string | null = null;
  switch (selection.type) {
    case "today":
      title = "Today";
      break;
    case "upcoming":
      title = "Upcoming";
      break;
    case "inbox":
      title = "Inbox";
      break;
    case "all":
      title = "All Tasks";
      break;
    case "project": {
      const project = projects.find((p) => p.id === selection.projectId);
      title = project?.name ?? "Project";
      dotColor = project?.color ?? null;
      break;
    }
  }

  const activeTags = tags.filter((t) => activeTagIds.includes(t.id));

  return (
    <header className="px-5 pt-2">
      <div
        className="flex min-h-10 flex-wrap items-center justify-between gap-4"
        data-tauri-drag-region
      >
        <h1
          className="flex items-center gap-2 text-[19px] font-bold tracking-[-0.3px]"
          data-tauri-drag-region
        >
          {dotColor && (
            <span
              className="size-[11px] shrink-0 rounded-full"
              style={{ background: dotColor }}
            />
          )}
          {title}
        </h1>

        <div className="flex items-center gap-2">
          <div className="flex w-[190px] items-center gap-1.5 rounded-md border border-edge bg-card px-2 py-1 text-ink-faint transition-colors focus-within:border-accent">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={search}
              placeholder="Search tasks…"
              aria-label="Search tasks"
              className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className={iconBtn} aria-label="Clear search" onClick={() => setSearch("")}>
                <IconX size={12} />
              </button>
            )}
          </div>

          <select
            className="cursor-pointer rounded-md border border-edge bg-card px-2 py-1 text-ink"
            aria-label="Filter by priority"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(Number(e.target.value))}
          >
            <option value={0}>Any priority</option>
            <option value={3}>High</option>
            <option value={2}>Medium</option>
            <option value={1}>Low</option>
          </select>

          <button
            className={`inline-flex items-center justify-center rounded-md border bg-card p-[5px] transition-colors hover:bg-hover ${
              showCompleted
                ? "border-accent text-accent"
                : "border-edge text-ink-muted hover:text-ink"
            }`}
            aria-label={showCompleted ? "Hide completed tasks" : "Show completed tasks"}
            title={showCompleted ? "Hide completed" : "Show completed"}
            onClick={toggleShowCompleted}
          >
            {showCompleted ? <IconEye /> : <IconEyeOff />}
          </button>

          <Segmented
            aria-label="View mode"
            value={viewMode}
            onChange={setViewMode}
            options={[
              {
                value: "list" as const,
                label: <IconList size={14} />,
                title: "List view",
                "aria-label": "List view",
              },
              {
                value: "board" as const,
                label: <IconBoard size={14} />,
                title: "Board view",
                "aria-label": "Board view",
              },
            ]}
          />
        </div>
      </div>

      {activeTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <span className="text-[11.5px] text-ink-faint">Filtered by</span>
          {activeTags.map((tag) => (
            <TagChip
              key={tag.id}
              as="button"
              color={tag.color}
              active
              onClick={() => toggleTagFilter(tag.id)}
            >
              {tag.name}
              <IconX size={11} />
            </TagChip>
          ))}
        </div>
      )}
    </header>
  );
}
