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
  const evidence = href ? parseEvidenceUrl(href) : null;

  if (evidence) return <EvidenceLink evidence={evidence}>{children}</EvidenceLink>;

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
  const bare = external && childText(children) === href;
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

/** The text a link renders, when it is plain — used only to tell an autolinked
 *  URL from `[label](url)`, so a miss just means no icon. */
function childText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => (typeof c === "string" ? c : ""))
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

/** Non-null claim directories, remembered for the session: the same path is
 *  asked for by every evidence token in a note. */
const cwdCache = new Map<number, string>();

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
  const [fromClaim, setFromClaim] = useState<string | null>(() =>
    taskId === null ? null : (cwdCache.get(taskId) ?? null),
  );
  useEffect(() => {
    if (taskId === null || fromPresence) return;
    const known = cwdCache.get(taskId);
    if (known) {
      setFromClaim(known);
      return;
    }
    let live = true;
    void fetchClaimCwd(taskId).then((cwd) => {
      if (cwd) cwdCache.set(taskId, cwd);
      if (live) setFromClaim(cwd);
    });
    return () => {
      live = false;
    };
  }, [taskId, fromPresence]);
  return fromPresence ?? fromClaim;
}

/** The repo a task's shas belong to. Links answer synchronously; the git
 *  remote needs a command, so the token renders as prose for the moment it
 *  takes and settles into a link once the answer lands. Null `links` means the
 *  caller doesn't need a repo at all. */
function useRepoBase(links: TaskLink[] | null | undefined, cwd: string | null) {
  const [repo, setRepo] = useState<RepoBase | null>(null);
  useEffect(() => {
    if (links === null) return;
    let live = true;
    void resolveRepoBase(links ?? [], cwd).then((base) => {
      if (live) setRepo(base);
    });
    return () => {
      live = false;
    };
  }, [links, cwd]);
  return repo;
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
}

const OwnerContext = createContext<Owner>({ taskId: null, scope: "notes" });

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
// a link node by the time bare tokens are considered.
const PLUGINS = [remarkGfm, remarkTaskRefs, remarkEvidenceLinks, remarkAsciiRules];
const SECTIONED_PLUGINS = [
  remarkGfm,
  remarkTaskRefs,
  remarkEvidenceLinks,
  remarkAsciiRules,
  remarkSections,
];

export function Markdown({
  children,
  inline = false,
  sections,
  taskId,
  scope = "notes",
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
}) {
  const rendered = (
    <ReactMarkdown
      remarkPlugins={sections ? SECTIONED_PLUGINS : PLUGINS}
      urlTransform={taskUrlTransform}
      components={sections ? SECTIONED_COMPONENTS : inline ? INLINE_COMPONENTS : BLOCK_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
  const owned = (
    <OwnerContext.Provider value={{ taskId: taskId ?? null, scope }}>
      {rendered}
    </OwnerContext.Provider>
  );
  if (!sections) return owned;
  return <SectionContext.Provider value={sections}>{owned}</SectionContext.Provider>;
}
