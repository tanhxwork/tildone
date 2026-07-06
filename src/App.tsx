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
