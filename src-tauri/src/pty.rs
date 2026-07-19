//! The embedded attach pane's engine: a PTY the app owns, running
//! `claude attach <id>` against a background session.
//!
//! One pane at a time by design (spec 2026-07-19-embedded-attach-pane): the
//! jump is "go to the session", not a multiplexer. Opening a new pane closes
//! the previous one; closing detaches — the attach *client* dies, the session
//! keeps running in Claude's daemon, which owns its real PTY.
//!
//! Data path (field guide, lesson 8): the reader thread sleeps in `read()`;
//! the kernel wakes it with each chunk, which is forwarded to the webview as
//! a `pty-data` event. EOF — the attach client exited, however that happened
//! — becomes `pty-exit`. No polling anywhere.

use std::io::Read;
use std::sync::{Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::Emitter;

/// The single visible pane's slot — which session the terminal is showing.
#[derive(Default)]
pub struct PtyLive(Mutex<Option<PaneSlot>>);

/// Two kinds of session can be on the pane (spec
/// 2026-07-19-hosted-agent-sessions); they differ in exactly one place —
/// what closing means:
///
/// - `Foreign`: a `claude attach` client against the daemon's session. This
///   process is disposable; close kills it and the session lives on in the
///   daemon.
/// - `Hosted`: a session from `host.rs`'s table — the CLI process *is* the
///   session and the app owns it. Close only detaches; the reader keeps
///   buffering and the session keeps running until an explicit `host_kill`.
enum PaneBackend {
    Foreign {
        /// Keystrokes go here — the master end's writer.
        writer: Box<dyn std::io::Write + Send>,
        /// Kept for resize (rows × cols ioctl → SIGWINCH in the child).
        master: Box<dyn portable_pty::MasterPty + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    },
    Hosted { session_id: u64 },
}

struct PaneSlot {
    /// Which open this pane came from. Reader threads tag their events with
    /// it so a late chunk from a closed pane can be ignored by the UI.
    generation: u64,
    backend: PaneBackend,
}

impl PaneSlot {
    fn release(self) {
        match self.backend {
            // Kill the attach *client* only. The session itself lives in the
            // daemon and is deliberately untouched.
            PaneBackend::Foreign { mut child, .. } => {
                let _ = child.kill();
            }
            // Detach only — the hosted session keeps running headless.
            PaneBackend::Hosted { session_id } => {
                crate::host::detach(session_id, self.generation);
            }
        }
    }
}

/// Fresh pane generation. Shared with `host.rs` so hosted and foreign panes
/// draw from one sequence — a generation names a pane instance, whatever is
/// behind it.
pub(crate) fn next_generation() -> u64 {
    static GENERATION: OnceLock<Mutex<u64>> = OnceLock::new();
    let counter = GENERATION.get_or_init(|| Mutex::new(0));
    let mut n = counter.lock().unwrap();
    *n += 1;
    *n
}

/// Put a hosted session on the pane, evicting whatever was there. `host.rs`
/// calls this after wiring the attach — the slot itself lives in Tauri state,
/// which only command context can reach.
pub(crate) fn claim_pane_for_hosted(live: &PtyLive, generation: u64, session_id: u64) {
    let previous = live
        .0
        .lock()
        .unwrap()
        .replace(PaneSlot { generation, backend: PaneBackend::Hosted { session_id } });
    if let Some(previous) = previous {
        previous.release();
    }
}

/// What a `pty-data` / `pty-exit` event carries.
#[derive(serde::Serialize, Clone)]
struct PtyEvent {
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Vec<u8>>,
}

/// The claude binary. A GUI app's PATH is minimal (launchd, not a login
/// shell), so never assume `claude` resolves: try the known install
/// locations, then ask a login shell. Only a *successful* answer is cached —
/// caching a miss would make "install claude, then click again" require an
/// app restart (codex verify finding, 2026-07-19).
fn claude_bin() -> Option<String> {
    static BIN: Mutex<Option<String>> = Mutex::new(None);
    if let Some(cached) = BIN.lock().unwrap().clone() {
        return Some(cached);
    }
    let found = resolve_claude_bin();
    if let Some(ref path) = found {
        *BIN.lock().unwrap() = Some(path.clone());
    }
    found
}

fn resolve_claude_bin() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        let local = format!("{home}/.local/bin/claude");
        if std::path::Path::new(&local).exists() {
            return Some(local);
        }
    }
    for candidate in ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    let out = std::process::Command::new("/bin/sh")
        .args(["-lc", "command -v claude"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// The short id `claude attach` expects for this session, from the registry's
/// JSON — or `None` when the session isn't an attachable background session.
/// Pure so the interesting branches are testable without the CLI.
fn attach_target_from(registry_json: &str, session_id: &str) -> Option<String> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(registry_json).ok()?;
    let entry = entries
        .iter()
        .find(|e| e.get("sessionId").and_then(|v| v.as_str()) == Some(session_id))?;
    // `claude attach` serves background sessions only; an interactive session
    // has a real window and takes the raise path instead.
    if entry.get("kind").and_then(|v| v.as_str()) != Some("background") {
        return None;
    }
    match entry.get("id").and_then(|v| v.as_str()) {
        Some(short) => Some(short.to_string()),
        // Registry rows occasionally omit `id`; the UUID's first block is the
        // same short form the CLI prints.
        None => session_id.split('-').next().map(str::to_string),
    }
}

/// Board → session routing, attach half: is this session attachable, and by
/// what id? `None` covers every "cannot" — CLI missing, registry unreadable,
/// session unknown or interactive — because the UI answers all of them with
/// the same quiet miss note.
#[tauri::command]
pub async fn attach_target(session_id: String) -> Result<Option<String>, String> {
    let target = tauri::async_runtime::spawn_blocking(move || {
        let bin = claude_bin()?;
        let out = std::process::Command::new(bin)
            .args(["agents", "--json"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        attach_target_from(&String::from_utf8_lossy(&out.stdout), &session_id)
    })
    .await
    .unwrap_or(None);
    Ok(target)
}

/// Open the pane: spawn `claude attach <short_id>` on a fresh PTY and stream
/// its output to the webview. Returns the generation the UI must filter
/// events by. Any previous pane is closed first — one pane at a time.
#[tauri::command]
pub async fn pty_open(
    app: tauri::AppHandle,
    live: tauri::State<'_, PtyLive>,
    short_id: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let generation = next_generation();

    // The blocking work — binary lookup (may run a login shell), openpty,
    // spawn — happens off the async command body, like `attach_target`.
    let parts = tauri::async_runtime::spawn_blocking(move || {
        let bin = claude_bin().ok_or_else(|| {
            "claude CLI not found — install it or add it to ~/.local/bin".to_string()
        })?;
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty failed: {e}"))?;
        let mut cmd = CommandBuilder::new(bin);
        cmd.arg("attach");
        cmd.arg(&short_id);
        cmd.env("TERM", "xterm-256color");
        if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("writer failed: {e}"))?;
        Ok::<_, String>((pair.master, child, reader, writer))
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))??;
    let (master, child, mut reader, writer) = parts;

    let previous = {
        let mut slot = live.0.lock().unwrap();
        slot.replace(PaneSlot {
            generation,
            backend: PaneBackend::Foreign { writer, master, child },
        })
    };
    if let Some(previous) = previous {
        previous.release();
    }

    // The reader: asleep in read() until the kernel has bytes, forwarding
    // each chunk. EOF (attach client exited or was killed) ends the thread.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit(
                        "pty-data",
                        PtyEvent { generation, data: Some(buf[..n].to_vec()) },
                    );
                }
            }
        }
        let _ = app.emit("pty-exit", PtyEvent { generation, data: None });
    });

    Ok(generation)
}

