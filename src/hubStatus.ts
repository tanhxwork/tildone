import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { HUB_STATUS, type HubStatus } from "./hubClient";

/** The last connection state Rust reported about the hub; null until it says anything. */
export const useHubStatus = create<{ status: HubStatus | null }>(() => ({ status: null }));

let watching = false;

/** Follow HUB_STATUS for the life of the page. Client mode only; safe to call twice. */
export async function watchHubStatus() {
  if (watching) return;
  watching = true;
  await listen<HubStatus>(HUB_STATUS, (event) => useHubStatus.setState({ status: event.payload }));
}
