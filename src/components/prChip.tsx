import { type ReactNode } from "react";
import type { TaskLink } from "../types";
import { LINK_KIND_COLORS, asLinkKind } from "../types";
import { IconCheck } from "./Icons";

/** The merge-status face of a PR chip (TIL-84). Its tint, a modifier class, and a
 *  trailing badge; null when the link is not a stamped PR, so the chip keeps its
 *  plain purple open-PR look. Shared by every place a PR renders — the card strip,
 *  the verify popover and the editor review band — so a merged PR reads ✓ the same
 *  in all of them, including as the review-door (TIL-88). `open` splits into ready
 *  (up to date) and behind.
 *
 *  The merged ✓ is wrapped in `.pr-check` because it is an icon, not a
 *  self-coloured span like the ↓N / draft badges: inside the review-door it would
 *  otherwise inherit that door's review-tinted svg rule. See src/App.css. */
export function prChip(
  link: TaskLink,
): { cls: string; color: string; suffix: ReactNode; title: string } | null {
  if (asLinkKind(link.kind) !== "pr" || !link.pr_state) return null;
  const behind = link.pr_behind ?? 0;
  // CI rollup (F4): tooltip-only — the chip's color stays a merge-state
  // signal; checks would double-encode and muddy both.
  const checks = link.pr_checks ? ` · checks ${link.pr_checks}` : "";
  switch (link.pr_state) {
    case "merged":
      return {
        cls: "pr-merged",
        color: "var(--success)",
        suffix: (
          <span className="pr-check">
            <IconCheck size={11} />
          </span>
        ),
        title: `merged${checks}`,
      };
    case "draft":
      return {
        cls: "pr-draft",
        color: "var(--text-faint)",
        suffix: <span className="pr-draft-tag">draft</span>,
        title: `draft${checks}`,
      };
    case "open":
      return behind > 0
        ? {
            cls: "pr-behind",
            color: "var(--warn)",
            suffix: <span className="pr-behind-count">↓{behind}</span>,
            title: `${behind} behind main · rebase before merge${checks}`,
          }
        : {
            cls: "pr-ready",
            color: LINK_KIND_COLORS.pr,
            suffix: null,
            title: `up to date${checks}`,
          };
    default:
      return null;
  }
}
