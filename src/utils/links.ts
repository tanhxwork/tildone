import type { LinkKind } from "../types";

/** Only http(s) is clickable — mirrors valid_http_url in agent.rs. The app opens
 *  links via tauri-plugin-opener, so a file:// or javascript: URL is a local-code
 *  hazard; refuse anything else at the boundary. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+/i.test(url.trim());
}

/** Best-effort guess of a repo URL's kind from its shape. The user or agent can
 *  always override it; when nothing matches, it's just a generic link. */
export function deriveLinkKind(url: string): LinkKind {
  const u = url.toLowerCase();
  if (u.includes("/pull/") || u.includes("/pulls/") || u.includes("/merge_requests/")) {
    return "pr";
  }
  if (u.includes("/commit/") || u.includes("/commits/")) return "commit";
  if (u.includes("/tree/") || u.includes("/branch/") || u.includes("/branches/")) {
    return "branch";
  }
  if (u.includes("worktree")) return "worktree";
  return "other";
}

/** A short, human label from the URL — mirrors link_label_from_url in agent.rs,
 *  with a little per-kind polish ("PR #12", a 7-char short SHA). */
export function deriveLinkLabel(url: string, kind: LinkKind): string {
  const last = lastSegment(url);
  if (kind === "pr") return /^\d+$/.test(last) ? `PR #${last}` : last;
  if (kind === "commit") return /^[0-9a-f]{7,40}$/i.test(last) ? last.slice(0, 7) : last;
  return last;
}

function lastSegment(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const seg = trimmed.split("/").filter(Boolean).pop();
  return seg ?? trimmed;
}
