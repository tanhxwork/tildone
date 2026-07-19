// The quit guard's dialog (spec 2026-07-19-hosted-agent-sessions). Hosted
// agent sessions are children of this process and die with it — unlike claude
// daemon sessions, which the daemon keeps. So quitting while any is live must
// be a decision: Rust blocks the exit once (RunEvent::ExitRequested), shows
// the window and emits `host-quit-warning`; this dialog either cancels (the
// app simply stays open) or confirms through `host_confirm_quit`, which stops
// the sessions and exits for real.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useHostStore } from "../hostStore";
import { IconTerminal } from "./Icons";

export function QuitWarning() {
  const [open, setOpen] = useState(false);
  const liveSessions = useHostStore((s) => s.sessions).filter((s) => !s.exited);

  useEffect(() => {
    const unlisten = listen("host-quit-warning", () => setOpen(true));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // The race where every session ends while the dialog is up resolves itself:
  // nothing left to warn about, so the next quit sails through.
  if (!open || liveSessions.length === 0) return null;

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        className="modal quit-warning"
        role="dialog"
        aria-label="Agent sessions still running"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Agent sessions still running</h2>
        </div>
        <p className="quit-warning-text">
          These sessions run inside Tildone and end when it quits. Sessions
          marked resumable can be brought back from their card next launch:
        </p>
        <ul className="quit-warning-list">
          {liveSessions.map((s) => (
            <li key={s.id}>
              <IconTerminal size={13} />
              <span className="quit-warning-name">{s.adapter_name}</span>
              {s.task_ref && <span className="quit-warning-ref">{s.task_ref}</span>}
              {s.bound && <span className="quit-warning-resumable">resumable</span>}
            </li>
          ))}
        </ul>
        <div className="modal-footer">
          <button className="btn" onClick={() => setOpen(false)}>
            Keep running
          </button>
          <button className="btn danger" onClick={() => void invoke("host_confirm_quit")}>
            Stop sessions and quit
          </button>
        </div>
      </div>
    </div>
  );
}
