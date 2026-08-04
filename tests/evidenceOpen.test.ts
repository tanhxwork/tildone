import { describe, expect, it, mock, beforeEach } from "bun:test";

// The gesture matrix — which click reaches openPath, which reveals, which
// previews — is the security-relevant half of evidence links, so it is tested
// at the seam that talks to the OS, with the Tauri boundary mocked.

const opened: string[] = [];
const revealed: string[] = [];
const read: string[] = [];
let readFails = new Set<string>();

mock.module("@tauri-apps/plugin-opener", () => ({
  openPath: async (p: string) => {
    opened.push(p);
  },
  revealItemInDir: async (p: string) => {
    revealed.push(p);
  },
  openUrl: async () => {},
}));

mock.module("@tauri-apps/api/path", () => ({
  homeDir: async () => "/Users/tester",
}));

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, string>) => {
    if (cmd === "read_evidence_image") {
      if (readFails.has(args.path)) throw new Error("missing");
      read.push(args.path);
      return new ArrayBuffer(4);
    }
    if (cmd === "git_remote_url") return null;
    return null;
  },
}));

// URL.createObjectURL doesn't exist outside a browser.
(globalThis as unknown as { URL: { createObjectURL: (b: unknown) => string } }).URL
  .createObjectURL = () => "blob:stub";

const { openEvidence } = await import("../src/utils/evidenceOpen");

const CWD = "/Users/tester/repo";
const galleryOpens: { src: string; filename: string }[][] = [];
const deps = {
  openFiles: (files: { src: string; filename: string }[]) => {
    galleryOpens.push(files);
  },
};

beforeEach(() => {
  opened.length = 0;
  revealed.length = 0;
  read.length = 0;
  galleryOpens.length = 0;
  readFails = new Set();
});

describe("openEvidence", () => {
  it("previews an image instead of handing it to the OS", async () => {
    expect(await openEvidence("shots/a.png", CWD, false, deps)).toBeNull();
    expect(read).toEqual(["/Users/tester/repo/shots/a.png"]);
    expect(galleryOpens[0]).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it("opens a document in its default app", async () => {
    expect(await openEvidence("docs/a.md", CWD, false, deps)).toBeNull();
    expect(opened).toEqual(["/Users/tester/repo/docs/a.md"]);
    expect(revealed).toEqual([]);
  });

  it("reveals script-bearing files rather than opening them", async () => {
    for (const name of ["docs/a.html", "docs/a.svg", "docs/a.htm"]) {
      await openEvidence(name, CWD, false, deps);
    }
    expect(opened).toEqual([]);
    expect(revealed).toHaveLength(3);
  });

  // The bug the Codex verify pass found: the set was judged by its first
  // member, so an .html riding along behind an .md was handed to the browser.
  it("judges every brace alternative, not just the first", async () => {
    expect(await openEvidence("docs/a.{md,html}", CWD, false, deps)).toBeNull();
    expect(opened).toEqual(["/Users/tester/repo/docs/a.md"]);
    expect(revealed).toEqual(["/Users/tester/repo/docs/a.html"]);
  });

  it("opens a brace set of images as one gallery", async () => {
    await openEvidence("shots/a-{light,dark}.png", CWD, false, deps);
    expect(galleryOpens[0]).toHaveLength(2);
  });

  it("says which member of a gallery is missing", async () => {
    readFails = new Set(["/Users/tester/repo/shots/a-dark.png"]);
    const note = await openEvidence("shots/a-{light,dark}.png", CWD, false, deps);
    expect(galleryOpens[0]).toHaveLength(1);
    expect(note).toContain("a-dark.png");
  });

  it("reveals instead of opening on alt-click", async () => {
    await openEvidence("docs/a.md", CWD, true, deps);
    expect(opened).toEqual([]);
    expect(revealed).toEqual(["/Users/tester/repo/docs/a.md"]);
  });

  it("refuses anything off the allowlist even when asked directly", async () => {
    for (const path of ["bin/run.sh", "app/Evil.app", "docs/../../etc/passwd.txt"]) {
      expect(await openEvidence(path, CWD, false, deps)).toBeNull();
    }
    expect(opened).toEqual([]);
    expect(revealed).toEqual([]);
    expect(read).toEqual([]);
  });

  it("expands ~ against home and leaves absolute paths alone", async () => {
    await openEvidence("~/Desktop/a.md", null, false, deps);
    await openEvidence("/tmp/b.md", null, false, deps);
    expect(opened).toEqual(["/Users/tester/Desktop/a.md", "/tmp/b.md"]);
  });

  it("says so when a relative path has no working directory", async () => {
    const note = await openEvidence("shots/a.png", null, false, deps);
    expect(note).toContain("No working directory");
    expect(read).toEqual([]);
  });
});
