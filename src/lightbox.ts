import { create } from "zustand";
import type { TaskImage } from "./types";

/**
 * The one floating image viewer. Card thumbnails and editor tiles open it with
 * the task's full image list so arrow keys step through siblings; no items
 * means closed. Kept out of the main store: it is pure view state, and the main
 * store's reload() replaces its slices wholesale.
 *
 * Two kinds of item, because two kinds of image reach it. An `attached` one is
 * a task_images row, addressed by id and served over the asset protocol. A
 * `file` one is a screenshot an agent merely *named* in its notes: it lives
 * outside the app's data dir, where the asset protocol deliberately cannot
 * reach, so Rust reads the bytes and the viewer gets a blob URL to show.
 */
export type LightboxItem =
  | { kind: "attached"; image: TaskImage }
  | { kind: "file"; src: string; filename: string };

interface LightboxStore {
  items: LightboxItem[];
  index: number;
  /** Open on attached task images — the original entry point. */
  open: (images: TaskImage[], index: number) => void;
  /** Open on blob URLs read from disk; revoked when the viewer closes. */
  openFiles: (files: { src: string; filename: string }[], index: number) => void;
  close: () => void;
  step: (delta: -1 | 1) => void;
}

/** A blob URL outlives the page unless revoked, so every close — and every
 *  re-open over a previous set — hands back the ones we minted. */
function revoke(items: LightboxItem[]) {
  for (const item of items) {
    if (item.kind === "file") URL.revokeObjectURL(item.src);
  }
}

export const useLightbox = create<LightboxStore>((set) => ({
  items: [],
  index: 0,
  open: (images, index) =>
    set((s) => {
      revoke(s.items);
      return {
        items: images.map((image): LightboxItem => ({ kind: "attached", image })),
        index,
      };
    }),
  openFiles: (files, index) =>
    set((s) => {
      revoke(s.items);
      return {
        items: files.map((f): LightboxItem => ({ kind: "file", ...f })),
        index,
      };
    }),
  close: () =>
    set((s) => {
      revoke(s.items);
      return { items: [], index: 0 };
    }),
  step: (delta) =>
    set((s) =>
      s.items.length === 0
        ? s
        : { index: (s.index + delta + s.items.length) % s.items.length },
    ),
}));
