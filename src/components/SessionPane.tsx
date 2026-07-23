// The embedded session pane: a real terminal slid over the board, showing
// one of two kinds of session (specs 2026-07-19-embedded-attach-pane and
// 2026-07-19-hosted-agent-sessions):
//
//   attach — `claude attach <id>` against the card's background session.
//            Close kills the attach client; the session lives in the daemon.
//   hosted — a board-started CLI whose PTY the app owns (host.rs). Close
//            only detaches; the session keeps running here, buffered, and a
//            re-jump replays the buffer.
//
// Lifecycle: mount xterm → pty_open / host_attach (returns a generation) →
// stream `pty-data` events tagged with that generation into the terminal;
// keys go back via pty_write; ResizeObserver → fit → pty_resize so the TUI
// reflows. Generations exist because a chunk from a pane closed a moment ago
// can still be in flight — stale generations are dropped, not drawn.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { usePaneStore } from "../paneStore";
import { useHostStore } from "../hostStore";
import { IconTerminal, IconX, IconMaximize, IconChevronRight, IconChevronLeft } from "./Icons";

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
  const collapsed = usePaneStore((s) => s.collapsed);
  const focusNonce = usePaneStore((s) => s.focusNonce);
  const closePane = usePaneStore((s) => s.closePane);
  const toggleFullscreen = usePaneStore((s) => s.toggleFullscreen);
  const toggleCollapsed = usePaneStore((s) => s.toggleCollapsed);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // The ref chip follows the LIVE session, not the open-time snapshot: an
  // unbound session that binds-on-claim while the pane is up gains its card
  // ref here without a re-open (spec 2026-07-20).
  const hostSessions = useHostStore((s) => s.sessions);
  const liveRef =
    target?.kind === "hosted"
      ? (hostSessions.find((s) => s.id === target.hostId)?.task_ref ?? target.taskRef)
      : (target?.taskRef ?? null);

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
      // Events that land while `generation` is still null — i.e. between the
      // Rust side flipping `attached` and our invoke() resolving — are held
      // here and drained once the generation is known. Dropping them instead
      // loses real output: for hosted attaches the SIGWINCH repaint fires in
      // exactly that window (codex verify finding, 2026-07-19), leaving a
      // stale frame that is in neither the replay snapshot nor the live
      // stream.
      let pending: PtyEvent[] = [];
      const exitNote = () =>
        term.write(
          target.kind === "hosted"
            ? "\r\n\x1b[2m[session exited]\x1b[0m\r\n"
            : "\r\n\x1b[2m[session detached — the session itself keeps running]\x1b[0m\r\n",
        );
      const un1 = await listen<PtyEvent>("pty-data", (e) => {
        if (disposed || !e.payload.data) return;
        if (generation === null) {
          pending.push(e.payload);
          return;
        }
        if (e.payload.generation !== generation) return;
        term.write(new Uint8Array(e.payload.data));
      });
      if (disposed) {
        // Cleanup already ran with an empty `unlistens` — release it here.
        un1();
        return;
      }
      unlistens.push(un1);
      const un2 = await listen<PtyEvent>("pty-exit", (e) => {
        if (disposed) return;
        if (generation === null) {
          pending.push(e.payload);
          return;
        }
        if (e.payload.generation !== generation) return;
        // For an attach pane this means the attach client died (session lives
        // on in the daemon); for a hosted pane the CLI itself exited.
        exitNote();
      });
      if (disposed) {
        un2();
        return;
      }
      unlistens.push(un2);

      let opened: number;
      try {
        if (target.kind === "hosted") {
          // The replay rides in the return value, not an event — the pane
          // only knows its generation once this resolves, so an event would
          // race the listener above and the replayed screen could be lost.
          const attach = await invoke<{ generation: number; replay: number[]; exited: boolean }>(
            "host_attach",
            { sessionId: target.hostId, cols: term.cols, rows: term.rows },
          );
          opened = attach.generation;
          if (attach.replay.length > 0) term.write(new Uint8Array(attach.replay));
          if (attach.exited) term.write("\r\n\x1b[2m[session exited]\x1b[0m\r\n");
        } else {
          opened = await invoke<number>("pty_open", {
            shortId: target.shortId,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch (err) {
        if (!disposed) term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
        // Release the listeners now, not at unmount: after a failed open
        // `generation` stays null forever, and leaving them registered would
        // buffer every future event app-wide into `pending` for as long as
        // this failed pane stays up (codex verify finding). splice so the
        // unmount cleanup can't double-release.
        unlistens.splice(0).forEach((un) => un());
        pending = [];
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
      // Drain the held events: everything our generation emitted before the
      // invoke resolved, in arrival order, after the replay it follows. An
      // exit event carries no data. Stale generations are dropped here, same
      // as live.
      for (const p of pending) {
        if (p.generation !== opened) continue;
        if (p.data) term.write(new Uint8Array(p.data));
        else exitNote();
      }
      pending = [];

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
    if (collapsed) {
      // Don't strand focus inside the hidden, aria-hidden pane: that keeps
      // paneHasFocus() true (swallowing board shortcuts) and traps keyboard
      // focus in aria-hidden content. Hand it to the peek tab — the reopen
      // control, which is rendered by the time this effect runs.
      termRef.current?.blur();
      document.querySelector<HTMLElement>(".session-pane-peek")?.focus();
      return;
    }
    termRef.current?.focus();
  }, [focusNonce, fullscreen, widthFraction, collapsed]);

  // The jumped card must stay in sight. Two mechanisms: the layout inset
  // (a root CSS var the board strip uses to stop underlapping the fixed
  // pane) and a vertical scroll to center the card in its now-solo column.
  useEffect(() => {
    const root = document.documentElement;
    if (target && !fullscreen && !collapsed) {
      root.style.setProperty("--pane-inset", `${widthFraction * 100}vw`);
    } else if (target && collapsed && !fullscreen) {
      // Collapsed: the task column reclaims the width, reserving only the
      // slim peek tab's footprint (keep in sync with .session-pane-peek).
      root.style.setProperty("--pane-inset", "30px");
    } else {
      root.style.setProperty("--pane-inset", "0px");
    }
    return () => {
      root.style.setProperty("--pane-inset", "0px");
    };
  }, [target, widthFraction, fullscreen, collapsed]);

  useEffect(() => {
    if (!target || target.taskId === null) return;
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

  const paneClass = [
    "session-pane",
    fullscreen && "session-pane--full",
    collapsed && !fullscreen && "session-pane--collapsed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {collapsed && !fullscreen && (
        <button
          type="button"
          className="session-pane-peek"
          title="Show terminal (⇧⌘T)"
          aria-label="Show terminal"
          aria-expanded={false}
          onClick={toggleCollapsed}
        >
          <IconChevronLeft size={13} />
          <span className="session-pane-peek-label">
            {liveRef ? `${liveRef} · terminal` : "terminal"}
          </span>
        </button>
      )}
      <aside
        className={paneClass}
        style={fullscreen ? undefined : { width: `${widthFraction * 100}%` }}
        aria-label="Attached session terminal"
        aria-hidden={collapsed && !fullscreen}
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
        {!fullscreen && (
          <button
            type="button"
            className="session-pane-toggle"
            title="Hide terminal (⇧⌘T)"
            aria-label="Hide terminal"
            aria-expanded={true}
            // The toggle sits over the resize grip; swallow the pointerdown so
            // clicking it never starts a resize drag.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleCollapsed}
          >
            <IconChevronRight size={13} />
          </button>
        )}
        <header className="session-pane-head">
        <IconTerminal size={13} />
        {liveRef ? (
          <span className="session-pane-ref">{liveRef}</span>
        ) : (
          target.kind === "hosted" && (
            <span className="session-pane-ref session-pane-ref--none">no card yet</span>
          )
        )}
        <span className="session-pane-name">
          {target.name ?? (target.kind === "attach" ? target.shortId : "session")}
        </span>
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
        <span>
          {target.kind === "hosted"
            ? "hosted · session keeps running on close"
            : "attached · session keeps running on close"}
        </span>
        <span>⌘W detach</span>
      </footer>
      </aside>
    </>
  );
}
