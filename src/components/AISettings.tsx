import { useEffect, useState } from "react";
import { aiReady, useAI, type AIMode } from "../ai";
import { IconCheck, IconSparkles, IconX } from "./Icons";
import {
  Button,
  field,
  fieldLabel,
  iconBtn,
  modal,
  modalOverlay,
  modalTitle,
} from "./ui";

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

const aiHint = "text-[12px] text-ink-muted";
const aiPanel = "flex flex-col gap-2.5 rounded-lg bg-inset p-3";

function aiDotClass(on: boolean): string {
  return `size-[7px] shrink-0 rounded-full ${on ? "bg-success" : "bg-ink-faint"}`;
}

function aiModeClass(selected: boolean): string {
  return `flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
    selected ? "border-accent bg-active" : "border-edge hover:bg-hover"
  }`;
}

export function AISettings() {
  const {
    config,
    setConfig,
    detected,
    probing,
    probe,
    refreshEngine,
    identify,
    engine,
    installing,
    starting,
    progress,
    installEngine,
    startEngine,
    stopEngine,
    closeSettings,
    chat,
  } = useAI();

  useEffect(() => {
    void probe();
    void refreshEngine();
    // Scan once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [customUrl, setCustomUrl] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  function pickMode(mode: AIMode) {
    setError("");
    setTestResult("");
    setConfig({ mode });
  }

  function pickServer(baseUrl: string, models: string[]) {
    setConfig({
      baseUrl,
      model: models.includes(config.model) ? config.model : (models[0] ?? ""),
    });
  }

  async function connectCustom() {
    setCustomBusy(true);
    setError("");
    try {
      const server = await identify(customUrl);
      pickServer(server.base_url, server.models);
      setCustomUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setCustomBusy(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setError("");
    setTestResult("");
    try {
      const reply = await chat(
        "You are a helpful assistant inside a to-do app.",
        "Reply with a short friendly greeting, 8 words or fewer.",
      );
      setTestResult(reply);
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }

  async function install() {
    setError("");
    try {
      await installEngine();
    } catch (e) {
      setError(String(e));
    }
  }

  async function start() {
    setError("");
    try {
      await startEngine();
    } catch (e) {
      setError(String(e));
    }
  }

  const selected = detected.find((d) => d.base_url === config.baseUrl);
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className={modalOverlay} onClick={closeSettings}>
      <div
        className={`${modal} max-h-[calc(100vh-80px)] w-[520px] max-w-[calc(100vw-48px)] overflow-y-auto`}
        role="dialog"
        aria-label="AI Assistant settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className={`${modalTitle} flex items-center gap-[7px]`}>
            <IconSparkles size={15} /> AI Assistant
          </h2>
          <button className={iconBtn} aria-label="Close" onClick={closeSettings}>
            <IconX />
          </button>
        </div>

        <p className="text-[12.5px] text-ink-muted">
          Everything runs locally on this computer — your tasks never leave your
          machine.
        </p>

        <div className="flex flex-col gap-2">
          <label className={aiModeClass(config.mode === "off")}>
            <input
              type="radio"
              name="ai-mode"
              className="mt-0.5 accent-accent"
              checked={config.mode === "off"}
              onChange={() => pickMode("off")}
            />
            <div>
              <div className="text-[13px] font-semibold">Off</div>
              <div className="mt-0.5 text-[12px] leading-[1.45] text-ink-muted">
                No AI features.
              </div>
            </div>
          </label>

          <label className={aiModeClass(config.mode === "external")}>
            <input
              type="radio"
              name="ai-mode"
              className="mt-0.5 accent-accent"
              checked={config.mode === "external"}
              onChange={() => pickMode("external")}
            />
            <div>
              <div className="text-[13px] font-semibold">My own local AI</div>
              <div className="mt-0.5 text-[12px] leading-[1.45] text-ink-muted">
                Use Ollama, LM Studio or any local server you already run.
              </div>
            </div>
          </label>

          <label className={aiModeClass(config.mode === "builtin")}>
            <input
              type="radio"
              name="ai-mode"
              className="mt-0.5 accent-accent"
              checked={config.mode === "builtin"}
              onChange={() => pickMode("builtin")}
            />
            <div>
              <div className="text-[13px] font-semibold">Built-in engine</div>
              <div className="mt-0.5 text-[12px] leading-[1.45] text-ink-muted">
                Tildone runs its own model on port 11500 — it won't touch your
                other AI apps.
              </div>
            </div>
          </label>
        </div>

        {config.mode === "external" && (
          <div className={aiPanel}>
            <div className="flex items-center justify-between text-[12px] font-semibold text-ink-muted">
              <span>Detected on this computer</span>
              <Button small disabled={probing} onClick={() => void probe()}>
                {probing ? "Scanning…" : "Rescan"}
              </Button>
            </div>

            {detected.length === 0 && !probing && (
              <p className={aiHint}>
                Nothing found on the usual ports (11434, 1234, 8080). Start your
                AI app, or enter its address below.
              </p>
            )}

            {detected.map((server) => (
              <div key={server.base_url}>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-[12.5px] ${
                    config.baseUrl === server.base_url ? "border-accent" : "border-edge"
                  }`}
                >
                  <input
                    type="radio"
                    name="ai-server"
                    className="accent-accent"
                    checked={config.baseUrl === server.base_url}
                    onChange={() => pickServer(server.base_url, server.models)}
                  />
                  <span className="font-semibold">{server.name}</span>
                  <span className="text-[11.5px] text-ink-faint">{server.base_url}</span>
                  <span className="ml-auto text-[11.5px] text-ink-muted">
                    {server.models.length} model{server.models.length === 1 ? "" : "s"}
                  </span>
                </label>
                {config.baseUrl === server.base_url && server.models.length > 0 && (
                  <label className={`${field} mt-2`}>
                    <span className={fieldLabel}>Model</span>
                    <select
                      className="w-full cursor-pointer rounded-md border border-edge bg-card px-[9px] py-1.5 focus:border-accent focus:outline-none"
                      value={config.model}
                      onChange={(e) => setConfig({ model: e.target.value })}
                    >
                      {server.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            ))}

            {selected === undefined && config.baseUrl && (
              <p className={aiHint}>
                Currently set to {config.baseUrl} ({config.model || "no model"}).
              </p>
            )}

            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md border border-edge bg-card px-2.5 py-[7px] text-[12.5px] text-ink focus:border-accent focus:outline-none"
                value={customUrl}
                placeholder="Custom address, e.g. localhost:8080"
                aria-label="Custom server address"
                onChange={(e) => setCustomUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && customUrl.trim() && void connectCustom()}
              />
              <Button
                disabled={!customUrl.trim() || customBusy}
                onClick={() => void connectCustom()}
              >
                {customBusy ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </div>
        )}

        {config.mode === "builtin" && (
          <div className={aiPanel}>
            {engine === null ? (
              <p className={aiHint}>Checking engine status…</p>
            ) : !engine.installed ? (
              installing ? (
                <div className="flex flex-col gap-2">
                  <span className={aiHint}>
                    {progress?.phase === "model"
                      ? `Downloading model… ${formatMB(progress.downloaded)}${progress.total ? ` of ${formatMB(progress.total)}` : ""}`
                      : progress
                        ? `Downloading engine… ${formatMB(progress.downloaded)}${progress.total ? ` of ${formatMB(progress.total)}` : ""}`
                        : "Preparing download…"}
                  </span>
                  <div className="h-1.5 overflow-hidden rounded-[3px] bg-hover">
                    <div
                      className="h-full rounded-[3px] bg-accent transition-[width] duration-300"
                      style={{ width: pct !== null ? `${pct}%` : "8%" }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <p className={aiHint}>
                    One-time download of about 1.1 GB (engine + Qwen 2.5 model).
                    After that it works fully offline.
                  </p>
                  <Button variant="primary" className="justify-center" onClick={() => void install()}>
                    Download &amp; set up
                  </Button>
                </>
              )
            ) : (
              <div className="flex items-center gap-2">
                <span className={aiDotClass(engine.running)} />
                <span className={aiHint}>
                  {engine.running
                    ? `Running on port ${engine.port}`
                    : starting
                      ? "Starting…"
                      : "Installed — starts automatically when you use an AI feature"}
                </span>
                <div className="flex-1" />
                {engine.running ? (
                  <Button small onClick={() => void stopEngine()}>
                    Stop
                  </Button>
                ) : (
                  <Button small disabled={starting} onClick={() => void start()}>
                    Start now
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-[12px] text-danger wrap-anywhere">{error}</p>}
        {testResult && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-success">
            <IconCheck size={13} /> {testResult}
          </p>
        )}

        <div className="flex items-center gap-2">
          {aiReady(config) && (
            <Button disabled={testing} onClick={() => void runTest()}>
              {testing ? "Testing…" : "Test it"}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="primary" onClick={closeSettings}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
