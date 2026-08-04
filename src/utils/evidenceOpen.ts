import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { TaskLink } from "../types";
import { EVIDENCE_EXTENSIONS, isRevealOnlyEvidence } from "./links";
import { braceExpand } from "./markdownEvidence";
import { repoBaseFromLinks, repoBaseFromRemote, type RepoBase } from "./repoUrl";

// The click half of an evidence link: what a path in an agent's prose actually
// points at, and what opening it should do. The grammar half (what counts as a
// token) lives in markdownEvidence.ts and stays free of Tauri imports.

/** Formats the lightbox can show — matched by IMAGE_EXTENSIONS in evidence.rs.
 *  `svg` is not here on purpose: it runs script, so it reveals in Finder. */
const PREVIEWABLE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Opening every alternative of a wide brace set would carpet-bomb the desktop
 *  with windows; past a handful the user wants the folder, not the files. */
const MAX_OPENS = 5;

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

export function isPreviewableImage(path: string): boolean {
  return PREVIEWABLE.has(extensionOf(path));
}

/** May this path be handed to the OS at all? The allowlist — shared with
 *  attached file evidence and with agent.rs — never admits an executable, a
 *  script, or a bundle. */
export function isEvidenceFile(path: string): boolean {
  return !path.split("/").includes("..") && EVIDENCE_EXTENSIONS.has(extensionOf(path));
}

let homeCache: string | null = null;
async function home(): Promise<string> {
  if (homeCache === null) homeCache = (await homeDir()).replace(/\/+$/, "");
  return homeCache;
}

/** An absolute path for one token, or null when nothing can anchor it: a
 *  relative path is only meaningful against the working directory its task was
 *  claimed in. `..` never reaches here — the plugin refuses those tokens — and
 *  Rust re-checks containment anyway before reading anything. */
export async function resolveEvidencePath(
  raw: string,
  cwd: string | null,
): Promise<string | null> {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~/")) return `${await home()}/${raw.slice(2)}`;
  if (!cwd) return null;
  return `${cwd.replace(/\/+$/, "")}/${raw.replace(/^\.\//, "")}`;
}

/** Every file a token names — more than one only for a brace set. */
export async function resolveEvidencePaths(
  raw: string,
  cwd: string | null,
): Promise<string[]> {
  const resolved = await Promise.all(
    braceExpand(raw).map((p) => resolveEvidencePath(p, cwd)),
  );
  return resolved.filter((p): p is string => p !== null);
}

export interface EvidenceOpenDeps {
  openFiles: (files: { src: string; filename: string }[], index: number) => void;
}

/**
 * Act on a file evidence link. Returns null on success, or the one-line message
 * the caller shows in place — a dead click and a dialog are both worse than a
 * quiet sentence where the click happened.
 *
 * The gesture follows the file, not the user's aim: an image previews inline, a
 * script-bearing document (html/svg) reveals in Finder rather than handing the
 * browser something an agent wrote, everything else opens in its default app.
 * Alt-click always reveals.
 */
export async function openEvidence(
  raw: string,
  cwd: string | null,
  reveal: boolean,
  deps: EvidenceOpenDeps,
): Promise<string | null> {
  const paths = await resolveEvidencePaths(raw, cwd);
  if (paths.length === 0) {
    return "No working directory is known for this task, so this path can't be resolved.";
  }
  // Second gate, deliberately redundant with the token grammar: this function
  // hands paths to the OS, so it re-checks the allowlist itself rather than
  // trusting that whoever called it did (post-commit review of aadeba9). It
  // must run per expanded path — `a.{md,html}` has no extension of its own.
  if (!paths.every(isEvidenceFile)) return null;

  if (reveal) {
    try {
      await revealItemInDir(paths[0]);
      return null;
    } catch {
      return `Can't find ${basename(paths[0])} — was it moved?`;
    }
  }

  if (paths.every(isPreviewableImage)) {
    const files: { src: string; filename: string }[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      try {
        const bytes = await invoke<ArrayBuffer>("read_evidence_image", { path });
        const type = MIME[extensionOf(path)] ?? "application/octet-stream";
        files.push({
          src: URL.createObjectURL(new Blob([bytes], { type })),
          filename: basename(path),
        });
      } catch {
        missing.push(basename(path));
      }
    }
    if (files.length === 0) return `Can't find ${basename(paths[0])} — was it moved?`;
    deps.openFiles(files, 0);
    // A shot that didn't load is still worth saying out loud — a gallery of
    // two where three were named otherwise reads as success.
    return missing.length > 0 ? `Can't find ${missing.join(", ")} — moved?` : null;
  }

  // Per path, not per token: `docs/report.{md,html}` expands to one file that
  // opens and one that must only be revealed, and judging the set by its first
  // member handed the browser an agent-named HTML file to run (found by the
  // Codex verify pass on TIL-203).
  for (const path of paths.slice(0, MAX_OPENS)) {
    try {
      if (isRevealOnlyEvidence(path)) await revealItemInDir(path);
      else await openPath(path);
    } catch {
      return `Can't find ${basename(path)} — was it moved?`;
    }
  }
  return null;
}

/** cwd → the repo it belongs to. `git remote` is a subprocess; a note may hold
 *  a dozen shas, and they all resolve to the same answer. */
const remoteCache = new Map<string, RepoBase | null>();

/** Where a sha or #NN on this task points: its own links first (they outlive
 *  the worktree), then the claim's git remote. Null means the token stays
 *  prose — better than a link to a repo we guessed at. */
export async function resolveRepoBase(
  links: TaskLink[],
  cwd: string | null,
): Promise<RepoBase | null> {
  const fromLinks = repoBaseFromLinks(links);
  if (fromLinks) return fromLinks;
  if (!cwd) return null;
  const cached = remoteCache.get(cwd);
  if (cached !== undefined) return cached;
  let base: RepoBase | null = null;
  try {
    const remote = await invoke<string | null>("git_remote_url", { cwd });
    base = remote ? repoBaseFromRemote(remote) : null;
  } catch {
    base = null;
  }
  remoteCache.set(cwd, base);
  return base;
}
