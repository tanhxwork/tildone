// Agent identity — presentation only.
//
// The database stores the agent's raw MCP client name verbatim (ground truth we
// can never recover if lost). This module maps that raw string to how it should
// look: a display name, a brand accent, and a mark. Being wrong here is cosmetic
// — an unknown agent still shows its real name and a neutral mark, never a blank.
//
// Matching is substring + case-insensitive so client-name variants resolve:
// "claude-code", "Claude Code", "claude" all land on Claude.

import type { ReactElement, SVGProps } from "react";
import { useStore } from "./store";
import { isRecentPresence, timeAgo } from "./utils/dates";

type MarkProps = SVGProps<SVGSVGElement> & { size?: number };

export interface AgentIdentity {
  /** How to render the name on the card / feed. */
  label: string;
  /** Brand accent, used for the mark and a subtle tint. Theme-independent. */
  color: string;
  /** The brand mark. */
  Mark: (p: MarkProps) => ReactElement;
}

function Frame({ size = 14, children, ...rest }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

// Anthropic's spark — a radial burst. Filled in Claude clay.
const ClaudeMark = (p: MarkProps) => (
  <Frame {...p}>
    <path
      fill="currentColor"
      d="M12 2c.5 3.2 1 4.1 2.2 5.3S17.6 9 20.8 9.5c-3.2.5-4.1 1-5.3 2.2S13 15.3 12.5 18.5c-.5-3.2-1-4.1-2.2-5.3S6.7 11 3.5 10.5c3.2-.5 4.1-1 5.3-2.2S11.5 5.2 12 2Z"
    />
  </Frame>
);

// A six-fold rosette — the "codex" knot, kept generic (not a literal logo).
const CodexMark = (p: MarkProps) => (
  <Frame {...p}>
    <g fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 3.5v4.3M12 16.2v4.3M20.5 12h-4.3M7.8 12H3.5M18 6l-3 3M9 15l-3 3M18 18l-3-3M9 9 6 6" />
    </g>
  </Frame>
);

// A caret/cursor — for Cursor.
const CursorMark = (p: MarkProps) => (
  <Frame {...p}>
    <path fill="currentColor" d="M5 3l14 8-6 1.6L10 20 5 3Z" />
  </Frame>
);

// Fallback: a small spark-in-a-ring, clearly "an agent" without claiming a brand.
const GenericAgentMark = (p: MarkProps) => (
  <Frame {...p}>
    <g fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="4.5" y="7" width="15" height="11" rx="3" />
      <path d="M12 3.5v3.5M9 12h.01M15 12h.01" strokeLinecap="round" />
    </g>
  </Frame>
);

interface Rule {
  match: string; // lowercase substring
  label: string;
  color: string;
  Mark: (p: MarkProps) => ReactElement;
}

// Order matters only if substrings overlap; these don't. Extend freely — an
// unmatched agent falls through to the generic identity below.
const RULES: Rule[] = [
  { match: "claude", label: "Claude", color: "#d97757", Mark: ClaudeMark },
  { match: "codex", label: "Codex", color: "#10a37f", Mark: CodexMark },
  { match: "cursor", label: "Cursor", color: "#6b7cff", Mark: CursorMark },
];

const GENERIC: Omit<AgentIdentity, "label"> = {
  color: "#8a8a8a",
  Mark: GenericAgentMark,
};

/**
 * Resolve a raw client name to how it should look.
 *
 * `null`/empty (an agent that sent no name) still resolves to a valid identity
 * labelled "Agent" — the row is known to be an agent even when the name is not.
 */
export function agentIdentity(rawName: string | null | undefined): AgentIdentity {
  const name = (rawName ?? "").trim();
  if (name) {
    const lower = name.toLowerCase();
    const rule = RULES.find((r) => lower.includes(r.match));
    if (rule) return { label: rule.label, color: rule.color, Mark: rule.Mark };
    // Known name, unknown brand: show the real name, generic mark.
    return { label: name, ...GENERIC };
  }
  return { label: "Agent", ...GENERIC };
}

/**
 * The card's presence slot: which agent last touched this task, and how long ago.
 *
 * Renders nothing when no agent has touched the task, or when the last touch is
 * older than the presence window (then it is history, not presence — still in the
 * Activity feed). This is a *read* over stored activity, so it updates on the same
 * reload every agent write already triggers; there is no live/dead flag to clear.
 */
export function AgentPresence({ taskId }: { taskId: number }) {
  const entry = useStore((s) => s.presence[taskId]);
  if (!entry || !isRecentPresence(entry.at)) return null;
  const { label, color, Mark } = agentIdentity(entry.name);
  return (
    <span
      className="card-presence"
      style={{ ["--agent-color" as string]: color }}
      title={`${label} · last active ${timeAgo(entry.at)}`}
    >
      <Mark className="card-presence-mark" size={13} />
      <span className="card-presence-name">{label}</span>
      <span className="card-presence-dot" aria-hidden="true">
        ·
      </span>
      <span className="card-presence-time">{timeAgo(entry.at)}</span>
    </span>
  );
}
