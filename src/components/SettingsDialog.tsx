import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useState } from "react";
import { useSettings, type Theme, type WeekStart } from "../settings";
import { useStore, type ImportedTask } from "../store";
import type { Status } from "../types";
import { parseCSV, toCSV, toJSON, toMarkdown } from "../utils/exportData";
import { IconX } from "./Icons";

type ExportFormat = "json" | "csv" | "markdown";

const EXT: Record<ExportFormat, string> = { json: "json", csv: "csv", markdown: "md" };

export function SettingsDialog() {
  const {
    theme,
    weekStart,
    defaultProjectId,
    agentServer,
    setTheme,
    setWeekStart,
    setDefaultProjectId,
    setAgentServer,
    closeSettings,
  } = useSettings();
  const { projects, tasks, tags, importData } = useStore();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);

  async function toggleAgentServer(enabled: boolean) {
    setAgentMessage(null);
    try {
      if (enabled) {
        await invoke<string>("agent_server_start");
      } else {
        await invoke("agent_server_stop");
      }
      setAgentServer(enabled);
    } catch (err) {
      setAgentMessage(String(err));
    }
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
                Local MCP server on 127.0.0.1:11502 — only while Tildone is running
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
            <p className="settings-sub">
              Connect an agent, e.g.:{" "}
              <code>claude mcp add --transport http tildone http://127.0.0.1:11502/mcp</code>
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
