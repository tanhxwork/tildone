import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { useAI } from "./ai";
import { AISettings } from "./components/AISettings";
import { CalendarView } from "./components/CalendarView";
import { CommandPalette } from "./components/CommandPalette";
import { CompletedView } from "./components/CompletedView";
import { FirstRun, firstRunDismissed } from "./components/FirstRun";
import { Header } from "./components/Header";
import { Kanban } from "./components/Kanban";
import { QuickAdd } from "./components/QuickAdd";
import { ReviewView } from "./components/ReviewView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TableView } from "./components/TableView";
import { TagManager } from "./components/TagManager";
import { TaskEditor } from "./components/TaskEditor";
import { TaskList } from "./components/TaskList";
import { WeekView } from "./components/WeekView";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { isPageSelection } from "./types";

function App() {
  const {
    loaded,
    init,
    selection,
    viewMode,
    editingTaskId,
    openEditor,
    setPaletteOpen,
    tagManagerOpen,
    setTagManagerOpen,
    projects,
    tasks,
  } = useStore();
  const aiSettingsOpen = useAI((s) => s.settingsOpen);
  const settingsOpen = useSettings((s) => s.settingsOpen);
  const openSettings = useSettings((s) => s.openSettings);
  const closeSettings = useSettings((s) => s.closeSettings);
  const searchRef = useRef<HTMLInputElement>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const [firstRunDone, setFirstRunDone] = useState(firstRunDismissed);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    // Warm the built-in engine on launch when the user opted in.
    const ai = useAI.getState();
    if (ai.config.mode === "builtin" && ai.config.autoStart) {
      ai.startEngine().catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Agent access: start the MCP server if enabled, and refresh the store
    // whenever an external agent writes to the database.
    if (useSettings.getState().agentServer) {
      // Never swallow this. The Rust side returns a precise reason (e.g. the port
      // is already taken), and discarding it is what let the board sit silently
      // dead while Settings still reported "on" — an agent has no way to notice.
      invoke("agent_server_start").catch((err) => {
        console.error("tildone: MCP server failed to start:", err);
      });
    }
    const unlisten = listen("agent-db-changed", () => {
      void useStore.getState().reload();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && e.key === "n") {
        e.preventDefault();
        quickAddRef.current?.focus();
      } else if (mod && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.key === "Escape") {
        if (useStore.getState().paletteOpen) {
          setPaletteOpen(false);
        } else if (useStore.getState().tagManagerOpen) {
          setTagManagerOpen(false);
        } else if (useSettings.getState().settingsOpen) {
          closeSettings();
        } else {
          openEditor(null);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openEditor, setPaletteOpen, setTagManagerOpen, openSettings, closeSettings]);

  if (!loaded) {
    return <div className="app-loading">Loading…</div>;
  }

  const isPage = isPageSelection(selection);
  const showFirstRun = !firstRunDone && projects.length === 0 && tasks.length === 0;

  let content;
  if (selection.type === "week") {
    content = <WeekView />;
  } else if (selection.type === "review") {
    content = <ReviewView />;
  } else if (selection.type === "completed") {
    content = <CompletedView />;
  } else if (viewMode === "board") {
    content = <Kanban />;
  } else if (viewMode === "table") {
    content = <TableView />;
  } else if (viewMode === "calendar") {
    content = <CalendarView />;
  } else {
    content = <TaskList />;
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Header searchRef={searchRef} />
        {(!isPage || selection.type === "week") && <QuickAdd inputRef={quickAddRef} />}
        <div className="content">{content}</div>
      </main>
      {editingTaskId !== null && <TaskEditor />}
      {aiSettingsOpen && <AISettings />}
      {settingsOpen && <SettingsDialog />}
      {tagManagerOpen && <TagManager />}
      <CommandPalette />
      {showFirstRun && <FirstRun onDone={() => setFirstRunDone(true)} />}
    </div>
  );
}

export default App;
