import { browser, $, expect } from "@wdio/globals";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_CONFIG_DIR } from "./support/dataDir.js";
import { remount } from "./support/reset.js";

// Settings → Agent access → Command-line tool. e2e builds are debug builds, which
// ship no tildone-axi beside the executable, so the row must say so instead of
// offering a button that cannot work.

const SHOTS = "./.test-artifacts/screenshots";

describe("settings: command-line tool", () => {
  before(async () => {
    await $("#root").waitForExist();
  });

  it("says the CLI is not bundled in a build that does not ship it", async () => {
    await $(".nav-item*=Settings").click();
    const row = $(".settings-row*=Command-line tool");
    await row.waitForExist();
    await row.scrollIntoView();

    expect(await row.getText()).toContain("Not bundled in this build");
    expect(await row.$$("button")).toHaveLength(0);

    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(`${SHOTS}/settings-cli-not-bundled.png`);
  });
});

// Settings live in settings.json, written by Rust. The window reads them from
// there and follows every writer: this dialog, an agent over MCP, a script, or an
// edit by hand (spec settings-file). The cases run in order, each moving the theme
// away from where the last left it.

const SETTINGS_FILE = join(E2E_CONFIG_DIR, "settings.json");
const fileTheme = () => JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).theme;
const htmlTheme = () => browser.execute(() => document.documentElement.dataset.theme);

async function tauriInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return browser.executeAsync(
    (c: string, a: Record<string, unknown>, done: (v: unknown) => void) => {
      const tauri = (window as never as { __TAURI__: { core: { invoke: Function } } }).__TAURI__;
      tauri.core.invoke(c, a).then(done, (e: unknown) => done(`ERR ${e}`));
    },
    cmd,
    args,
  );
}

/** One MCP tool call against the app's real server, as an agent would make it. */
async function mcpTool(name: string, args: Record<string, unknown>) {
  const base = (await tauriInvoke("agent_server_start")) as string;
  const url = base.endsWith("/mcp") ? base : `${base.replace(/\/$/, "")}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  let id = 0;
  const rpc = async (method: string, params: unknown, notify = false) => {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = ++id;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    headers["mcp-session-id"] = res.headers.get("mcp-session-id") ?? headers["mcp-session-id"] ?? "";
    const text = await res.text();
    if (notify) return null;
    const data = text.trim().startsWith("{")
      ? text
      : text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5);
    return JSON.parse(data);
  };
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "settings-e2e", version: "1" },
  });
  await rpc("notifications/initialized", {}, true);
  const out = await rpc("tools/call", { name, arguments: args });
  if (out.error || out.result?.isError) throw new Error(`${name}: ${JSON.stringify(out)}`);
  return JSON.parse(out.result.content[0].text);
}

describe("settings: settings.json", () => {
  before(async () => {
    await $("#root").waitForExist();
  });

  it("dialog change lands in settings.json", async () => {
    await $(".nav-item*=Settings").click();
    await $('[aria-label="Theme"]').$("button=Dark").click();
    await browser.waitUntil(async () => fileTheme() === "dark", {
      timeout: 5000,
      timeoutMsg: "theme dark never reached settings.json",
    });
    expect(await htmlTheme()).toBe("dark");
  });

  it("outside write to settings.json switches the theme", async () => {
    const file = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...file, theme: "light" }));
    await browser.waitUntil(async () => (await htmlTheme()) === "light", {
      timeout: 6000,
      timeoutMsg: "the window never picked up the edit to settings.json",
    });
    // The open dialog follows the file too, not just the page.
    await $('[aria-label="Theme"]').$("button.active=Light").waitForExist({ timeout: 2000 });
    await browser.saveScreenshot(`${SHOTS}/settings-outside-write-light.png`);
  });

  it("update_settings over MCP switches the theme", async () => {
    const out = await mcpTool("update_settings", { theme: "dark" });
    expect(out.settings.theme).toBe("dark");
    await browser.waitUntil(async () => (await htmlTheme()) === "dark", {
      timeout: 6000,
      timeoutMsg: "the window never applied the MCP settings change",
    });
    expect(fileTheme()).toBe("dark");
    await $('[aria-label="Theme"]').$("button.active=Dark").waitForExist({ timeout: 2000 });
    await browser.saveScreenshot(`${SHOTS}/settings-mcp-dark.png`);
  });

  it("old localStorage theme survives the upgrade", async () => {
    // An install from before settings.json: no file, the theme in localStorage.
    // Wait for Rust to notice the file is gone before the window asks to migrate.
    rmSync(SETTINGS_FILE, { force: true });
    await browser.waitUntil(
      async () => ((await tauriInvoke("settings_get")) as { theme: string }).theme === "auto",
      { timeout: 6000, timeoutMsg: "Rust never noticed settings.json was removed" },
    );
    await remount(() =>
      localStorage.setItem("tildone-settings", JSON.stringify({ theme: "light" })),
    );
    expect(await htmlTheme()).toBe("light");
    await browser.waitUntil(async () => fileTheme() === "light", {
      timeout: 5000,
      timeoutMsg: "the migrated theme never reached settings.json",
    });
  });
});
