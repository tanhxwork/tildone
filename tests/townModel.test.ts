import { describe, expect, it } from "bun:test";
import { townModel, type TownModel } from "../src/selectors";
import type { Project, Task } from "../src/types";
import type { FallbackPresence, LivePresence } from "../src/utils/presence";

// The town maps the board's existing presence state onto rooms and characters.
// A character is exactly a task whose cardPresence is non-null — so these cases
// mirror the presence rules (a live entry always shows; a recent fallback shows
// as quiet; a stale one shows nothing), plus the town's own layout rules (every
// project a room, Inbox last, orphans fall to Inbox).

let seq = 0;

function project(name: string, opts: Partial<Project> = {}): Project {
  seq += 1;
  return {
    id: seq,
    name,
    color: "#888888",
    position: seq,
    folder_path: null,
    code: null,
    ...opts,
  };
}

function task(opts: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: seq,
    project_id: null,
    title: `task ${seq}`,
    notes: "",
    status: "doing",
    priority: 0,
    due_date: null,
    position: -seq,
    created_at: "2026-07-01T00:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    archived_at: null,
    number: null,
    ref: null,
    unseen_at: null,
    tag_ids: [],
    ...opts,
  };
}

function livePresence(opts: Partial<LivePresence> & { task_id: number }): LivePresence {
  return {
    session_id: `sess-${opts.task_id}`,
    agent_name: "claude-code",
    state: "working",
    at: "2026-07-28T10:00:00.000Z",
    branch: null,
    cwd: null,
    last_log: null,
    reachable: false,
    attachable: false,
    ...opts,
  };
}

/** Index a flat list of live entries the way the store's `live` map is keyed. */
function liveMap(entries: LivePresence[]): Record<number, LivePresence> {
  const out: Record<number, LivePresence> = {};
  for (const e of entries) out[e.task_id] = e;
  return out;
}

function room(model: TownModel, projectId: number | null) {
  const r = model.rooms.find((x) => x.projectId === projectId);
  if (!r) throw new Error(`no room for project ${projectId}`);
  return r;
}

describe("townModel", () => {
  it("gives every project a room plus a trailing Inbox, even with no characters", () => {
    const a = project("alpha");
    const b = project("beta");
    const model = townModel([a, b], [], {}, {});
    expect(model.rooms.map((r) => r.projectId)).toEqual([a.id, b.id, null]);
    expect(model.rooms.every((r) => r.characters.length === 0)).toBe(true);
    // Inbox is always last.
    expect(model.rooms.at(-1)!.name).toBe("Inbox");
  });

  it("orders rooms by project position then id, Inbox last", () => {
    const late = project("late", { position: 5 });
    const early = project("early", { position: 1 });
    const model = townModel([late, early], [], {}, {});
    expect(model.rooms.map((r) => r.name)).toEqual(["early", "late", "Inbox"]);
  });

  it("places a live session as a character in its project's room, passing state/log/session through", () => {
    const p = project("alpha");
    const t = task({ project_id: p.id });
    const live = liveMap([
      livePresence({ task_id: t.id, state: "working", last_log: "tests written (RED)", agent_name: "claude-code" }),
    ]);
    const model = townModel([p], [t], live, {});
    const chars = room(model, p.id).characters;
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({
      taskId: t.id,
      sessionId: `sess-${t.id}`,
      agentName: "claude-code",
      state: "working",
      lastLog: "tests written (RED)",
      live: true,
    });
    // No stray character leaked into Inbox.
    expect(room(model, null).characters).toHaveLength(0);
  });

  it("puts a project-less task's character in the Inbox room", () => {
    const t = task({ project_id: null });
    const model = townModel([], [t], liveMap([livePresence({ task_id: t.id })]), {});
    expect(room(model, null).characters.map((c) => c.taskId)).toEqual([t.id]);
  });

  it("routes an orphan project_id (no such project) to Inbox rather than dropping it", () => {
    const t = task({ project_id: 9999 });
    const model = townModel([project("alpha")], [t], liveMap([livePresence({ task_id: t.id })]), {});
    expect(room(model, null).characters.map((c) => c.taskId)).toEqual([t.id]);
  });

  it("shows a recent fallback write as a quiet, non-live character with no session id", () => {
    const p = project("alpha");
    const t = task({ project_id: p.id });
    const fallback: Record<number, FallbackPresence> = {
      [t.id]: { name: "codex", at: new Date().toISOString() },
    };
    const model = townModel([p], [t], {}, fallback);
    const chars = room(model, p.id).characters;
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({
      state: "quiet",
      live: false,
      sessionId: null,
      agentName: "codex",
    });
  });

  it("shows nothing for a stale fallback write (past the presence window)", () => {
    const p = project("alpha");
    const t = task({ project_id: p.id });
    const fallback: Record<number, FallbackPresence> = {
      [t.id]: { name: "codex", at: "2020-01-01T00:00:00.000Z" },
    };
    const model = townModel([p], [t], {}, fallback);
    expect(room(model, p.id).characters).toHaveLength(0);
  });

  it("excludes a deleted task even when presence lingers", () => {
    const p = project("alpha");
    const t = task({ project_id: p.id, deleted_at: "2026-07-28T09:00:00.000Z" });
    const model = townModel([p], [t], liveMap([livePresence({ task_id: t.id })]), {});
    expect(room(model, p.id).characters).toHaveLength(0);
  });

  it("holds several sessions in one room, newest activity first", () => {
    const p = project("alpha");
    const older = task({ project_id: p.id });
    const newer = task({ project_id: p.id });
    const live = liveMap([
      livePresence({ task_id: older.id, at: "2026-07-28T10:00:00.000Z" }),
      livePresence({ task_id: newer.id, at: "2026-07-28T11:00:00.000Z" }),
    ]);
    const model = townModel([p], [older, newer], live, {});
    expect(room(model, p.id).characters.map((c) => c.taskId)).toEqual([newer.id, older.id]);
  });
});
