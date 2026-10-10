import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettings } from "../settings";
import { timeAgo } from "../utils/dates";
import { useWsStore } from "../wsStore";
import {
  deliveryAction,
  deliveryKey,
  pillSummary,
  sitesUp,
  type DeliveryState,
  type WsDelivery,
} from "../wsServers";

// The ws dev-server hub in three places: the Servers page (WsServersView and
// WsServersHeader), the header pill with its popover (WsPill), and the sidebar
// count (in Sidebar.tsx). All three read the one poll in wsStore.ts.

const DOT_CLASS: Record<DeliveryState, string> = {
  running: "up",
  starting: "starting",
  stopped: "stopped",
  failed: "down",
};

/** "15:56:45" for the page header, "15:58" for the offline banner. */
function clock(ms: number, withSeconds = false): string {
  return format(new Date(ms), withSeconds ? "HH:mm:ss" : "HH:mm");
}

/** The ago-text for a commit time the hub sends as epoch ms. */
function commitAgo(changed: number): string {
  return changed > 0 ? timeAgo(new Date(changed).toISOString()) : "";
}

/** Opens a site in the Mac's browser; the webview itself never loads it. */
function OpenLink({ url }: { url: string }) {
  return (
    <button className="ws-open" onClick={() => void openUrl(url)}>
      Open ↗
    </button>
  );
}

/** Start while a delivery is down, Stop while it runs; disabled while the call is out. */
function DeliveryButton({ delivery }: { delivery: WsDelivery }) {
  const act = useWsStore((s) => s.act);
  const busy = useWsStore((s) => s.pending[deliveryKey(delivery)] === true);
  const verb = deliveryAction(delivery);
  return (
    <button
      className={`btn small ${verb === "start" ? "primary" : ""}`}
      disabled={busy}
      onClick={() => void act(delivery)}
    >
      {verb === "start" ? "Start" : "Stop"}
    </button>
  );
}

/** Shown when the latest poll failed: the reason, and how old the list under it is. */
function OfflineBanner() {
  const error = useWsStore((s) => s.error);
  const lastOk = useWsStore((s) => s.lastOk);
  if (error === null) return null;
  return (
    <div className="ws-banner">
      <span className="ws-dot down" />
      <div>
        Can't reach ws.{lastOk !== null && ` Showing the list from ${clock(lastOk)}.`}
        <div className="ws-banner-why">{error}</div>
      </div>
    </div>
  );
}

/** Sidebar count: sites up, with a dot that is red while ws is unreachable or a site is down. */
export function WsNavCount() {
  const status = useWsStore((s) => s.status);
  const error = useWsStore((s) => s.error);
  const { tone } = pillSummary(status, error);
  if (!status) return <span className={`ws-dot ${tone === "down" ? "down" : "stopped"}`} />;
  return (
    <span className="nav-count ws-nav-count">
      <span className={`ws-dot ${tone === "down" ? "down" : "up"}`} />
      {sitesUp(status)}
    </span>
  );
}

/** Beside the page title: where the data comes from, when it last worked, and Refresh. */
export function WsServersHeader() {
  const lastOk = useWsStore((s) => s.lastOk);
  const refresh = useWsStore((s) => s.refresh);
  return (
    <>
      <span className="ws-meta">
        on ws{lastOk !== null && ` · updated ${clock(lastOk, true)}`}
      </span>
      <button className="btn small" onClick={() => void refresh()}>
        Refresh
      </button>
    </>
  );
}

