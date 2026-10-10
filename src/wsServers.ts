// The dev-server hub on the user's Linux workstation ("ws"), as the Servers
// view and the header pill see it. Pure shapes and summaries; the polling
// lives in wsStore.ts and the HTTP in src-tauri/src/wsservers.rs.

export type DeliveryState = "running" | "starting" | "stopped" | "failed";

export interface WsSite {
  name: string;
  url: string;
  branch: string;
  /** Last commit, epoch ms. */
  changed: number;
  up: boolean;
}

export interface WsDelivery {
  slug: string;
  repo: string;
  /** The hub's folder name for the delivery's worktree; Start and Stop take it. */
  root: string;
  branch: string;
  url: string;
  state: DeliveryState;
  changed: number;
}

export interface WsStatus {
  at: string;
  sites: WsSite[];
  deliveries: WsDelivery[];
}

export interface PillSummary {
  text: string;
  /** "down" is red: ws is unreachable or a site is down. */
  tone: "up" | "down" | "idle";
}

const STATES: DeliveryState[] = ["running", "starting", "stopped", "failed"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Narrows the hub's JSON into WsStatus. A row that is not an object is
 * dropped; a missing field takes an empty default, so a hub that grows or
 * loses a field never blanks the whole view.
 */
export function parseStatus(raw: unknown): WsStatus {
  const root = isRecord(raw) ? raw : {};
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);
  return {
    at: str(root.at),
    sites: rows(root.sites).map((s) => ({
      name: str(s.name),
      url: str(s.url),
      branch: str(s.branch),
      changed: typeof s.changed === "number" ? s.changed : 0,
      up: s.up === true,
    })),
    deliveries: rows(root.deliveries).map((d) => ({
      slug: str(d.slug),
      repo: str(d.repo),
      root: str(d.root),
      branch: str(d.branch),
      url: str(d.url),
      state: STATES.find((s) => s === d.state) ?? "stopped",
      changed: typeof d.changed === "number" ? d.changed : 0,
    })),
  };
}

/** Sites the hub reports as up: the sidebar count. */
export function sitesUp(status: WsStatus | null): number {
  return status ? status.sites.filter((s) => s.up).length : 0;
}

/**
 * The header pill. Offline wins over everything, because the list under it is
 * stale. Then any down site; otherwise the up count, plus the deliveries that
 * are not running (stopped or failed) when there are some.
 */
export function pillSummary(status: WsStatus | null, error: string | null): PillSummary {
  if (error !== null) return { text: "ws offline", tone: "down" };
  if (!status) return { text: "ws", tone: "idle" };
  const down = status.sites.filter((s) => !s.up).length;
  if (down > 0) return { text: `ws · ${down} down`, tone: "down" };
  const stopped = status.deliveries.filter(
    (d) => d.state === "stopped" || d.state === "failed",
  ).length;
  const up = `ws · ${sitesUp(status)} up`;
  return { text: stopped > 0 ? `${up} · ${stopped} stopped` : up, tone: "up" };
}

/** A delivery's action: Stop while it runs or boots, Start otherwise. */
export function deliveryAction(d: WsDelivery): "start" | "stop" {
  return d.state === "running" || d.state === "starting" ? "stop" : "start";
}

/** Key for a delivery in the store's pending-action map. */
export function deliveryKey(d: WsDelivery): string {
  return `${d.root}/${d.slug}`;
}
