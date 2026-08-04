import { Children, createContext, isValidElement, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { fetchClaimCwd } from "../db";
import { isHttpUrl } from "../utils/links";
import {
  imageRefId,
  remarkTaskRefs,
  taskUrlTransform,
  TASK_SCHEME,
} from "../utils/markdownTaskRefs";
import { imageSrc, useImageBase } from "../utils/images";
import { useLightbox } from "../lightbox";
import { remarkAsciiRules, remarkSections } from "../utils/markdownSections";
import {
  braceExpand,
  parseEvidenceUrl,
  remarkEvidenceLinks,
  type EvidenceRef,
} from "../utils/markdownEvidence";
import { isPreviewableImage, openEvidence, resolveRepoBase } from "../utils/evidenceOpen";
import { commitUrl, prUrl, type RepoBase } from "../utils/repoUrl";
import { useEvidenceNotice, type NoticeScope } from "../evidenceNotice";
import type { TaskLink } from "../types";
import {
  FileEvidenceIcon,
  IconChevronRight,
  IconGitCommit,
  IconGitPullRequest,
  IconLink,
} from "./Icons";

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openEditor = useStore((s) => s.openEditor);
  const owner = useContext(OwnerContext);
  // Turning the plugin off is not enough to keep evidence out of a surface:
  // the sentinel can be hand-written as an ordinary markdown link, and this
  // renderer would still activate it (found by the Codex verify pass on
  // TIL-203). The surface decides here, not the plugin chain.
  const sentinel = href ? parseEvidenceUrl(href) : null;
  // On a surface without evidence, a sentinel is not merely inactive — it must
  // not survive as an anchor at all, or it stays available to a context-menu
  // "open link" (found by the third Codex verify pass on TIL-203).
  if (sentinel && !owner.evidence) {
    return <span className="md-evidence-inert">{children}</span>;
  }
  const evidence = owner.evidence ? sentinel : null;

  // The link must also *say* what it opens. Our plugin always labels a token
  // with the token itself, so requiring that is a round-trip check — and it is
  // what stops a hand-written `[build log](tildone:file/~%2FLibrary%2Fsecret.txt)`
  // in agent-written notes from hiding its target behind friendly words (found
  // by the Codex verify pass on TIL-203).
  if (evidence) {
    const shown = childText(children);
    const expected = evidence.kind === "pr" ? `#${evidence.value}` : evidence.value;
    if (shown === expected) {
      return <EvidenceLink evidence={evidence}>{children}</EvidenceLink>;
    }
    return <span className="md-evidence-inert">{children}</span>;
  }

  if (href?.startsWith(TASK_SCHEME)) {
    const id = Number(href.slice(TASK_SCHEME.length));
    return (
      <a
        className="md-task-ref"
        role="button"
        href={href}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (Number.isFinite(id)) openEditor(id);
        }}
      >
        {children}
      </a>
    );
  }

  const external = href ? isHttpUrl(href) : false;
  // A bare URL an agent typed autolinks to itself; give it the same leading
  // icon the other evidence carries, so a line of evidence reads as one list.
  // Only where evidence belongs, though — a comment's links stay plain.
  const bare = external && owner.evidence && childText(children) === href;
  return (
    <a
      className={bare ? "md-link md-evidence" : "md-link"}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (external && href) void openUrl(href);
      }}
    >
      {bare && <IconLink size={12} className="md-evidence-icon" />}
      {children}
    </a>
  );
}

/**
 * Every character a link actually renders, including text nested in emphasis or
 * a code span.
 *
 * Depth matters twice over: counting only direct string children let a label
 * with bold text spliced in front of the path display words the target never
 * contained and still pass the label check, and it made the common
 * `` `docs/a.md` `` (a code span, so no direct text) fail it — inert evidence
 * for the shape agents write most. Both found by the Codex verify pass on
 * TIL-203.
 */
function childText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string") return child;
      if (typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return childText(child.props.children);
      }
      return "";
    })
    .join("");
}

const EVIDENCE_ICON = {
  sha: IconGitCommit,
  pr: IconGitPullRequest,
} as const;

