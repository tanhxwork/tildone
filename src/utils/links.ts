import { asLinkKind, LINK_KINDS, type LinkKind, type TaskLink } from "../types";

/** Only http(s) is clickable — mirrors valid_http_url in agent.rs. The app opens
 *  links via tauri-plugin-opener, so a file:// or javascript: URL is a local-code
 *  hazard; refuse anything else at the boundary. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+/i.test(url.trim());
}

/** Extensions a file-evidence link may point at — kept in lockstep with
 *  EVIDENCE_EXTENSIONS in src-tauri/src/agent.rs. A file opens in its default
 *  app, so this is an allowlist and never admits an executable or a script. */
export const EVIDENCE_EXTENSIONS = new Set([
  "md", "txt", "html", "htm", "png", "jpg", "jpeg", "gif", "svg", "webp", "pdf", "json", "csv", "log",
]);

/** The lowercased extension of a path's basename, or "" for none / a dotfile. */
function fileExtension(target: string): string {
  const name = target.trim().split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** An absolute local path (`/…` or `~/…`) to an allowlisted evidence file.
 *  Mirrors valid_file_path in agent.rs; the extension is the real guard. */
export function isFileEvidence(target: string): boolean {
  const t = target.trim();
  if (!(t.startsWith("/") || t.startsWith("~/"))) return false;
  return EVIDENCE_EXTENSIONS.has(fileExtension(t));
}

/** Extensions that execute script when handed to the OS default app: an HTML or
 *  SVG file opens in the browser and runs any inline JavaScript (in a file://
 *  origin). They stay attachable as evidence, but the UI reveals them in Finder
 *  instead of opening them — the user opens them deliberately if they trust the
 *  source. Never call openPath on these. See openLink in TaskEditor. */
export const REVEAL_ONLY_EXTENSIONS = new Set(["html", "htm", "svg"]);

export function isRevealOnlyEvidence(target: string): boolean {
  return REVEAL_ONLY_EXTENSIONS.has(fileExtension(target));
}

/** Best-effort guess of a repo URL's kind from its shape. The user or agent can
 *  always override it; when nothing matches, it's just a generic link. */
export function deriveLinkKind(url: string): LinkKind {
  if (isFileEvidence(url)) return "file";
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
