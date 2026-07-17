import type { Heading, Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { WIKI_REF } from "./markdownTaskRefs";

// Sectioning happens on the mdast tree, never on source text: a "## fake"
// line inside a code fence is a `code` node there, not a heading, so it can
// never start a section. Only root-level headings count — a heading quoted
// inside a blockquote or list is content, not structure.

export interface NoteSection {
  key: string;
  title: string;
  depth: number;
  topLevel: boolean;
}

export const AUTO_COLLAPSE_MIN_SECTIONS = 2;
export const AUTO_COLLAPSE_MAX_LINES = 100;

interface HeadingInfo {
  node: Heading;
  key: string;
  title: string;
}

// The rendered pipeline runs remarkTaskRefs before this plugin (which turns
// `[[task N]]` text into a link reading "task N"), while parseNoteSections
// parses pristine source. Normalising refs here keeps the two sides emitting
// byte-identical keys for the same heading.
function headingTitle(node: Heading): string {
  return toString(node).replace(WIKI_REF, "task $1").trim();
}

function collectHeadings(tree: Root): HeadingInfo[] {
  const occurrences = new Map<string, number>();
  const headings: HeadingInfo[] = [];
  for (const child of tree.children) {
    if (child.type !== "heading") continue;
    const title = headingTitle(child);
    const n = occurrences.get(title) ?? 0;
    occurrences.set(title, n + 1);
    headings.push({ node: child, key: `${title}::${n}`, title });
  }
  return headings;
}

type NodeData = { hName?: string; hProperties?: Record<string, unknown> };

// How many source lines a collapsed section is hiding — the heading itself
// doesn't count, only what folds away under it. Read off mdast positions, so
// it measures the note as written rather than as rendered.
function bodyLines(children: RootContent[]): number {
  const body = children.slice(1);
  const start = body[0]?.position?.start.line;
  const end = body[body.length - 1]?.position?.end.line;
  return start && end ? end - start + 1 : 0;
}

// Wraps each shallowest-depth heading and its following siblings (up to the
// next such heading) in a node rendered as <section data-section-key …>, and
// stamps every root-level heading with data-note-heading so the section bar
// can scroll to it. Content before the first heading stays unwrapped.
export function remarkSections() {
  return (tree: Root) => {
    const headings = collectHeadings(tree);
    if (headings.length === 0) return;
    const byNode = new Map<Heading, HeadingInfo>(headings.map((h) => [h.node, h]));
    const minDepth = Math.min(...headings.map((h) => h.node.depth));

    for (const h of headings) {
      const data = (h.node.data ??= {}) as NodeData;
      (data.hProperties ??= {})["data-note-heading"] = h.key;
    }

    const next: RootContent[] = [];
    let bucket: { info: HeadingInfo; children: RootContent[] } | null = null;
    const flush = () => {
      if (!bucket) return;
      next.push({
        type: "notesSection",
        data: {
          hName: "section",
          hProperties: {
            "data-section-key": bucket.info.key,
            "data-section-title": bucket.info.title,
            "data-section-lines": String(bodyLines(bucket.children)),
          },
        },
        children: bucket.children,
      } as unknown as RootContent);
      bucket = null;
    };

    for (const child of tree.children) {
      const info = child.type === "heading" ? byNode.get(child) : undefined;
      if (info && info.node.depth === minDepth) {
        flush();
        bucket = { info, children: [child] };
      } else if (bucket) {
        bucket.children.push(child);
      } else {
        next.push(child);
      }
    }
    flush();
    tree.children = next;
  };
}

const parser = unified().use(remarkParse);

// The section list for the sticky nav bar — same tree walk, same keys as the
// plugin, so a key from here always matches a rendered data-note-heading.
export function parseNoteSections(source: string): NoteSection[] {
  if (!source.trim()) return [];
  const tree = parser.parse(source) as Root;
  const headings = collectHeadings(tree);
  if (headings.length === 0) return [];
  const minDepth = Math.min(...headings.map((h) => h.node.depth));
  return headings.map((h) => ({
    key: h.key,
    title: h.title,
    depth: h.node.depth,
    topLevel: h.node.depth === minDepth,
  }));
}

// Long notes open as an outline: everything starts collapsed once there are
// enough top-level sections AND enough raw lines to make scrolling painful.
export function shouldAutoCollapse(source: string, sections: NoteSection[]): boolean {
  const topLevel = sections.filter((s) => s.topLevel).length;
  return (
    topLevel >= AUTO_COLLAPSE_MIN_SECTIONS &&
    source.split("\n").length > AUTO_COLLAPSE_MAX_LINES
  );
}
