import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IMG_SCHEME,
  imageEmbedMarkdown,
  remarkTaskRefs,
  taskUrlTransform,
} from "../src/utils/markdownTaskRefs";

// The store-bound <img> renderer in Markdown.tsx only ever reads `src`, so
// asserting the src that survives the sanitizer fully covers the routing
// decision the app makes at render time.
function render(md: string): string {
  return renderToStaticMarkup(
    h(
      ReactMarkdown as unknown as (props: Record<string, unknown>) => unknown,
      { remarkPlugins: [remarkGfm, remarkTaskRefs], urlTransform: taskUrlTransform },
      md,
    ) as never,
  );
}

describe("inline image embeds", () => {
  it("writes an embed addressing the image row, not a path", () => {
    expect(imageEmbedMarkdown(12, "screenshot.png")).toBe(
      "![screenshot.png](tildone:img/12)",
    );
  });

  it("strips brackets from the filename so the alt text can't terminate early", () => {
    expect(imageEmbedMarkdown(3, "shot [final].png")).toBe(
      "![shot final.png](tildone:img/3)",
    );
  });

  it("keeps the tildone:img src through the sanitizer", () => {
    const out = render(imageEmbedMarkdown(12, "screenshot.png"));
    expect(out).toContain(`src="${IMG_SCHEME}12"`);
    expect(out).toContain('alt="screenshot.png"');
  });

  it("still lets the task-ref scheme through", () => {
    expect(taskUrlTransform("tildone:task/7")).toBe("tildone:task/7");
  });

  it("still neutralises javascript: URLs", () => {
    expect(taskUrlTransform("javascript:alert(1)")).toBe("");
  });
});
