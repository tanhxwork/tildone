import { asLinkKind, LINK_KINDS, type LinkKind, type TaskLink } from "../types";

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

/** One entry per link kind — the most recently added link of that kind, plus how
 *  many of that kind exist in total. A long-running task accumulates a link per
 *  attempt (six PRs, a branch per worktree); a card only has room for the state
 *  of play, so it shows the newest of each and lets the detail view hold history.
 *  Ordered by LINK_KINDS so a card's chips don't reshuffle as links are added. */
export function latestLinkPerKind(links: TaskLink[]): { link: TaskLink; total: number }[] {
  const byKind = new Map<LinkKind, { link: TaskLink; total: number }>();
  for (const link of links) {
    const kind = asLinkKind(link.kind);
    const seen = byKind.get(kind);
    // Links arrive ordered by id, but don't lean on it — id is the age.
    if (!seen) byKind.set(kind, { link, total: 1 });
    else byKind.set(kind, { link: link.id > seen.link.id ? link : seen.link, total: seen.total + 1 });
  }
  return LINK_KINDS.map((kind) => byKind.get(kind)).filter((e) => e !== undefined);
}

function lastSegment(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const seg = trimmed.split("/").filter(Boolean).pop();
  return seg ?? trimmed;
}
