import { defaultUrlTransform } from "react-markdown";
import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";

// [[task 33]] -> an in-app link to that task. The sentinel scheme below is
// resolved by the custom <a> renderer in Markdown.tsx; pulling the plugin out
// here keeps it free of React/Tauri imports so it stays unit-testable.
export const WIKI_REF = /\[\[task (\d+)\]\]/gi;
export const TASK_SCHEME = "tildone:task/";

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
  if (url.startsWith(TASK_SCHEME)) return url;
  return defaultUrlTransform(url);
}
