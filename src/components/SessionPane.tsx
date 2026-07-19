// The embedded attach pane (spec 2026-07-19-embedded-attach-pane): a real
// terminal, slid over the board, running `claude attach <id>` against the
// card's background session. Close = detach; the session keeps running in
// Claude's daemon.
//
// Lifecycle: mount xterm → pty_open (returns a generation) → stream
// `pty-data` events tagged with that generation into the terminal; keys go
// back via pty_write; ResizeObserver → fit → pty_resize so the TUI reflows.
// Generations exist because a chunk from a pane closed a moment ago can
// still be in flight — stale generations are dropped, not drawn.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { usePaneStore } from "../paneStore";
import { IconTerminal, IconX, IconMaximize } from "./Icons";

interface PtyEvent {
  generation: number;
  data?: number[];
}

/** The terminal's ground, in both app themes — a TUI brings its own colors
 *  and expects a dark screen. One constant feeds xterm's theme AND the pane
 *  body behind it, so the padding ring can never mismatch the canvas. */
const TERM_BG = "#16181d";

/** Serializes pane opens across effect instances. Two instances can race —
 *  StrictMode re-invokes effects synchronously in dev, a fast session switch
 *  does it for real — and whichever `pty_open` resolved *last* would own the
 *  Rust slot, evicting the mounted pane (codex verify finding, 2026-07-19).
 *  Queueing means a disposed instance reaches its turn already disposed and
 *  never opens at all, and a live successor always opens after its
 *  predecessor's takeover is settled. */
let openQueue: Promise<unknown> = Promise.resolve();

export function SessionPane() {
  const target = usePaneStore((s) => s.target);
  const widthFraction = usePaneStore((s) => s.widthFraction);
  const fullscreen = usePaneStore((s) => s.fullscreen);
  const focusNonce = usePaneStore((s) => s.focusNonce);
  const closePane = usePaneStore((s) => s.closePane);
  const toggleFullscreen = usePaneStore((s) => s.toggleFullscreen);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // One attach per (session, mount). The effect tears the whole terminal
  // down on session change or close — never reuse an xterm across sessions.
  useEffect(() => {
    if (!target || !bodyRef.current) return;

    const term = new Terminal({
      scrollback: 5000,
      fontSize: 12,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      theme: { background: TERM_BG },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(bodyRef.current);
    // WebGL when the webview offers it; the DOM renderer is a fine fallback
    // at TUI data rates.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* renderer fallback is automatic */
    }
    fit.fit();
    termRef.current = term;

    // The whole async chain below races the effect's own cleanup: StrictMode
    // re-invokes effects synchronously in dev, and a fast session switch does
    // the same for real. Every await is therefore followed by a `disposed`
    // check that undoes exactly what just completed — and every Rust-side
    // mutation carries `generation`, so a stale instance can no-op but never
    // touch a successor pane's session (codex verify finding, 2026-07-19).
    let generation: number | null = null;
    let disposed = false;
    const unlistens: Array<() => void> = [];
    let dataSub: { dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;

    const run = async () => {
      if (disposed) return;
      const un1 = await listen<PtyEvent>("pty-data", (e) => {
        if (disposed || e.payload.generation !== generation || !e.payload.data) return;
        term.write(new Uint8Array(e.payload.data));
      });
      if (disposed) {
        // Cleanup already ran with an empty `unlistens` — release it here.
        un1();
        return;
      }
      unlistens.push(un1);
      const un2 = await listen<PtyEvent>("pty-exit", (e) => {
        if (disposed || e.payload.generation !== generation) return;
        term.write("\r\n\x1b[2m[session detached — the session itself keeps running]\x1b[0m\r\n");
      });
      if (disposed) {
        un2();
        return;
      }
      unlistens.push(un2);

      let opened: number;
      try {
        opened = await invoke<number>("pty_open", {
          shortId: target.shortId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (err) {
        if (!disposed) term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
        return;
      }
      if (disposed) {
        // This instance died while its open was in flight and may have just
        // evicted the successor's pane. Generation-guarded close: undoes the
        // takeover if ours is live, no-ops if the successor already won.
        void invoke("pty_close", { generation: opened }).catch(() => {});
        return;
      }
      generation = opened;

      // Input and resize wire up only once the pane is genuinely ours.
      dataSub = term.onData((data) => {
        void invoke("pty_write", { generation: opened, data }).catch(() => {});
      });
      observer = new ResizeObserver(() => {
        fit.fit();
        void invoke("pty_resize", {
          generation: opened,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      });
      if (bodyRef.current) observer.observe(bodyRef.current);
      term.focus();
    };
    const turn = openQueue;
    openQueue = (async () => {
      await turn.catch(() => {});
      await run();
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      dataSub?.dispose();
      unlistens.forEach((un) => un());
      if (generation !== null) {
        void invoke("pty_close", { generation }).catch(() => {});
      }
      term.dispose();
      termRef.current = null;
    };
  }, [target?.sessionId]);

  // Re-click on the same card, or fullscreen/width changes: hand focus back
  // to the terminal so typing continues without a click.
  useEffect(() => {
    termRef.current?.focus();
  }, [focusNonce, fullscreen, widthFraction]);

  // The jumped card must stay in sight. Two mechanisms: the layout inset
  // (a root CSS var the board strip uses to stop underlapping the fixed
  // pane) and a vertical scroll to center the card in its now-solo column.
  useEffect(() => {
    const root = document.documentElement;
    if (target && !fullscreen) {
      root.style.setProperty("--pane-inset", `${widthFraction * 100}vw`);
    } else {
      root.style.setProperty("--pane-inset", "0px");
    }
    return () => {
      root.style.setProperty("--pane-inset", "0px");
    };
  }, [target, widthFraction, fullscreen]);

  useEffect(() => {
    if (!target) return;
    document
      .querySelector(`[data-task-id="${target.taskId}"]`)
      ?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, [target?.taskId]);

  if (!target) return null;

  function onGripDown(down: React.PointerEvent) {
    down.preventDefault();
    const onMove = (e: PointerEvent) => {
      // Grip position → pane fraction, measured from the right edge.
      usePaneStore.getState().setWidthFraction(1 - e.clientX / window.innerWidth);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onPaneKeyDown(e: React.KeyboardEvent) {
    // ⌘W detaches. Esc is deliberately NOT handled — it belongs to the TUI.
    if (e.metaKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      e.stopPropagation();
      closePane();
    }
  }

  return (
    <aside
      className={fullscreen ? "session-pane session-pane--full" : "session-pane"}
      style={fullscreen ? undefined : { width: `${widthFraction * 100}%` }}
      aria-label="Attached session terminal"
      onKeyDown={onPaneKeyDown}
    >
      {!fullscreen && (
        <div
          className="session-pane-grip"
          onPointerDown={onGripDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal pane"
        />
      )}
      <header className="session-pane-head">
        <IconTerminal size={13} />
        {target.taskRef && <span className="session-pane-ref">{target.taskRef}</span>}
        <span className="session-pane-name">{target.name ?? target.shortId}</span>
        <button
          type="button"
          className="icon-btn"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={toggleFullscreen}
        >
          <IconMaximize size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Detach — the session keeps running (⌘W)"
          aria-label="Detach terminal"
          onClick={closePane}
        >
          <IconX size={13} />
        </button>
      </header>
      <div className="session-pane-body" style={{ background: TERM_BG }} ref={bodyRef} />
      <footer className="session-pane-foot">
        <span>attached · session keeps running on close</span>
        <span>⌘W detach</span>
      </footer>
    </aside>
  );
}
