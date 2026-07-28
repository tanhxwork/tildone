// Pure camera math for the town scene. No PixiJS import, no DOM — this file
// is unit-tested in isolation (tests/townCamera.test.ts) and the renderer
// (pixiScene.ts) is the only thing that reads a Camera to draw with.
//
// Transform convention: the world is drawn at a fixed internal pixel scale.
// A world point (wx, wy) maps to a screen point via
//
//     screen = (world - cam) * zoom
//
// i.e. screenX = (wx - cam.x) * zoom, screenY = (wy - cam.y) * zoom.
// So cam.x/cam.y are WORLD-PIXEL coordinates: the world point currently drawn
// at screen (0, 0), the top-left of the visible viewport. cam.zoom scales
// world pixels to screen pixels (zoom > 1 = zoomed in / larger on screen).
//
// Every function here returns a NEW Camera — none of them mutate the input —
// and every result is passed through clampCamera so the visible window never
// drifts outside the world (or, when the world is smaller than the viewport
// on an axis, stays centered on that axis).

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Allowed discrete zoom levels, ascending. Keeps pixel art from getting soft. */
export const ZOOM_STEPS: number[] = [0.75, 1, 1.5, 2, 3];

/** Index of the ZOOM_STEPS entry nearest to `z`. */
function nearestStepIndex(z: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const dist = Math.abs(ZOOM_STEPS[i] - z);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Nearest legal zoom step to `z`, then moved `dir` steps
 * (dir +1 = zoom in / larger, -1 = out). Clamped to the ends.
 */
export function nextZoom(z: number, dir: 1 | -1): number {
  const idx = nearestStepIndex(z);
  const nextIdx = Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + dir));
  return ZOOM_STEPS[nextIdx];
}

/**
 * Clamp cam.x/y so the visible window [cam.x, cam.x + view.w/zoom) stays
 * within [0, world.w) (and the analogous window for y within [0, world.h)).
 * When the world is smaller than the visible window on an axis, CENTER it on
 * that axis instead (cam.x = (world.w - view.w/zoom) / 2, which is <= 0).
 * Returns a NEW Camera; does not mutate.
 */
export function clampCamera(cam: Camera, world: Size, view: Size): Camera {
  const visW = view.w / cam.zoom;
  const visH = view.h / cam.zoom;

  const x =
    world.w < visW
      ? (world.w - visW) / 2
      : Math.min(Math.max(cam.x, 0), world.w - visW);

  const y =
    world.h < visH
      ? (world.h - visH) / 2
      : Math.min(Math.max(cam.y, 0), world.h - visH);

  return { x, y, zoom: cam.zoom };
}

/**
 * Set zoom to `newZoom` (assumed already a legal step) while keeping the
 * world point currently under screen point `pointer` fixed under the
 * pointer. Then clamp. Returns a NEW Camera.
 */
export function zoomTo(
  cam: Camera,
  newZoom: number,
  pointer: Pt,
  world: Size,
  view: Size,
): Camera {
  const worldX = cam.x + pointer.x / cam.zoom;
  const worldY = cam.y + pointer.y / cam.zoom;
  const newX = worldX - pointer.x / newZoom;
  const newY = worldY - pointer.y / newZoom;
  return clampCamera({ x: newX, y: newY, zoom: newZoom }, world, view);
}

/**
 * Pan by a SCREEN-pixel delta from a pointer drag: dragging the content
 * right (dScreen.x > 0) reveals content to the left, so cam.x decreases by
 * dScreen.x / zoom. Then clamp. Returns a NEW Camera.
 */
export function panBy(
  cam: Camera,
  dScreen: Pt,
  world: Size,
  view: Size,
): Camera {
  const newX = cam.x - dScreen.x / cam.zoom;
  const newY = cam.y - dScreen.y / cam.zoom;
  return clampCamera({ x: newX, y: newY, zoom: cam.zoom }, world, view);
}

/**
 * Ease the camera so world point `target` moves toward the center of the
 * view. `ease` in [0,1]; zoom unchanged. Returns a NEW Camera.
 */
export function follow(
  cam: Camera,
  target: Pt,
  world: Size,
  view: Size,
  ease: number,
): Camera {
  const desiredX = target.x - view.w / cam.zoom / 2;
  const desiredY = target.y - view.h / cam.zoom / 2;
  const newX = cam.x + (desiredX - cam.x) * ease;
  const newY = cam.y + (desiredY - cam.y) * ease;
  return clampCamera({ x: newX, y: newY, zoom: cam.zoom }, world, view);
}
