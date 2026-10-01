import type { TownModel } from "../selectors";

// Contract stub for the Town's Canvas 2D renderer (lane 2 fills it in; lane 3's
// TownPage drives it). A port of the engine in
// docs/artifacts/2026-10-01-town-redesign.html, layout B.

/** What the pointer is over. Bots, drones and scenery never produce one. */
export type TownTarget =
  | { kind: "agent"; taskId: number }
  /** A project's building; clicking it opens or closes that one building. */
  | { kind: "building"; projectId: number }
  /** A project's floating name chip; clicking it focuses that island. */
  | { kind: "label"; projectId: number };

export interface TownHover {
  target: TownTarget;
  /** Anchor in CSS pixels relative to the canvas's top-left, for placing the card. */
  x: number;
  y: number;
}

export interface TownRendererOptions {
  /** Pointer moved onto a target, or off every target (null). */
  onHover: (hover: TownHover | null) => void;
  onClick: (target: TownTarget) => void;
}

/**
 * Owns one canvas: sizes it to its box (ResizeObserver, devicePixelRatio), runs
 * the draw loop (paused while the page is hidden; ambient motion frozen under
 * prefers-reduced-motion) and hit-tests the pointer. Every setter is cheap to call
 * on each React render: it rebuilds the scene only when its input changed.
 */
export class TownRenderer {
  constructor(canvas: HTMLCanvasElement, options: TownRendererOptions) {
    void canvas;
    void options;
  }

  /** The roster to draw: one island per project room, Inbox agents in the square. */
  setModel(model: TownModel): void {
    void model;
  }

  /** Night palette (dark theme) or day palette. */
  setDark(dark: boolean): void {
    void dark;
  }

  /** Buildings drawn cut open; every other building is drawn closed. */
  setOpen(projectIds: ReadonlySet<number>): void {
    void projectIds;
  }

  /** Show helper bots and drones (true) or agents only (false). */
  setBots(show: boolean): void {
    void show;
  }

  /** Zoom to one project's island and fade the rest; null frames the whole town. */
  focus(projectId: number | null): void {
    void projectId;
  }

  /** Where an agent is drawn now (CSS px, canvas-relative), for showing its card
   *  from the keyboard; null when the agent is not in the scene. */
  agentAnchor(taskId: number): { x: number; y: number } | null {
    void taskId;
    return null;
  }

  /** Stops the loop and disconnects observers and listeners. */
  destroy(): void {}
}