/**
 * A path, sha or PR number an agent wrote in prose, resolved against the task
 * it belongs to at click time.
 *
 * Resolution can fail honestly — a relative path with no claimed cwd, a sha on
 * a task with no repo to point at — and then the token renders as plain text
 * with a reason in its tooltip. A link that goes nowhere is worse than prose.
 */
function EvidenceLink({
  evidence,
  children,
}: {
  evidence: EvidenceRef;
  children?: ReactNode;
}) {
  const owner = useContext(OwnerContext);
  const taskId = owner.taskId;
  const cwd = useClaimCwd(taskId);
  const links = useStore((s) => (taskId === null ? undefined : s.links[taskId]));
  const openFiles = useLightbox((s) => s.openFiles);
  const notify = useEvidenceNotice((s) => s.show);
  const repo = useRepoBase(evidence.kind === "file" ? null : links, cwd);

  if (evidence.kind === "file") {
    const paths = braceExpand(evidence.value);
    const relative = !evidence.value.startsWith("/") && !evidence.value.startsWith("~/");
    if (relative && !cwd) {
      return (
        <span className="md-evidence-inert" title="No working directory is known for this task">
          {children}
        </span>
      );
    }
    const image = paths.every(isPreviewableImage);
    return (
      <a
        className="md-evidence"
        href="#"
        title={`${evidence.value}${image ? "" : " · opens in its default app"} · ⌥-click to reveal in Finder`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void openEvidence(evidence.value, cwd, e.altKey, { openFiles }).then((err) => {
            if (err) notify(owner.scope, err);
          });
        }}
      >
        <span className="md-evidence-icon">
          <FileEvidenceIcon path={paths[0]} size={12} />
        </span>
        {children}
        {paths.length > 1 && <span className="md-evidence-count">×{paths.length}</span>}
      </a>
    );
  }

  const Icon = EVIDENCE_ICON[evidence.kind];
  if (!repo) {
    return (
      <span className="md-evidence-inert" title="No repository is known for this task">
        {children}
      </span>
    );
  }
  const url =
    evidence.kind === "sha" ? commitUrl(repo, evidence.value) : prUrl(repo, evidence.value);
  return (
    <a
      className="md-evidence"
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openUrl(url);
      }}
    >
      <Icon size={12} className="md-evidence-icon" />
      {children}
    </a>
  );
}

/** Claim directories, remembered briefly: every evidence token in a note asks
 *  for the same one. Short-lived on purpose — a task re-claimed in a different
 *  worktree must not keep resolving against the old one for the rest of the app
 *  run (found by the Codex verify pass on TIL-203). */
const cwdCache = new Map<number, { cwd: string; at: number }>();
const CWD_TTL_MS = 15_000;

function cachedCwd(taskId: number): string | null {
  const hit = cwdCache.get(taskId);
  if (!hit) return null;
  if (Date.now() - hit.at > CWD_TTL_MS) {
    cwdCache.delete(taskId);
    return null;
  }
  return hit.cwd;
}

/**
 * The working directory a relative evidence path hangs off.
 *
 * Live presence has it while the agent server runs; the claim row has it
 * always. Reading both is what keeps a screenshot in an old note clickable on a
 * board with agent access switched off — the case the e2e run found.
 */
