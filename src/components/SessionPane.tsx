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

    let generation: number | null = null;
    let disposed = false;
    const unlistens: Array<() => void> = [];

    void (async () => {
      const un1 = await listen<PtyEvent>("pty-data", (e) => {
        if (disposed || e.payload.generation !== generation || !e.payload.data) return;
        term.write(new Uint8Array(e.payload.data));
      });
      const un2 = await listen<PtyEvent>("pty-exit", (e) => {
        if (disposed || e.payload.generation !== generation) return;
        term.write("\r\n\x1b[2m[session detached — the session itself keeps running]\x1b[0m\r\n");
      });
      unlistens.push(un1, un2);
      try {
        generation = await invoke<number>("pty_open", {
          shortId: target.shortId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (err) {
        term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
      }
      term.focus();
    })();

    const dataSub = term.onData((data) => {
      void invoke("pty_write", { data }).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
      void invoke("pty_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(bodyRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      dataSub.dispose();
      unlistens.forEach((un) => un());
      void invoke("pty_close").catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, [target?.sessionId]);

  // Re-click on the same card, or fullscreen/width changes: hand focus back
  // to the terminal so typing continues without a click.
  useEffect(() => {
    termRef.current?.focus();
  }, [focusNonce, fullscreen, widthFraction]);

  // The jumped card must stay in sight: center it in the remaining strip.
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
