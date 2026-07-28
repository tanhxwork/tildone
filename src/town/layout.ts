// Town geometry — pure, shared by the Pixi renderer and the DOM overlay.
//
// The overlay (hover targets, tooltips, aria, test ids) must sit exactly over the
// characters the canvas draws. Rather than read positions back out of Pixi, both
// consume this one layout: same rooms, same character coordinates, computed once
// from the model and the viewport width. Pure and deterministic → unit-testable,
// and the overlay can never drift from the canvas.

import type { TownCharacter, TownModel, TownRoom } from "../selectors";

export const ROOM_W = 220;
export const ROOM_H = 124;
const GAP = 16;
const PAD = 16;
/** Interior inset inside the walls. */
const WALL = 12;
const CELL = 46;
const PER_ROW = 4;

export interface CharPlacement {
  char: TownCharacter;
  /** Absolute centre of the character within the town canvas. */
  x: number;
  y: number;
}

export interface RoomPlacement {
  room: TownRoom;
  x: number;
  y: number;
  w: number;
  h: number;
  chars: CharPlacement[];
}

export interface TownLayout {
  rooms: RoomPlacement[];
  width: number;
  height: number;
}

function placeChars(chars: TownCharacter[], roomX: number, roomY: number): CharPlacement[] {
  // Seat characters near the desk (lower in the room) and stack extra rows
  // upward, so a populated room reads as "at work" rather than floating at top.
  return chars.map((char, i) => {
    const col = i % PER_ROW;
    const row = Math.floor(i / PER_ROW);
    return {
      char,
      x: roomX + WALL + CELL / 2 + col * CELL,
      y: roomY + ROOM_H - 54 - row * CELL,
    };
  });
}

/**
 * Lay the fixed town out as a wrapping grid of equal room cells. Rooms keep the
 * model's order (projects by position, Inbox last); characters tile inside their
 * room. `width`/`height` are the full canvas extent for scroll sizing.
 */
export function layoutTown(model: TownModel, viewportWidth: number): TownLayout {
  const usable = Math.max(ROOM_W, viewportWidth - PAD * 2);
  const cols = Math.max(1, Math.floor((usable + GAP) / (ROOM_W + GAP)));

  const rooms: RoomPlacement[] = model.rooms.map((room, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAD + col * (ROOM_W + GAP);
    const y = PAD + row * (ROOM_H + GAP);
    return { room, x, y, w: ROOM_W, h: ROOM_H, chars: placeChars(room.characters, x, y) };
  });

  const rowCount = Math.max(1, Math.ceil(model.rooms.length / cols));
  return {
    rooms,
    width: PAD * 2 + cols * (ROOM_W + GAP) - GAP,
    height: PAD * 2 + rowCount * (ROOM_H + GAP) - GAP,
  };
}