export function WsServersView() {
  const hubUrl = useSettings((s) => s.wsHubUrl);
  const status = useWsStore((s) => s.status);
  const error = useWsStore((s) => s.error);
  const actionError = useWsStore((s) => s.actionError);

  if (!hubUrl) {
    return <p className="ws-empty">Set the ws hub URL in Settings to see your dev servers.</p>;
  }

  return (
    <div className="ws-view">
      <OfflineBanner />
      {actionError && <div className="ws-action-error">{actionError}</div>}
      {!status && error === null && <p className="ws-empty">Loading…</p>}
      {status && (
        <>
          <h3 className="ws-heading">Sites</h3>
          <table className="ws-table">
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Branch</th>
                <th>Last commit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.sites.map((site) => (
                <tr key={site.name}>
                  <td>
                    <span className={`ws-dot ${site.up ? "up" : "down"}`} />
                  </td>
                  <td>{site.name}</td>
                  <td>
                    <code>{site.branch}</code>
                  </td>
                  <td className="ws-faint">{commitAgo(site.changed)}</td>
                  <td>
                    <div className="ws-actions">{site.up && <OpenLink url={site.url} />}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {status.sites.length === 0 && <p className="ws-empty">No sites.</p>}

          <h3 className="ws-heading">Factory deliveries</h3>
          <table className="ws-table">
            <thead>
              <tr>
                <th />
                <th>Slug</th>
                <th>Repo</th>
                <th>Branch</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.deliveries.map((d) => (
                <tr key={deliveryKey(d)}>
                  <td>
                    <span className={`ws-dot ${DOT_CLASS[d.state]}`} />
                  </td>
                  <td>{d.slug}</td>
                  <td>{d.repo}</td>
                  <td>
                    <code>{d.branch}</code>
                  </td>
                  <td className={d.state === "failed" ? "ws-failed" : "ws-faint"}>
                    {d.state === "failed" ? "start failed" : d.state}
                  </td>
                  <td>
                    <div className="ws-actions">
                      {d.state === "running" && <OpenLink url={d.url} />}
                      <DeliveryButton delivery={d} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {status.deliveries.length === 0 && <p className="ws-empty">No deliveries.</p>}
        </>
      )}
    </div>
  );
}

/**
 * The header pill: one glance at whether ws is fine, a click for the lists.
 * Hidden while the hub URL setting is empty. The popover closes on a click
 * outside it or on Esc; the Esc is consumed (default prevented, propagation
 * stopped) so the Town's zoom-out and App's editor close leave it alone.
 */
export function WsPill() {
  const hubUrl = useSettings((s) => s.wsHubUrl);
  const status = useWsStore((s) => s.status);
  const error = useWsStore((s) => s.error);
  const lastOk = useWsStore((s) => s.lastOk);
  const actionError = useWsStore((s) => s.actionError);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!hubUrl) return null;
  const { text, tone } = pillSummary(status, error);

  return (
    <div className="ws-pill-wrap" ref={wrapRef}>
      <button
        className={`ws-pill ${open ? "open" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        title="Dev servers on ws"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`ws-dot ${tone === "idle" ? "stopped" : tone}`} />
        {text}
      </button>
      {open && (
        <div className="ws-pop" role="dialog" aria-label="ws dev servers">
          <div className="ws-pop-head">
            <span>ws dev servers</span>
            <span>{lastOk !== null && clock(lastOk, true)}</span>
          </div>
          <OfflineBanner />
          {actionError && <div className="ws-action-error">{actionError}</div>}
          {status && (
            <>
              <h5 className="ws-pop-section">Sites</h5>
              {status.sites.map((site) => (
                <div className="ws-row" key={site.name}>
                  <span className={`ws-dot ${site.up ? "up" : "down"}`} />
                  <span className="ws-row-name">{site.name}</span>
                  {site.up && <OpenLink url={site.url} />}
                </div>
              ))}
              <h5 className="ws-pop-section">Deliveries</h5>
              {status.deliveries.map((d) => (
                <div className="ws-row" key={deliveryKey(d)}>
                  <span className={`ws-dot ${DOT_CLASS[d.state]}`} />
                  <span className="ws-row-name">
                    {d.slug} · {d.repo}
                  </span>
                  {d.state === "failed" && <span className="ws-failed">failed</span>}
                  {d.state === "running" && <OpenLink url={d.url} />}
                  <DeliveryButton delivery={d} />
                </div>
              ))}
              {status.deliveries.length === 0 && <div className="ws-pop-empty">None</div>}
            </>
          )}
          {!status && error === null && <div className="ws-pop-empty">Loading…</div>}
        </div>
      )}
    </div>
  );
}
