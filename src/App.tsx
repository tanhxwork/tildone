import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { useAI } from "./ai";
import { useFileDropListener } from "./fileDrop";
import { AISettings } from "./components/AISettings";
import { TildoneMark } from "./components/Brand";
import { CalendarView } from "./components/CalendarView";
import { CommandPalette } from "./components/CommandPalette";
import { Lightbox } from "./components/Lightbox";
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
import { SessionPane } from "./components/SessionPane";
import { TaskEditor } from "./components/TaskEditor";
import { TaskList } from "./components/TaskList";
import { WeekView } from "./components/WeekView";
import { QuitWarning } from "./components/QuitWarning";
import { initArtifactStore } from "./artifactStore";
import { initHostStore } from "./hostStore";
import { paneHasFocus } from "./paneStore";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { isPageSelection } from "./types";

/**
 * The installed app owns port 11502 by contract, so a fast restart (quit; replace
 * bundle; open) can race the outgoing process still holding the port. Retry the
 * bind a few times with backoff so a transient failure self-heals instead of
 * needing a manual relaunch. Safe to retry: `agent_server_start` returns the
 * existing endpoint when already up, and a failed bind stores no state.
 */
async function startAgentServerWithRetry(): Promise<void> {
  const backoffMs = [250, 500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      await invoke("agent_server_start");
      return;
    } catch (err) {
      if (attempt >= backoffMs.length) {
        // Never swallow the final failure. Settings also warns, but this carries
        // the precise reason (e.g. the port is still held); an agent has no other
        // way to notice the board sat silently dead.
        console.error(
          `tildone: MCP server failed to start after ${attempt + 1} attempts:`,
          err,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
  }
}

function App() {
  const {
    loaded,
    initError,
    initStatus,
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

  // One app-wide listener for native OS file drops; individual surfaces opt in
  // with useDropTarget (see src/fileDrop.ts for why it can't be per-element).
  useFileDropListener();

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
      // Retry with backoff so a transient bind race on a fast restart self-heals;
      // the final failure is still surfaced loudly (see startAgentServerWithRetry).
      // Once up, push the persisted notify preference so a muted setting survives a
      // restart — the flag lives in the Rust process (default on), and the call is a
      // harmless no-op if the bind ultimately failed.
      void startAgentServerWithRetry().then(() =>
        invoke("agent_set_notify", { enabled: useSettings.getState().agentNotify }),
      );
    }
    const unlisten = listen("agent-db-changed", () => {
      void useStore.getState().reload();
    });
    // The landing action shared by tildone://task/<REF> deep links and a click on
    // an agent notification (Rust emits both): open that task's editor, in the
    // task's context. If the current view already contains the task — All Tasks,
    // the task's own project, or Inbox for a projectless task — stay put; from
    // anywhere else, switch to the task's project (or Inbox) first, so closing
    // the editor leaves the user beside the card, not on an unrelated page. The
    // current view mode is kept either way. select() clears editingTaskId, so
    // the switch must happen before openEditor.
    // A miss gets one reload-and-retry — the ref may be seconds old, arriving ahead
    // of the store — and a ref that still resolves to nothing is silently ignored:
    // a deep link must never error at the user.
    const unlistenOpenTask = listen<string>("open-task-ref", async (event) => {
      const wanted = event.payload.trim().toUpperCase();
      if (!wanted) return;
      const byRef = () =>
        useStore.getState().tasks.find((t) => t.ref?.toUpperCase() === wanted);
      let task = byRef();
      if (!task) {
        await useStore.getState().reload();
        task = byRef();
      }
      if (!task) return;
      const st = useStore.getState();
      const sel = st.selection;
      const alreadyThere =
        sel.type === "all" ||
        (task.project_id !== null
          ? sel.type === "project" && sel.projectId === task.project_id
          : sel.type === "inbox");
      if (!alreadyThere) {
        st.select(
          task.project_id !== null
            ? { type: "project", projectId: task.project_id }
            : { type: "inbox" },
        );
      }
      useStore.getState().openEditor(task.id);
    });
    // Presence is POLLED, not pushed, and that is the whole reason it is affordable.
    // A heartbeat fires on every tool call of every agent; routing those through
    // `agent-db-changed` would drag the board through a full fetchAll() of the entire
    // database per beat (that listener, right above, is undebounced) — worse with
    // every agent added. This asks one cheap question on a timer instead.
    //
    // 10s: presence is ambient. The pulse appearing a few seconds late costs nothing,
    // while a tighter loop buys nothing a human can perceive.
    void useStore.getState().loadPresence();
    const presenceTimer = setInterval(() => {
      void useStore.getState().loadPresence();
    }, 10_000);
    // Hosted sessions are event-driven, not polled: Rust emits `host-changed`
    // on every start / exit / kill and the store re-pulls the list.
    const disposeHost = initHostStore();
    // Artifact facts are the same shape: Rust watches the filesystem and
    // emits `artifacts-changed`; the store re-pulls.
    const disposeArtifacts = initArtifactStore();
    // Effect signals (F4): the board asks the forge itself about PR/CI state
    // — on focus and every 5 minutes while visible, never in background.
    // Repeats under 60 s are skipped; a failed poll is silent by contract.
    let lastForgePoll = 0;
    const pollForge = () => {
      if (Date.now() - lastForgePoll < 60_000) return;
      lastForgePoll = Date.now();
      void invoke("forge_poll").catch(() => {});
    };
    pollForge();
    window.addEventListener("focus", pollForge);
    const forgeTimer = setInterval(() => {
      if (document.hasFocus()) pollForge();
    }, 5 * 60_000);
    return () => {
      void unlisten.then((fn) => fn());
      void unlistenOpenTask.then((fn) => fn());
      clearInterval(presenceTimer);
      disposeHost();
      disposeArtifacts();
      window.removeEventListener("focus", pollForge);
      clearInterval(forgeTimer);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Keys inside the session pane belong to the attached TUI, not the
      // board — Esc there is Claude's cancel, not "close the palette".
      if (paneHasFocus()) return;
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
    return (
      <div className="app-loading">
        <TildoneMark width={44} className="app-loading-mark" />
        {initError ? (
          <div className="app-loading-error">
            <strong>Couldn’t open your board.</strong>
            <p>
              The database didn’t load after several tries. Quitting and
              reopening Tildone usually clears it.
            </p>
            <pre>{initError}</pre>
          </div>
        ) : (
          <span className="app-loading-status">{initStatus}</span>
        )}
      </div>
    );
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
      <SessionPane />
      {aiSettingsOpen && <AISettings />}
      {settingsOpen && <SettingsDialog />}
      {tagManagerOpen && <TagManager />}
      <CommandPalette />
      <Lightbox />
      <QuitWarning />
      {showFirstRun && <FirstRun onDone={() => setFirstRunDone(true)} />}
    </div>
  );
}

export default App;