/// Keystrokes from the pane. Every mutation carries the caller's generation
/// and is silently a no-op unless it matches the live pane's — a stale pane
/// instance (an unmount racing a fresh open, StrictMode's discarded double
/// in dev) must never write into a *different* session's attach client
/// (codex verify finding, 2026-07-19). A key racing a close is normal, not
/// an error.
#[tauri::command]
pub fn pty_write(
    live: tauri::State<'_, PtyLive>,
    generation: u64,
    data: String,
) -> Result<(), String> {
    let mut slot = live.0.lock().unwrap();
    if let Some(pane) = slot.as_mut() {
        if pane.generation != generation {
            return Ok(());
        }
        match &mut pane.backend {
            PaneBackend::Foreign { writer, .. } => writer
                .write_all(data.as_bytes())
                .and_then(|()| writer.flush())
                .map_err(|e| format!("write failed: {e}"))?,
            PaneBackend::Hosted { session_id } => {
                crate::host::write_bytes(*session_id, data.as_bytes())?
            }
        }
    }
    Ok(())
}

/// The divider moved or fullscreen toggled: resize the PTY so the TUI
/// reflows (SIGWINCH reaches the attach client). Generation-guarded like
/// `pty_write`.
#[tauri::command]
pub fn pty_resize(
    live: tauri::State<'_, PtyLive>,
    generation: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let slot = live.0.lock().unwrap();
    if let Some(pane) = slot.as_ref() {
        if pane.generation != generation {
            return Ok(());
        }
        match &pane.backend {
            PaneBackend::Foreign { master, .. } => master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("resize failed: {e}"))?,
            PaneBackend::Hosted { session_id } => crate::host::resize(*session_id, cols, rows)?,
        }
    }
    Ok(())
}

