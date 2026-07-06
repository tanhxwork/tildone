import {
  addDays,
  differenceInCalendarDays,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { Task } from "../types";

export type WeekStartDay = "monday" | "sunday";

export function toDateStr(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** The 7 dates (YYYY-MM-DD) of the week containing `anchor`. */
export function weekDates(anchor: Date, weekStart: WeekStartDay): string[] {
  const start = startOfWeek(anchor, { weekStartsOn: weekStart === "monday" ? 1 : 0 });
  return Array.from({ length: 7 }, (_, i) => toDateStr(addDays(start, i)));
}

/** Full weeks (rows of 7 date strings) covering the month of `anchor`. */
export function monthGrid(anchor: Date, weekStart: WeekStartDay): string[][] {
  const first = startOfMonth(anchor);
  const gridStart = startOfWeek(first, { weekStartsOn: weekStart === "monday" ? 1 : 0 });
  const weeks: string[][] = [];
  let cursor = gridStart;
  const month = first.getMonth();
  do {
    weeks.push(Array.from({ length: 7 }, (_, i) => toDateStr(addDays(cursor, i))));
    cursor = addDays(cursor, 7);
  } while (cursor.getMonth() === month);
  return weeks;
}

export function todayStr(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function tomorrowStr(): string {
  return format(addDays(new Date(), 1), "yyyy-MM-dd");
}

export function isOverdue(task: Task): boolean {
  return !!task.due_date && task.status !== "done" && task.due_date < todayStr();
}

export function dueLabel(dueDate: string): string {
  const date = parseISO(dueDate);
  const diff = differenceInCalendarDays(date, startOfDay(new Date()));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format(date, sameYear ? "EEE, MMM d" : "MMM d, yyyy");
}

/** Sort: unfinished first, then by due date (nulls last), priority desc, manual position. */
export function compareTasks(a: Task, b: Task): number {
  const doneA = a.status === "done" ? 1 : 0;
  const doneB = b.status === "done" ? 1 : 0;
  if (doneA !== doneB) return doneA - doneB;
  const dueA = a.due_date ?? "9999-12-31";
  const dueB = b.due_date ?? "9999-12-31";
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}
