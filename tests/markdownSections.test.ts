import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkTaskRefs, taskUrlTransform } from "../src/utils/markdownTaskRefs";
import {
  parseNoteSections,
  remarkAsciiRules,
  remarkSections,
  shouldAutoCollapse,
} from "../src/utils/markdownSections";

// Renders through the sectioned pipeline TaskEditor's <Markdown sections> uses,
// without a custom `section` renderer — the plugin's wrapper nodes then emit
// native <section data-section-key …> elements, which is what we assert on.
function render(md: string): string {
  return renderToStaticMarkup(
    h(
      ReactMarkdown as unknown as (props: Record<string, unknown>) => unknown,
      {
        remarkPlugins: [remarkGfm, remarkTaskRefs, remarkAsciiRules, remarkSections],
        urlTransform: taskUrlTransform,
      },
      md,
    ) as never,
  );
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("remarkSections", () => {
  it("groups content under top-level headings into <section> wrappers", () => {
    const out = render("## Alpha\n\nbody a\n\n## Beta\n\nbody b");
    expect(count(out, "<section")).toBe(2);
    expect(out).toContain('data-section-title="Alpha"');
    expect(out).toContain('data-section-title="Beta"');
    // body a belongs to Alpha's section, which closes before Beta opens
    const alphaClose = out.indexOf("</section>");
    expect(out.indexOf("body a")).toBeLessThan(alphaClose);
    expect(out.indexOf("body b")).toBeGreaterThan(alphaClose);
  });

  it("leaves preamble before the first heading outside any section", () => {
    const out = render("Goal: stay visible\n\n## Alpha\n\nbody");
    expect(out.indexOf("Goal: stay visible")).toBeLessThan(out.indexOf("<section"));
  });

  it("sections on the shallowest depth present, not a hardcoded level", () => {
    const out = render("### One\n\nx\n\n### Two\n\ny");
    expect(count(out, "<section")).toBe(2);
  });

  it("nests deeper headings inside their parent section", () => {
    const out = render("## Alpha\n\n### Sub\n\nx\n\n## Beta");
    expect(count(out, "<section")).toBe(2);
    expect(out.indexOf("<h3")).toBeLessThan(out.indexOf("</section>"));
  });

  it("a fenced ## line never starts a section", () => {
    const out = render("## Real\n\n```\n## fake heading\n```\n");
    expect(count(out, "<section")).toBe(1);
    expect(out).not.toContain('data-section-title="fake heading"');
  });

  it("duplicate heading titles get distinct keys", () => {
    const out = render("## Evidence\n\na\n\n## Evidence\n\nb");
    const keys = [...out.matchAll(/data-section-key="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("tags every heading with a jumpable data-note-heading key", () => {
    const out = render("## Alpha\n\n### Sub\n\n## Beta");
    expect(count(out, "data-note-heading=")).toBe(3);
  });

  it("keys headings containing [[task N]] refs consistently with the ref plugin", () => {
    const out = render("## About [[task 33]]\n\nbody\n\n## Beta");
    const keys = [...out.matchAll(/data-section-key="([^"]+)"/g)].map((m) => m[1]);
    const parsed = parseNoteSections("## About [[task 33]]\n\nbody\n\n## Beta");
    expect(parsed.map((s) => s.key)).toEqual(keys);
  });

  it("a note without headings renders unwrapped", () => {
    const out = render("just a paragraph\n\n- and a list");
    expect(out).not.toContain("<section");
  });

  // The count a collapsed row shows: source lines hidden under the heading.
  const linesOf = (md: string) =>
    [...render(md).matchAll(/data-section-lines="(\d+)"/g)].map((m) => Number(m[1]));

  it("measures the body lines each section hides, excluding the heading", () => {
    // Alpha's body spans lines 3-5 (two paragraphs and the blank between).
    expect(linesOf("## Alpha\n\nbody a\n\nmore a\n\n## Beta\n\nbody b")).toEqual([3, 1]);
  });

  it("counts every line of a multi-line block, not just its first", () => {
    expect(linesOf("## Alpha\n\n- one\n- two\n- three")).toEqual([3]);
  });

  it("reports zero for a heading with nothing under it", () => {
    expect(linesOf("## Empty\n\n## Beta\n\nbody")).toEqual([0, 1]);
  });

  it("counts a nested subsection's lines toward its parent section", () => {
    // Only top-level headings open sections, so ### and its body belong to Alpha.
    expect(linesOf("## Alpha\n\nintro\n\n### Sub\n\nnested")).toEqual([5]);
  });

  it("wraps the lede — everything above the first heading — in one container", () => {
    const out = render("Goal: ship it\n\nmore context\n\n## Alpha\n\nbody");
    expect(count(out, 'class="md-note-lede"')).toBe(1);
    // both preamble paragraphs are inside it, and it closes before the section
    expect(out.indexOf("Goal: ship it")).toBeLessThan(out.indexOf("</div>"));
    expect(out.indexOf("more context")).toBeLessThan(out.indexOf("</div>"));
    expect(out.indexOf("</div>")).toBeLessThan(out.indexOf("<section"));
  });

  it("emits no lede when the note opens straight into a heading", () => {
    expect(render("## Alpha\n\nbody\n\n## Beta\n\nb")).not.toContain("md-note-lede");
  });
});

describe("remarkAsciiRules", () => {
  it("renders a run of = as the rule the author drew", () => {
    const out = render("above\n\n=====\n\nbelow\n\n## Alpha\n\nbody");
    expect(out).toContain("<hr");
    expect(out).not.toContain("=====");
  });

  it("leaves a = run inside a code fence alone", () => {
    // The whole point of working on the tree: a fence is a code node, not a rule.
    const out = render("## Alpha\n\n```\n=====\n```");
    expect(out).toContain("=====");
    expect(out).not.toContain("<hr");
  });

  it("does not touch a setext heading's underline", () => {
    // "Title\n=====" is an h1, not a paragraph — it must stay a heading.
    const out = render("Title\n=====\n\nbody\n\n## Alpha\n\nx");
    expect(out).toContain("<h1");
    expect(out).not.toContain("<hr");
  });

  it("leaves prose that merely contains = alone", () => {
    const out = render("## Alpha\n\na === b is not a rule");
    expect(out).not.toContain("<hr");
    expect(out).toContain("a === b is not a rule");
  });
});

describe("parseNoteSections", () => {
  const source = "Goal: x\n\n## Alpha\n\n### Sub\n\nx\n\n## Beta\n\ny";

  it("returns headings in order with depth and top-level flags", () => {
    const sections = parseNoteSections(source);
    expect(sections.map((s) => s.title)).toEqual(["Alpha", "Sub", "Beta"]);
    expect(sections.map((s) => s.topLevel)).toEqual([true, false, true]);
    expect(sections.map((s) => s.depth)).toEqual([2, 3, 2]);
  });

  it("emits exactly the keys the plugin renders", () => {
    const html = render(source);
    for (const s of parseNoteSections(source)) {
      expect(html).toContain(`data-note-heading="${s.key}"`);
    }
  });

  it("ignores headings inside code fences", () => {
    const sections = parseNoteSections("## Real\n\n```\n## fake\n```\n");
    expect(sections.map((s) => s.title)).toEqual(["Real"]);
  });

  it("returns [] for empty or heading-free notes", () => {
    expect(parseNoteSections("")).toEqual([]);
    expect(parseNoteSections("plain text")).toEqual([]);
  });
});

describe("shouldAutoCollapse", () => {
  const longBody = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");

  it("collapses 2+ top-level sections past 100 source lines", () => {
    const source = `## A\n\n${longBody}\n\n## B\n\nx`;
    expect(shouldAutoCollapse(source, parseNoteSections(source))).toBe(true);
  });

  it("does not collapse short notes even with many sections", () => {
    const source = "## A\n\nx\n\n## B\n\ny\n\n## C\n\nz";
    expect(shouldAutoCollapse(source, parseNoteSections(source))).toBe(false);
  });

  it("does not collapse a single top-level section however long", () => {
    const source = `## Only\n\n${longBody}\n\n### Sub\n\nx`;
    expect(shouldAutoCollapse(source, parseNoteSections(source))).toBe(false);
  });
});
