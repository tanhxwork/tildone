import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import * as real from "./db";
import { hubConnect } from "./hubClient";
import { getBoardHubUrl, isClientMode } from "./hubMode";
import { useHubStatus } from "./hubStatus";
import { remoteDb, withOpKey } from "./remoteDb";

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

/** What the banner and a refused write say about changes queued for another hub. */
export const foreignLine = ({ hub, count }: { hub: string; count: number }) =>
  `${count} ${count === 1 ? "change" : "changes"} queued for ${hub} ${count === 1 ? "waits" : "wait"} for that hub.`;

export const useOffline = create<{
  offline: boolean;
  /** ISO time of the last board the hub gave us (or the copy on disk). */
  lastSynced: string | null;
  waiting: number;
  /** Queued changes the hub rejected on the last replay; the banner says so once. */
  dropped: number;
  /** Changes a previous run queued for another hub. They stay on disk, unsent, until this window uses that hub again. */
  foreign: { hub: string; count: number } | null;
  /** A refused write's reason, shown under the banner for a few seconds. */
  notice: string;
}>(() => ({ offline: false, lastSynced: null, waiting: 0, dropped: 0, foreign: null, notice: "" }));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** Say why a write did not happen. The banner area shows it for a few seconds. */
export function notify(message: string) {
  clearTimeout(noticeTimer);
  useOffline.setState({ notice: message });
  noticeTimer = setTimeout(() => useOffline.setState({ notice: "" }), 6_000);
}

