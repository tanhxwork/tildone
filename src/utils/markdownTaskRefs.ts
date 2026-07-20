import { defaultUrlTransform } from "react-markdown";
import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";

// [[task 33]] -> an in-app link to that task. The sentinel scheme below is
// resolved by the custom <a> renderer in Markdown.tsx; pulling the plugin out
// here keeps it free of React/Tauri imports so it stays unit-testable.
export const WIKI_REF = /\[\[task (\d+)\]\]/gi;
export const TASK_SCHEME = "tildone:task/";

// ![alt](tildone://img/12) -> an attached image rendered inline in the notes.
// The id addresses a task_images row, not a path, so the embed survives the
// app-data dir moving between the dev and release identifiers.
//
// The spec writes the scheme with the authority slashes; the task-ref scheme
// above has none. Both forms are accepted on read (a hand-written or
// agent-written note may use either), and the slashed one is what we emit.
export const IMG_SCHEME = "tildone://img/";
const IMG_SCHEME_BARE = "tildone:img/";

/** The image-row id an embed URL addresses, or null if it isn't one. */
export function imageRefId(url: string): number | null {
  const rest = url.startsWith(IMG_SCHEME)
    ? url.slice(IMG_SCHEME.length)
    : url.startsWith(IMG_SCHEME_BARE)
      ? url.slice(IMG_SCHEME_BARE.length)
      : null;
  if (rest === null) return null;
  const id = Number(rest);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The markdown a notes embed of an attached image is written as. */
export function imageEmbedMarkdown(id: number, alt: string): string {
  // ] and ) would terminate the alt text / URL early; a filename may contain them.
  const safeAlt = alt.replace(/[[\]]/g, "");
  return `![${safeAlt}](${IMG_SCHEME}${id})`;
}

// Visiting only `text` nodes means refs written inside `code`/`inlineCode` are
// left literal — those nodes carry a `value` string, not text children.
export function remarkTaskRefs() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      WIKI_REF.lastIndex = 0;
      if (!WIKI_REF.test(value)) return;

      WIKI_REF.lastIndex = 0;
      const replacement: Array<Root["children"][number]> = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = WIKI_REF.exec(value)) !== null) {
        if (match.index > last) {
          replacement.push({ type: "text", value: value.slice(last, match.index) });
        }
        const n = match[1];
        replacement.push({
          type: "link",
          url: `${TASK_SCHEME}${n}`,
          children: [{ type: "text", value: `task ${n}` }],
        });
        last = match.index + match[0].length;
      }
      if (last < value.length) {
        replacement.push({ type: "text", value: value.slice(last) });
      }

      parent.children.splice(index, 1, ...replacement);
      // Skip the nodes we just inserted so we don't re-scan them.
      return index + replacement.length;
    });
  };
}

// react-markdown's default sanitizer strips any URL scheme it doesn't recognise
// (so it would blank out our `tildone:` sentinel). Let that one scheme through —
// it only ever routes to openEditor, never navigates — and defer everything else
// to the default transform, which still neutralises javascript:/data: URLs.
export function taskUrlTransform(url: string) {
  if (url.startsWith(TASK_SCHEME) || imageRefId(url) !== null) return url;
  return defaultUrlTransform(url);
}
