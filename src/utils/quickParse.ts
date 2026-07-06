import { addDays, addWeeks, format, nextMonday } from "date-fns";
import type { Project, Tag } from "../types";

export interface QuickParse {
  /** Input with recognized tokens stripped and whitespace collapsed. */
  title: string;
  dueDate: string | null; // YYYY-MM-DD
  projectId: number | null;
  priority: number; // 0 none, 1 low, 2 medium, 3 high
  /** Canonical names of existing tags, or the name as typed for new ones. */
  tagNames: string[];
}

interface Span {
  start: number;
  end: number;
}

interface DateCandidate extends Span {
  date: Date;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const WEEKDAY_ALT = Object.keys(WEEKDAYS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// "5pm", "5 pm", "17:00", "5:30pm" — optionally preceded by "at".
const TIME = String.raw`(?:at\s+)?(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))`;

function validDate(year: number, month: number, day: number): Date | null {
  const d = new Date(year, month, day);
  return d.getMonth() === month && d.getDate() === day ? d : null;
}

/** A month-day resolves to the current year, or next year if already past. */
function monthDay(now: Date, month: number, day: number): Date | null {
  const thisYear = validDate(now.getFullYear(), month, day);
  if (thisYear && format(thisYear, "yyyy-MM-dd") >= format(now, "yyyy-MM-dd")) {
    return thisYear;
  }
  return validDate(now.getFullYear() + 1, month, day);
}

function dateCandidates(input: string, now: Date): DateCandidate[] {
  const out: DateCandidate[] = [];
  const push = (m: RegExpMatchArray, date: Date | null) => {
    if (date && m.index !== undefined) {
      out.push({ start: m.index, end: m.index + m[0].length, date });
    }
  };

  for (const m of input.matchAll(/\b(today|tod|tomorrow|tmr)\b/gi)) {
    const w = m[1].toLowerCase();
    push(m, w === "today" || w === "tod" ? now : addDays(now, 1));
  }
  for (const m of input.matchAll(/\bnext\s+week\b/gi)) {
    push(m, nextMonday(now));
  }
  for (const m of input.matchAll(
    new RegExp(String.raw`\b(?:(next)\s+)?(${WEEKDAY_ALT})\b`, "gi"),
  )) {
    const target = WEEKDAYS[m[2].toLowerCase()];
    const delta = (target - now.getDay() + 7) % 7;
    const upcoming = addDays(now, delta); // delta 0 → today
    push(m, m[1] ? addDays(upcoming, 7) : upcoming);
  }
  for (const m of input.matchAll(/\bin\s+(\d{1,2})\s+(days?|weeks?)\b/gi)) {
    const n = Number(m[1]);
    push(m, m[2].toLowerCase().startsWith("day") ? addDays(now, n) : addWeeks(now, n));
  }
  for (const m of input.matchAll(
    new RegExp(String.raw`\b(${MONTH_ALT})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "gi"),
  )) {
    push(m, monthDay(now, MONTHS[m[1].toLowerCase()], Number(m[2])));
  }
  for (const m of input.matchAll(
    new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\b`, "gi"),
  )) {
    push(m, monthDay(now, MONTHS[m[2].toLowerCase()], Number(m[1])));
  }
  for (const m of input.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(m, validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  return out;
}

/** Grow a date span to swallow a directly adjacent time ("tomorrow 5pm", "5pm tomorrow"). */
function absorbAdjacentTime(input: string, span: Span): Span {
  const after = input.slice(span.end).match(new RegExp(String.raw`^\s+${TIME}\b`, "i"));
  if (after) return { ...span, end: span.end + after[0].length };
  const before = input.slice(0, span.start).match(new RegExp(String.raw`(?:^|\s)${TIME}\s+$`, "i"));
  if (before) return { ...span, start: span.start - before[0].trimStart().length };
  return span;
}

function stripSpans(input: string, spans: Span[]): string {
  let result = input;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, s.start) + " " + result.slice(s.end);
  }
  return result.replace(/\s+/g, " ").trim();
}

export function parseQuickAdd(
  input: string,
  ctx: { projects: Project[]; tags: Tag[]; now?: Date },
): QuickParse {
  const now = ctx.now ?? new Date();
  const spans: Span[] = [];

  // #project — only recognized when it names an existing project.
  let projectId: number | null = null;
  for (const m of input.matchAll(/(^|\s)#(\S+)/g)) {
    const project = ctx.projects.find(
      (p) => p.name.toLowerCase() === m[2].toLowerCase(),
    );
    if (project && m.index !== undefined) {
      projectId = project.id; // last match wins
      const start = m.index + m[1].length;
      spans.push({ start, end: start + 1 + m[2].length });
    }
  }

  // @tag — always consumed; new names create tags on submit.
  const tagNames: string[] = [];
  for (const m of input.matchAll(/(^|\s)@(\S+)/g)) {
    if (m.index === undefined) continue;
    const existing = ctx.tags.find((t) => t.name.toLowerCase() === m[2].toLowerCase());
    const name = existing ? existing.name : m[2];
    if (!tagNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
      tagNames.push(name);
    }
    const start = m.index + m[1].length;
    spans.push({ start, end: start + 1 + m[2].length });
  }

  // !priority — words or 1–3 on the internal scale (3 = high).
  let priority = 0;
  for (const m of input.matchAll(/(^|\s)!(high|medium|med|low|[123])(?=\s|$)/gi)) {
    if (m.index === undefined) continue;
    const w = m[2].toLowerCase();
    priority = w === "high" ? 3 : w === "medium" || w === "med" ? 2 : w === "low" ? 1 : Number(w);
    const start = m.index + m[1].length;
    spans.push({ start, end: start + 1 + m[2].length });
  }

  // Date phrases — last one wins and is stripped (with any adjacent time);
  // earlier date-like words stay in the title ("prep Monday agenda fri").
  let dueDate: string | null = null;
  const candidates = dateCandidates(input, now).filter(
    (c) => !spans.some((s) => c.start < s.end && s.start < c.end),
  );
  if (candidates.length > 0) {
    const winner = candidates.reduce((a, b) => (b.start >= a.start ? b : a));
    dueDate = format(winner.date, "yyyy-MM-dd");
    spans.push(absorbAdjacentTime(input, winner));
  }

  return { title: stripSpans(input, spans), dueDate, projectId, priority, tagNames };
}
