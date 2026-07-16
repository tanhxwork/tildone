import type { Selection, Status, Task } from "./types";
import { STATUSES } from "./types";

// Turning a Kanban drag into position writes. `position` is an ordinal within one
// (project, status) group, but a drag only ever knows the *visible* (filtered)
// column. Writing the visible index straight through corrupts any group the column
// doesn't show in full — cross-project board views, and any single-project view with
// a tag/priority/search filter active (see docs/specs/2026-07-16-drag-reorder-filtered-views.md).
//
// The store holds the whole task set, so we can always reconstruct the full group and
// keep hidden cards' order intact. Two regimes:
//   - single-group views (project, inbox): merge the visible reorder back into the
//     full group and dense-renumber — a precise reorder that survives filters.
//   - mixed views (all, today, upcoming): a column interleaves projects and has no
//     single manual order, so only the dragged card moves — to the top or bottom of
//     its own group by which half of the column it was dropped in.

const MIXED_VIEWS = new Set<Selection["type"]>(["all", "today", "upcoming"]);

/** A column in these views interleaves projects; a single manual order is undefined. */
export function isMixedView(selection: Selection): boolean {
  return MIXED_VIEWS.has(selection.type);
}

export interface DragUpdate {
  id: number;
  status: Status;
  position: number;
  completed_at: string | null;
}

/**
 * Pure: given the full task set, the current view, the dragged card and the new
 * VISIBLE column order the drag produced, return the position (and status/completed_at)
 * writes needed. `now` is passed in so the function stays deterministic for tests.
 */
export function computeDragUpdates(
  tasks: Task[],
  selection: Selection,
  activeId: number,
  columns: Record<Status, number[]>,
  now: string,
): DragUpdate[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = byId.get(activeId);
  if (!active) return [];

  // The column the card ended up in is its destination status.
  const destStatus = STATUSES.find((s) => columns[s]?.includes(activeId));
  if (!destStatus) return [];

  const projectId = active.project_id;

  const completedFor = (id: number, status: Status): string | null => {
    const t = byId.get(id)!;
    if (status === t.status) return t.completed_at;
    return status === "done" ? now : null;
  };

  // Live members of the dragged card's destination group, in board order, minus the
  // card itself. This is the FULL group — hidden filtered cards included — because it
  // reads the store's task set, not the visible column.
  const groupWithoutActive = tasks
    .filter(
      (t) =>
        t.deleted_at === null &&
        t.status === destStatus &&
        t.project_id === projectId &&
        t.id !== activeId,
    )
    .sort((a, b) => a.position - b.position || a.id - b.id);

  if (isMixedView(selection)) {
    // Only the dragged card moves. Top or bottom of its group by drop half; the group's
    // other cards, and every other project, are left exactly as they were. Position may
    // drift past the dense range, which is fine — positions only need to stay distinct
    // and ordered (see groupSlot in store.ts).
    const col = columns[destStatus];
    const dropIndex = col.indexOf(activeId);
    const topHalf = dropIndex < col.length / 2;
    const positions = groupWithoutActive.map((t) => t.position);
    const position =
      positions.length === 0
        ? 0
        : topHalf
          ? Math.min(...positions) - 1
          : Math.max(...positions) + 1;
    return [
      {
        id: activeId,
        status: destStatus,
        position,
        completed_at: completedFor(activeId, destStatus),
      },
    ];
  }

  // Single-group view: merge the visible reorder back into the full group. A single drag
  // moves only the active card among the visible cards, so anchor it to the visible card
  // now immediately above it and slot it just after that card in the full order. Hidden
  // cards keep their relative places; then dense-renumber the whole group.
  const visibleOrder = columns[destStatus].filter((id) => {
    const t = byId.get(id);
    return t !== undefined && t.project_id === projectId;
  });
  const idx = visibleOrder.indexOf(activeId);
  const upperNeighbour = idx > 0 ? visibleOrder[idx - 1] : null;

  const full = groupWithoutActive.map((t) => t.id);
  const insertAt = upperNeighbour === null ? 0 : full.indexOf(upperNeighbour) + 1;
  full.splice(insertAt, 0, activeId);

  return full.map((id, index) => ({
    id,
    status: destStatus,
    position: index,
    completed_at: completedFor(id, destStatus),
  }));
}
