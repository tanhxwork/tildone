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
    return (
      <div className="flex h-screen items-center justify-center text-ink-muted">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-main">
        <Header searchRef={searchRef} />
        <QuickAdd inputRef={quickAddRef} />
        <div className="flex-1 overflow-y-auto px-5 pb-6 pt-1">
          {viewMode === "board" ? <Kanban /> : <TaskList />}
        </div>
      </main>
      {editingTaskId !== null && <TaskEditor />}
      {aiSettingsOpen && <AISettings />}
    </div>
  );
}

export default App;
