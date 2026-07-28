// A* pathfinding over the town's walkability grid.
//
// Characters path to a specific target (their building's door, a leisure spot,
// the world edge to walk off) around building obstacles. Idle *wander* does not
// use this — it takes cheap random walkable steps — so this stays a small,
// pure, 4-connected A* with a Manhattan heuristic. Pure and deterministic →
// unit-tested in tests/townPathfind.test.ts.

import { isWalkable, type Tile, type TownWorld } from "./world";

function key(x: number, y: number): number {
  // Pack into one number; grid stays well under 2^16 per axis.
  return y * 65536 + x;
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Shortest 4-connected walkable path from `from` to `to`, inclusive of both
 * endpoints. Returns `[]` when unreachable (the caller stays put). A path of
 * length 1 (`from` == `to`) is `[from]`. `to` must itself be walkable; an
 * unwalkable goal yields `[]`.
 *
 * `blocked` optionally forbids *intermediate* tiles the pathfinder may not cross
 * (e.g. other characters' leisure spots) — it is not applied to `from` or `to`,
 * so a character can always leave its current tile and reach its own target.
 */
export function findPath(
  world: TownWorld,
  from: Tile,
  to: Tile,
  blocked?: (x: number, y: number) => boolean,
): Tile[] {
  if (!isWalkable(world, from.x, from.y) || !isWalkable(world, to.x, to.y)) {
    return [];
  }
  if (from.x === to.x && from.y === to.y) return [from];

  const h = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);

  const open: Array<{ x: number; y: number; f: number }> = [
    { x: from.x, y: from.y, f: h(from.x, from.y) },
  ];
  const gScore = new Map<number, number>([[key(from.x, from.y), 0]]);
  const cameFrom = new Map<number, Tile>();
  const closed = new Set<number>();

  while (open.length > 0) {
    // Small grids (bounded by concurrent projects) — a linear min scan is fine.
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[best].f) best = i;
    }
    const current = open.splice(best, 1)[0];
    const ck = key(current.x, current.y);
    if (current.x === to.x && current.y === to.y) {
      const path: Tile[] = [{ x: current.x, y: current.y }];
      let k = ck;
      while (cameFrom.has(k)) {
        const p = cameFrom.get(k)!;
        path.push(p);
        k = key(p.x, p.y);
      }
      return path.reverse();
    }
    if (closed.has(ck)) continue;
    closed.add(ck);

    const g = gScore.get(ck)!;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!isWalkable(world, nx, ny)) continue;
      // Skip forbidden intermediate tiles unless it's the goal itself.
      if (blocked && blocked(nx, ny) && !(nx === to.x && ny === to.y)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentative = g + 1;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentative);
        cameFrom.set(nk, { x: current.x, y: current.y });
        open.push({ x: nx, y: ny, f: tentative + h(nx, ny) });
      }
    }
  }
  return [];
}
