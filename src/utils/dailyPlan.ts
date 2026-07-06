import type { Project, Task } from "../types";
import { PRIORITY_LABELS } from "../types";
import { todayStr } from "./dates";

export const PLAN_SYSTEM =
  "You are a planning assistant inside a to-do app. Write a plan for the user's day: " +
  "first a 2-3 sentence overview in plain prose (no headings), then up to 3 lines, " +
  "each starting with a number and a period, naming the exact task titles to focus on, " +
  "most important first. Nothing else.";

export interface PlanInput {
  overdue: Task[];
  todays: Task[];
}

/** Open tasks that a daily plan should consider. */
export function planTasks(tasks: Task[], today: string = todayStr()): PlanInput {
  const open = tasks.filter((t) => t.status !== "done");
  return {
    overdue: open.filter((t) => t.due_date !== null && t.due_date < today),
    todays: open.filter((t) => t.due_date === today),
  };
}

function taskLine(task: Task, projects: Project[]): string {
  const parts = [task.title];
  if (task.priority > 0) parts.push(`priority ${PRIORITY_LABELS[task.priority]}`);
  const project = projects.find((p) => p.id === task.project_id);
  if (project) parts.push(`project ${project.name}`);
  if (task.due_date) parts.push(`due ${task.due_date}`);
  return `- ${parts.join(", ")}`;
}

export function buildPlanPrompt(
  input: PlanInput,
  projects: Project[],
  today: string = todayStr(),
): string {
  const sections = [`Today is ${today}.`];
  if (input.overdue.length > 0) {
    sections.push(`Overdue tasks:\n${input.overdue.map((t) => taskLine(t, projects)).join("\n")}`);
  }
  if (input.todays.length > 0) {
    sections.push(`Due today:\n${input.todays.map((t) => taskLine(t, projects)).join("\n")}`);
  }
  sections.push("Plan my day.");
  return sections.join("\n\n");
}

export interface ParsedPlan {
  digest: string;
  focus: string[];
}

/** Split the model reply into an overview paragraph and up to 3 focus items. */
export function parsePlan(text: string): ParsedPlan {
  const digest: string[] = [];
  const focus: string[] = [];
  // Models sneak in markdown bold and section labels despite the prompt.
  for (const raw of text.replace(/\*\*|__/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:\d+[.)]|[-*•])\s+(.*)$/);
    if (m && m[1]) {
      if (focus.length < 3) focus.push(m[1].trim());
    } else {
      digest.push(line);
    }
  }
  const joined = digest
    .join(" ")
    .replace(/^\s*Overview:\s*/i, "")
    .replace(/\s*Plan:\s*$/i, "");
  return { digest: joined, focus };
}
