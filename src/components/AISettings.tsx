import { useEffect, useState } from "react";
import {
  MODEL_TIERS,
  aiReady,
  recommendedTier,
  useAI,
  type AIMode,
  type EngineModelId,
} from "../ai";
import { IconCheck, IconSparkles, IconX } from "./Icons";

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
    ramBytes,
    fetchRam,
    installing,
    starting,
    progress,
    installEngine,
    stopEngine,
    refreshModels,
    deleteModel,
    useModel,
    diskModels,
    disk,
    closeSettings,
    chat,
    secretary,
    refreshSecretary,
  } = useAI();

  useEffect(() => {
    void probe();
    void refreshEngine();
    void refreshModels();
    void fetchRam();
    void refreshSecretary();
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

  async function downloadTier(id: EngineModelId) {
    setError("");
    setConfig({ engineModel: id });
    try {
      await installEngine();
      await refreshModels();
    } catch (e) {
      setError(String(e));
    }
  }

  async function useTier(id: EngineModelId) {
    setError("");
    try {
      await useModel(id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeModel(file: string) {
    setError("");
    try {
      await deleteModel(file);
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
    <div className="modal-overlay" onClick={closeSettings}>
      <div
        className="modal ai-modal"
        role="dialog"
        aria-label="AI Assistant settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <IconSparkles size={15} /> AI Assistant
          </h2>
          <button className="icon-btn" aria-label="Close" onClick={closeSettings}>
            <IconX />
          </button>
        </div>

        <p className="ai-intro">
          Everything runs locally on this computer — your tasks never leave your
          machine.
        </p>

        <div className="ai-modes">
          <label className={`ai-mode ${config.mode === "off" ? "selected" : ""}`}>
            <input
              type="radio"
              name="ai-mode"
              checked={config.mode === "off"}
              onChange={() => pickMode("off")}
            />
            <div>
              <div className="ai-mode-title">Off</div>
              <div className="ai-mode-desc">No AI features.</div>
            </div>
          </label>

          <label
            className={`ai-mode ${config.mode === "external" ? "selected" : ""}`}
          >
            <input
              type="radio"
              name="ai-mode"
              checked={config.mode === "external"}
              onChange={() => pickMode("external")}
            />
            <div>
              <div className="ai-mode-title">My own local AI</div>
              <div className="ai-mode-desc">
                Use Ollama, LM Studio or any local server you already run.
              </div>
            </div>
          </label>

          <label
            className={`ai-mode ${config.mode === "builtin" ? "selected" : ""}`}
          >
            <input
              type="radio"
              name="ai-mode"
              checked={config.mode === "builtin"}
              onChange={() => pickMode("builtin")}
            />
            <div>
              <div className="ai-mode-title">Built-in engine</div>
              <div className="ai-mode-desc">
                Tildone runs its own model on port 11500 — it won't touch your
                other AI apps.
              </div>
            </div>
          </label>
        </div>

        {config.mode === "external" && (
          <div className="ai-panel">
            <div className="ai-panel-header">
              <span>Detected on this computer</span>
              <button className="btn small" disabled={probing} onClick={() => void probe()}>
                {probing ? "Scanning…" : "Rescan"}
              </button>
            </div>

            {detected.length === 0 && !probing && (
              <p className="ai-hint">
                Nothing found on the usual ports (11434, 1234, 8080). Start your
                AI app, or enter its address below.
              </p>
            )}

            {detected.map((server) => (
              <div key={server.base_url}>
                <label
                  className={`ai-server ${config.baseUrl === server.base_url ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="ai-server"
                    checked={config.baseUrl === server.base_url}
                    onChange={() => pickServer(server.base_url, server.models)}
                  />
                  <span className="ai-server-name">{server.name}</span>
                  <span className="ai-server-url">{server.base_url}</span>
                  <span className="ai-server-count">
                    {server.models.length} model{server.models.length === 1 ? "" : "s"}
                  </span>
                </label>
                {config.baseUrl === server.base_url && server.models.length > 0 && (
                  <label className="field ai-model-field">
                    <span className="field-label">Model</span>
                    <select
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
              <p className="ai-hint">
                Currently set to {config.baseUrl} ({config.model || "no model"}).
              </p>
            )}

            <div className="ai-custom">
              <input
                value={customUrl}
                placeholder="Custom address, e.g. localhost:8080"
                aria-label="Custom server address"
                onChange={(e) => setCustomUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && customUrl.trim() && void connectCustom()}
              />
              <button
                className="btn"
                disabled={!customUrl.trim() || customBusy}
                onClick={() => void connectCustom()}
              >
                {customBusy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        )}

        {config.mode === "builtin" && (
          <div className="ai-panel">
            <div className="ai-models">
              {MODEL_TIERS.map((tier) => {
                const onDisk = diskModels.find((m) => m.tier === tier.id);
                const rec = ramBytes !== null && recommendedTier(ramBytes) === tier.id;
                const lowRam = ramBytes !== null && tier.minRamGB > ramBytes / 1024 ** 3;
                const downloadingThis = installing && config.engineModel === tier.id;
                const state = onDisk?.running ? "active" : onDisk ? "ready" : "missing";
                return (
                  <div key={tier.id} className={`ai-model ${state}`}>
                    <div className="ai-model-main">
                      <span className="ai-model-label">
                        {tier.label}
                        {rec && <span className="ai-tier-badge">Recommended</span>}
                      </span>
                      <span className="ai-model-detail">{tier.detail}</span>
                      {lowRam && (
                        <span className="ai-model-warn">
                          Needs ≥ {tier.minRamGB} GB RAM — may run slowly here
                        </span>
                      )}
                    </div>
                    <span className="ai-model-size">
                      {onDisk ? formatGB(onDisk.size_bytes) : `~${tier.sizeGB} GB`}
                    </span>
                    <span className={`ai-model-state ${state}`}>
                      {state === "active"
                        ? "Active"
                        : state === "ready"
                          ? "Ready"
                          : "Not downloaded"}
                    </span>
                    <div className="ai-model-actions">
                      {downloadingThis ? (
                        <div className="ai-progress-block">
                          <span className="ai-hint">
                            {progress?.phase === "model"
                              ? `Model… ${formatMB(progress.downloaded)}${progress.total ? ` / ${formatMB(progress.total)}` : ""}`
                              : progress
                                ? `Engine… ${formatMB(progress.downloaded)}${progress.total ? ` / ${formatMB(progress.total)}` : ""}`
                                : "Preparing…"}
                          </span>
                          <div className="ai-progress">
                            <div
                              className="ai-progress-fill"
                              style={{ transform: `scaleX(${pct !== null ? pct / 100 : 0.08})` }}
                            />
                          </div>
                        </div>
                      ) : state === "active" ? (
                        <button className="btn small" onClick={() => void stopEngine()}>
                          Stop
                        </button>
                      ) : state === "ready" ? (
                        <>
                          <button
                            className="btn small primary"
                            disabled={starting}
                            onClick={() => void useTier(tier.id)}
                          >
                            {starting ? "Starting…" : "Use"}
                          </button>
                          <button
                            className="btn small"
                            onClick={() => void removeModel(onDisk!.file)}
                          >
                            Delete
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn small primary"
                          disabled={installing}
                          onClick={() => void downloadTier(tier.id)}
                        >
                          Download
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {diskModels
                .filter((m) => m.tier === null)
                .map((m) => (
                  <div key={m.file} className="ai-model orphan">
                    <div className="ai-model-main">
                      <span className="ai-model-label">Other model</span>
                      <span className="ai-model-detail">{m.file}</span>
                    </div>
                    <span className="ai-model-size">{formatGB(m.size_bytes)}</span>
                    <span className="ai-model-state">Unused</span>
                    <div className="ai-model-actions">
                      <button className="btn small" onClick={() => void removeModel(m.file)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
            </div>

            {disk && (
              <p className="ai-disk">
                {formatGB(disk.models_bytes)} in models · {formatGB(disk.free_bytes)} free
              </p>
            )}

            {engine?.running && (
              <p className="ai-hint">Engine running on port {engine.port}.</p>
            )}

            <label className="ai-autostart">
              <input
                type="checkbox"
                checked={config.autoStart}
                onChange={(e) => setConfig({ autoStart: e.target.checked })}
              />
              Start the engine when Tildone opens
            </label>
          </div>
        )}

        {aiReady(config) && (
          <div className="ai-panel ai-secretary">
            <label className="ai-autostart">
              <input
                type="checkbox"
                checked={config.secretaryEnabled}
                onChange={(e) => setConfig({ secretaryEnabled: e.target.checked })}
              />
              Board secretary — tick subtasks and log progress from working
              sessions' transcripts
            </label>
            {config.secretaryEnabled && (
              <p className="ai-hint">
                {!secretary?.enabled
                  ? "Starting…"
                  : secretary.watching.length === 0
                    ? "Idle — no working session has claimed a card."
                    : `Watching ${secretary.watching.length} session${
                        secretary.watching.length === 1 ? "" : "s"
                      } · ${
                        secretary.behind.length > 0
                          ? secretary.engine_ready
                            ? `catching up on ${secretary.behind.length}`
                            : "engine off — will catch up"
                          : "up to date"
                      }`}
              </p>
            )}
          </div>
        )}

        {error && <p className="ai-error">{error}</p>}
        {testResult && (
          <p className="ai-test-result">
            <IconCheck size={13} /> {testResult}
          </p>
        )}

        <div className="modal-footer">
          {aiReady(config) && (
            <button className="btn" disabled={testing} onClick={() => void runTest()}>
              {testing ? "Testing…" : "Test it"}
            </button>
          )}
          <div className="spacer" />
          <button className="btn primary" onClick={closeSettings}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
