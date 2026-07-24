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

// Bytes xterm has emitted (onData) since the tap was installed. Home/End ride
// term.input and paste rides term.paste, so both surface here exactly as they
// reach the pty — server output (term.write) never fires onData, so the prompt
// and echoes don't pollute this.
async function emitted(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __emit?: string[] }).__emit ?? []);
}

// Dispatch a ⌘-chord straight at xterm's textarea. Synthetic dispatch (not
// browser.keys) is deliberate: WebDriver key injection into this webview drops
// the Meta modifier off Arrow keydowns, so an OS-level ⌘← never reaches the
// handler with metaKey set. A synthesized event guarantees the modifier and
// exercises the handler exactly as a real ⌘-press does. Returns false when the
// handler called preventDefault (i.e. it claimed the chord).
async function metaChord(key: string, shift = false): Promise<boolean> {
  return browser.execute(
    (k, s) => {
      const ta = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
      if (!ta) return true;
      return ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, shiftKey: s, bubbles: true, cancelable: true }));
    },
    key,
    shift,
  );
}

describe("terminal — ⌘ line-editing & copy/paste", () => {
  afterEach(async () => {
    // Never leave a live pty behind the next spec, even if an assertion threw.
    for (const s of await invoke<HostSession[]>("host_list"))
      if (s.adapter_id === "shell" && !s.exited) await invoke("host_kill", { sessionId: s.id });
  });

  it("⌘←/⌘→ emit Home/End, ⌘C copies the selection, ⌘V pastes, ⌘⇧ passes through", async () => {
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
    // onData → pty_write path (wired only after attach) is live.
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
      { timeout: 12000, timeoutMsg: "shell prompt never rendered (or VITE_E2E seam missing)" },
    );

    // Tap onData to see the exact bytes leaving for the pty, and stub the
    // clipboard so ⌘C/⌘V are observable without OS clipboard access.
    await browser.execute(() => {
      const w = window as unknown as {
        __emit: string[];
        __pasteRead: boolean;
        __clipOut: string | null;
        __clipIn: string;
        __tildoneTerm: { onData(cb: (d: string) => void): void };
      };
      w.__emit = [];
      w.__pasteRead = false;
      w.__clipOut = null;
      w.__clipIn = "PASTED-marker";
      w.__tildoneTerm.onData((d) => w.__emit.push(d));
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

    // ⌘←/⌘→ are claimed (preventDefault → dispatch returns false) and emit the
    // Home/End CSI sequences verbatim onto the pty pipe.
    expect(await metaChord("ArrowLeft")).toBe(false);
    expect(await metaChord("ArrowRight")).toBe(false);
    expect(await emitted()).toEqual(expect.arrayContaining(["\x1b[H", "\x1b[F"]));

    // ⌘⇧←, ⌘⇧c, ⌘⇧v and a ⌘-chord the handler doesn't own all pass through
    // untouched — not claimed (dispatch returns true), and nothing new emitted.
    const beforePassthrough = (await emitted()).length;
    expect(await metaChord("ArrowLeft", true)).toBe(true);
    expect(await metaChord("c", true)).toBe(true);
    expect(await metaChord("v", true)).toBe(true);
    expect(await metaChord("q")).toBe(true);
    expect((await emitted()).length).toBe(beforePassthrough);

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

    // ⌘V reads the clipboard and pastes the bytes onto the pty pipe.
    expect(await metaChord("v")).toBe(false);
    await browser.waitUntil(
      async () => browser.execute(() => (window as unknown as { __pasteRead: boolean }).__pasteRead),
      { timeout: 4000, timeoutMsg: "⌘V did not read the clipboard" },
    );
    await browser.waitUntil(async () => (await emitted()).some((d) => d.includes("PASTED-marker")), {
      timeout: 4000,
      timeoutMsg: "⌘V did not emit the pasted bytes to the pty",
    });
  });
});