function useClaimCwd(taskId: number | null): string | null {
  const fromPresence = useStore((s) =>
    taskId === null ? null : (s.live[taskId]?.cwd ?? null),
  );
  // The answer is stamped with the task it belongs to and checked at *render*,
  // not cleared in an effect: an effect runs after the frame it was meant to
  // fix, so switching cards left one clickable frame resolving against the
  // previous card's worktree (found by the Codex verify pass on TIL-203).
  const [fetched, setFetched] = useState<{ taskId: number; cwd: string | null } | null>(
    null,
  );
  // Re-asked whenever presence refreshes (the poll replaces this map wholesale),
  // so a task re-claimed in another worktree is picked up on a card that has
  // been sitting open. A TTL on the cache alone only helped on remount — the
  // mounted link kept its first answer forever (third Codex verify pass).
  const presenceTick = useStore((s) => s.live);
  useEffect(() => {
    if (taskId === null || fromPresence) return;
    const known = cachedCwd(taskId);
    if (known) {
      setFetched({ taskId, cwd: known });
      return;
    }
    let live = true;
    void fetchClaimCwd(taskId).then((cwd) => {
      if (cwd) cwdCache.set(taskId, { cwd, at: Date.now() });
      if (live) setFetched({ taskId, cwd });
    });
    return () => {
      live = false;
    };
  }, [taskId, fromPresence, presenceTick]);
  if (fromPresence) return fromPresence;
  if (taskId === null) return null;
  if (fetched?.taskId === taskId) return fetched.cwd;
  return cachedCwd(taskId);
}

/** The repo a task's shas belong to. Links answer synchronously; the git
 *  remote needs a command, so the token renders as prose for the moment it
 *  takes and settles into a link once the answer lands. Null `links` means the
 *  caller doesn't need a repo at all. */
function useRepoBase(links: TaskLink[] | null | undefined, cwd: string | null) {
  // Keyed by the exact inputs it was resolved for, and compared at render —
  // same stale-frame race as the cwd above, where the previous card's forge
  // would have received this card's sha.
  const [resolved, setResolved] = useState<{
    links: TaskLink[] | null | undefined;
    cwd: string | null;
    repo: RepoBase | null;
  } | null>(null);
  useEffect(() => {
    if (links === null) return;
    let live = true;
    void resolveRepoBase(links ?? [], cwd).then((repo) => {
      if (live) setResolved({ links, cwd, repo });
    });
    return () => {
      live = false;
    };
  }, [links, cwd]);
  if (!resolved || resolved.links !== links || resolved.cwd !== cwd) return null;
  return resolved.repo;
}

/** The task whose notes are being rendered. An embed may only resolve to that
 *  task's own attachments — notes are agent-writable over MCP, so a global
 *  by-id lookup would let one task's notes display another's image (found by
 *  the TIL-111 review pass). Absent (the Activity feed, comments) means no
 *  task owns this text, and embeds resolve to nothing. */
interface Owner {
  taskId: number | null;
  /** Which panel this prose is rendered in, so a failed evidence click reports
   *  itself where the user clicked. */
  scope: NoticeScope;
  /** Whether this surface has evidence links at all. */
  evidence: boolean;
}

const OwnerContext = createContext<Owner>({
  taskId: null,
  scope: "notes",
  evidence: false,
});

/** ![alt](tildone://img/12) — an image attached to this task, rendered inline in
 *  its notes. The row is looked up live so a removed image degrades to its alt
 *  text rather than a broken tile, and clicking opens the lightbox. */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const ownerTaskId = useContext(OwnerContext).taskId;
  const images = useStore((s) => s.images);
  const openLightbox = useLightbox((s) => s.open);
  useImageBase();

  const id = src ? imageRefId(src) : null;
  if (id === null) {
    // Any other src is a remote/absolute URL the webview can't be trusted to
    // fetch; show the alt text rather than reaching off-machine from notes.
    return <span className="md-image-missing">{alt || "image"}</span>;
  }
  const image =
    ownerTaskId === null
      ? undefined
      : (images[ownerTaskId] ?? []).find((img) => img.id === id);
  const url = image ? imageSrc(image) : null;
  if (!image || !url) {
    return <span className="md-image-missing">{alt || "Image removed"}</span>;
  }
  return (
    <img
      className="md-image"
      src={url}
      alt={alt || image.filename}
      // The rendered notes are click-to-edit; opening the image must not also
      // drop the user into the raw textarea.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox([image], 0);
      }}
    />
  );
}

// Expand/collapse state lives with the caller (NotesView) so it can persist
// per task and drive the section nav; the renderer only reads and toggles.
export interface SectionUi {
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
}

const SectionContext = createContext<SectionUi | null>(null);

type SectionProps = {
  children?: ReactNode;
  "data-section-key"?: string;
  "data-section-title"?: string;
  "data-section-lines"?: string;
};

