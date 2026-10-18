import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import * as real from "./db";
import { hubConnect } from "./hubClient";
import { isClientMode } from "./hubMode";
import { useHubStatus } from "./hubStatus";
import { remoteDb } from "./remoteDb";

/**
 * Client mode while the hub is unreachable. The board keeps showing its last synced
 * copy, task-level writes are queued as operations (a db.ts function name and its
 * arguments, never SQL), and they replay on the hub, in order, when it is back. The
 * hub runs each one itself, so a new task gets its real number and ref there.
 *
 * `db` below is src/db.ts with every function gated: local mode calls straight
 * through, client mode calls the hub and falls back to the queue (or to an empty
 * read, or to a refusal) when the hub cannot be reached.
 */

export const NOT_AVAILABLE = "Not available offline";

export const useOffline = create<{
  offline: boolean;
  /** ISO time of the last board the hub gave us (or the copy on disk). */
  lastSynced: string | null;
  waiting: number;
  /** Queued changes the hub rejected on the last replay; the banner says so once. */
  dropped: number;
}>(() => ({ offline: false, lastSynced: null, waiting: 0, dropped: 0 }));

/** What the store tells this module; registered by store.ts (which imports this file). */
interface Host {
  projectCode(projectId: number | null): string;
  taskNotes(taskId: number): string | undefined;
  reload(): Promise<void>;
}
let host: Host;
export const registerOfflineHost = (h: Host) => {
  host = h;
};

/** True for the messages hubclient.rs sends when the hub cannot be reached
 *  ("hub <url>: unreachable: …" covers a timeout too, "connection lost: …" the
 *  event stream). A token, schema or SQL error is the hub answering, not offline. */
export const isUnreachable = (err: unknown) =>
  /: unreachable: |connection lost|closed the event stream/.test(String((err as Error)?.message ?? err));

// ---------------------------------------------------------------------------
// Files (offlinestore.rs)

let writes = Promise.resolve();
/** Writes go one at a time, in call order; a failure is logged, never thrown. */
function persist(name: "outbox" | "board-copy", value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  writes = writes
    .then(() => invoke<void>("offline_write", { name, json }))
    .catch((err) => console.error(`tildone: cannot save ${name}:`, err));
  return writes;
}

/** Resolves when every write so far has reached the disk. */
export const filesSettled = () => writes;

async function readFile<T>(name: "outbox" | "board-copy"): Promise<T | null> {
  try {
    const json = await invoke<string | null>("offline_read", { name });
    return json ? (JSON.parse(json) as T) : null;
  } catch {
    return null;
  }
}

type Board = Awaited<ReturnType<typeof real.fetchAll>>;

/** The last board the hub gave us, or null when this machine never synced one. */
export const loadBoardCopy = () => readFile<{ syncedAt: string; data: Board }>("board-copy");

function saveBoardCopy(data: Board) {
  const syncedAt = new Date().toISOString();
  useOffline.setState({ lastSynced: syncedAt });
  void persist("board-copy", { syncedAt, data });
}

// ---------------------------------------------------------------------------
// The outbox

interface Op {
  fn: string;
  args: unknown[];
  /** The temporary id this op's result stands in for. */
  temp?: number;
  /** updateTask with notes: the task's notes before the edit, to spot a conflict on replay. */
  baseNotes?: string;
}

/** `ids`: the argument positions that can hold a task, subtask or link id (a
 *  temporary one when it was made offline). Temporary ids are negative and come from
 *  one counter, so a map from temporary to real id needs no table. An insertTask's
 *  from_task_id is the one id inside an object (see remap). */
interface Spec {
  ids: number[];
  /** What the call returns offline, in the shape the store reads. */
  stub?: (args: any[], temp: number) => unknown;
  /** The new row's id in the hub's result, for ops that later ops can name. */
  made?: (result: any) => number;
}

const QUEUED: Record<string, Spec> = {
  insertTask: {
    ids: [],
    made: (r) => r.id,
    stub: ([t], temp) => ({
      id: temp,
      number: null,
      ref: `${host.projectCode(t.project_id)}-?`,
      goal_id: t.goal_id ?? null,
    }),
  },
  // effectiveTaskPatch needs the DB; the hub applies it on replay.
  updateTask: { ids: [0], stub: ([, patch]) => patch },
  deleteTask: { ids: [0] },
  insertSubtask: { ids: [0], made: (r) => r, stub: (_, temp) => temp },
  updateSubtask: { ids: [0] },
  deleteSubtask: { ids: [0] },
  insertComment: {
    ids: [0],
    stub: ([task_id, body], temp) => ({
      id: temp,
      task_id,
      body,
      actor_kind: "user",
      actor_name: null,
      created_at: new Date().toISOString(),
    }),
  },
  addLink: {
    ids: [0],
    made: (r) => r.id,
    stub: ([task_id, url, label, kind], temp) => ({ id: temp, task_id, url, label, kind }),
  },
  deleteLink: { ids: [0] },
  setTaskTags: { ids: [0] },
  insertActivity: { ids: [0] },
};

