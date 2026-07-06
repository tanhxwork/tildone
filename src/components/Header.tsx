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
    <header className="header">
      <div className="header-top" data-tauri-drag-region>
        <h1 className="view-title" data-tauri-drag-region>
          {dotColor && <span className="project-dot large" style={{ background: dotColor }} />}
          {title}
        </h1>

        <div className="header-controls">
          <div className="search-box">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={search}
              placeholder="Search tasks…"
              aria-label="Search tasks"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="icon-btn" aria-label="Clear search" onClick={() => setSearch("")}>
                <IconX size={12} />
              </button>
            )}
          </div>

          <select
            className="priority-filter"
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
            className={`icon-btn toggle ${showCompleted ? "on" : ""}`}
            aria-label={showCompleted ? "Hide completed tasks" : "Show completed tasks"}
            title={showCompleted ? "Hide completed" : "Show completed"}
            onClick={toggleShowCompleted}
          >
            {showCompleted ? <IconEye /> : <IconEyeOff />}
          </button>

          <div className="segmented" role="group" aria-label="View mode">
            <button
              className={viewMode === "list" ? "active" : ""}
              aria-label="List view"
              title="List view"
              onClick={() => setViewMode("list")}
            >
              <IconList size={14} />
            </button>
            <button
              className={viewMode === "board" ? "active" : ""}
              aria-label="Board view"
              title="Board view"
              onClick={() => setViewMode("board")}
            >
              <IconBoard size={14} />
            </button>
          </div>
        </div>
      </div>

      {activeTags.length > 0 && (
        <div className="active-filters">
          <span className="filters-label">Filtered by</span>
          {activeTags.map((tag) => (
            <button
              key={tag.id}
              className="tag-chip active removable"
              style={{ ["--tag-color" as string]: tag.color }}
              onClick={() => toggleTagFilter(tag.id)}
            >
              {tag.name}
              <IconX size={11} />
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
