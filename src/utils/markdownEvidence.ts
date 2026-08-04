import { SKIP, visit } from "unist-util-visit";
import type { InlineCode, Root, Text } from "mdast";
import { EVIDENCE_EXTENSIONS } from "./links";

// Evidence links: the bare tokens an agent writes into notes and progress log
// lines — a screenshot path, a commit sha, a PR number — turned into clicks.
// Nobody attached them (that's a chip); they are inferred from the prose.
//
// This module only decides *what is a token*. Resolution — which cwd a relative
// path hangs off, which repo a sha belongs to — needs the owning task, so it
// happens in the renderer at click time; the plugin just emits a sentinel URL,
// the same trick [[task N]] uses. Keeping it free of React/Tauri imports is
// what makes the grammar testable through the real remark pipeline.

export const FILE_SCHEME = "tildone:file/";
export const SHA_SCHEME = "tildone:sha/";
export const PR_SCHEME = "tildone:pr/";

export type EvidenceKind = "file" | "sha" | "pr";
export interface EvidenceRef {
  kind: EvidenceKind;
  /** The path as written (braces unexpanded), the sha, or the PR number. */
  value: string;
}

const SCHEMES: [string, EvidenceKind][] = [
  [FILE_SCHEME, "file"],
  [SHA_SCHEME, "sha"],
  [PR_SCHEME, "pr"],
];

export function evidenceUrl(kind: EvidenceKind, value: string): string {
  const scheme = SCHEMES.find(([, k]) => k === kind)![0];
  return scheme + encodeURIComponent(value);
}

/**
 * The evidence reference a sentinel URL addresses, or null if it isn't one.
 *
 * The sentinel is not a capability. Notes are agent-writable, and markdown lets
 * an agent hand-write the URL directly — `[shot](tildone:file/%2Fbin%2Fsh)` —
 * so a URL that merely *looks* like one of ours would otherwise walk straight
 * past the token grammar that is the entire safety model (flagged by the
 * post-commit review of aadeba9). Every parse therefore re-runs the classifier
 * and keeps only what the plugin itself would have produced.
 */
export function parseEvidenceUrl(url: string): EvidenceRef | null {
  for (const [scheme, kind] of SCHEMES) {
    if (!url.startsWith(scheme)) continue;
    let value: string;
    try {
      value = decodeURIComponent(url.slice(scheme.length));
    } catch {
      return null;
    }
    // `#` for a PR is the shape classifyToken sees in prose; the sentinel
    // carries the bare number.
    const back = classifyToken(kind === "pr" ? `#${value}` : value);
    if (!back || back.kind !== kind || back.value !== value) return null;
    return back;
  }
  return null;
}

/** One path per alternative in a `{a,b,c}` set — the shape an agent writes when
 *  a run produced the same shot three times. A malformed or nested set yields
 *  nothing, which is what disqualifies the token from linking at all. */
export function braceExpand(path: string): string[] {
  const open = path.indexOf("{");
  if (open === -1) return path.includes("}") ? [] : [path];
  const close = path.indexOf("}", open);
  if (close === -1) return [];
  const rest = path.slice(close + 1);
  if (rest.includes("{") || rest.includes("}")) return [];
  const alts = path.slice(open + 1, close).split(",");
  if (alts.some((a) => a === "" || a.includes("/"))) return [];
  return alts.map((a) => path.slice(0, open) + a + rest);
}

/** The lowercased extension of a path's basename, or "" for none / a dotfile. */
function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// Punctuation a token may be wrapped in when it sits in a sentence. Stripped
// before classification and never part of the link — "…/a.md, then" must not
// link the comma. A path always ends in its extension, so a trailing brace can
// never be legitimate.
const LEAD = /^[([{<"'`]+/;
const TRAIL = /[)\]}>,.;:!?"'`]+$/;

/** A path safe to *offer* as a link. The extension allowlist is the safety
 *  model (shared with attached file evidence and with agent.rs), so source and
 *  scripts are deliberately absent; `..` is refused outright so a note can
 *  never aim a click above the working directory it resolves against. */
function asFilePath(core: string): string | null {
  if (!core.includes("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(core)) return null; // a URL or another scheme
  if (!/^[\w./~@%+\-{},]+$/.test(core)) return null;
  if (core.split("/").includes("..")) return null;
  const expanded = braceExpand(core);
  if (expanded.length === 0) return null;
  if (!expanded.every((p) => EVIDENCE_EXTENSIONS.has(extensionOf(p)))) return null;
  return core;
}

/** What this token is, if anything. */
export function classifyToken(core: string): EvidenceRef | null {
  const pr = /^#(\d{1,6})$/.exec(core);
  if (pr) return { kind: "pr", value: pr[1] };
  // A git sha is lowercase hex; requiring a digit is what keeps English words
  // built only from a-f ("effaced", "defaced") out.
  if (/^[0-9a-f]{7,40}$/.test(core) && /\d/.test(core)) {
    return { kind: "sha", value: core };
  }
  const path = asFilePath(core);
  return path ? { kind: "file", value: path } : null;
}

interface Hit {
  start: number;
  end: number;
  ref: EvidenceRef;
}

/** Every evidence token in a run of prose, with the exact slice to replace. */
export function findEvidence(value: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of value.matchAll(/\S+/g)) {
    const raw = match[0];
    const at = match.index;
    const lead = LEAD.exec(raw)?.[0].length ?? 0;
    const core = raw.slice(lead).replace(TRAIL, "");
    if (!core) continue;
    const ref = classifyToken(core);
    if (ref) hits.push({ start: at + lead, end: at + lead + core.length, ref });
  }
  return hits;
}

type Child = Root["children"][number];

function linkNode(ref: EvidenceRef, label: Child | string): Child {
  return {
    type: "link",
    url: evidenceUrl(ref.kind, ref.value),
    children: [typeof label === "string" ? { type: "text", value: label } : label],
  } as Child;
}

/** Turns bare evidence tokens into links. Runs after remarkTaskRefs so a
 *  [[task N]] ref is already a link node (and therefore skipped — a link inside
 *  a link is not a thing). Code spans are visited too, but only when the whole
 *  span is a single token: `` `shot.png` `` is evidence, while
 *  `` `python3 tests/x.py` `` is a command and stays literal. */
export function remarkEvidenceLinks() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      // An existing link — a markdown link, a gfm autolink, a [[task N]] ref —
      // owns everything inside it; a link within a link is not a thing.
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "inlineCode") return;
      if (!parent || index === undefined) return;
      const ref = classifyToken((node as InlineCode).value.trim());
      if (!ref) return;
      parent.children.splice(index, 1, linkNode(ref, node as Child) as never);
      return SKIP;
    });

    visit(tree, (node, index, parent) => {
      if (node.type === "link" || node.type === "linkReference") return SKIP;
      if (node.type !== "text") return;
      if (!parent || index === undefined) return;
      const hits = findEvidence((node as Text).value);
      if (hits.length === 0) return;

      const value = (node as Text).value;
      const replacement: Child[] = [];
      let last = 0;
      for (const hit of hits) {
        if (hit.start > last) {
          replacement.push({ type: "text", value: value.slice(last, hit.start) });
        }
        replacement.push(linkNode(hit.ref, value.slice(hit.start, hit.end)));
        last = hit.end;
      }
      if (last < value.length) {
        replacement.push({ type: "text", value: value.slice(last) });
      }

      parent.children.splice(index, 1, ...(replacement as never[]));
      // Skip what we just inserted so the new links aren't re-scanned.
      return index + replacement.length;
    });
  };
}
