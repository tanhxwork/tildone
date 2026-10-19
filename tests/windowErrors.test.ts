import { beforeEach, describe, expect, it, mock } from "bun:test";

// Uncaught window errors and unhandled rejections go to the Rust command that feeds
// the client report. The Tauri boundary is mocked.

const calls: { cmd: string; args: unknown }[] = [];
let failInvoke = false;

const realCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string, args: unknown = {}) => {
    calls.push({ cmd, args });
    if (failInvoke) throw new Error("no ipc");
  },
}));

const { installErrorReporting } = await import("../src/hubClient");

type Handler = (e: unknown) => void;
const handlers: Record<string, Handler> = {};
const target = {
  addEventListener: (type: string, h: Handler) => {
    handlers[type] = h;
  },
} as unknown as Pick<Window, "addEventListener">;

beforeEach(() => {
  calls.length = 0;
  failInvoke = false;
  installErrorReporting(target);
});

describe("window error reporting", () => {
  it("sends an uncaught error and an unhandled rejection as one line each", () => {
    handlers.error({ error: new TypeError("x is undefined"), message: "ignored" });
    handlers.unhandledrejection({ reason: new Error("boom") });
    handlers.unhandledrejection({ reason: "plain text" });
    expect(calls).toEqual([
      { cmd: "client_report_error", args: { message: "TypeError: x is undefined" } },
      { cmd: "client_report_error", args: { message: "Unhandled rejection: Error: boom" } },
      { cmd: "client_report_error", args: { message: "Unhandled rejection: plain text" } },
    ]);
  });

  it("never throws when the report itself fails", async () => {
    failInvoke = true;
    expect(() => handlers.error({ message: "Script error." })).not.toThrow();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});
