import type { ReactNode } from "react";
import { classifyHubError } from "../hubError";
import { foreignLine, NOT_AVAILABLE, useOffline } from "../offline";
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

/** The reason a control is off while the hub is down; renders nothing online. */
export function OfflineHint({ className = "" }: { className?: string }) {
  const offline = useOffline((s) => s.offline);
  return offline ? <span className={`offline-hint ${className}`}>{NOT_AVAILABLE}</span> : null;
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
  const { offline, lastSynced, waiting, dropped, foreign, notice } = useOffline();
  const line = (text: ReactNode) => (
    <div className="hub-banner" role="status">
      {text}
    </div>
  );
  // The line under the banner: why the last write did not happen.
  const note = notice && (
    <div className="hub-banner hub-notice" role="alert">
      {notice}
    </div>
  );
  if (offline) {
    return (
      <>
        {line(
          <>
            Offline · last synced {clock(lastSynced)}
            {waiting > 0 && ` · ${waiting} ${waiting === 1 ? "change" : "changes"} waiting`}
          </>,
        )}
        {note}
      </>
    );
  }
  if (foreign) {
    return (
      <>
        {line(foreignLine(foreign))}
        {note}
      </>
    );
  }
  if (dropped > 0) {
    return (
      <>
        {line(
          <>
            {dropped} offline {dropped === 1 ? "change was" : "changes were"} rejected by the hub
            and dropped.{" "}
            <button className="btn small" onClick={() => useOffline.setState({ dropped: 0 })}>
              Dismiss
            </button>
          </>,
        )}
        {note}
      </>
    );
  }
  if (!status || status.state === "connected") return note || null;
  return (
    <>
      {line(`${classifyHubError(status.message).label}: ${status.message}`)}
      {note}
    </>
  );
}