/** Every other write. Offline they throw NOT_AVAILABLE. */
const REFUSED = [
  "insertImage", "deleteImage", "createObservation", "decideObservation", "watchObservation",
  "insertProject", "updateProject", "updateProjectPositions", "deleteProject",
  "insertGoal", "updateGoal", "updateGoalPositions", "deleteGoal",
  "deleteAllTrashed", "purgeTrashedBefore",
  "insertTag", "updateTag", "deleteTag", "mergeTags",
] as const;

/** Reads that have no copy to fall back to: offline they answer empty. */
const EMPTY = {
  fetchComments: [],
  fetchActivity: [],
  fetchLastTagChange: null,
  fetchClaimCwd: null,
  fetchAgentPresence: {},
} as const;

interface Outbox {
  nextTemp: number;
  ops: Op[];
  /** Temporary id → real id, for the ops that already ran on a replay that was cut short. */
  ids: Record<number, number>;
}
let outbox: Outbox = { nextTemp: -1, ops: [], ids: {} };

// The count is changes the user made; the activity lines that ride along are not.
const countWaiting = () => outbox.ops.filter((op) => op.fn !== "insertActivity").length;

function saveOutbox() {
  useOffline.setState({ waiting: countWaiting() });
  return persist("outbox", outbox);
}

/** Read the outbox a previous run left; called once at init, before the first write. */
export async function loadOutbox() {
  outbox = (await readFile<Outbox>("outbox")) ?? { nextTemp: -1, ops: [], ids: {} };
  useOffline.setState({ waiting: countWaiting() });
}

/** The queue is in use (hub down, or a replay is running): later writes join it so order holds. */
const holding = () => useOffline.getState().offline || outbox.ops.length > 0;

function queue(fn: string, args: unknown[]) {
  const spec = QUEUED[fn];
  const temp = spec.stub ? outbox.nextTemp-- : 0;
  const op: Op = { fn, args };
  if (spec.made) op.temp = temp;
  if (fn === "updateTask" && "notes" in (args[1] as object)) {
    op.baseNotes = host.taskNotes(args[0] as number);
  }
  outbox.ops.push(op);
  void saveOutbox();
  return spec.stub?.(args, temp);
}

// ---------------------------------------------------------------------------
// Offline state and the way back

const PROBE_MS = [2_000, 5_000, 10_000, 30_000];
let probing = false;

/** The hub cannot be reached: queue from now on, and keep knocking until it answers. */
export function goOffline() {
  if (!isClientMode()) return;
  if (!useOffline.getState().offline) useOffline.setState({ offline: true });
  void probe();
}

/** Retry hubConnect (it also restarts the change follower) until it succeeds. */
async function probe() {
  if (probing) return;
  probing = true;
  try {
    for (let i = 0; useOffline.getState().offline; i++) {
      await new Promise((r) => setTimeout(r, PROBE_MS[Math.min(i, PROBE_MS.length - 1)]));
      try {
        await hubConnect();
        break;
      } catch {
        // still down
      }
    }
  } finally {
    probing = false;
  }
  if (useOffline.getState().offline) await comeBack();
}

let replaying = false;

/** The hub answers again: send the queue, then show the hub's board. */
export async function comeBack() {
  if (replaying || (!useOffline.getState().offline && outbox.ops.length === 0)) return;
  replaying = true;
  try {
    await replay();
  } finally {
    replaying = false;
  }
  if (outbox.ops.length > 0) return; // cut short by goOffline, which keeps knocking
  outbox.ids = {};
  void saveOutbox();
  useOffline.setState({ offline: false });
  // A hubConnect from the probe replaces the follower before it can say "connected".
  useHubStatus.setState({ status: { state: "connected", message: "" } });
  await host.reload();
}

/** A temporary id → the real one. An op that names a task whose creation was dropped is dropped too. */
function remap(id: unknown): unknown {
  if (typeof id !== "number" || id >= 0) return id;
  const made = outbox.ids[id];
  if (made === undefined) throw new Error(`depends on a change that was dropped (${id})`);
  return made;
}

