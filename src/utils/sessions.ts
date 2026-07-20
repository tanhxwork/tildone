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
