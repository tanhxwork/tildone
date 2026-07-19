import { create } from "zustand";
import type { TaskImage } from "./types";

/**
 * The one floating image viewer. Card thumbnails and editor tiles open it with
 * the task's full image list so arrow keys step through siblings; empty images
 * means closed. Kept out of the main store: it is pure view state, and the main
 * store's reload() replaces its slices wholesale.
 */
interface LightboxStore {
  images: TaskImage[];
  index: number;
  open: (images: TaskImage[], index: number) => void;
  close: () => void;
  step: (delta: -1 | 1) => void;
}

export const useLightbox = create<LightboxStore>((set) => ({
  images: [],
  index: 0,
  open: (images, index) => set({ images, index }),
  close: () => set({ images: [], index: 0 }),
  step: (delta) =>
    set((s) =>
      s.images.length === 0
        ? s
        : { index: (s.index + delta + s.images.length) % s.images.length },
    ),
}));
