import { browser, $, expect } from "@wdio/globals";

/** The point of src-tauri/src/drops.rs is that the webview can read a file only
 *  because the user dropped it — not because it asked. That property is what
 *  replaced a $HOME/** read scope, so it deserves a test rather than a comment:
 *  these call the command directly, the way hostile renderer code would. */
async function readDropped(path: string): Promise<{ ok: boolean; err: string }> {
  return browser.executeAsync((p: string, done: (v: unknown) => void) => {
    const tauri = (window as never as { __TAURI__?: { core: { invoke: Function } } }).__TAURI__;
    if (!tauri) return done({ ok: false, err: "no __TAURI__" });
    tauri.core
      .invoke("read_dropped_image", { path: p })
      .then(() => done({ ok: true, err: "" }))
      .catch((e: unknown) => done({ ok: false, err: String(e) }));
  }, path) as Promise<{ ok: boolean; err: string }>;
}

describe("dropped-file read boundary", () => {
  before(async () => {
    await $("#root").waitForExist();
    const overlay = $(".firstrun-overlay");
    if (await overlay.isExisting()) {
      await $(".firstrun-footer button.btn.primary").click();
      await overlay.waitForExist({ reverse: true });
    }
  });

  it("refuses a readable file the user never dropped", async () => {
    // /etc/hosts exists and is world-readable, so a pass here would mean the
    // command served it purely because it was asked — the exact failure the
    // gesture-scoped design exists to prevent.
    const res = await readDropped("/etc/hosts");
    expect(res.ok).toBe(false);
    expect(res.err).toContain("not a recently dropped path");
  });

  it("refuses a path in the user's home directory", async () => {
    // The previous design granted $HOME/** outright; this proves that grant is
    // gone rather than merely unused.
    const res = await readDropped("/Users/hongxuan/.ssh/id_rsa");
    expect(res.ok).toBe(false);
    expect(res.err).toContain("not a recently dropped path");
  });

  it("refuses a directory traversal dressed up as a dropped path", async () => {
    const res = await readDropped("/tmp/../etc/hosts");
    expect(res.ok).toBe(false);
  });
});
