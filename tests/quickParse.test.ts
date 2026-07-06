import { describe, expect, it } from "bun:test";
import { parseQuickAdd } from "../src/utils/quickParse";
import type { Project, Tag } from "../src/types";

// Monday, 2026-07-06 — all relative dates in these tests are anchored here.
const NOW = new Date(2026, 6, 6, 10, 0, 0);

const projects: Project[] = [
  { id: 7, name: "Home", color: "#888", position: 0 },
  { id: 8, name: "Work", color: "#888", position: 1 },
];
const tags: Tag[] = [{ id: 3, name: "errand", color: "#888" }];

function parse(input: string, ctx: Partial<{ projects: Project[]; tags: Tag[] }> = {}) {
  return parseQuickAdd(input, {
    projects: ctx.projects ?? projects,
    tags: ctx.tags ?? tags,
    now: NOW,
  });
}

describe("plain input", () => {
  it("passes through untouched with no tokens", () => {
    const r = parse("buy milk");
    expect(r).toEqual({
      title: "buy milk",
      dueDate: null,
      projectId: null,
      priority: 0,
      tagNames: [],
    });
  });

  it("does not match weekday abbreviations inside words", () => {
    expect(parse("sunset review monday").dueDate).toBe("2026-07-06");
    expect(parse("sunset review").dueDate).toBeNull();
    expect(parse("satisfy the auditors").dueDate).toBeNull();
  });
});

describe("date phrases", () => {
  it("parses today/tod and tomorrow/tmr", () => {
    expect(parse("pay rent today").dueDate).toBe("2026-07-06");
    expect(parse("pay rent tod").dueDate).toBe("2026-07-06");
    expect(parse("pay rent tomorrow").dueDate).toBe("2026-07-07");
    expect(parse("pay rent tmr").dueDate).toBe("2026-07-07");
    expect(parse("pay rent tomorrow").title).toBe("pay rent");
  });

  it("parses upcoming weekday, full and short", () => {
    expect(parse("email boss fri").dueDate).toBe("2026-07-10");
    expect(parse("email boss friday").dueDate).toBe("2026-07-10");
    expect(parse("email boss FRI").dueDate).toBe("2026-07-10");
    // same weekday as today → today
    expect(parse("email boss monday").dueDate).toBe("2026-07-06");
  });

  it("parses next <weekday> as the week after the upcoming one", () => {
    expect(parse("email boss next fri").dueDate).toBe("2026-07-17");
    expect(parse("email boss next fri").title).toBe("email boss");
    expect(parse("email boss next monday").dueDate).toBe("2026-07-13");
  });

  it("parses next week as next Monday", () => {
    const r = parse("plan sprint next week");
    expect(r.dueDate).toBe("2026-07-13");
    expect(r.title).toBe("plan sprint");
  });

  it("parses in N days / weeks", () => {
    expect(parse("follow up in 3 days").dueDate).toBe("2026-07-09");
    expect(parse("follow up in 1 day").dueDate).toBe("2026-07-07");
    expect(parse("follow up in 2 weeks").dueDate).toBe("2026-07-20");
  });

  it("parses month-day and day-month, rolling past dates to next year", () => {
    expect(parse("renew visa jul 20").dueDate).toBe("2026-07-20");
    expect(parse("renew visa 20 jul").dueDate).toBe("2026-07-20");
    expect(parse("renew visa July 20th").dueDate).toBe("2026-07-20");
    expect(parse("renew visa mar 1").dueDate).toBe("2027-03-01");
    expect(parse("renew visa jul 20").title).toBe("renew visa");
  });

  it("parses ISO dates and rejects invalid ones", () => {
    expect(parse("release 2026-08-01").dueDate).toBe("2026-08-01");
    expect(parse("release 2026-13-01").dueDate).toBeNull();
    expect(parse("release 2026-13-01").title).toBe("release 2026-13-01");
  });

  it("last date phrase wins; earlier ones stay in the title", () => {
    const r = parse("prep Monday agenda fri");
    expect(r.dueDate).toBe("2026-07-10");
    expect(r.title).toBe("prep Monday agenda");
  });
});