async function replay() {
  let dropped = 0;
  try {
    while (outbox.ops.length > 0) {
      const op = outbox.ops[0];
      try {
        const args = op.args.map((a, i) => (QUEUED[op.fn].ids.includes(i) ? remap(a) : a));
        if (op.fn === "insertTask") {
          const task = args[0] as { from_task_id?: number | null };
          args[0] = { ...task, from_task_id: remap(task.from_task_id) };
        }
        const result = await run(op, args);
        if (op.temp !== undefined) outbox.ids[op.temp] = QUEUED[op.fn].made!(result);
      } catch (err) {
        if (isUnreachable(err)) return goOffline();
        console.warn(`tildone: dropped queued ${op.fn}:`, err);
        dropped++;
      }
      outbox.ops.shift();
      await saveOutbox();
    }
  } finally {
    if (dropped > 0) useOffline.setState((s) => ({ dropped: s.dropped + dropped }));
  }
}

/** Run one op on the hub. Notes written offline only go in if the hub's notes are still
 *  the ones the edit started from; otherwise the hub's stay and the offline text becomes
 *  a comment, so nothing is lost. */
async function run(op: Op, args: unknown[]) {
  if (op.baseNotes !== undefined) {
    const id = args[0] as number;
    const { notes, ...rest } = args[1] as { notes: string };
    const rows = await remoteDb.select<{ notes: string }[]>(
      "SELECT notes FROM tasks WHERE id = $1",
      [id],
    );
    if (rows[0] && rows[0].notes !== op.baseNotes) {
      await real.insertComment(
        id,
        `Notes edited offline. The notes changed on the hub in the meantime, so the hub's version stays. The offline version:\n\n${notes}`,
      );
      // If the update below is cut short, a retry must not add the comment again.
      args = [id, rest];
      op.args = args;
    }
    delete op.baseNotes;
  }
  return (real as any)[op.fn](...args);
}

/** Follow the hub's connection state for the life of the page (client mode). */
let watching = false;
export function watchOffline() {
  if (watching) return;
  watching = true;
  useHubStatus.subscribe(({ status }) => {
    if (!status) return;
    if (status.state === "connected") void comeBack();
    else if (status.state === "error" && isUnreachable(status.message)) goOffline();
  });
}

/** Launched with the hub down: show this copy, say how old it is, and keep knocking. */
export function startOffline(syncedAt: string) {
  useOffline.setState({ offline: true, lastSynced: syncedAt });
  void probe();
}

// ---------------------------------------------------------------------------
// The gated db

const gated: Record<string, (...args: any[]) => Promise<unknown>> = {};

for (const fn of Object.keys(QUEUED)) {
  gated[fn] = async (...args) => {
    const call = () => (real as any)[fn](...args);
    if (!isClientMode()) return call();
    if (!holding()) {
      try {
        return await call();
      } catch (err) {
        if (!isUnreachable(err)) throw err;
        goOffline();
      }
    }
    return queue(fn, args);
  };
}

for (const fn of REFUSED) {
  gated[fn] = async (...args) => {
    const call = () => (real as any)[fn](...args);
    if (!isClientMode()) return call();
    if (!useOffline.getState().offline) {
      try {
        return await call();
      } catch (err) {
        if (!isUnreachable(err)) throw err;
        goOffline();
      }
    }
    throw new Error(NOT_AVAILABLE);
  };
}

for (const [fn, empty] of Object.entries(EMPTY)) {
  gated[fn] = async (...args) => {
    const call = () => (real as any)[fn](...args);
    if (!isClientMode()) return call();
    if (useOffline.getState().offline) return empty;
    try {
      return await call();
    } catch (err) {
      if (!isUnreachable(err)) throw err;
      goOffline();
      return empty;
    }
  };
}

// Every board the hub gives us becomes the copy a later offline launch opens.
gated.fetchAll = async () => {
  if (!isClientMode()) return real.fetchAll();
  try {
    const data = await real.fetchAll();
    saveBoardCopy(data);
    return data;
  } catch (err) {
    if (isUnreachable(err)) goOffline();
    throw err;
  }
};

/** src/db.ts, gated for offline use. store.ts takes its db from here. */
export const db = { ...real, ...gated } as typeof real;

/** The board on screen is the user's own until the queue is empty: a reload would drop their changes. */
export const holdsBoard = () => isClientMode() && holding();
