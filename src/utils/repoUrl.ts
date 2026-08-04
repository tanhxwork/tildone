import { asLinkKind, type TaskLink } from "../types";
import { isHttpUrl } from "./links";

// Where a bare sha or #NN in notes points. Two sources, in order: the task's own
// links (a commit/PR/branch chip already names the repo, and keeps working long
// after the worktree is gone), then the claim's cwd via `git remote get-url`.
// Neither is guaranteed, and a token that resolves to nothing stays prose.

export interface RepoBase {
  /** `https://host/owner/repo`, no trailing slash. */
  base: string;
  /** GitLab nests commit and MR paths under `/-/`; nothing else does. */
  gitlab: boolean;
}

/** Path segments that mean "the repo part of the URL ended here". */
const MARKERS = new Set([
  "commit",
  "commits",
  "pull",
  "pulls",
  "pull-requests",
  "merge_requests",
  "tree",
  "blob",
  "branch",
  "branches",
  "compare",
  "issues",
  "releases",
]);

/**
 * The repo a forge URL belongs to.
 *
 * `strict` additionally demands that the URL *prove* it is a forge URL by
 * carrying one of the marker segments. It is used for links, whose `kind` is
 * chosen by the agent that added them and therefore cannot be trusted on its
 * own: a link labelled `branch` pointing at `https://evil.example/a/b` would
 * otherwise become the base for every sha on the card (found by the Codex
 * verify pass on TIL-203). A `git remote` answer needs no such proof — it came
 * from the repository itself.
 */
export function repoBaseFromUrl(url: string, strict = false): RepoBase | null {
  if (!isHttpUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const gitlab = url.includes("/-/") || parsed.hostname.includes("gitlab");
  const segments = parsed.pathname.split("/").filter(Boolean);
  // A marker only counts *after* owner/repo: `github.com/owner/tree/tree/main`
  // is a repository actually named "tree", and cutting at the first match
  // dropped it (found by the third Codex verify pass on TIL-203).
  const cut = url.includes("/-/")
    ? segments.indexOf("-")
    : segments.findIndex((s, i) => i >= 2 && MARKERS.has(s));
  if (strict && cut === -1) return null;
  const repo = (cut === -1 ? segments : segments.slice(0, cut)).map(stripGitSuffix);
  if (repo.length < 2) return null;
  return { base: `${parsed.origin}/${repo.join("/")}`, gitlab };
}

/** Link kinds that actually name a repository. A `file` or `other` link is
 *  whatever someone pasted — a docs page, a dashboard — and letting one become
 *  the base would aim every sha on the card at a stranger's host (found by the
 *  Codex verify pass on TIL-203). */
const REPO_KINDS = new Set(["commit", "pr", "branch"]);

/** The first repo-naming link on the task. Ordered by id (oldest first) by the
 *  store, and every such link on a task points at the same repo in practice,
 *  so the first hit is as good as any. */
export function repoBaseFromLinks(links: TaskLink[]): RepoBase | null {
  for (const link of links) {
    if (!REPO_KINDS.has(asLinkKind(link.kind))) continue;
    // Strict: the kind is the agent's word, the URL shape is evidence.
    const base = repoBaseFromUrl(link.url, true);
    if (base) return base;
  }
  return null;
}

/** `git remote get-url origin` output → a browsable base. Handles the scp-like
 *  form (`git@host:owner/repo.git`), ssh:// and https://; anything else (a
 *  local path remote, say) has no web address and yields null. */
export function repoBaseFromRemote(remote: string): RepoBase | null {
  const raw = remote.trim();
  if (!raw) return null;
  const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(raw);
  const url = scp
    ? `https://${scp[1]}/${scp[2]}`
    : raw.replace(/^ssh:\/\/(?:[\w.-]+@)?/, "https://").replace(/^git:\/\//, "https://");
  if (!isHttpUrl(url)) return null;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).map(stripGitSuffix);
    if (segments.length < 2) return null;
    return {
      base: `${parsed.origin}/${segments.join("/")}`,
      gitlab: parsed.hostname.includes("gitlab"),
    };
  } catch {
    return null;
  }
}

export function commitUrl(repo: RepoBase, sha: string): string {
  return `${repo.base}/${repo.gitlab ? "-/commit" : "commit"}/${sha}`;
}

export function prUrl(repo: RepoBase, number: string): string {
  return `${repo.base}/${repo.gitlab ? "-/merge_requests" : "pull"}/${number}`;
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}
