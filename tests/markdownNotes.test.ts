import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkTaskRefs, taskUrlTransform } from "../src/utils/markdownTaskRefs";

// Renders through the exact pipeline TaskEditor's <Markdown> uses (remark-gfm +
// the [[task N]] plugin + the url sanitizer), minus the store-bound <a> renderer.
// The <a> renderer only reads href, so asserting on the emitted href fully
// covers the routing decision the app makes at click time.
function render(md: string, inline = false): string {
  return renderToStaticMarkup(
    h(
      ReactMarkdown as unknown as (props: Record<string, unknown>) => unknown,
      {
        remarkPlugins: [remarkGfm, remarkTaskRefs],
        urlTransform: taskUrlTransform,
        components: inline
          ? { p: (p: { children?: unknown }) => p.children }
          : {},
      },
      md,
    ) as never,
  );
}

describe("notes markdown rendering", () => {
  it("renders headings, bold, inline code and lists", () => {
    const out = render("## Findings\n\nSome **bold** and `code`.\n\n- one\n- two");
    expect(out).toContain("<h2>Findings</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<li>one</li>");
  });

  it("renders a GFM table", () => {
    const out = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<td>1</td>");
  });

  it("turns [[task N]] into an in-app link with the tildone sentinel href", () => {
    const out = render("See [[task 33]] for context.");
    expect(out).toContain('href="tildone:task/33"');
    expect(out).toContain(">task 33</a>");
  });

  it("leaves [[task N]] literal inside inline code", () => {
    const out = render("literal `[[task 5]]` here");
    expect(out).toContain("<code>[[task 5]]</code>");
    expect(out).not.toContain('href="tildone:task/5"');
  });

  it("leaves [[task N]] literal inside a code fence", () => {
    const out = render("```\n[[task 9]]\n```");
    expect(out).not.toContain('href="tildone:task/9"');
  });

  it("preserves external https links", () => {
    const out = render("[click](https://example.com)");
    expect(out).toContain('href="https://example.com"');
  });

  it("neutralises javascript: urls", () => {
    const out = render("[x](javascript:alert(1))");
    expect(out.toLowerCase()).not.toContain("javascript:alert");
  });

  it("does not render raw HTML as elements (inert text)", () => {
    const out = render("<script>alert(1)</script> and <img src=x onerror=alert(1)>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
  });

  it("inline mode drops the wrapping paragraph", () => {
    const out = render("built **fast** with `x`", true);
    expect(out).not.toContain("<p>");
    expect(out).toContain("<strong>fast</strong>");
  });
});
