import { describe, expect, it } from "bun:test";
import type { TaskLink } from "../src/types";
import {
  commitUrl,
  prUrl,
  repoBaseFromLinks,
  repoBaseFromRemote,
  repoBaseFromUrl,
} from "../src/utils/repoUrl";

function link(url: string, kind = "commit"): TaskLink {
  return { id: 1, task_id: 1, url, kind, label: "x", created_at: "" } as TaskLink;
}

describe("repoBaseFromUrl", () => {
  it("reads a github commit, pr and branch url", () => {
    for (const url of [
      "https://github.com/tanhxwork/tildone/commit/abc1234",
      "https://github.com/tanhxwork/tildone/pull/84",
      "https://github.com/tanhxwork/tildone/tree/worktree-x",
    ]) {
      expect(repoBaseFromUrl(url)).toEqual({
        base: "https://github.com/tanhxwork/tildone",
        gitlab: false,
      });
    }
  });

  it("keeps gitlab subgroups and marks the flavour", () => {
    expect(
      repoBaseFromUrl("https://gitlab.com/group/sub/app/-/merge_requests/12"),
    ).toEqual({ base: "https://gitlab.com/group/sub/app", gitlab: true });
  });

  it("takes the bare repo url as its own base", () => {
    expect(repoBaseFromUrl("https://github.com/o/r")).toEqual({
      base: "https://github.com/o/r",
      gitlab: false,
    });
  });

  it("is null for non-repo and non-http urls", () => {
    expect(repoBaseFromUrl("https://example.com")).toBeNull();
    expect(repoBaseFromUrl("/Users/x/shot.png")).toBeNull();
  });
});

describe("repoBaseFromLinks", () => {
  it("takes the first link that names a repo", () => {
    const links = [
      link("https://example.com/docs", "other"),
      link("https://github.com/o/r/commit/abc1234"),
    ];
    expect(repoBaseFromLinks(links)?.base).toBe("https://github.com/o/r");
  });

  it("is null when no link names a repo", () => {
    expect(repoBaseFromLinks([link("https://example.com", "other")])).toBeNull();
    expect(repoBaseFromLinks([])).toBeNull();
  });
});

describe("repoBaseFromRemote", () => {
  it("normalises the scp-like ssh remote", () => {
    expect(repoBaseFromRemote("git@github.com:tanhxwork/tildone.git")).toEqual({
      base: "https://github.com/tanhxwork/tildone",
      gitlab: false,
    });
  });

  it("normalises ssh:// and https:// remotes", () => {
    expect(repoBaseFromRemote("ssh://git@gitlab.com/g/app.git")).toEqual({
      base: "https://gitlab.com/g/app",
      gitlab: true,
    });
    expect(repoBaseFromRemote("https://github.com/o/r.git\n")).toEqual({
      base: "https://github.com/o/r",
      gitlab: false,
    });
  });

  it("is null for a remote with no web address", () => {
    expect(repoBaseFromRemote("/srv/git/bare.git")).toBeNull();
    expect(repoBaseFromRemote("")).toBeNull();
  });
});

describe("urls", () => {
  it("builds github and gitlab shapes", () => {
    const gh = { base: "https://github.com/o/r", gitlab: false };
    const gl = { base: "https://gitlab.com/g/app", gitlab: true };
    expect(commitUrl(gh, "e4548660")).toBe("https://github.com/o/r/commit/e4548660");
    expect(prUrl(gh, "84")).toBe("https://github.com/o/r/pull/84");
    expect(commitUrl(gl, "e4548660")).toBe(
      "https://gitlab.com/g/app/-/commit/e4548660",
    );
    expect(prUrl(gl, "12")).toBe("https://gitlab.com/g/app/-/merge_requests/12");
  });
});
