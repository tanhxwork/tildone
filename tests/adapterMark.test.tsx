import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { adapterMark } from "../src/agents";

// The Session row's launcher buttons carry no text — the mark is the whole
// label — so a mark that silently collapsed to the fallback would be an
// unnoticed regression. These pin that each adapter draws something distinct.
const draw = (id: string) => renderToStaticMarkup(h(adapterMark(id), { size: 14 }) as never);

describe("adapterMark", () => {
  it("gives each known adapter its own mark", () => {
    const drawn = ["claude", "codex", "opencode", "shell"].map(draw);
    expect(new Set(drawn).size).toBe(4);
  });

  it("falls back to the terminal mark for an adapter we have not branded", () => {
    expect(draw("some-future-cli")).toBe(draw("shell"));
  });

  it("draws at the requested size", () => {
    expect(draw("claude")).toContain('width="14"');
  });
});
