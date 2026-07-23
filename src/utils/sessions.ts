// Pure derivations behind the sidebar's Sessions section (spec
// 2026-07-20-shell-escape-hatch-session-first-intake). Kept out of the
// component so the row model — label choice, presence state, expiry
// countdown — is unit-testable (the seam agreed at the design gate).

/** The slice of a hosted session the row model needs. */
export interface SessionLike {
  task_ref: string | null;
  adapter_id: string;
  adapter_name: string;
  cwd?: string;
  exited: boolean;
  waiting: boolean;
  unbound_stage?: "remind" | "expire-soon" | null;
  expires_in_secs?: number | null;
  title_hint?: string | null;
}

export type SessionState = "exited" | "waiting" | "quiet";

export interface SessionRowModel {
  /** Primary line: the card ref, else the typed first line, else the CLI. */
  label: string;
  /** Secondary line: where it runs. */
  sublabel: string;
  state: SessionState;
  /** The unbound hint/chip: null, the quiet hint, or the countdown chip. */
  unbound: null | { kind: "remind" } | { kind: "expire-soon"; countdown: string };
}

/** One mono character per adapter — the strip glyph vocabulary. */
export function adapterGlyph(adapterId: string): string {
  switch (adapterId) {
    case "claude":
      return "✱";
    case "codex":
      return "◆";
    case "shell":
      return "$";
    default:
      return "○";
  }
}

