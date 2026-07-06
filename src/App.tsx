import { useEffect, useRef } from "react";
import "./App.css";
import { useAI } from "./ai";
import { AISettings } from "./components/AISettings";
import { Header } from "./components/Header";
import { Kanban } from "./components/Kanban";
import { QuickAdd } from "./components/QuickAdd";
import { Sidebar } from "./components/Sidebar";
import { TaskEditor } from "./components/TaskEditor";
import { TaskList } from "./components/TaskList";
import { useStore } from "./store";

function App() {
  const { loaded, init, viewMode, editingTaskId, openEditor } = useStore();
  const aiSettingsOpen = useAI((s) => s.settingsOpen);
  const searchRef = useRef<HTMLInputElement>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (mod && e.key === "n") {
        e.preventDefault();
        quickAddRef.current?.focus();
      } else if (e.key === "Escape") {
        openEditor(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openEditor]);

  if (!loaded) {
    return <div className="app-loading">Loading…</div>;
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Header searchRef={searchRef} />
        <QuickAdd inputRef={quickAddRef} />
        <div className="content">{viewMode === "board" ? <Kanban /> : <TaskList />}</div>
      </main>
      {editingTaskId !== null && <TaskEditor />}
      {aiSettingsOpen && <AISettings />}
    </div>
  );
}

export default App;
