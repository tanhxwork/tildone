import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkTaskRefs, taskUrlTransform } from "../src/utils/markdownTaskRefs";
import {
  braceExpand,
  parseEvidenceUrl,
  remarkEvidenceLinks,
} from "../src/utils/markdownEvidence";

// The same pipeline Markdown.tsx builds, minus the store-bound <a> renderer:
// the renderer only reads href, so the emitted href is the whole routing
// decision. Prior art: tests/markdownNotes.test.ts.
function render(md: string): string {
  return renderToStaticMarkup(
    h(
      ReactMarkdown as unknown as (props: Record<string, unknown>) => unknown,
      {
        remarkPlugins: [remarkGfm, remarkTaskRefs, remarkEvidenceLinks],
        urlTransform: taskUrlTransform,
        components: {},
      },
      md,
    ) as never,
  );
}

/** Every href the pipeline emitted, in order. */
function hrefs(md: string): string[] {
  return [...render(md).matchAll(/href="([^"]*)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
}

describe("file paths", () => {
  it("links a relative evidence path", () => {
    expect(hrefs("screenshots: .test-artifacts/shot.png")).toEqual([
      "tildone:file/.test-artifacts%2Fshot.png",
    ]);
  });

  it("links absolute and home-relative paths", () => {
    expect(hrefs("/Users/x/report.pdf and ~/Desktop/notes.md")).toEqual([
      "tildone:file/%2FUsers%2Fx%2Freport.pdf",
      "tildone:file/~%2FDesktop%2Fnotes.md",
    ]);
  });

  it("keeps the trailing sentence punctuation out of the link", () => {
    expect(hrefs("see docs/specs/a.md, then docs/plans/b.md.")).toEqual([
      "tildone:file/docs%2Fspecs%2Fa.md",
      "tildone:file/docs%2Fplans%2Fb.md",
    ]);
  });

  it("links a whole inline-code span that is one path", () => {
    expect(hrefs("`.test-artifacts/shot.png`")).toEqual([
      "tildone:file/.test-artifacts%2Fshot.png",
    ]);
  });

  it("leaves a path inside a multi-token code span literal", () => {
    expect(hrefs("`python3 .harness/tests/x.py`")).toEqual([]);
    expect(hrefs("tests: 8 passed (`python3 .harness/t.md`)")).toEqual([]);
  });

  it("refuses paths that are not allowlisted evidence", () => {
    // Source and scripts are deliberately not openable — the extension
    // allowlist is the safety model.
    expect(hrefs("src/foo.ts and scripts/run.sh and bin/tool")).toEqual([]);
  });

  it("refuses a path that climbs out of its base", () => {
    expect(hrefs("../../etc/passwd.txt")).toEqual([]);
    expect(hrefs("docs/../../secrets.md")).toEqual([]);
  });

  it("needs a slash — a bare filename stays prose", () => {
    expect(hrefs("see README.md for more")).toEqual([]);
  });

  it("leaves an existing markdown link alone", () => {
    expect(hrefs("[shot](docs/a.md)")).toEqual(["docs/a.md"]);
  });

  it("does not re-link inside an autolinked URL", () => {
    expect(hrefs("https://example.com/a/b.png")).toEqual([
      "https://example.com/a/b.png",
    ]);
  });
});

describe("brace sets", () => {
  it("links the whole set as one token", () => {
    expect(hrefs("shots/annotate-{light,dark,dark-panel}.png")).toEqual([
      "tildone:file/shots%2Fannotate-%7Blight%2Cdark%2Cdark-panel%7D.png",
    ]);
  });

  it("expands to one path per alternative", () => {
    expect(braceExpand("shots/annotate-{light,dark}.png")).toEqual([
      "shots/annotate-light.png",
      "shots/annotate-dark.png",
    ]);
  });

  it("leaves a path with no braces as itself", () => {
    expect(braceExpand("shots/a.png")).toEqual(["shots/a.png"]);
  });
});

describe("commit shas", () => {
  it("links a bare sha", () => {
    expect(hrefs("commit: e4548660")).toEqual(["tildone:sha/e4548660"]);
  });

  it("refuses hex-shaped English words", () => {
    // "effaced", "defaced", "decade" are all a-f only.
    expect(hrefs("the text was effaced and defaced")).toEqual([]);
  });

  it("refuses too-short and too-long runs", () => {
    expect(hrefs("abc123 and 0123456789012345678901234567890123456789012")).toEqual(
      [],
    );
  });

  it("links a sha inside its own code span", () => {
    expect(hrefs("`e4548660`")).toEqual(["tildone:sha/e4548660"]);
  });
});

describe("pr numbers", () => {
  it("links #84", () => {
    expect(hrefs("landed in #84 yesterday")).toEqual(["tildone:pr/84"]);
  });

  it("links a parenthesised pr", () => {
    expect(hrefs("(#84)")).toEqual(["tildone:pr/84"]);
  });

  it("leaves a heading alone", () => {
    expect(hrefs("## Findings")).toEqual([]);
    expect(hrefs("### 84 things")).toEqual([]);
  });

  it("refuses a bare # and an over-long number", () => {
    expect(hrefs("# and #1234567")).toEqual([]);
  });
});

describe("parseEvidenceUrl", () => {
  it("round-trips each sentinel", () => {
    expect(parseEvidenceUrl("tildone:file/a%2Fb.png")).toEqual({
      kind: "file",
      value: "a/b.png",
    });
    expect(parseEvidenceUrl("tildone:sha/e4548660")).toEqual({
      kind: "sha",
      value: "e4548660",
    });
    expect(parseEvidenceUrl("tildone:pr/84")).toEqual({ kind: "pr", value: "84" });
  });

  it("is null for anything else", () => {
    expect(parseEvidenceUrl("https://example.com")).toBeNull();
    expect(parseEvidenceUrl("tildone:task/3")).toBeNull();
  });

  // The sentinel is not a capability: markdown lets an agent write the URL by
  // hand, so a link that never went through the token grammar must not inherit
  // its trust. Found by the post-commit review of aadeba9.
  it("refuses a hand-written sentinel the grammar would never emit", () => {
    for (const url of [
      "tildone:file/%2Fbin%2Fsh",
      "tildone:file/%2FApplications%2FEvil.app",
      "tildone:file/..%2F..%2Fetc%2Fpasswd.txt",
      "tildone:file/~%2FDownloads%2Fpayload.dmg",
      "tildone:sha/deadbeef", // no digit — hex-shaped, but not a sha
      "tildone:pr/notanumber",
    ]) {
      expect(parseEvidenceUrl(url)).toBeNull();
    }
  });

  it("does not turn a hand-written sentinel into a live link", () => {
    // The url transform strips it, leaving prose rather than a click.
    expect(hrefs("[open me](tildone:file/%2Fbin%2Fsh)")).toEqual([""]);
  });
});
