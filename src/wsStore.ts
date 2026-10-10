// One shared poll of the ws dev-server hub, read by the Servers view, the
// sidebar count and the header pill. Rust does the HTTP (certificate and
// Origin rules, see src-tauri/src/wsservers.rs); this store only schedules it.
//
// A failed poll keeps the last good status and records the error beside it,
// so the view can say "showing the list from 15:58" instead of going blank.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "./settings";
import {
  deliveryAction,
  deliveryKey,
  parseStatus,
  type WsDelivery,
  type WsStatus,
} from "./wsServers";

const POLL_MS = 5000;

interface WsState {
  status: WsStatus | null;
  /** Epoch ms of the last poll that worked. */
  lastOk: number | null;
  /** Why the latest poll failed; null while ws answers. */
  error: string | null;
  /** Deliveries with a Start or Stop in flight, by deliveryKey. */
  pending: Record<string, true>;
  /** Why the latest Start or Stop failed. */
  actionError: string | null;

  refresh: () => Promise<void>;
  act: (delivery: WsDelivery) => Promise<void>;
  reset: () => void;
}

export const useWsStore = create<WsState>()((set, get) => ({
  status: null,
  lastOk: null,
  error: null,
  pending: {},
  actionError: null,

  refresh: async () => {
    const hubUrl = useSettings.getState().wsHubUrl;
    if (!hubUrl) return;
    try {
      const status = parseStatus(await invoke("ws_status", { hubUrl }));
      // The URL was changed or cleared while this poll was out.
      if (useSettings.getState().wsHubUrl !== hubUrl) return;
      set({ status, lastOk: Date.now(), error: null });
    } catch (e) {
      if (useSettings.getState().wsHubUrl !== hubUrl) return;
      set({ error: String(e) });
    }
  },

  // Start or Stop one delivery, then re-poll so the row shows the new state.
  act: async (delivery) => {
    const hubUrl = useSettings.getState().wsHubUrl;
    if (!hubUrl) return;
    const key = deliveryKey(delivery);
    set((s) => ({ pending: { ...s.pending, [key]: true }, actionError: null }));
    try {
      await invoke("ws_action", {
        hubUrl,
        verb: deliveryAction(delivery),
        root: delivery.root,
        slug: delivery.slug,
      });
    } catch (e) {
      set({ actionError: `${deliveryAction(delivery)} ${delivery.slug}: ${String(e)}` });
    }
    set((s) => {
      const { [key]: _done, ...rest } = s.pending;
      return { pending: rest };
    });
    await get().refresh();
  },

  reset: () =>
    set({ status: null, lastOk: null, error: null, pending: {}, actionError: null }),
}));

/**
 * Starts the poll while the hub URL is set and stops it when the setting is
 * cleared, which also drops the stale data. Returns the disposer for App's
 * effect. Polls pause while the window is hidden.
 */
export function initWsStore(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    if (!document.hidden) void useWsStore.getState().refresh();
  };
  const sync = (hubUrl: string) => {
    if (timer) clearInterval(timer);
    timer = null;
    useWsStore.getState().reset();
    if (!hubUrl) return;
    tick();
    timer = setInterval(tick, POLL_MS);
  };
  sync(useSettings.getState().wsHubUrl);
  const unsub = useSettings.subscribe((s, prev) => {
    if (s.wsHubUrl !== prev.wsHubUrl) sync(s.wsHubUrl);
  });
  return () => {
    unsub();
    if (timer) clearInterval(timer);
  };
}
