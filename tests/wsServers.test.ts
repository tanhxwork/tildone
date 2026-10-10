import { describe, expect, it } from "bun:test";
import {
  deliveryAction,
  parseStatus,
  pillSummary,
  sitesUp,
  type WsDelivery,
  type WsSite,
  type WsStatus,
} from "../src/wsServers";

const site = (name: string, up = true): WsSite => ({
  name,
  url: `https://${name}.ws.test:8444/`,
  branch: "main",
  changed: 1,
  up,
});

const delivery = (state: WsDelivery["state"]): WsDelivery => ({
  slug: "gallery-admin",
  repo: "senso",
  root: "senso-1",
  branch: "factory/gallery-admin",
  url: "https://gallery-admin.ws.test:8444/",
  state,
  changed: 1,
});

const status = (sites: WsSite[], deliveries: WsDelivery[] = []): WsStatus => ({
  at: "",
  sites,
  deliveries,
});

describe("pillSummary", () => {
  it("counts up sites and stopped deliveries, green", () => {
    const s = status([site("a"), site("b")], [delivery("stopped")]);
    expect(pillSummary(s, null)).toEqual({ text: "ws · 2 up · 1 stopped", tone: "up" });
  });

  it("leaves the stopped part off when every delivery runs", () => {
    const s = status([site("a")], [delivery("running"), delivery("starting")]);
    expect(pillSummary(s, null)).toEqual({ text: "ws · 1 up", tone: "up" });
  });

  it("counts a failed start as stopped", () => {
    expect(pillSummary(status([site("a")], [delivery("failed")]), null).text).toBe(
      "ws · 1 up · 1 stopped",
    );
  });

  it("goes red and counts down sites", () => {
    const s = status([site("a"), site("b", false), site("c", false)]);
    expect(pillSummary(s, null)).toEqual({ text: "ws · 2 down", tone: "down" });
  });

  it("reads offline whenever the poll failed, even with old data", () => {
    const s = status([site("a", false)]);
    expect(pillSummary(s, "refused")).toEqual({ text: "ws offline", tone: "down" });
  });

  it("is neutral before the first answer", () => {
    expect(pillSummary(null, null)).toEqual({ text: "ws", tone: "idle" });
  });
});

describe("parseStatus", () => {
  it("reads the hub's feed", () => {
    const parsed = parseStatus({
      at: "2026-10-10T07:56:45.000Z",
      sites: [{ name: "crestlink", url: "u", branch: "main", changed: 5, up: true }],
      deliveries: [
        { slug: "g", repo: "r", root: "r-1", branch: "b", url: "u", state: "failed", changed: 6.5 },
      ],
    });
    expect(parsed.sites[0]).toEqual({ name: "crestlink", url: "u", branch: "main", changed: 5, up: true });
    expect(parsed.deliveries[0].state).toBe("failed");
    expect(parsed.deliveries[0].changed).toBe(6.5);
  });

  it("survives junk without throwing", () => {
    expect(parseStatus(null)).toEqual({ at: "", sites: [], deliveries: [] });
    const parsed = parseStatus({ sites: [1, "x", { name: "a" }], deliveries: [{ state: "weird" }] });
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.sites[0].up).toBe(false);
    expect(parsed.deliveries[0].state).toBe("stopped");
  });
});

describe("deliveryAction and sitesUp", () => {
  it("offers Stop only while a delivery runs or boots", () => {
    expect(deliveryAction(delivery("running"))).toBe("stop");
    expect(deliveryAction(delivery("starting"))).toBe("stop");
    expect(deliveryAction(delivery("stopped"))).toBe("start");
    expect(deliveryAction(delivery("failed"))).toBe("start");
  });

  it("counts only up sites", () => {
    expect(sitesUp(status([site("a"), site("b", false)]))).toBe(1);
    expect(sitesUp(null)).toBe(0);
  });
});
