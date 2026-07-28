import { describe, expect, it } from "bun:test";
import {
  Camera,
  clampCamera,
  follow,
  nextZoom,
  panBy,
  Size,
  zoomTo,
  ZOOM_STEPS,
} from "../src/town/camera";

// Pure camera math: screen = (world - cam) * zoom, cam.x/y are the world-pixel
// coordinates mapped to screen (0,0). These pin the zoom step table, the
// clamp-to-world / center-when-smaller behavior, and that zoom/pan/follow all
// route through clampCamera so callers never see an out-of-range camera.

describe("nextZoom", () => {
  it("steps up from an exact step", () => {
    expect(nextZoom(1, 1)).toBe(1.5);
  });

  it("steps down from an exact step", () => {
    expect(nextZoom(1, -1)).toBe(0.75);
  });

  it("clamps at the top", () => {
    expect(nextZoom(3, 1)).toBe(3);
  });

  it("clamps at the bottom", () => {
    expect(nextZoom(0.75, -1)).toBe(0.75);
  });

  it("snaps a non-step input to the nearest step before moving", () => {
    // 1.2 is nearest to 1 (ZOOM_STEPS = [0.75, 1, 1.5, 2, 3]), then +1 -> 1.5
    expect(nextZoom(1.2, 1)).toBe(1.5);
  });

  it("exposes the ascending step table", () => {
    expect(ZOOM_STEPS).toEqual([0.75, 1, 1.5, 2, 3]);
  });
});

describe("clampCamera", () => {
  const world: Size = { w: 1000, h: 1000 };
  const view: Size = { w: 400, h: 300 };

  it("clamps above-max cam.x down to world.w - view.w/zoom", () => {
    const cam: Camera = { x: 900, y: 0, zoom: 1 };
    const result = clampCamera(cam, world, view);
    expect(result.x).toBe(600);
  });

  it("clamps negative cam.x up to 0", () => {
    const cam: Camera = { x: -50, y: -50, zoom: 1 };
    const result = clampCamera(cam, world, view);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it("centers an axis when the world is smaller than the view on it", () => {
    const smallWorld: Size = { w: 200, h: 1000 };
    const wideView: Size = { w: 400, h: 300 };
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    const result = clampCamera(cam, smallWorld, wideView);
    expect(result.x).toBe((200 - 400) / 2);
    expect(result.x).toBe(-100);
  });

  it("does not mutate the input camera", () => {
    const cam: Camera = { x: 900, y: 900, zoom: 1 };
    clampCamera(cam, world, view);
    expect(cam).toEqual({ x: 900, y: 900, zoom: 1 });
  });
});

describe("zoomTo", () => {
  it("keeps the world point under the pointer fixed when zooming in", () => {
    const world: Size = { w: 1_000_000, h: 1_000_000 };
    const view: Size = { w: 400, h: 300 };
    const cam: Camera = { x: 5000, y: 5000, zoom: 1 };
    const pointer = { x: 200, y: 150 };

    const worldPtBefore = {
      x: cam.x + pointer.x / cam.zoom,
      y: cam.y + pointer.y / cam.zoom,
    };

    const result = zoomTo(cam, 2, pointer, world, view);

    const worldPtAfter = {
      x: result.x + pointer.x / result.zoom,
      y: result.y + pointer.y / result.zoom,
    };

    expect(worldPtAfter.x).toBeCloseTo(worldPtBefore.x, 9);
    expect(worldPtAfter.y).toBeCloseTo(worldPtBefore.y, 9);
    expect(result.zoom).toBe(2);
  });
});

describe("panBy", () => {
  it("decreases cam.x by dScreen.x/zoom when dragging right", () => {
    const world: Size = { w: 1_000_000, h: 1_000_000 };
    const view: Size = { w: 400, h: 300 };
    const cam: Camera = { x: 5000, y: 5000, zoom: 1 };

    const result = panBy(cam, { x: 100, y: 0 }, world, view);

    expect(result.x).toBeCloseTo(4900, 9);
    expect(result.y).toBeCloseTo(5000, 9);
  });
});

describe("follow", () => {
  it("moves cam.x halfway toward the centered target with ease=0.5", () => {
    const world: Size = { w: 1_000_000, h: 1_000_000 };
    const view: Size = { w: 400, h: 300 };
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    const target = { x: 5000, y: 5000 };

    const desiredX = target.x - view.w / cam.zoom / 2;
    const desiredY = target.y - view.h / cam.zoom / 2;

    const result = follow(cam, target, world, view, 0.5);

    expect(result.x).toBeCloseTo(cam.x + (desiredX - cam.x) * 0.5, 9);
    expect(result.y).toBeCloseTo(cam.y + (desiredY - cam.y) * 0.5, 9);
  });
});
