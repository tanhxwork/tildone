import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAI } from "./ai";
import { setBoardHubUrl } from "./hubMode";
import { applyTheme, STORAGE_KEY, useSettings } from "./settings";
import {
  getSettings,
  migrateSettings,
  SETTINGS_CHANGED,
  type AppSettings,
} from "./settingsFile";
import { onSettings, receive } from "./settingsIo";
import {
  aiFromApp,
  legacyToApp,
  LEGACY_SETTINGS_KEYS,
  settingsFromApp,
  THEME_HINT_KEY,
} from "./settingsMap";

// Rust owns settings.json. This module is how the window follows it: it loads the
// file at launch (handing over the old localStorage values once), listens for every
// change from any writer (the dialog, MCP, tildone-axi, a hand edit), puts the new
// values in the stores, and runs the side effects of what changed. The stores' own
// setters only write; the effects live here so they run once whoever made the change.

const LEGACY_AI_KEY = "tildone-ai-config";

/** What the effects last ran against. null until the first load, which runs the boot effects. */
let applied: AppSettings | null = null;
let started = false;

/**
 * The installed app owns port 11502 by contract, so a fast restart (quit; replace
 * bundle; open) can race the outgoing process still holding the port. Retry the
 * bind a few times with backoff so a transient failure self-heals instead of
 * needing a manual relaunch. Safe to retry: `agent_server_start` returns the
 * existing endpoint when already up, and a failed bind stores no state.
 */
async function startAgentServerWithRetry(): Promise<string> {
  const backoffMs = [250, 500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke<string>("agent_server_start");
    } catch (err) {
      if (attempt >= backoffMs.length) {
        // Never swallow the final failure. The dialog shows it, and this carries
        // the precise reason (e.g. the port is still held) for anything watching.
        console.error(
          `tildone: MCP server failed to start after ${attempt + 1} attempts:`,
          err,
        );
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
  }
}

async function startAgentServer() {
  useSettings.setState({ agentError: null });
  try {
    const agentEndpoint = await startAgentServerWithRetry();
    // The setting may have been turned off again while the bind was retrying.
    if (applied && !applied.agent_server) {
      await invoke("agent_server_stop");
      return;
    }
    useSettings.setState({ agentEndpoint });
    // The notify flag lives in the Rust process (default on): push the saved
    // preference into the freshly-started server so a muted setting survives.
    await invoke("agent_set_notify", { enabled: useSettings.getState().agentNotify });
  } catch (err) {
    useSettings.setState({ agentEndpoint: null, agentError: String(err) });
  }
}

async function stopAgentServer() {
  try {
    await invoke("agent_server_stop");
    useSettings.setState({ agentEndpoint: null, agentError: null });
  } catch (err) {
    useSettings.setState({ agentError: String(err) });
  }
}

/** Ask Rust where the MCP server is; the dialog calls this when it opens. */
export async function refreshAgentEndpoint() {
  try {
    const agentEndpoint = await invoke<string | null>("agent_server_endpoint");
    useSettings.setState({ agentEndpoint });
  } catch {
    useSettings.setState({ agentEndpoint: null });
  }
}

const AI_KEYS = [
  "ai_mode",
  "ai_base_url",
  "ai_model",
  "ai_engine_model",
  "ai_auto_start",
  "ai_secretary",
] as const;

/** The side effects of `prev` becoming `next`; the first load (prev null) is the boot. */
function runEffects(prev: AppSettings | null, next: AppSettings) {
  const first = prev === null;
  const changed = (...keys: (keyof AppSettings)[]) =>
    first || keys.some((k) => prev[k] !== next[k]);

  if (changed("theme")) applyTheme(next.theme);

  // Which board this window shows is picked once, at init (db.ts, the hub connect).
  // A change of hub or token starts the window over rather than switching live.
  if (!first && changed("board_hub_url", "board_hub_token")) {
    window.location.reload();
    return;
  }
  const clientMode = next.board_hub_url.trim() !== "";

  // ws_hub_url needs no call: wsStore watches the store field and restarts its poll.

  if (clientMode) {
    // The hub's MCP server is the one agents use; a client starts none, whatever the
    // setting says. A server left running from before the switch stops here.
    if (first) void invoke("agent_server_stop").catch(() => {});
  } else if (changed("agent_server") && next.agent_server) void startAgentServer();
  else if (changed("agent_server") && !first) void stopAgentServer();
  else if (!first && changed("agent_notify")) {
    // Fire-and-forget: if the server isn't running this is a no-op that the next
    // start re-syncs.
    void invoke("agent_set_notify", { enabled: next.agent_notify }).catch(() => {});
  }

  const ai = useAI.getState();
  if (first) {
    // Warm the built-in engine on launch when the user opted in for chat.
    if (!clientMode && next.ai_mode === "builtin" && next.ai_auto_start) {
      ai.startEngine().catch(() => {});
    }
    // Board secretary: the Rust loop starts parked; push the config so it knows
    // whether (and where) to run. When pinned to the engine, this also starts it.
    void ai.syncSecretary();
  } else if (changed(...AI_KEYS)) {
    // Installed/running state is per-tier; re-check when the tier changes.
    if (changed("ai_engine_model")) void ai.refreshEngine();
    // Any config change may change where (or whether) the secretary runs.
    void ai.syncSecretary();
  }
}

function apply(next: AppSettings) {
  const prev = applied;
  applied = next;
  setBoardHubUrl(next.board_hub_url);
  useSettings.setState(settingsFromApp(next));
  localStorage.setItem(THEME_HINT_KEY, next.theme);
  useAI.setState({ config: aiFromApp(next) });
  runEffects(prev, next);
}

/** Drop the moved keys from localStorage once Rust has them; layout state stays. */
function dropLegacy() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (stored && typeof stored === "object") {
      for (const key of LEGACY_SETTINGS_KEYS) delete stored[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
    localStorage.removeItem(LEGACY_AI_KEY);
  } catch {
    // Leftovers are harmless: Rust ignores a second migration.
  }
}

/**
 * Load the settings into the stores and start following changes. Called once at
 * launch from the store's init. The first call also hands Rust the old
 * localStorage values; Rust keeps what settings.json already has and does this
 * only once per install.
 */
export async function loadAppSettings() {
  if (!started) {
    started = true;
    onSettings(apply);
    await listen<AppSettings>(SETTINGS_CHANGED, (event) => receive(event.payload));
    // MCP or the CLI installed, started, stopped or deleted the engine: bring the
    // badge, the model list and the secretary's endpoint up to date. (The dialog's
    // own actions refresh themselves; Rust emits this only for the outside ones.)
    await listen<string>("engine-changed", (event) => {
      const ai = useAI.getState();
      void ai.refreshModels();
      // A stop only refreshes, like the dialog's Stop: syncSecretary would start it again.
      if (event.payload === "stop") void ai.refreshEngine();
      // Probes the engine first, then starts it and configures the secretary as needed.
      else void ai.syncSecretary();
    });
  }
  const legacy = legacyToApp(
    localStorage.getItem(STORAGE_KEY),
    localStorage.getItem(LEGACY_AI_KEY),
  );
  let settings: AppSettings;
  try {
    settings = await migrateSettings(legacy);
  } catch {
    settings = await getSettings();
    receive(settings);
    return;
  }
  dropLegacy();
  receive(settings);
}
