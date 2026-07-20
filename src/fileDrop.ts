import { useEffect } from "react";
import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Tauri intercepts native OS file drops before the webview sees them, so the
 *  HTML5 dragover/drop events never fire — `onDragDropEvent` is the only way in.
 *  That event is window-global and carries a cursor position rather than a DOM
 *  target, so this module is the missing router: one listener for the whole app,
 *  hit-testing the position against elements that opted in via
 *  `data-drop-target="<name>"`, then handing the paths to that target's handler.
 */

type DropHandler = (paths: string[]) => void;

const handlers = new Map<string, DropHandler>();

interface FileDropState {
  /** Name of the drop target the cursor is currently over, if any. */
  over: string | null;
  setOver: (name: string | null) => void;
}

const useFileDropStore = create<FileDropState>((set) => ({
  over: null,
  setOver: (name) => set((s) => (s.over === name ? s : { over: name })),
}));

/** The drop-target name under a physical-pixel cursor position, or null.
 *  Tauri reports positions in physical pixels; the DOM works in CSS pixels. */
function targetAt(x: number, y: number): string | null {
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(x / scale, y / scale);
  const host = el?.closest("[data-drop-target]");
  const name = host?.getAttribute("data-drop-target") ?? null;
  return name && handlers.has(name) ? name : null;
}

/** Register the single app-wide drag-drop listener. Call once, from App. */
export function useFileDropListener(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const { setOver } = useFileDropStore.getState();
        if (event.payload.type === "over") {
          const { x, y } = event.payload.position;
          setOver(targetAt(x, y));
        } else if (event.payload.type === "drop") {
          const { x, y } = event.payload.position;
          const name = targetAt(x, y);
          setOver(null);
          if (name) handlers.get(name)?.(event.payload.paths);
        } else {
          setOver(null);
        }
      })
      .then((fn) => {
        // The listener may resolve after unmount (StrictMode double-invoke, or a
        // fast reload); drop it immediately rather than leaking a live handler.
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** Opt an element in as a drop target. Spread the returned props onto it and use
 *  `isOver` to draw the drag-over ring. */
export function useDropTarget(
  name: string,
  onDrop: DropHandler,
): { isOver: boolean; dropProps: { "data-drop-target": string } } {
  const isOver = useFileDropStore((s) => s.over === name);

  useEffect(() => {
    handlers.set(name, onDrop);
    return () => {
      handlers.delete(name);
      // A target that unmounts mid-drag would otherwise leave its ring lit.
      if (useFileDropStore.getState().over === name) {
        useFileDropStore.getState().setOver(null);
      }
    };
  }, [name, onDrop]);

  return { isOver, dropProps: { "data-drop-target": name } };
}
