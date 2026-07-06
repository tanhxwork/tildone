import { useEffect, useMemo, useRef, useState } from "react";
import { liveTasks } from "../selectors";
import { useSettings } from "../settings";
import { useStore } from "../store";
import type { Selection, ViewMode } from "../types";
import { dueLabel } from "../utils/dates";
import { IconCheck, IconPlus, IconSearch } from "./Icons";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: "plus" | "go" | "check";
  keywords: string;
  run: () => void;
}

export function CommandPalette() {
  const store = useStore();
  const {
    tasks,
    projects,
    paletteOpen,
    setPaletteOpen,
    select,
    setViewMode,
    openEditor,
    addTask,
    setTagManagerOpen,
  } = store;
  const { openSettings, theme, setTheme, defaultProjectId } = useSettings();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setCursor(0);
      // Focus after the overlay mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  const q = query.trim().toLowerCase();

  const goto = (selection: Selection, mode?: ViewMode) => () => {
    select(selection);
    if (mode) setViewMode(mode);
    setPaletteOpen(false);
  };

  const actions = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "go-today", label: "Go to Today", keywords: "go today", icon: "go", run: goto({ type: "today" }) },
      { id: "go-upcoming", label: "Go to Upcoming", keywords: "go upcoming", icon: "go", run: goto({ type: "upcoming" }) },
      { id: "go-inbox", label: "Go to Inbox", keywords: "go inbox", icon: "go", run: goto({ type: "inbox" }) },
      { id: "go-all", label: "Go to All Tasks", keywords: "go all tasks", icon: "go", run: goto({ type: "all" }) },
      { id: "go-week", label: "Go to My Week", keywords: "go my week plan", icon: "go", run: goto({ type: "week" }) },
      { id: "go-review", label: "Go to Review", keywords: "go review dashboard stats", icon: "go", run: goto({ type: "review" }) },
      { id: "go-completed", label: "Go to Completed & Trash", keywords: "go completed trash history archive", icon: "go", run: goto({ type: "completed" }) },
      { id: "view-calendar", label: "Open Calendar view", keywords: "calendar month view", icon: "go", run: goto({ type: "all" }, "calendar") },
      { id: "view-table", label: "Open Table view", keywords: "table spreadsheet view", icon: "go", run: goto({ type: "all" }, "table") },
      { id: "view-board", label: "Open Board view", keywords: "board kanban view", icon: "go", run: goto({ type: "all" }, "board") },
      {
        id: "open-settings",
        label: "Open Settings",
        keywords: "settings preferences theme",
        icon: "go",
        run: () => {
          openSettings();
          setPaletteOpen(false);
        },
      },
      {
        id: "manage-tags",
        label: "Manage tags & projects",
        keywords: "tags projects manager rename merge",
        icon: "go",
        run: () => {
          setTagManagerOpen(true);
          setPaletteOpen(false);
        },
      },
      {
        id: "toggle-theme",
        label: `Switch theme (now: ${theme})`,
        keywords: "theme dark light toggle appearance",
        icon: "go",
        run: () => {
          setTheme(theme === "dark" ? "light" : theme === "light" ? "auto" : "dark");
          setPaletteOpen(false);
        },
      },
    ];
    for (const project of projects) {
      list.push({
        id: `go-project-${project.id}`,
        label: `Go to ${project.name}`,
        keywords: `go project ${project.name.toLowerCase()}`,
        icon: "go",
        run: goto({ type: "project", projectId: project.id }),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, theme]);

  const results = useMemo(() => {
    const matchedActions = q
      ? actions.filter((a) => a.keywords.includes(q) || a.label.toLowerCase().includes(q))
      : actions.slice(0, 8);

    const addCommands: Command[] = [];
    if (q) {
      addCommands.push({
        id: "add-inbox",
        label: `Add task “${query.trim()}”`,
        hint: defaultProjectId !== null
          ? (projects.find((p) => p.id === defaultProjectId)?.name ?? "Inbox")
          : "Inbox",
        keywords: "",
        icon: "plus",
        run: () => {
          void addTask({ title: query.trim(), project_id: defaultProjectId, due_date: null });
          setPaletteOpen(false);
        },
      });
      for (const project of projects.slice(0, 3)) {
        addCommands.push({
          id: `add-${project.id}`,
          label: `Add task “${query.trim()}” to ${project.name}`,
          keywords: "",
          icon: "plus",
          run: () => {
            void addTask({ title: query.trim(), project_id: project.id, due_date: null });
            setPaletteOpen(false);
          },
        });
      }
    }

    const matchedTasks = q
      ? liveTasks(tasks)
          .filter(
            (t) =>
              t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q),
          )
          .slice(0, 8)
      : [];

    return { actions: matchedActions, adds: addCommands, tasks: matchedTasks };
  }, [q, query, actions, tasks, projects, defaultProjectId, addTask, setPaletteOpen]);

  const flat: Command[] = [
    ...results.actions,
    ...results.adds,
    ...results.tasks.map<Command>((t) => ({
      id: `task-${t.id}`,
      label: t.title,
      hint: t.due_date ? dueLabel(t.due_date) : undefined,
      keywords: "",
      icon: "check",
      run: () => {
        openEditor(t.id);
        setPaletteOpen(false);
      },
    })),
  ];

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!paletteOpen) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flat[cursor]?.run();
    } else if (e.key === "Escape") {
      setPaletteOpen(false);
    }
  }

  let index = -1;
  const section = (title: string, items: Command[]) =>
    items.length === 0 ? null : (
      <div className="palette-section" key={title}>
        <div className="palette-section-title">{title}</div>
        {items.map((cmd) => {
          index += 1;
          const i = index;
          return (
            <button
              key={cmd.id}
              className={`palette-item ${i === cursor ? "active" : ""}`}
              data-active={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={cmd.run}
            >
              <span className="palette-icon">
                {cmd.icon === "plus" ? (
                  <IconPlus size={13} />
                ) : cmd.icon === "check" ? (
                  <IconCheck size={13} />
                ) : (
                  <IconSearch size={13} />
                )}
              </span>
              <span className="palette-label">{cmd.label}</span>
              {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
            </button>
          );
        })}
      </div>
    );

  return (
    <div className="modal-overlay palette-overlay" onClick={() => setPaletteOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette-input">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search tasks or type a command…"
            aria-label="Command palette"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
          />
          <kbd className="palette-esc">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {section("Actions", results.actions)}
          {section("Add", results.adds)}
          {section(
            "Tasks",
            flat.slice(results.actions.length + results.adds.length),
          )}
          {flat.length === 0 && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
