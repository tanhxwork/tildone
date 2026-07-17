import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";
import { useSettings, type Theme, type WeekStart } from "../settings";
import { useStore, type ImportedTask } from "../store";
import type { Status } from "../types";
import { parseCSV, toCSV, toJSON, toMarkdown } from "../utils/exportData";
import { IconX } from "./Icons";

type ExportFormat = "json" | "csv" | "markdown";

/** Mirrors `HookStatus` in src-tauri/src/hookinstall.rs. */
interface HookStatus {
  installed: boolean;
  /** Where the hook script lives once installed. Shown so the user can go look. */
  script: string;
  /** The file Connect will edit. Named up front — nobody should find out afterwards. */
  settings: string;
}

const EXT: Record<ExportFormat, string> = { json: "json", csv: "csv", markdown: "md" };

export function SettingsDialog() {
  const {
    theme,
    weekStart,
    defaultProjectId,
    agentServer,
    agentNotify,
    setTheme,
    setWeekStart,
    setDefaultProjectId,
    setAgentServer,
    setAgentNotify,
    closeSettings,
  } = useSettings();
  const { projects, tasks, tags, importData } = useStore();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  // The port is only fixed for a release build — a dev build takes whatever the
  // OS hands out — so the endpoint has to be asked for, never assumed. This also
  // reports the *server's* real state rather than echoing the setting back, which
  // is what let the server sit dead while the dialog claimed it was on.
  const [endpoint, setEndpoint] = useState<string | null>(null);
  // Asked for, never assumed — same reason as the endpoint above. Whether the hook is
  // installed is a fact about the user's settings.json, which anything (including the
  // user, by hand) may have changed since last we looked.
  const [hook, setHook] = useState<HookStatus | null>(null);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookMessage, setHookMessage] = useState<string | null>(null);

  useEffect(() => {
    void invoke<string | null>("agent_server_endpoint")
      .then(setEndpoint)
      .catch(() => setEndpoint(null));
    void invoke<HookStatus>("hook_status")
      .then(setHook)
      .catch(() => setHook(null));
  }, []);

  async function toggleHook() {
    setHookBusy(true);
    setHookMessage(null);
    try {
      const msg = await invoke<string>(hook?.installed ? "hook_uninstall" : "hook_install");
      setHookMessage(msg);
      // Re-read rather than assume the toggle landed: the command may have refused
      // (malformed settings) and changed nothing at all.
      setHook(await invoke<HookStatus>("hook_status"));
    } catch (e) {
      setHookMessage(String(e));
    } finally {
      setHookBusy(false);
    }
  }

  async function toggleAgentServer(enabled: boolean) {
    setAgentMessage(null);
    try {
      if (enabled) {
        setEndpoint(await invoke<string>("agent_server_start"));
        // Sync the notify preference into the freshly-started server.
        await invoke("agent_set_notify", { enabled: agentNotify });
      } else {
        await invoke("agent_server_stop");
        setEndpoint(null);
      }
      setAgentServer(enabled);
    } catch (err) {
      setEndpoint(null);
      setAgentMessage(String(err));
    }
  }

  function toggleAgentNotify(enabled: boolean) {
    setAgentNotify(enabled);
    // Fire-and-forget: the flag lives in the Rust process. If the server isn't
    // running the call is a harmless no-op that the next start re-syncs.
    void invoke("agent_set_notify", { enabled }).catch(() => {});
  }

  async function doExport(format: ExportFormat) {
    setMessage(null);
    const path = await saveDialog({
      defaultPath: `tildone-export.${EXT[format]}`,
      filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }],
    });
    if (!path) return;
    const snapshot = { projects, tasks, tags };
    const content =
      format === "json"
        ? toJSON(snapshot)
        : format === "csv"
          ? toCSV(snapshot)
          : toMarkdown(snapshot);
    await writeTextFile(path, content);
    setMessage(`Exported to ${path}`);
  }

  async function doImport() {
    setMessage(null);
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Tildone import", extensions: ["json", "csv"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const text = await readTextFile(path);
      let payload: { projects?: { name: string; color?: string }[]; tasks: ImportedTask[] };
      if (path.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text);
        const rawTasks = Array.isArray(parsed) ? parsed : parsed.tasks;
        if (!Array.isArray(rawTasks)) throw new Error("No tasks array found in JSON");
        payload = {
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          tasks: rawTasks.map((t: Record<string, unknown>) => ({
            title: String(t.title ?? t.content ?? ""),
            notes: typeof t.notes === "string" ? t.notes : undefined,
            status: (t.status as Status) ?? undefined,
            priority: typeof t.priority === "number" ? t.priority : undefined,
            due_date: typeof t.due_date === "string" ? t.due_date : null,
            completed_at: typeof t.completed_at === "string" ? t.completed_at : null,
            project: typeof t.project === "string" ? t.project : null,
            tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
          })),
        };
      } else {
        const rows = parseCSV(text);
        if (rows.length < 2) throw new Error("CSV has no data rows");
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const col = (name: string) => header.indexOf(name);
        const get = (row: string[], name: string) => {
          const i = col(name);
          return i >= 0 ? (row[i] ?? "").trim() : "";
        };
        if (col("title") === -1) throw new Error('CSV needs a "title" column');
        payload = {
          tasks: rows.slice(1).map((row) => ({
            title: get(row, "title"),
            notes: get(row, "notes") || undefined,
            status: (get(row, "status") as Status) || undefined,
            priority: get(row, "priority") ? Number(get(row, "priority")) : undefined,
            due_date: get(row, "due_date") || get(row, "due") || null,
            completed_at: get(row, "completed_at") || null,
            project: get(row, "project") || null,
            tags: (get(row, "tags") || "")
              .split(/[;|]/)
              .map((s) => s.trim())
              .filter(Boolean),
          })),
        };
      }
      const count = await importData(payload);
      setMessage(`Imported ${count} task${count === 1 ? "" : "s"}.`);
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={closeSettings}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close settings" onClick={closeSettings}>
            <IconX size={14} />
          </button>
        </div>

        <section className="settings-section">
          <h3 className="settings-heading">General</h3>

          <div className="settings-row">
            <div className="settings-label">
              Theme
              <span className="settings-sub">Auto follows the system appearance</span>
            </div>
            <div className="segmented" role="group" aria-label="Theme">
              {(["auto", "light", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  className={theme === t ? "active" : ""}
                  onClick={() => setTheme(t)}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-label">Start week on</div>
            <select
              className="priority-filter"
              aria-label="Start week on"
              value={weekStart}
              onChange={(e) => setWeekStart(e.target.value as WeekStart)}
            >
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </select>
          </div>

          <div className="settings-row">
            <div className="settings-label">
              New tasks go to
              <span className="settings-sub">when no project is selected</span>
            </div>
            <select
              className="priority-filter"
              aria-label="Default project for new tasks"
              value={defaultProjectId ?? ""}
              onChange={(e) =>
                setDefaultProjectId(e.target.value === "" ? null : Number(e.target.value))
              }
            >
              <option value="">Inbox</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Agent access</h3>

          <div className="settings-row">
            <div className="settings-label">
              Let AI agents manage tasks
              <span className="settings-sub">
                {endpoint
                  ? `Local MCP server on ${endpoint.replace(/^https?:\/\//, "").replace(/\/mcp$/, "")} — only while Tildone is running`
                  : "Local MCP server — only while Tildone is running"}
              </span>
            </div>
            <div className="segmented" role="group" aria-label="Agent access">
              {([false, true] as const).map((on) => (
                <button
                  key={String(on)}
                  className={agentServer === on ? "active" : ""}
                  onClick={() => void toggleAgentServer(on)}
                >
                  {on ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>

          {agentServer && (
            <div className="settings-row">
              <div className="settings-label">
                Notify me when an agent finishes or gets stuck
                <span className="settings-sub">
                  A native notification when an agent completes a task, or marks one
                  blocked or needs-review — never for your own changes.
                </span>
              </div>
              <div className="segmented" role="group" aria-label="Agent notifications">
                {([false, true] as const).map((on) => (
                  <button
                    key={String(on)}
                    className={agentNotify === on ? "active" : ""}
                    onClick={() => toggleAgentNotify(on)}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {agentServer && (
            <div className="settings-row">
              <div className="settings-label">
                Show Claude Code working, live
                <span className="settings-sub">
                  {hook?.installed
                    ? "Cards show which worktree an agent is in and whether it is working right now."
                    : "Without this, a card can only show when an agent last wrote to the board — an agent working quietly for 25 minutes looks like one that left."}
                </span>
              </div>
              <button
                className="btn small"
                disabled={hookBusy}
                onClick={() => void toggleHook()}
              >
                {hookBusy ? "Working…" : hook?.installed ? "Disconnect" : "Connect Claude Code"}
              </button>
            </div>
          )}
          {/* Say plainly that this edits their file, and exactly which one. Nobody
              should discover after the fact that a todo app rewrote their settings. */}
          {agentServer && hook && !hook.installed && (
            <p className="settings-sub">
              Adds four hooks to <code>{hook.settings}</code> and copies a script to{" "}
              <code>{hook.script}</code>. Your existing hooks are left alone, and
              Disconnect removes exactly what was added.
            </p>
          )}
          {hookMessage && <p className="settings-message">{hookMessage}</p>}

          {endpoint && (
            <p className="settings-sub">
              Connect an agent, e.g.:{" "}
              <code>claude mcp add --transport http tildone {endpoint}</code>
            </p>
          )}
          {agentServer && !endpoint && (
            <p className="settings-message">
              Agent access is on, but the server is not listening. Restarting Tildone
              usually fixes it.
            </p>
          )}
          {agentMessage && <p className="settings-message">{agentMessage}</p>}
        </section>

        <section className="settings-section">
          <h3 className="settings-heading">Data & backup</h3>
          <p className="settings-sub">
            Everything stays on this Mac in a local SQLite database (tildone.db in the app data
            folder).
          </p>

          <div className="settings-row">
            <div className="settings-label">Export</div>
            <div className="settings-actions">
              <button className="btn small" disabled={busy} onClick={() => void doExport("json")}>
                JSON
              </button>
              <button className="btn small" disabled={busy} onClick={() => void doExport("csv")}>
                CSV
              </button>
              <button
                className="btn small"
                disabled={busy}
                onClick={() => void doExport("markdown")}
              >
                Markdown
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-label">
              Import
              <span className="settings-sub">JSON (Tildone export) or CSV with a title column</span>
            </div>
            <div className="settings-actions">
              <button className="btn small" disabled={busy} onClick={() => void doImport()}>
                {busy ? "Importing…" : "Import…"}
              </button>
            </div>
          </div>

          {message && <p className="settings-message">{message}</p>}
        </section>
      </div>
    </div>
  );
}
