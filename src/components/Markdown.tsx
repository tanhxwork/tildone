import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { isHttpUrl } from "../utils/links";
import { remarkTaskRefs, taskUrlTransform, TASK_SCHEME } from "../utils/markdownTaskRefs";

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

const BLOCK_COMPONENTS: Components = {
  a: MarkdownLink,
};

// Inline contexts (the Activity feed) collapse the wrapping paragraph so a
// one-line entry keeps its tight row instead of gaining block spacing.
const INLINE_COMPONENTS: Components = {
  a: MarkdownLink,
  p: ({ children }) => <>{children}</>,
};

export function Markdown({
  children,
  inline = false,
}: {
  children: string;
  inline?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkTaskRefs]}
      urlTransform={taskUrlTransform}
      components={inline ? INLINE_COMPONENTS : BLOCK_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
}
