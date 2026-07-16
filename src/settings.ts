import { create } from "zustand";

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
  settingsOpen: boolean;

  setTheme: (theme: Theme) => void;
  setWeekStart: (weekStart: WeekStart) => void;
  setDefaultProjectId: (id: number | null) => void;
  setAgentServer: (enabled: boolean) => void;
  setAgentNotify: (enabled: boolean) => void;
  setTagsCollapsed: (collapsed: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

const STORAGE_KEY = "tildone-settings";

function loadPersisted(): Pick<
  SettingsState,
  "theme" | "weekStart" | "defaultProjectId" | "agentServer" | "agentNotify" | "tagsCollapsed"
> {
  const defaults = {
    theme: "auto" as Theme,
    weekStart: "monday" as WeekStart,
    defaultProjectId: null,
    agentServer: false,
    agentNotify: true,
    tagsCollapsed: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
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