/** What the store tells this module; registered by store.ts (which imports this file). */
interface Host {
  projectCode(projectId: number | null): string;
  task(taskId: number): { project_id: number | null; goal_id: number | null; notes: string } | undefined;
  goalProject(goalId: number): number | undefined;
  /** The board on screen, in the shape fetchAll returns it. */
  board(): Board;
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

/** The last board this window's hub gave us, or null when this machine never synced one
 *  from it (a copy from another hub is not this board). */
export async function loadBoardCopy() {
  const copy = await readFile<{ hub?: string; syncedAt: string; data: Board }>("board-copy");
  return copy && copy.hub === getBoardHubUrl() ? copy : null;
}

const writeCopy = (syncedAt: string, data: Board) =>
  void persist("board-copy", { hub: getBoardHubUrl(), syncedAt, data });

/** A board the hub just gave us is the copy, written at once: a quit right after must
 *  not leave a copy that still holds temporary ids with nothing queued to replay them. */
function saveFetchedCopy(data: Board) {
  clearTimeout(copyTimer);
  copyTimer = undefined;
  const syncedAt = new Date().toISOString();
  useOffline.setState({ lastSynced: syncedAt });
  writeCopy(syncedAt, data);
}

let copyTimer: ReturnType<typeof setTimeout> | undefined;
/** After a queued write the copy is the board on screen (so a restart shows what waits),
 *  with its old sync time. Written a second later, so typing does not write it per key. */
function saveCopySoon() {
  clearTimeout(copyTimer);
  copyTimer = setTimeout(flushCopy, 1_000);
}

/** Write the copy now if one waits. Also runs when the page hides or reloads. */
export function flushCopy() {
  if (copyTimer === undefined) return;
  clearTimeout(copyTimer);
  copyTimer = undefined;
  const { lastSynced } = useOffline.getState();
  if (lastSynced) writeCopy(lastSynced, host.board());
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
  /** Names this op's writes to the hub, so a replay that runs again does not repeat one the hub already ran. */
  key: string;
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

/** db.ts effectiveTaskPatch, read off the board on screen: a goal must belong to the
 *  task's project, so a move to another project clears it. */
function effectivePatch(id: number, patch: Record<string, unknown>) {
  if (!("project_id" in patch) && !("goal_id" in patch)) return patch;
  const current = host.task(id);
  if (!current) return patch;
  const dest = "project_id" in patch ? ((patch.project_id as number | null) ?? null) : current.project_id;
  if (patch.goal_id != null) {
    return dest !== null && host.goalProject(patch.goal_id as number) === dest
      ? patch
      : { ...patch, goal_id: null };
  }
  return dest !== current.project_id && current.goal_id !== null ? { ...patch, goal_id: null } : patch;
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
  // The hub applies the patch itself on replay; the stub is what it will write.
  updateTask: { ids: [0], stub: ([id, patch]) => effectivePatch(id, patch) },
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
  /** The hub these ops are for; another hub's ops are never replayed here. */
  hub?: string;
  nextTemp: number;
  ops: Op[];
  /** Temporary id → real id, for the ops that already ran on a replay that was cut short. */
  ids: Record<number, number>;
}
let outbox: Outbox = { nextTemp: -1, ops: [], ids: {} };

// The count is changes the user made; the activity lines that ride along are not.
const changes = (ops: Op[]) => ops.filter((op) => op.fn !== "insertActivity").length;
const countWaiting = () => changes(outbox.ops);

function saveOutbox() {
  useOffline.setState({ waiting: countWaiting() });
  // Another hub's queue is on disk and stays there untouched.
  if (useOffline.getState().foreign) return writes;
  return persist("outbox", { ...outbox, hub: getBoardHubUrl() });
}

/**
 * Read the outbox a previous run left; called once at init, before the first write.
 * One kept for another hub is not ours: it is not loaded, not replayed and not
 * overwritten (queueing is refused instead), and the banner says it waits.
 */
export async function loadOutbox() {
  const saved = await readFile<Outbox>("outbox");
  const ours = saved?.hub === getBoardHubUrl();
  const foreign =
    saved && !ours && saved.ops.length > 0
      ? { hub: saved.hub ?? "another hub", count: changes(saved.ops) }
      : null;
  outbox = ours ? saved! : { nextTemp: -1, ops: [], ids: {} };
  for (const op of outbox.ops) op.key ??= crypto.randomUUID(); // queued before keys existed
  useOffline.setState({ waiting: countWaiting(), foreign });
}

/** Forget the temporary ids once the board on screen has the real ones (store.reload calls this). */
export function settleTempIds() {
  if (outbox.ops.length > 0 || Object.keys(outbox.ids).length === 0) return;
  outbox.ids = {};
  void saveOutbox();
}

/** The queue is in use (hub down, or a replay is running): later writes join it so order holds. */
const holding = () => useOffline.getState().offline || outbox.ops.length > 0;

function queue(fn: string, args: unknown[]) {
  const spec = QUEUED[fn];
  const temp = spec.stub ? outbox.nextTemp-- : 0;
  const op: Op = { fn, args, key: crypto.randomUUID() };
  if (spec.made) op.temp = temp;
  if (fn === "updateTask" && "notes" in (args[1] as object)) {
    op.baseNotes = host.task(args[0] as number)?.notes;
  }
  const result = spec.stub?.(args, temp); // the stub reads the board as it was before this write
  outbox.ops.push(op);
  void saveOutbox();
  saveCopySoon(); // a restart must show what is waiting, not only what the hub had
  return result;
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
  useOffline.setState({ offline: false });
  // A hubConnect from the probe replaces the follower before it can say "connected".
  useHubStatus.setState({ status: { state: "connected", message: "" } });
  // The temporary ids stay mapped until the reload has put the real ones on screen
  // (store.reload calls settleTempIds): a write on a temporary id in between still lands.
  await host.reload().catch((err) => console.warn("tildone: reload after replay failed:", err));
}

/** A temporary id → the real one. An op that names a task whose creation was dropped is dropped too. */
function remap(id: unknown): unknown {
  if (typeof id !== "number" || id >= 0) return id;
  const made = outbox.ids[id];
  if (made === undefined) throw new Error(`depends on a change that was dropped (${id})`);
  return made;
}

/** The call's arguments with temporary ids swapped for the real ones, by the positions the spec names. */
function remapArgs(fn: string, args: unknown[]): unknown[] {
  const out = args.map((a, i) => (QUEUED[fn].ids.includes(i) ? remap(a) : a));
  if (fn === "insertTask") {
    const task = out[0] as { from_task_id?: number | null };
    out[0] = { ...task, from_task_id: remap(task.from_task_id) };
  }
  return out;
}

async function replay() {
  let dropped = 0;
  try {
    while (outbox.ops.length > 0) {
      const op = outbox.ops[0];
      try {
        const result = await run(op, remapArgs(op.fn, op.args));
        if (op.temp !== undefined) outbox.ids[op.temp] = QUEUED[op.fn].made!(result);
      } catch (err) {
        if (isUnreachable(err)) return goOffline();
        console.warn(`tildone: dropped queued ${op.fn}:`, err);
        if (op.fn !== "insertActivity") dropped++; // counted like the waiting ones
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
      await withOpKey(op.key, () =>
        real.insertComment(
          id,
          `Notes edited offline. The notes changed on the hub in the meantime, so the hub's version stays. The offline version:\n\n${notes}`,
        ),
      );
      // If the update below is cut short (or the app quits), a retry must not add the comment again.
      // The update gets a new key: its writes are numbered from 0 again and must not match the comment's.
      args = [id, rest];
      op.args = args;
      op.key = crypto.randomUUID();
      delete op.baseNotes;
      await saveOutbox();
    }
    delete op.baseNotes;
  }
  return withOpKey(op.key, () => (real as any)[op.fn](...args));
}

/** Follow the hub's connection state for the life of the page (client mode). */
let watching = false;
export function watchOffline() {
  if (watching) return;
  watching = true;
  window.addEventListener("pagehide", flushCopy);
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
    if (!isClientMode()) return (real as any)[fn](...args);
    if (!holding()) {
      try {
        // Not queued, but a task made offline may still be on screen under its temporary id.
        return await (real as any)[fn](...remapArgs(fn, args));
      } catch (err) {
        if (!isUnreachable(err)) throw err;
        goOffline();
      }
    }
    const { foreign } = useOffline.getState();
    if (foreign) {
      // The one outbox file is another hub's; writing to it would erase those changes.
      const message = `${foreignLine(foreign)} ${NOT_AVAILABLE}.`;
      notify(message);
      throw new Error(message);
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
    notify(NOT_AVAILABLE);
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
    saveFetchedCopy(data);
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
