import { Children, createContext, isValidElement, useContext } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
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
import { IconChevronRight } from "./Icons";

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openEditor = useStore((s) => s.openEditor);

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
  return (
    <a
      className="md-link"
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (external && href) void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

/** The task whose notes are being rendered. An embed may only resolve to that
 *  task's own attachments — notes are agent-writable over MCP, so a global
 *  by-id lookup would let one task's notes display another's image (found by
 *  the TIL-111 review pass). Absent (the Activity feed, comments) means no
 *  task owns this text, and embeds resolve to nothing. */
const OwnerContext = createContext<number | null>(null);

/** ![alt](tildone://img/12) — an image attached to this task, rendered inline in
 *  its notes. The row is looked up live so a removed image degrades to its alt
 *  text rather than a broken tile, and clicking opens the lightbox. */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const ownerTaskId = useContext(OwnerContext);
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

const PLUGINS = [remarkGfm, remarkTaskRefs, remarkAsciiRules];
const SECTIONED_PLUGINS = [remarkGfm, remarkTaskRefs, remarkAsciiRules, remarkSections];

export function Markdown({
  children,
  inline = false,
  sections,
  taskId,
}: {
  children: string;
  inline?: boolean;
  sections?: SectionUi;
  /** Whose notes these are. Required for ![](tildone://img/…) embeds to resolve;
   *  without it an embed renders as its alt text. */
  taskId?: number;
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
    <OwnerContext.Provider value={taskId ?? null}>{rendered}</OwnerContext.Provider>
  );
  if (!sections) return owned;
  return <SectionContext.Provider value={sections}>{owned}</SectionContext.Provider>;
}
