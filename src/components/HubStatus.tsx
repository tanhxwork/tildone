import { classifyHubError } from "../hubError";
import { useOffline } from "../offline";
import { useSettings } from "../settings";
import { useHubStatus } from "../hubStatus";
import { useStore } from "../store";

/**
 * Client mode, init failed: the hub did not answer (wrong token, unreachable, a
 * different schema). Names the cause, and offers the way back to this machine's
 * board. Clearing the hub URL reloads the window (appSettings.ts).
 */
export function HubErrorScreen({ error }: { error: string }) {
  const hubUrl = useSettings((s) => s.boardHubUrl);
  const setBoardHub = useSettings((s) => s.setBoardHub);
  const retry = () => {
    useStore.setState({ hubError: null });
    void useStore.getState().init();
  };
  return (
    <div className="app-loading-error" role="alert">
      <strong>{classifyHubError(error).heading}</strong>
      <p>{hubUrl}</p>
      <pre>{error}</pre>
      <div className="hub-error-actions">
        <button className="btn primary" onClick={retry}>
          Retry
        </button>
        <button className="btn" onClick={() => setBoardHub("", "")}>
          Use this machine’s board
        </button>
      </div>
    </div>
  );
}

const clock = (iso: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "unknown";
};

/**
 * A quiet line while the hub connection is down; renders nothing when connected.
 * Offline, it says how old the board is and how many changes wait to go up. After a
 * replay, it says once how many the hub rejected.
 */
export function HubStatusBanner() {
  const status = useHubStatus((s) => s.status);
  const { offline, lastSynced, waiting, dropped } = useOffline();
  if (offline) {
    return (
      <div className="hub-banner" role="status">
        Offline · last synced {clock(lastSynced)}
        {waiting > 0 && ` · ${waiting} ${waiting === 1 ? "change" : "changes"} waiting`}
      </div>
    );
  }
  if (dropped > 0) {
    return (
      <div className="hub-banner" role="status">
        {dropped} offline {dropped === 1 ? "change was" : "changes were"} rejected by the hub and
        dropped.{" "}
        <button className="btn small" onClick={() => useOffline.setState({ dropped: 0 })}>
          Dismiss
        </button>
      </div>
    );
  }
  if (!status || status.state === "connected") return null;
  return (
    <div className="hub-banner" role="status">
      {classifyHubError(status.message).label}: {status.message}
    </div>
  );
}
