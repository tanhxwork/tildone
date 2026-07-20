import { describe, expect, test } from "bun:test";
import {
  adapterGlyph,
  countdown,
  cwdBasename,
  sessionRowModel,
  suggestedTitle,
  type SessionLike,
} from "../src/utils/sessions";

function base(over: Partial<SessionLike> = {}): SessionLike {
  return {
    task_ref: null,
    adapter_id: "claude",
    adapter_name: "Claude Code",
    cwd: "/Users/x/projects/tildone",
    exited: false,
    waiting: false,
    unbound_stage: null,
    expires_in_secs: null,
    title_hint: null,
    ...over,
  };
}

describe("sessionRowModel", () => {
  test("bound session labels with the card ref; unbound falls back to hint then adapter", () => {
    expect(sessionRowModel(base({ task_ref: "TIL-9" })).label).toBe("TIL-9");
    expect(sessionRowModel(base({ title_hint: "fix the bug" })).label).toBe("fix the bug");
    expect(sessionRowModel(base()).label).toBe("Claude Code");
  });

  test("state ranks exited over waiting over quiet", () => {
    expect(sessionRowModel(base({ exited: true, waiting: true })).state).toBe("exited");
    expect(sessionRowModel(base({ waiting: true })).state).toBe("waiting");
    expect(sessionRowModel(base()).state).toBe("quiet");
  });

  test("unbound lifecycle surfaces only on live task-less sessions", () => {
    expect(sessionRowModel(base({ unbound_stage: "remind" })).unbound).toEqual({
      kind: "remind",
    });
    expect(
      sessionRowModel(base({ unbound_stage: "expire-soon", expires_in_secs: 720 })).unbound,
    ).toEqual({ kind: "expire-soon", countdown: "12m" });
    // A bound session never shows the chip, whatever the stage says.
    expect(
      sessionRowModel(base({ task_ref: "TIL-9", unbound_stage: "expire-soon" })).unbound,
    ).toBeNull();
    // Neither does an exited one — it has its own state.
    expect(sessionRowModel(base({ exited: true, unbound_stage: "remind" })).unbound).toBeNull();
  });

  test("sublabel is the cwd basename", () => {
    expect(sessionRowModel(base()).sublabel).toBe("tildone");
    expect(sessionRowModel(base({ cwd: undefined })).sublabel).toBe("");
  });
});

describe("helpers", () => {
  test("adapter glyphs", () => {
    expect(adapterGlyph("claude")).toBe("✱");
    expect(adapterGlyph("codex")).toBe("◆");
    expect(adapterGlyph("shell")).toBe("$");
    expect(adapterGlyph("opencode")).toBe("○");
  });

  test("countdown is coarse minutes above 2m, seconds below", () => {
    expect(countdown(720)).toBe("12m");
    expect(countdown(121)).toBe("3m");
    expect(countdown(90)).toBe("90s");
    expect(countdown(0)).toBe("0s");
  });

  test("suggested title prefers the typed first line", () => {
    expect(suggestedTitle(base({ title_hint: "add scrollback search" }))).toBe(
      "add scrollback search",
    );
    expect(suggestedTitle(base({ adapter_id: "shell", adapter_name: "Shell" }))).toBe(
      "Shell · tildone",
    );
    expect(suggestedTitle(base({ cwd: undefined }))).toBe("Claude Code");
  });

  test("cwdBasename survives trailing slashes and roots", () => {
    expect(cwdBasename("/a/b/")).toBe("b");
    expect(cwdBasename("/")).toBe("/");
  });
});
