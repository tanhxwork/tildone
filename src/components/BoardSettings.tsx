import { useEffect, useState } from "react";
import { hubToken } from "../hubClient";
import { useHubStatus } from "../hubStatus";
import { useSettings } from "../settings";
import { useStore } from "../store";

/** Settings → Board: this machine's board, or another Tildone's (the hub). */
export function BoardSection() {
  const boardHubUrl = useSettings((s) => s.boardHubUrl);
  const boardHubToken = useSettings((s) => s.boardHubToken);
  const setBoardHub = useSettings((s) => s.setBoardHub);
  const hubError = useStore((s) => s.hubError);
  const status = useHubStatus((s) => s.status);
  // Picking "Hub" only opens the fields; nothing changes until Connect, because a
  // new URL or token reloads the window.
  const [hubPicked, setHubPicked] = useState(boardHubUrl !== "");
  const [url, setUrl] = useState(boardHubUrl);
  const [token, setToken] = useState(boardHubToken);
  const [showToken, setShowToken] = useState(false);
  const inClientMode = boardHubUrl !== "";
  const dirty = url.trim() !== boardHubUrl || token.trim() !== boardHubToken;

  let line = "Not connected";
  if (inClientMode && !dirty) {
    if (hubError) line = hubError;
    else if (status && status.state !== "connected") line = status.message;
    else line = "Connected";
  }

  return (
    <section className="settings-section">
      <h3 className="settings-heading">Board</h3>

      <div className="settings-row">
        <div className="settings-label">
          Use the board on
          <span className="settings-sub">
            This machine, or another Tildone that has Agent access on.
          </span>
        </div>
        <div className="segmented" role="group" aria-label="Board">
          {(["machine", "hub"] as const).map((choice) => (
            <button
              key={choice}
              className={(choice === "hub") === hubPicked ? "active" : ""}
              onClick={() => {
                setHubPicked(choice === "hub");
                // Back to this machine at once; the token stays for the next time.
                if (choice === "machine" && inClientMode) setBoardHub("", boardHubToken);
              }}
            >
              {choice === "hub" ? "Hub" : "This machine"}
            </button>
          ))}
        </div>
      </div>

      {hubPicked && (
        <>
          <div className="settings-row">
            <div className="settings-label">Hub URL</div>
            <input
              className="settings-input"
              aria-label="Board hub URL"
              placeholder="http://workstation:11502"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="settings-row">
            <div className="settings-label">
              Hub token
              <span className="settings-sub">Shown in the hub’s Settings, under Agent access.</span>
            </div>
            <span className="settings-actions">
              <input
                className="settings-input"
                aria-label="Board hub token"
                type={showToken ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="btn small" onClick={() => setShowToken((v) => !v)}>
                {showToken ? "Hide" : "Show"}
              </button>
            </span>
          </div>

          <div className="settings-row">
            <div className="settings-label">
              Status
              <span className="settings-sub" role="status" data-testid="hub-status">
                {line}
              </span>
            </div>
            <button
              className="btn small"
              disabled={!url.trim() || !dirty}
              onClick={() => setBoardHub(url, token)}
            >
              Connect
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The token another Tildone needs to use this one as its hub. Masked until asked
 * for, like the token field above: it is a credential, and the dialog is
 * screenshared often enough.
 */
export function HubTokenRow() {
  const [token, setToken] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void hubToken()
      .then(setToken)
      .catch(() => setToken(null));
  }, []);

  if (!token) return null;
  return (
    <div className="settings-row">
      <div className="settings-label">
        Hub token
        <span className="settings-sub">
          Another Tildone enters this, with this machine’s address, to use this board.
        </span>
      </div>
      <span className="settings-actions">
        <input
          className="settings-input"
          aria-label="Hub token"
          type={show ? "text" : "password"}
          readOnly
          value={token}
        />
        <button className="btn small" onClick={() => setShow((v) => !v)}>
          {show ? "Hide" : "Show"}
        </button>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard.writeText(token).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </div>
  );
}