function NotesSection({ children, ...rest }: SectionProps) {
  const ui = useContext(SectionContext);
  const key = rest["data-section-key"] ?? "";
  const title = rest["data-section-title"] ?? "";
  const lines = Number(rest["data-section-lines"] ?? 0);
  const kids = Children.toArray(children);
  const headingAt = kids.findIndex((k) => isValidElement(k));
  const heading = kids[headingAt];
  const body = kids.slice(headingAt + 1);
  const expanded = ui ? ui.isExpanded(key) : true;

  // stopPropagation on both events: the whole rendered notes area is
  // click-to-edit, and a collapse gesture must never open the raw textarea.
  return (
    <section className={`md-section${expanded ? "" : " collapsed"}`} data-section-key={key}>
      <div
        className="md-section-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} section: ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          ui?.toggle(key);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            ui?.toggle(key);
          }
        }}
      >
        <IconChevronRight size={12} className={`md-section-chevron${expanded ? " open" : ""}`} />
        <div className="md-section-heading">{heading}</div>
        {!expanded && lines > 0 && (
          <span className="md-section-count">
            {lines} {lines === 1 ? "line" : "lines"}
          </span>
        )}
      </div>
      {expanded && <div className="md-section-body">{body}</div>}
    </section>
  );
}

const BLOCK_COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
};

const SECTIONED_COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  section: NotesSection as Components["section"],
};

// Inline contexts (the Activity feed) collapse the wrapping paragraph so a
// one-line entry keeps its tight row instead of gaining block spacing.
const INLINE_COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  p: ({ children }) => <>{children}</>,
};

// remarkEvidenceLinks runs after remarkTaskRefs so a [[task N]] ref is already
// a link node by the time bare tokens are considered. It is opt-out rather than
// always-on: comments are prose between people, and the spec deliberately kept
// them out (found still linkified by the Codex verify pass on TIL-203).
const PLUGINS = [remarkGfm, remarkTaskRefs, remarkEvidenceLinks, remarkAsciiRules];
const PLAIN_PLUGINS = [remarkGfm, remarkTaskRefs, remarkAsciiRules];
const SECTIONED_PLUGINS = [
  remarkGfm,
  remarkTaskRefs,
  remarkEvidenceLinks,
  remarkAsciiRules,
  remarkSections,
];
const PLAIN_SECTIONED_PLUGINS = [
  remarkGfm,
  remarkTaskRefs,
  remarkAsciiRules,
  remarkSections,
];

export function Markdown({
  children,
  inline = false,
  sections,
  taskId,
  scope = "notes",
  evidence = true,
}: {
  children: string;
  inline?: boolean;
  sections?: SectionUi;
  /** Whose notes these are. Required for ![](tildone://img/…) embeds to resolve;
   *  without it an embed renders as its alt text. Evidence links need it too —
   *  it is what supplies the working directory a relative path hangs off. */
  taskId?: number;
  /** Which panel this prose sits in, so a failed evidence click reports itself
   *  there rather than somewhere else on screen. */
  scope?: NoticeScope;
  /** Whether bare paths, shas and PR numbers become clickable. On for notes and
   *  the Activity feed; off for comments, which the spec kept out of scope. */
  evidence?: boolean;
}) {
  const plugins = sections
    ? evidence
      ? SECTIONED_PLUGINS
      : PLAIN_SECTIONED_PLUGINS
    : evidence
      ? PLUGINS
      : PLAIN_PLUGINS;
  const rendered = (
    <ReactMarkdown
      remarkPlugins={plugins}
      urlTransform={taskUrlTransform}
      components={sections ? SECTIONED_COMPONENTS : inline ? INLINE_COMPONENTS : BLOCK_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
  const owned = (
    <OwnerContext.Provider value={{ taskId: taskId ?? null, scope, evidence }}>
      {rendered}
    </OwnerContext.Provider>
  );
  if (!sections) return owned;
  return <SectionContext.Provider value={sections}>{owned}</SectionContext.Provider>;
}
