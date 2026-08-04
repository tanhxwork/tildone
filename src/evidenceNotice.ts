import { create } from "zustand";

/** Where a failed evidence click reports itself: the panel the user clicked in.
 *  A missing screenshot is a fact about the filesystem, not an app error — it
 *  gets a quiet line under the prose that named it, never a dialog. */
export type NoticeScope = "notes" | "activity";

interface NoticeStore {
  message: string;
  scope: NoticeScope | null;
  show: (scope: NoticeScope, message: string) => void;
  clear: () => void;
}

const LINGER_MS = 6000;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useEvidenceNotice = create<NoticeStore>((set) => ({
  message: "",
  scope: null,
  show: (scope, message) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => set({ message: "", scope: null }), LINGER_MS);
    set({ scope, message });
  },
  clear: () => {
    if (timer) clearTimeout(timer);
    set({ message: "", scope: null });
  },
}));
