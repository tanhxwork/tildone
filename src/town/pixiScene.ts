// The town's Pixi layer — a dumb renderer of a TownLayout over a set of textures.
//
// Rooms are a Tildone card shell (rounded floor + hairline border, so the chrome
// stays on-brand) wrapping a tiled Kenney floor, a desk, and a door. Each
// character is a distinct Tiny Dungeon person chosen by agent, with a state glyph
// (⌨️/⚠️/💤) above — the ref image's vocabulary. Textures are passed in, so this
// file imports no PNGs and the standalone demo can supply its own set.
//
// Reconciliation is rebuild-on-render: rooms/characters are few and a render only
// fires on a store change or resize (never per frame), so clearing and redrawing
// cannot drift. Per-frame animation is applied by the ticker to the character
// views the last render produced.

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  TilingSprite,
} from "pixi.js";
import type { PresenceState } from "../utils/presence";
import type { TownTextures } from "./assets";
import type { TownLayout } from "./layout";

export interface TownTheme {
  floor: number;
  wall: number;
  title: number;
  inkMuted: number;
  blocked: number;
  reducedMotion: boolean;
}

interface CharView {
  container: Container;
  sprite: Sprite;
  icon: Text;
  state: PresenceState;
  phase: number;
  baseY: number;
}

const STATE_ICON: Record<PresenceState, string> = {
  working: "⌨️",
  blocked: "⚠️",
  quiet: "💤",
};

const TITLE_H = 30;
const TILE = 32; // 16px art drawn at 2×
const CHAR_SCALE = 2;

/** Character sprite key by agent name — mirrors agents.tsx RULES. Kept here so the
 *  scene has no dependency on the PNG-importing assets module. */
export function charKeyForAgent(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("tildone-ai")) return "secretary";
  if (n.includes("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  if (n.includes("cursor")) return "cursor";
  return "generic";
}

export function createTownScene(app: Application, tex: TownTextures) {
  const world = new Container();
  app.stage.addChild(world);
  let views: CharView[] = [];
  let elapsed = 0;
  let reduced = false;

  const titleStyle = (fill: number) =>
    new TextStyle({ fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: "600", fill });

  function drawRoom(place: TownLayout["rooms"][number], theme: TownTheme) {
    const room = new Container();
    room.x = place.x;
    room.y = place.y;
    const { w, h } = place;

    // Base floor colour + rounded shell.
    room.addChild(new Graphics().roundRect(0, 0, w, h, 8).fill(theme.floor));

    // Tiled pixel floor in the interior (below the title bar, inside the walls),
    // clipped to a rounded rect so it never pokes past the shell corners.
    const ix = 6;
    const iy = TITLE_H;
    const iw = w - 12;
    const ih = h - TITLE_H - 6;
    const floor = new TilingSprite({ texture: tex.floor, width: iw, height: ih });
    floor.tileScale.set(TILE / tex.floor.width);
    floor.position.set(ix, iy);
    const clip = new Graphics().roundRect(ix, iy, iw, ih, 6).fill(0xffffff);
    floor.mask = clip;
    room.addChild(floor, clip);

    // A desk the characters work at, and a door on the wall.
    const desk = new Sprite(tex.desk);
    desk.anchor.set(0.5, 1);
    desk.scale.set(2);
    desk.position.set(w / 2, h - 12);
    room.addChild(desk);

    const door = new Sprite(tex.door);
    door.anchor.set(0.5, 1);
    door.scale.set(1.6);
    door.position.set(w - 26, h - 4);
    room.addChild(door);

    // Hairline border on top of the floor edge, then the project title.
    room.addChild(
      new Graphics().roundRect(0.5, 0.5, w - 1, h - 1, 8).stroke({ width: 1, color: theme.wall }),
    );
    const label = new Text({
      text: place.room.name,
      style: titleStyle(place.room.characters.length ? theme.title : theme.inkMuted),
    });
    label.x = 10;
    label.y = 9;
    room.addChild(label);

    world.addChild(room);
  }

  function drawCharacter(x: number, y: number, agentName: string | null, state: PresenceState, theme: TownTheme): CharView {
    const container = new Container();
    container.x = x;
    container.y = y;

    const sprite = new Sprite(tex.chars[charKeyForAgent(agentName)] ?? tex.chars.generic);
    sprite.anchor.set(0.5, 0.82);
    sprite.scale.set(CHAR_SCALE);
    if (state === "quiet") sprite.alpha = 0.55;
    container.addChild(sprite);

    if (state === "blocked") {
      container.addChild(
        new Graphics().circle(0, -4, 16).stroke({ width: 2, color: theme.blocked, alpha: 0.9 }),
      );
    }

    const icon = new Text({
      text: STATE_ICON[state],
      style: new TextStyle({ fontFamily: "sans-serif", fontSize: 14 }),
    });
    icon.anchor.set(0.5, 1);
    icon.y = -22;
    container.addChild(icon);

    world.addChild(container);
    return { container, sprite, icon, state, phase: Math.random() * Math.PI * 2, baseY: y };
  }

  function render(layout: TownLayout, theme: TownTheme) {
    world.removeChildren();
    views.forEach((v) => v.container.destroy({ children: true }));
    views = [];
    for (const place of layout.rooms) {
      drawRoom(place, theme);
      for (const c of place.chars) {
        views.push(drawCharacter(c.x, c.y, c.char.agentName, c.char.state, theme));
      }
    }
  }

  // Ambient motion: working bobs, quiet's 💤 drifts, blocked ticks a small alarm.
  app.ticker.add((ticker) => {
    if (reduced) return;
    elapsed += ticker.deltaMS / 1000;
    for (const v of views) {
      const t = elapsed + v.phase;
      if (v.state === "working") {
        v.container.y = v.baseY + Math.sin(t * 3) * 1.5;
      } else if (v.state === "quiet") {
        v.icon.y = -22 + Math.sin(t * 1.5) * 3;
        v.icon.alpha = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 1.5));
      } else if (v.state === "blocked") {
        v.icon.x = Math.sin(t * 12) * 1.2;
      }
    }
  });

  return {
    render(layout: TownLayout, theme: TownTheme) {
      reduced = theme.reducedMotion;
      render(layout, theme);
    },
    destroy() {
      world.destroy({ children: true });
    },
  };
}
