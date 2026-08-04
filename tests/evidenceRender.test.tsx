import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { Markdown } from "../src/components/Markdown";

// What the *renderer* does with an evidence sentinel, as opposed to what the
// plugin emits. Both gates that decide whether a click is live — the label must
// name its target, and the surface must want evidence at all — live here, and
// both were defeatable when the Codex verify pass looked (TIL-203).

function render(md: string, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(h(Markdown, props as never, md) as never);
}

const live = (html: string) => /<a[^>]*class="md-evidence"/.test(html);
const inert = (html: string) => html.includes("md-evidence-inert");

describe("the label must name the target", () => {
  it("keeps a plugin-shaped link live", () => {
    expect(live(render("/Users/x/report.md"))).toBe(true);
  });

  it("keeps a backticked path live", () => {
    // A code span contributes no *direct* text child; reading only those made
    // the shape agents write most often render inert.
    expect(live(render("`/Users/x/report.md`"))).toBe(true);
  });

  it("refuses a label that says more than the target", () => {
    const html = render("[**extra**/Users/x/report.md](tildone:file/%2FUsers%2Fx%2Freport.md)");
    expect(live(html)).toBe(false);
    expect(inert(html)).toBe(true);
  });

  it("refuses a label that hides the target entirely", () => {
    const html = render("[build log](tildone:file/~%2FLibrary%2Fsecret.txt)");
    expect(live(html)).toBe(false);
  });
});

describe("surfaces that don't want evidence", () => {
  it("does not linkify bare tokens with evidence off", () => {
    expect(live(render("/Users/x/report.md", { evidence: false }))).toBe(false);
  });

  // Turning the plugin off is not enough: the sentinel can be hand-written, and
  // the renderer used to activate it regardless of surface.
  it("does not activate a hand-written sentinel with evidence off", () => {
    const html = render("[/Users/x/report.md](tildone:file/%2FUsers%2Fx%2Freport.md)", {
      evidence: false,
    });
    expect(live(html)).toBe(false);
  });
});