export function cwdBasename(cwd: string | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** "12m" / "90s" — the expiry chip's countdown, coarse on purpose. */
export function countdown(secs: number): string {
  if (secs >= 120) return `${Math.ceil(secs / 60)}m`;
  return `${Math.max(0, Math.ceil(secs))}s`;
}

/** The title "make it a task" uses: typed first line, else adapter · dir. */
export function suggestedTitle(s: SessionLike): string {
  const hint = s.title_hint?.trim();
  if (hint) return hint;
  const dir = cwdBasename(s.cwd);
  return dir ? `${s.adapter_name} · ${dir}` : s.adapter_name;
}

export function sessionRowModel(s: SessionLike): SessionRowModel {
  const state: SessionState = s.exited ? "exited" : s.waiting ? "waiting" : "quiet";
  let unbound: SessionRowModel["unbound"] = null;
  if (!s.exited && s.task_ref === null) {
    if (s.unbound_stage === "remind") unbound = { kind: "remind" };
    else if (s.unbound_stage === "expire-soon") {
      unbound = { kind: "expire-soon", countdown: countdown(s.expires_in_secs ?? 0) };
    }
  }
  return {
    label: s.task_ref ?? s.title_hint?.trim() ?? s.adapter_name,
    sublabel: cwdBasename(s.cwd),
    state,
    unbound,
  };
}

// The session switcher (spec 2026-07-23-session-context-rail). The pane stays
// single — one visible terminal — but the switcher makes re-targeting it
// visible: every live session as a tab/roster entry, clicking one hands the
// one pane to that session (the existing openPane re-attach + buffer replay).
// Kept pure here so the list model — order, active-marking, the foreign attach
// entry, and ⌘[/⌘] cycling — is unit-testable, same seam as sessionRowModel.

/** A hosted session carrying the id the pane target keys on. */
export interface SwitchableSession extends SessionLike {
  id: number;
}

/** One entry in the switcher (a terminal tab and a roster row are the same
 *  model, rendered twice). */
export interface SwitchTab {
  /** Matches PaneTarget.sessionId — `hosted-<id>` for hosted sessions, the
   *  claim UUID for a foreign attach session. */
  sessionId: string;
  /** Primary label: the card ref, else the typed hint, else the CLI name. */
  label: string;
  ref: string | null;
  state: SessionState;
  active: boolean;
}

/** The switcher list: every **live** hosted session in the given order (an
 *  exited session lingers in the store until dismissed, but it is board
 *  detritus, not a switch target — so it is neither counted "live" nor
 *  cycled to), marking the active one — plus the active attach target
 *  prepended when it isn't itself a hosted session (a foreign `claude attach`
 *  session lives in no store, so it can only ride in from the open pane's own
 *  target). */
export function switcherSessions(
  sessions: SwitchableSession[],
  activeSessionId: string | null,
  activeAttach?: { sessionId: string; ref: string | null } | null,
): SwitchTab[] {
  const tabs: SwitchTab[] = sessions
    .filter((s) => !s.exited)
    .map((s) => {
    const sessionId = `hosted-${s.id}`;
    const m = sessionRowModel(s);
    return {
      sessionId,
      label: m.label,
      ref: s.task_ref,
      state: m.state,
      active: sessionId === activeSessionId,
    };
  });
  if (activeAttach && !tabs.some((t) => t.sessionId === activeAttach.sessionId)) {
    tabs.unshift({
      sessionId: activeAttach.sessionId,
      label: activeAttach.ref ?? "session",
      ref: activeAttach.ref,
      state: "quiet",
      active: activeAttach.sessionId === activeSessionId,
    });
  }
  return tabs;
}

/** The session ⌘[ / ⌘] should switch to: the neighbour of the active tab,
 *  wrapping. Returns null when there is nothing else to switch to (0 or 1
 *  tabs). dir +1 = next, −1 = previous. A missing active falls to the first. */
export function nextSessionId(
  tabs: SwitchTab[],
  activeSessionId: string | null,
  dir: 1 | -1,
): string | null {
  if (tabs.length < 2) return null;
  const idx = tabs.findIndex((t) => t.sessionId === activeSessionId);
  if (idx === -1) return tabs[0].sessionId;
  const next = (idx + dir + tabs.length) % tabs.length;
  return tabs[next].sessionId;
}

// Closing the terminal (X button / ⌘W) follows Ghostty's Cmd+W (user decision
// 2026-07-23): it CLOSES the session rather than cycling between live ones. A
// hosted CLI we own is killed (host_kill, which removes its row entirely); a
// foreign attach we don't own is merely detached. The view then falls to the
// next live session, or closes to the board when none remain — the tab
// metaphor, which now *converges* because the closed session is genuinely
// gone (the old "detach + fall to next" never terminated: a detached session
// stays live, so X ping-ponged between the two forever — the uncloseable-pane
// bug this replaces).

/** The session the pane should show after the current one closes, or null to
 *  close the pane to the board. Pass the sessions remaining after the close —
 *  a killed hosted session has already left host.rs's table, a detached attach
 *  was never in it — so `closingSessionId` only guards the window before a kill
 *  has propagated to the store. First live session in list order wins; null =
 *  close the last tab, so the pane returns to the board (Ghostty's window-close
 *  on the final tab). */
export function nextAfterClose<T extends { id: number; exited: boolean }>(
  sessions: T[],
  closingSessionId: string,
): T | null {
  return sessions.find((s) => !s.exited && `hosted-${s.id}` !== closingSessionId) ?? null;
}

/** Whether closing this pane would KILL a live CLI we own — the only case that
 *  warrants a confirm prompt. A hosted session is a child process we own;
 *  detaching a foreign attach kills nothing, so it never prompts. For a hosted
 *  target we confirm unless we can *prove* the CLI is already dead: only a row
 *  the store shows as `exited` skips the prompt. A missing row is NOT proof of
 *  death — a just-started session lives in host.rs before the async `host_list`
 *  refresh lands it in the store, so `closeCurrentSession` would `host_kill` a
 *  running CLI; treating "unknown" as live makes the prompt fail safe (Codex
 *  defect, 2026-07-23). An extra confirm on a genuinely-gone row is harmless —
 *  the follow-up `host_kill` just no-ops. */
export function closeKillsLiveCli(
  targetKind: "hosted" | "attach" | undefined,
  hostSession: { exited: boolean } | null | undefined,
): boolean {
  if (targetKind !== "hosted") return false;
  if (!hostSession) return true; // unknown row → assume live, confirm
  return !hostSession.exited;
}
