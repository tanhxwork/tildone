import { addDays, format, parseISO } from "date-fns";
import type { ObserveCard, ObserveLogLine, Task } from "./types";

// The Observe page (spec 2026-10-01 observe section): a card waits on its
// trigger, falls Due when the log reaches its count or today reaches its date,
// and is Observed once the user picks an option. Pure slicing of the store's
// `observeCards` slice — tests/observeViews.test.ts pins the rules.

export type ObserveState = "due" | "waiting" | "observed";

/** Waiting / Due / Observed, derived from the card and the local day (YYYY-MM-DD).
 *  Never stored: the same card changes state just by a date passing. */
export function observeState(card: ObserveCard, today: string): ObserveState {
  if (card.decision !== null) return "observed";
  if (card.trigger_count !== null && card.log.length >= card.trigger_count) return "due";
  if (card.trigger_date !== null && today >= card.trigger_date) return "due";
  return "waiting";
}

export interface ObserveGroups {
  due: ObserveCard[];
  waiting: ObserveCard[];
  /** Newest decision first. */
  observed: ObserveCard[];
}

/** The page's three groups. Due and Waiting keep creation order (oldest first),
 *  so a card does not jump around as lines arrive. */
export function observeGroups(cards: ObserveCard[], today: string): ObserveGroups {
  const groups: ObserveGroups = { due: [], waiting: [], observed: [] };
  const byAge = [...cards].sort((a, b) => a.task.id - b.task.id);
  for (const card of byAge) groups[observeState(card, today)].push(card);
  groups.observed.sort((a, b) =>
    (b.task.completed_at ?? "").localeCompare(a.task.completed_at ?? ""),
  );
  return groups;
}

/** The card the detail pane opens on: the first Due card, else the first card in
 *  list order. Null when there are no cards. */
export function defaultObserveId(groups: ObserveGroups): number | null {
  const first = groups.due[0] ?? groups.waiting[0] ?? groups.observed[0];
  return first ? first.task.id : null;
}

/** Sidebar badge and header sub line. Observed counts only decisions made in the
 *  current local month. */
export function observeCounts(
  cards: ObserveCard[],
  today: string,
): { due: number; waiting: number; observedThisMonth: number } {
  const month = today.slice(0, 7);
  let due = 0;
  let waiting = 0;
  let observedThisMonth = 0;
  for (const card of cards) {
    const state = observeState(card, today);
    if (state === "due") due += 1;
    else if (state === "waiting") waiting += 1;
    else if (card.task.completed_at && localDay(card.task.completed_at).startsWith(month)) {
      observedThisMonth += 1;
    }
  }
  return { due, waiting, observedThisMonth };
}

/** "Yes in 3 of 5" over the lines that carry a verdict; null when none does. */
export function yesSummary(log: ObserveLogLine[]): string | null {
  const judged = log.filter((l) => l.verdict !== null);
  if (judged.length === 0) return null;
  const yes = judged.filter((l) => l.verdict === true).length;
  return `Yes in ${yes} of ${judged.length}`;
}

export type DecisionTone = "success" | "danger" | "neutral";

/** Options are written keep -> change -> revert, so the tone follows order: the
 *  first is success, the last of two or more is danger, anything between neutral. */
export function decisionTone(index: number, optionCount: number): DecisionTone {
  if (index === 0) return "success";
  if (index === optionCount - 1) return "danger";
  return "neutral";
}

/** The trigger "Watch more" writes: three more lines past what is already logged
 *  for a count card (so it always returns to Waiting), a week from today for a
 *  date card. */
export function watchMoreTrigger(
  card: ObserveCard,
  today: string,
): { trigger_count: number } | { trigger_date: string } {
  if (card.trigger_count !== null) {
    return { trigger_count: Math.max(card.trigger_count, card.log.length) + 3 };
  }
  return { trigger_date: format(addDays(parseISO(today), 7), "yyyy-MM-dd") };
}

/** The live task opened from this card's decision, if any. */
export function followUpTask(card: ObserveCard, tasks: Task[]): Task | null {
  return tasks.find((t) => t.from_task_id === card.task.id && t.deleted_at === null) ?? null;
}

/** Up to ten squares for a count trigger; past ten, each square stands for a share. */
export function meterSquares(card: ObserveCard): { total: number; filled: number } {
  const count = card.trigger_count ?? 0;
  const total = Math.min(count, 10);
  const logged = Math.min(card.log.length, count);
  const filled = count <= 10 ? logged : Math.round((logged / count) * total);
  return { total, filled };
}

/** A stored ISO timestamp as the local YYYY-MM-DD. */
function localDay(iso: string): string {
  return format(new Date(iso), "yyyy-MM-dd");
}
