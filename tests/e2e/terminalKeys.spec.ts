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

// Bytes xterm has emitted (onData) since the tap was installed. Line motions
// ride term.input and paste rides term.paste, so both surface here as they
// reach the pty — server output (term.write) never fires onData, so the prompt
// and echoes don't pollute this.
async function emitted(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __emit?: string[] }).__emit ?? []);
}

// The bits of the xterm instance the e2e seam exposes on window.__tildoneTerm.
type TermSeam = {
  write(data: string, callback?: () => void): void;
  selectLines(start: number, end: number): void;
  getSelection(): string;
  clearSelection(): void;
  buffer: {
    active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined };
  };
};

// Two lines the test owns, so the copy assertion never depends on shell output.
// Two rather than one on purpose: a one-line selection cannot tell a correct
// copy apart from one that keeps only the first row of a multi-row selection.
const MARKER_A = "TILDONE-COPY-MARKER-195-A";
const MARKER_B = "TILDONE-COPY-MARKER-195-B";
const MARKER = `${MARKER_A}\n${MARKER_B}`;
const LATE = "late output from the shell";

// Server-output path: term.write never fires onData, so this is invisible to
// `emitted()` — it changes the screen without touching the pty pipe, exactly
// like the shell's own output does.
//
// The callback is awaited because xterm parses writes *asynchronously* (the
// write buffer schedules parsing on a timer). Returning as soon as write() has
// been called leaves the bytes queued, so a chord fired immediately afterwards
// would run against the screen as it was *before* the write — which would make
// the late-output case below silently untested.
async function writeToTerm(data: string): Promise<void> {
  await browser.execute((d) => {
    const w = window as unknown as { __tildoneTerm: TermSeam; __wrote: boolean };
    w.__wrote = false;
    w.__tildoneTerm.write(d, () => {
      w.__wrote = true;
    });
  }, data);
  await browser.waitUntil(
    async () => browser.execute(() => (window as unknown as { __wrote: boolean }).__wrote),
    { timeout: 4000, timeoutMsg: "xterm never finished parsing the write" },
  );
}

// Absolute buffer row (scrollback included) whose text is exactly `line`, or -1.
// Absolute is the coordinate space selectLines() takes, so the two indexings
// agree, and it is stable under later output: appended lines land below.
async function rowOf(line: string): Promise<number> {
  return browser.execute((m) => {
    const b = (window as unknown as { __tildoneTerm: TermSeam }).__tildoneTerm.buffer.active;
    for (let y = b.length - 1; y >= 0; y--)
      if ((b.getLine(y)?.translateToString(true) ?? "").trim() === m) return y;
    return -1;
  }, line);
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

  it("⌘←/⌘→ emit Ctrl-A/Ctrl-E, ⌘⌫ clears the line, ⌘C copies, ⌘V pastes, ⌘⇧ passes through", async () => {
    await $("#root").waitForExist();

    // Spawn a live shell so the pane and its xterm exist (same path a user takes).
    await $('button[aria-label="New session"]').click();
    await $(".sess-new").waitForExist();
    await $(".sess-new-cwd").setValue("/tmp");
    const shellAdapter = $(".sess-new-adapter*=Shell");
    await shellAdapter.waitForExist();
    await shellAdapter.click();
    await $(".session-pane").waitForExist();

    // The footer surfaces the terminal shortcut cheat-sheet as kbd chips —
    // every ⌘-chord the handler owns plus close/hide must be listed (TIL-169).
    const footKeys = await browser.execute(() =>
      Array.from(document.querySelectorAll(".session-pane-foot .session-pane-keys kbd")).map((k) => k.textContent),
    );
    expect(footKeys).toEqual(expect.arrayContaining(["⌘←", "⌘→", "⌘⌫", "⌘C", "⌘V", "⌘W", "⇧⌘T"]));

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

    // ⌘←/⌘→ are claimed (preventDefault → dispatch returns false) and emit
    // Ctrl-A (\x01, beginning-of-line) / Ctrl-E (\x05, end-of-line) verbatim
    // onto the pty pipe — the bytes zsh/bash actually bind for line motion,
    // unlike CSI Home/End which zsh's default keymap ignored (TIL-167 finding).
    expect(await metaChord("ArrowLeft")).toBe(false);
    expect(await metaChord("ArrowRight")).toBe(false);
    // ⌘⌫ → Ctrl-U (\x15, kill-whole-line) — delete the whole row.
    expect(await metaChord("Backspace")).toBe(false);
    expect(await emitted()).toEqual(expect.arrayContaining(["\x01", "\x05", "\x15"]));

    // ⌘⇧←, ⌘⇧c, ⌘⇧v and a ⌘-chord the handler doesn't own all pass through
    // untouched — not claimed (dispatch returns true), and nothing new emitted.
    const beforePassthrough = (await emitted()).length;
    expect(await metaChord("ArrowLeft", true)).toBe(true);
    expect(await metaChord("c", true)).toBe(true);
    expect(await metaChord("v", true)).toBe(true);
    expect(await metaChord("q")).toBe(true);
    expect((await emitted()).length).toBe(beforePassthrough);

    // ⌘C copies the current selection verbatim to the clipboard.
    //
    // The selection is two lines we wrote ourselves, not `selectAll()`. The old
    // shape — selectAll → snapshot → ⌘C → compare — made this assertion a diff
    // of the entire screen buffer, developer's zsh startup banner included, so
    // any late shell repaint between the snapshot and the chord failed it on
    // content the spec has no business depending on (TIL-195). Selecting a known
    // region out of a *larger* buffer is also the stronger assertion: it tells
    // "copies the selection" apart from "copies everything", which a
    // whole-buffer selection could not — and two rows keep the multi-row
    // fidelity that a single-row marker would have given up.
    await writeToTerm(`\r\n${MARKER_A}\r\n${MARKER_B}\r\n`);
    const rowA = await rowOf(MARKER_A);
    const rowB = await rowOf(MARKER_B);
    expect(rowA).toBeGreaterThanOrEqual(0);
    expect(rowB).toBe(rowA + 1);
    await browser.execute(
      (a, b) => (window as unknown as { __tildoneTerm: TermSeam }).__tildoneTerm.selectLines(a, b),
      rowA,
      rowB,
    );
    expect(
      await browser.execute(() => (window as unknown as { __tildoneTerm: TermSeam }).__tildoneTerm.getSelection()),
    ).toBe(MARKER);

    // Late shell output — the tail of an async startup banner, say — must not
    // change what ⌘C copies. This is the exact input that broke the old
    // full-buffer assertion; the selection is anchored to the marker rows, so it
    // rides through. Keeping it here turns yesterday's flake into a covered case
    // — but only if the repaint has actually reached the screen before the
    // chord, so that is asserted rather than assumed.
    await writeToTerm(`\r${LATE}\r\n`);
    expect(await rowOf(LATE)).toBeGreaterThanOrEqual(0);

    expect(await metaChord("c")).toBe(false);
    await browser.waitUntil(
      async () => browser.execute(() => (window as unknown as { __clipOut: string | null }).__clipOut !== null),
      { timeout: 4000, timeoutMsg: "⌘C did not write to the clipboard" },
    );
    expect(await browser.execute(() => (window as unknown as { __clipOut: string }).__clipOut)).toBe(MARKER);
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
