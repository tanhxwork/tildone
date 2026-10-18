import { beforeEach, describe, expect, it, mock } from "bun:test";

// Client mode sends the board's queries, pasted images and attachment reads to the
// hub through Rust commands. The Tauri boundary is mocked; what is checked is which
// command each call reaches and what comes back.

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let fileReads = 0;

// bun's mock.module is process-wide; keep the real exports for plugin-fs and friends.
const realCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === "hub_sql") {
      return args.kind === "select" ? [{ id: 7 }] : { rowsAffected: 1, lastInsertId: 42 };
    }
    if (cmd === "hub_image_put") return "/hub/data/attachments/9/shot.png";
    if (cmd === "hub_file") {
      fileReads += 1;
      return new ArrayBuffer(4);
    }
    return "/app-data";
  },
}));

const { setBoardHubUrl, isClientMode } = await import("../src/hubMode");
const { remoteDb } = await import("../src/remoteDb");
const { saveImageFile, imageSrc } = await import("../src/utils/images");

beforeEach(() => {
  calls.length = 0;
  fileReads = 0;
  setBoardHubUrl("http://127.0.0.1:11502");
});

describe("client mode", () => {
  it("is on only while a hub URL is set", () => {
    expect(isClientMode()).toBe(true);
    setBoardHubUrl("  ");
    expect(isClientMode()).toBe(false);
  });

  it("sends select and execute to the hub with the params as written", async () => {
    const rows = await remoteDb.select<{ id: number }[]>("SELECT id FROM tasks WHERE id = $1", [7]);
    const res = await remoteDb.execute("UPDATE tasks SET title = $2 WHERE id = $1", [7, "x"]);
    expect(rows).toEqual([{ id: 7 }]);
    expect(res).toEqual({ rowsAffected: 1, lastInsertId: 42 });
    expect(calls.map((c) => c.args)).toEqual([
      { kind: "select", sql: "SELECT id FROM tasks WHERE id = $1", params: [7] },
      { kind: "execute", sql: "UPDATE tasks SET title = $2 WHERE id = $1", params: [7, "x"] },
    ]);
  });

  it("stores a pasted image on the hub and records the hub's path", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const saved = await saveImageFile(9, {
      key: "k",
      blob,
      name: "shot.png",
      width: 10,
      height: 20,
      url: "blob:x",
    });
    expect(saved).toEqual({
      path: "/hub/data/attachments/9/shot.png",
      filename: "shot.png",
      bytes: 3,
      width: 10,
      height: 20,
    });
    const put = calls.find((c) => c.cmd === "hub_image_put");
    expect(put?.args.taskId).toBe(9);
    expect(put?.args.bytes).toEqual([1, 2, 3]);
    // Nothing was written to this machine's attachments folder.
    expect(calls.some((c) => c.cmd.startsWith("plugin:fs"))).toBe(false);
  });

  it("fetches an attachment from the hub once and serves the blob URL after", async () => {
    const image = { id: 1, task_id: 9, path: "/hub/data/attachments/9/a.png" } as never;
    expect(imageSrc(image)).toBeNull(); // the fetch starts; the first paint has no URL yet
    await new Promise((r) => setTimeout(r, 0));
    const url = imageSrc(image);
    expect(url).toStartWith("blob:");
    expect(imageSrc(image)).toBe(url);
    expect(fileReads).toBe(1);
  });
});