/// Detach: close *this caller's* pane, never the session (see
/// `PaneSlot::release` — a foreign attach client dies, a hosted session
/// keeps running headless) — and never a newer pane that has since taken the
/// slot. The generation guard is what lets a disposed pane instance undo an
/// accidental takeover without ever being able to kill its successor.
#[tauri::command]
pub fn pty_close(live: tauri::State<'_, PtyLive>, generation: u64) -> Result<(), String> {
    let pane = {
        let mut slot = live.0.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.generation == generation) {
            slot.take()
        } else {
            None
        }
    };
    if let Some(pane) = pane {
        pane.release();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTRY: &str = r#"[
        {"id":"c6b09956","cwd":"/x","kind":"background","sessionId":"c6b09956-6758-4b3e-b427-bf846ce2ecaa","name":"jump","state":"working"},
        {"pid":71456,"cwd":"/y","kind":"interactive","sessionId":"96f99c27-dcab-47c0-979e-1395e452a39a","name":"zeno"},
        {"cwd":"/z","kind":"background","sessionId":"aaaabbbb-1111-2222-3333-444455556666","name":"no-short-id"}
    ]"#;

    #[test]
    fn background_session_resolves_to_its_short_id() {
        assert_eq!(
            attach_target_from(REGISTRY, "c6b09956-6758-4b3e-b427-bf846ce2ecaa"),
            Some("c6b09956".to_string())
        );
    }

    #[test]
    fn interactive_session_is_not_attachable() {
        // It has a window; the raise path owns it. Attach must refuse.
        assert_eq!(
            attach_target_from(REGISTRY, "96f99c27-dcab-47c0-979e-1395e452a39a"),
            None
        );
    }

    #[test]
    fn missing_short_id_falls_back_to_uuid_first_block() {
        assert_eq!(
            attach_target_from(REGISTRY, "aaaabbbb-1111-2222-3333-444455556666"),
            Some("aaaabbbb".to_string())
        );
    }

    #[test]
    fn unknown_session_and_bad_json_answer_none() {
        assert_eq!(attach_target_from(REGISTRY, "not-there"), None);
        assert_eq!(attach_target_from("not json", "x"), None);
        assert_eq!(attach_target_from("[]", "x"), None);
    }
}
