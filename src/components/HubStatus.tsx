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
      <strong>Couldn’t reach the hub.</strong>
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

/** A quiet line while the hub connection is down; renders nothing when connected. */
export function HubStatusBanner() {
  const status = useHubStatus((s) => s.status);
  if (!status || status.state === "connected") return null;
  return (
    <div className="hub-banner" role="status">
      {status.state === "schema-mismatch" ? "Hub runs another version: " : "Hub unreachable: "}
      {status.message}
    </div>
  );
}
