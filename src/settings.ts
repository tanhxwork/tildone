import { create } from "zustand";
import { prunedGoalDismissals } from "./selectors";

export type Theme = "auto" | "light" | "dark";
export type WeekStart = "monday" | "sunday";

interface SettingsState {
  theme: Theme;
  weekStart: WeekStart;
  defaultProjectId: number | null;
  agentServer: boolean;
  /** Raise a native notification when an agent completes / blocks / needs-review a
   * task. Default on. Only meaningful while agentServer is on. */
  agentNotify: boolean;
  tagsCollapsed: boolean;
  /** Per-project sidebar goal-nesting collapse (migration 025). Missing entry
   * means expanded — same "true = collapsed" convention as tagsCollapsed, keyed
   * by project id since each project's goal list collapses independently. */
  projectGoalsCollapsed: Record<number, boolean>;
  /** "Not yet" on a goal's completion strip, keyed by goal id and remembering
   * the task total it was dismissed at. Keying on the total is what re-arms it:
   * dismiss at 3/3, add a fourth task, and finishing that one is a new
   * completion moment rather than a strip the user already said no to. */
  goalCloseDismissed: Record<number, number>;
  settingsOpen: boolean;

  setTheme: (theme: Theme) => void;
  setWeekStart: (weekStart: WeekStart) => void;
  setDefaultProjectId: (id: number | null) => void;
  setAgentServer: (enabled: boolean) => void;
  setAgentNotify: (enabled: boolean) => void;
  setTagsCollapsed: (collapsed: boolean) => void;
  setProjectGoalsCollapsed: (projectId: number, collapsed: boolean) => void;
  dismissGoalClose: (goalId: number, total: number) => void;
  /** Drop dismissals for goals that no longer exist. */
  pruneGoalCloseDismissed: (liveGoalIds: number[]) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

const STORAGE_KEY = "tildone-settings";

function loadPersisted(): Pick<
  SettingsState,
  | "theme"
  | "weekStart"
  | "defaultProjectId"
  | "agentServer"
  | "agentNotify"
  | "tagsCollapsed"
  | "projectGoalsCollapsed"
  | "goalCloseDismissed"
> {
  const defaults = {
    theme: "auto" as Theme,
    weekStart: "monday" as WeekStart,
    defaultProjectId: null,
    agentServer: false,
    agentNotify: true,
    tagsCollapsed: false,
    projectGoalsCollapsed: {} as Record<number, boolean>,
    goalCloseDismissed: {} as Record<number, number>,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    const goalCloseDismissed: Record<number, number> = {};
    if (parsed.goalCloseDismissed && typeof parsed.goalCloseDismissed === "object") {
      for (const [key, value] of Object.entries(parsed.goalCloseDismissed)) {
        const id = Number(key);
        if (Number.isFinite(id) && typeof value === "number" && Number.isFinite(value)) {
          goalCloseDismissed[id] = value;
        }
      }
    }
    const projectGoalsCollapsed: Record<number, boolean> = {};
    if (parsed.projectGoalsCollapsed && typeof parsed.projectGoalsCollapsed === "object") {
      for (const [key, value] of Object.entries(parsed.projectGoalsCollapsed)) {
        const id = Number(key);
        if (Number.isFinite(id) && value === true) projectGoalsCollapsed[id] = true;
      }
    }
    return {
      theme: ["auto", "light", "dark"].includes(parsed.theme) ? parsed.theme : defaults.theme,
      weekStart: ["monday", "sunday"].includes(parsed.weekStart)
        ? parsed.weekStart
        : defaults.weekStart,
      defaultProjectId:
        typeof parsed.defaultProjectId === "number" ? parsed.defaultProjectId : null,
      agentServer: parsed.agentServer === true,
      // Default on: absent (older settings) or any non-false value means notify.
      agentNotify: parsed.agentNotify !== false,
      tagsCollapsed: parsed.tagsCollapsed === true,
      projectGoalsCollapsed,
      goalCloseDismissed,
    };
  } catch {
    return defaults;
  }
}

function persist(state: SettingsState) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      theme: state.theme,
      weekStart: state.weekStart,
      defaultProjectId: state.defaultProjectId,
      agentServer: state.agentServer,
      agentNotify: state.agentNotify,
      tagsCollapsed: state.tagsCollapsed,
      projectGoalsCollapsed: state.projectGoalsCollapsed,
      goalCloseDismissed: state.goalCloseDismissed,
    }),
  );
}

export const useSettings = create<SettingsState>()((set, get) => ({
  ...loadPersisted(),
  settingsOpen: false,

  setTheme: (theme) => {
    set({ theme });
    persist(get());
    applyTheme(theme);
  },
  setWeekStart: (weekStart) => {
    set({ weekStart });
    persist(get());
  },
  setDefaultProjectId: (defaultProjectId) => {
    set({ defaultProjectId });
    persist(get());
  },
  setAgentServer: (agentServer) => {
    set({ agentServer });
    persist(get());
  },
  setAgentNotify: (agentNotify) => {
    set({ agentNotify });
    persist(get());
  },
  setTagsCollapsed: (tagsCollapsed) => {
    set({ tagsCollapsed });
    persist(get());
  },
  setProjectGoalsCollapsed: (projectId, collapsed) => {
    set((s) => {
      const next = { ...s.projectGoalsCollapsed };
      if (collapsed) next[projectId] = true;
      else delete next[projectId];
      return { projectGoalsCollapsed: next };
    });
    persist(get());
  },
  dismissGoalClose: (goalId, total) => {
    set((s) => ({ goalCloseDismissed: { ...s.goalCloseDismissed, [goalId]: total } }));
    persist(get());
  },
  // Called on every board load, so it catches a goal deleted here, in another
  // window, or by an agent — one place instead of a hook in each delete path.
  pruneGoalCloseDismissed: (liveGoalIds) => {
    const next = prunedGoalDismissals(get().goalCloseDismissed, liveGoalIds);
    if (next === null) return;
    set({ goalCloseDismissed: next });
    persist(get());
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
}));

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(theme: Theme) {
  const resolved = theme === "auto" ? (darkQuery.matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
}

darkQuery.addEventListener("change", () => applyTheme(useSettings.getState().theme));

applyTheme(useSettings.getState().theme);
