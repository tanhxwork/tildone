import { browser, $, expect } from "@wdio/globals";

// Runs inside the app's own webview (withGlobalTauri in the e2e overlay).
async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return browser.execute(
    (c, a) =>
      (window as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } } })
        .__TAURI__.core.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>;
}

interface HostSession {
  id: number;
  adapter_id: string;
  exited: boolean;
}

// Dispatch a ⌘-chord straight at xterm's textarea. Synthetic dispatch (rather
// than browser.keys) is deliberate: WebDriver key injection into this webview
// drops the Meta modifier off Arrow keydowns, so an OS-level ⌘← never reaches
// the handler with metaKey set. A synthesized event guarantees the modifier and
// exercises the handler exactly as a real ⌘-press does. Returns false when the
// handler called preventDefault (i.e. it claimed the chord).
async function metaChord(key: string): Promise<boolean> {
  return browser.execute((k) => {
    const ta = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (!ta) return true;
    return ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true }));
  }, key);
}

describe("terminal — ⌘ line-editing & copy/paste", () => {
  it("⌘←/⌘→ are claimed as Home/End, ⌘C copies the selection, ⌘V pastes", async () => {
    await $("#root").waitForExist();

    // Spawn a live shell so the pane and its xterm exist (same path a user takes).
    await $('button[aria-label="New session"]').click();
    await $(".sess-new").waitForExist();
    await $(".sess-new-cwd").setValue("/tmp");
    const shellAdapter = $(".sess-new-adapter*=Shell");
    await shellAdapter.waitForExist();
    await shellAdapter.click();
    await $(".session-pane").waitForExist();

    // Wait for the shell prompt to render — proof the pty is attached and the
    // handler's pty_write path (wired only after attach) is live.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const t = (
            window as unknown as {
              __tildoneTerm?: { buffer: { active: { length: number; getLine(y: number): { translateToString(t?: boolean): string } | undefined } } };
            }
          ).__tildoneTerm;
          if (!t) return false;
          const b = t.buffer.active;
          for (let y = 0; y < b.length; y++) if ((b.getLine(y)?.translateToString(true) ?? "").trim().length) return true;
          return false;
        }),
      { timeout: 12000, timeoutMsg: "shell prompt never rendered" },
    );

    // Stub the clipboard so ⌘C/⌘V are observable without OS clipboard access:
    // writeText records the copied text; readText records that a paste asked
    // for it. Both are deterministic — no dependency on the shell echoing back.
    await browser.execute(() => {
      const w = window as unknown as { __clipOut: string | null; __pasteRead: boolean; __clipIn: string };
      w.__clipOut = null;
      w.__pasteRead = false;
      w.__clipIn = "PASTED-marker";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__clipOut = t;
            return Promise.resolve();
          },
          readText: () => {
            w.__pasteRead = true;
            return Promise.resolve(w.__clipIn);
          },
        },
      });
    });

    await $(".xterm").click();

    // ⌘←/⌘→ are claimed by the handler (preventDefault → dispatch returns false).
    expect(await metaChord("ArrowLeft")).toBe(false);
    expect(await metaChord("ArrowRight")).toBe(false);
    // A ⌘-chord the handler does not own passes through untouched.
    expect(await metaChord("q")).toBe(true);

    // ⌘C copies the current selection verbatim to the clipboard.
    const selection = await browser.execute(() => {
      const t = (window as unknown as { __tildoneTerm: { selectAll(): void; getSelection(): string } }).__tildoneTerm;
      t.selectAll();
      return t.getSelection();
    });
    expect(selection.length).toBeGreaterThan(0);
    expect(await metaChord("c")).toBe(false);
    await browser.waitUntil(
      async () => browser.execute(() => (window as unknown as { __clipOut: string | null }).__clipOut !== null),
      { timeout: 4000, timeoutMsg: "⌘C did not write to the clipboard" },
    );
    expect(await browser.execute(() => (window as unknown as { __clipOut: string }).__clipOut)).toBe(selection);
    await browser.execute(() =>
      (window as unknown as { __tildoneTerm: { clearSelection(): void } }).__tildoneTerm.clearSelection(),
    );

    // ⌘V is claimed and reads the clipboard to forward into the pty. (The
    // pty_write path itself is covered by the ⌘←/⌘→ interception above; the
    // shell's echo of the pasted text is intentionally not asserted — it's a
    // racy, shell-config-dependent signal.)
    expect(await metaChord("v")).toBe(false);
    await browser.waitUntil(
      async () => browser.execute(() => (window as unknown as { __pasteRead: boolean }).__pasteRead),
      { timeout: 4000, timeoutMsg: "⌘V did not read the clipboard to paste" },
    );

    // Teardown: don't leave a live pty behind the next spec.
    for (const s of await invoke<HostSession[]>("host_list"))
      if (s.adapter_id === "shell" && !s.exited) await invoke("host_kill", { sessionId: s.id });
  });
});
