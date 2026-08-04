import type { TaskLink } from "../types";
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

/** The repo a forge URL belongs to. */
export function repoBaseFromUrl(url: string): RepoBase | null {
  if (!isHttpUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const gitlab = url.includes("/-/") || parsed.hostname.includes("gitlab");
  const segments = parsed.pathname.split("/").filter(Boolean);
  const cut = url.includes("/-/")
    ? segments.indexOf("-")
    : segments.findIndex((s) => MARKERS.has(s));
  const repo = (cut === -1 ? segments : segments.slice(0, cut)).map(stripGitSuffix);
  if (repo.length < 2) return null;
  return { base: `${parsed.origin}/${repo.join("/")}`, gitlab };
}

/** The first link on the task that names a repo. Ordered by id (oldest first)
 *  by the store, and every link on a task points at the same repo in practice,
 *  so the first hit is as good as any. */
export function repoBaseFromLinks(links: TaskLink[]): RepoBase | null {
  for (const link of links) {
    const base = repoBaseFromUrl(link.url);
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
