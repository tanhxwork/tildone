import { describe, expect, it } from "bun:test";
import { buildPlanPrompt, parsePlan, planTasks } from "../src/utils/dailyPlan";
import type { Project, Task } from "../src/types";

const TODAY = "2026-07-06";

function task(over: Partial<Task>): Task {
  return {
    id: 1,
    project_id: null,
    title: "task",
    notes: "",
    status: "todo",
    priority: 0,
    due_date: null,
    position: 0,
    created_at: "",
    completed_at: null,
    tag_ids: [],
    ...over,
  };
}

const projects: Project[] = [{ id: 5, name: "Home", color: "#888", position: 0 }];

describe("planTasks", () => {
  it("splits open tasks into overdue and today, ignoring done and undated", () => {
    const tasks = [
      task({ id: 1, title: "overdue", due_date: "2026-07-01" }),
      task({ id: 2, title: "today", due_date: TODAY }),
      task({ id: 3, title: "done overdue", due_date: "2026-07-01", status: "done" }),
      task({ id: 4, title: "future", due_date: "2026-08-01" }),
      task({ id: 5, title: "no date" }),
    ];
    const r = planTasks(tasks, TODAY);
    expect(r.overdue.map((t) => t.title)).toEqual(["overdue"]);
    expect(r.todays.map((t) => t.title)).toEqual(["today"]);
  });
});

describe("buildPlanPrompt", () => {
  it("mentions date, sections, priority and project names", () => {
    const r = planTasks(
      [
        task({ id: 1, title: "pay rent", due_date: "2026-07-01", priority: 3, project_id: 5 }),
        task({ id: 2, title: "buy milk", due_date: TODAY }),
      ],
      TODAY,
    );
    const prompt = buildPlanPrompt(r, projects, TODAY);
    expect(prompt).toContain("Today is 2026-07-06");
    expect(prompt).toContain("Overdue tasks:");
    expect(prompt).toContain("- pay rent, priority High, project Home, due 2026-07-01");
    expect(prompt).toContain("Due today:");
    expect(prompt).toContain("- buy milk");
  });
});

describe("parsePlan", () => {
  it("separates prose from numbered focus lines", () => {
    const r = parsePlan(
      "You have a light day with one overdue item.\nStart early.\n1. pay rent\n2. buy milk\n3. call mom\n4. extra",
    );
    expect(r.digest).toBe("You have a light day with one overdue item. Start early.");
    expect(r.focus).toEqual(["pay rent", "buy milk", "call mom"]);
  });

  it("accepts bullet markers and handles prose-only replies", () => {
    expect(parsePlan("- first\n* second").focus).toEqual(["first", "second"]);
    const prose = parsePlan("Just a calm day. Nothing urgent.");
    expect(prose.focus).toEqual([]);
    expect(prose.digest).toBe("Just a calm day. Nothing urgent.");
  });

  it("strips markdown bold and Overview/Plan labels", () => {
    const r = parsePlan("**Overview:** A busy day ahead. **Plan:**\n1. pay rent");
    expect(r.digest).toBe("A busy day ahead.");
    expect(r.focus).toEqual(["pay rent"]);
  });
});
