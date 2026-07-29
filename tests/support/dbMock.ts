import { mock, type Mock } from "bun:test";
import type {
  ActivityEntry,
  Comment,
  Project,
  Subtask,
  Tag,
  Task,
  TaskImage,
  TaskLink,
} from "../../src/types";

// The ONE db mock for every store test. Import `db` and `useStore` from here;
// never call mock.module("../src/db") in a test file again.
//
// Why it has to be shared (TIL-194): src/store.ts binds its db namespace once,
// at first evaluation (`import * as db from "./db"`), and bun's mock.module
// registry is process-global. So the *first* test file to import the store
// freezes the db surface for the whole run — every later file's own
// mock.module call re-registers the module but never reaches the store, which
// is still holding the first file's object. Seven files each registering a
// partial surface therefore passed in isolation and failed together with
// "db.insertTask is not a function" for whatever the winning file omitted.
// One registration covering every export removes the ordering dependency
// entirely; dbSurface.test.ts fails the build if an export is added to
// src/db.ts and not mirrored here.

export const NOW = "2026-01-01T00:00:00.000Z";

export type Board = {
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  subtasks: Subtask[];
  presence: Record<number, { name: string | null; at: string }>;
  links: Record<number, TaskLink[]>;
  images: Record<number, TaskImage[]>;
  commentCounts: Record<number, number>;
};

/** A board with nothing on it — the default `fetchAll` result. */
export function emptyBoard(): Board {
  return {
    projects: [],
    tasks: [],
    tags: [],
    subtasks: [],
    presence: {},
    links: {},
    images: {},
    commentCounts: {},
  };
}

let seq = 0;
/** Monotonic ids for the inserts, reset by resetDbMock(). */
export function nextId(): number {
  seq += 1;
  return seq;
}

// Defaults are deliberately inert: they satisfy the store's await and return a
// well-shaped value, so a test only has to override the one call it is about.
const DEFAULTS = {
  trace: (_msg: string): void => {},
  openDb: async (): Promise<void> => {},

  fetchAll: async (): Promise<Board> => emptyBoard(),

  insertImage: async (
    taskId: number,
    file: { path: string; filename: string; bytes: number; width: number; height: number },
  ): Promise<TaskImage> => ({ id: nextId(), task_id: taskId, ...file, created_at: NOW }),
  deleteImage: async (_id: number): Promise<void> => {},

  insertComment: async (taskId: number, body: string): Promise<Comment> => ({
    id: nextId(),
    task_id: taskId,
    body,
    created_at: NOW,
    actor_kind: null,
    actor_name: null,
  }),
  fetchComments: async (_taskId: number): Promise<Comment[]> => [],

  addLink: async (
    taskId: number,
    url: string,
    label: string,
    kind: string,
  ): Promise<TaskLink> => ({ id: nextId(), task_id: taskId, url, label, kind }),
  deleteLink: async (_id: number): Promise<void> => {},

  insertSubtask: async (_taskId: number, _title: string, _position: number): Promise<number> =>
    nextId(),
  updateSubtask: async (
    _id: number,
    _patch: { title?: string; done?: boolean; position?: number },
  ): Promise<void> => {},
  deleteSubtask: async (_id: number): Promise<void> => {},

  insertActivity: async (_taskId: number, _label: string): Promise<void> => {},
  fetchActivity: async (_taskId: number): Promise<ActivityEntry[]> => [],
  fetchLastTagChange: async (_taskId: number): Promise<string | null> => null,
  fetchAgentPresence: async (): Promise<
    Record<number, { name: string | null; at: string }>
  > => ({}),

  insertProject: async (_name: string, _color: string): Promise<{ id: number; code: string }> => {
    const id = nextId();
    return { id, code: `P${id}` };
  },
  updateProject: async (..._a: unknown[]): Promise<void> => {},
  updateProjectPositions: async (..._a: unknown[]): Promise<void> => {},
  deleteProject: async (_id: number): Promise<void> => {},

  insertTask: async (_task: unknown): Promise<{ id: number; number: number; ref: string }> => {
    const id = nextId();
    return { id, number: id, ref: `T-${id}` };
  },
  backfillRefs: async (): Promise<void> => {},
  updateTask: async (_id: number, _patch: Partial<Task>): Promise<void> => {},
  deleteTask: async (_id: number): Promise<void> => {},
  deleteAllTrashed: async (): Promise<void> => {},
  purgeTrashedBefore: async (_cutoff: string): Promise<void> => {},
  allTaskIds: async (): Promise<Set<number>> => new Set<number>(),

  insertTag: async (_name: string, _color: string): Promise<number> => nextId(),
  updateTag: async (_id: number, _name: string, _color: string): Promise<void> => {},
  deleteTag: async (_id: number): Promise<void> => {},
  mergeTags: async (_fromId: number, _toId: number): Promise<void> => {},
  setTaskTags: async (_taskId: number, _tagIds: number[]): Promise<void> => {},
};

export type DbSurface = typeof DEFAULTS;

function spies<T extends Record<string, (...a: never[]) => unknown>>(defaults: T) {
  const out = {} as { [K in keyof T]: Mock<T[K]> };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    out[key] = mock(defaults[key]) as Mock<T[keyof T]> as Mock<T[typeof key]>;
  }
  return out;
}

/** The mocked db module — every export of src/db.ts, as a spy. */
export const db = spies(DEFAULTS);

mock.module("../../src/db", () => db);

/** Clear every call record and restore the inert default implementations. */
export function resetDbMock(): void {
  seq = 0;
  for (const key of Object.keys(DEFAULTS) as (keyof DbSurface)[]) {
    db[key].mockReset();
    (db[key] as Mock<(...a: never[]) => unknown>).mockImplementation(
      DEFAULTS[key] as (...a: never[]) => unknown,
    );
  }
}

// Imported after the mock is registered, so the store binds the mocked module.
// Every store test must take what it needs from here — a static
// `import … from "../src/store"` in a test file is only safe while this
// module happens to be imported above it, which is not a property worth
// depending on. Re-export instead.
export const { useStore, groupSlot } = await import("../../src/store");