describe("times", () => {
  it("strips a time adjacent to a date phrase but stores date only", () => {
    const r = parse("pay rent tomorrow 5pm");
    expect(r.dueDate).toBe("2026-07-07");
    expect(r.title).toBe("pay rent");
    expect(parse("pay rent tomorrow at 5:30pm").title).toBe("pay rent");
    expect(parse("standup tomorrow 09:15").title).toBe("standup");
    expect(parse("5pm tomorrow pay rent").title).toBe("pay rent");
  });

  it("leaves a bare time without a date phrase in the title", () => {
    const r = parse("call mom 5pm");
    expect(r.dueDate).toBeNull();
    expect(r.title).toBe("call mom 5pm");
  });
});

describe("#project", () => {
  it("matches existing projects case-insensitively", () => {
    const r = parse("fix sink #home");
    expect(r.projectId).toBe(7);
    expect(r.title).toBe("fix sink");
    expect(parse("fix sink #HOME").projectId).toBe(7);
  });

  it("leaves unmatched project tokens in the title", () => {
    const r = parse("ship v2 #nonexistent !2");
    expect(r.projectId).toBeNull();
    expect(r.priority).toBe(2);
    expect(r.title).toBe("ship v2 #nonexistent");
  });

  it("last project wins and all matched tokens are stripped", () => {
    const r = parse("thing #home #work");
    expect(r.projectId).toBe(8);
    expect(r.title).toBe("thing");
  });
});

describe("@tag", () => {
  it("uses the canonical name of an existing tag", () => {
    expect(parse("buy stamps @Errand").tagNames).toEqual(["errand"]);
  });

  it("keeps new tag names as typed and dedupes case-insensitively", () => {
    const r = parse("plan trip @travel @Travel @errand");
    expect(r.tagNames).toEqual(["travel", "errand"]);
    expect(r.title).toBe("plan trip");
  });

  it("does not treat emails as tags", () => {
    const r = parse("email bob@example.com");
    expect(r.tagNames).toEqual([]);
    expect(r.title).toBe("email bob@example.com");
  });
});

describe("!priority", () => {
  it("accepts words and numbers on the internal scale", () => {
    expect(parse("a !high").priority).toBe(3);
    expect(parse("a !medium").priority).toBe(2);
    expect(parse("a !med").priority).toBe(2);
    expect(parse("a !low").priority).toBe(1);
    expect(parse("a !3").priority).toBe(3);
    expect(parse("a !1").priority).toBe(1);
    expect(parse("a !HIGH").priority).toBe(3);
  });

  it("last priority wins and all are stripped", () => {
    const r = parse("thing !1 !3");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("thing");
  });

  it("ignores ! mid-word", () => {
    const r = parse("wow!high energy");
    expect(r.priority).toBe(0);
    expect(r.title).toBe("wow!high energy");
  });
});

describe("combined", () => {
  it("parses the full kitchen-sink example", () => {
    const r = parse("pay rent tomorrow 5pm #home !high @errand");
    expect(r).toEqual({
      title: "pay rent",
      dueDate: "2026-07-07",
      projectId: 7,
      priority: 3,
      tagNames: ["errand"],
    });
  });

  it("a date word consumed by a tag token is not also a due date", () => {
    const r = parse("water plants @tomorrow");
    expect(r.dueDate).toBeNull();
    expect(r.tagNames).toEqual(["tomorrow"]);
    expect(r.title).toBe("water plants");
  });

  it("returns an empty title when input is only tokens", () => {
    const r = parse("tomorrow !high");
    expect(r.title).toBe("");
    expect(r.dueDate).toBe("2026-07-07");
  });
});
