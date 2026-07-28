// Town textures — Kenney "Tiny Dungeon" (CC0). See assets/ASSETS.md.
//
// Vite turns each PNG import into a URL; Pixi's Assets.load fetches it and we
// force nearest-neighbour so the 16px art stays crisp when scaled up. This module
// is the only place that imports the PNGs, so pixiScene stays a pure renderer over
// the TownTextures it is handed (and the standalone demo can supply its own).

import { Assets, type Texture } from "pixi.js";
import floorUrl from "./assets/floor.png";
import floor2Url from "./assets/floor2.png";
import wallUrl from "./assets/wall.png";
import deskUrl from "./assets/desk.png";
import doorUrl from "./assets/door.png";
import charClaude from "./assets/char-claude.png";
import charCodex from "./assets/char-codex.png";
import charCursor from "./assets/char-cursor.png";
import charSecretary from "./assets/char-secretary.png";
import charGeneric from "./assets/char-generic.png";

export interface TownTextures {
  floor: Texture;
  wall: Texture;
  desk: Texture;
  door: Texture;
  /** Character sprite per agent key (see charKeyForAgent). */
  chars: Record<string, Texture>;
}

const CHAR_URLS: Record<string, string> = {
  claude: charClaude,
  codex: charCodex,
  cursor: charCursor,
  secretary: charSecretary,
  generic: charGeneric,
};

let cache: TownTextures | null = null;

export async function loadTownTextures(): Promise<TownTextures> {
  if (cache) return cache;
  const urls: Record<string, string> = {
    floor: floorUrl,
    floor2: floor2Url,
    wall: wallUrl,
    desk: deskUrl,
    door: doorUrl,
    ...CHAR_URLS,
  };
  const loaded: Record<string, Texture> = {};
  await Promise.all(
    Object.entries(urls).map(async ([k, url]) => {
      const tex = (await Assets.load(url)) as Texture;
      tex.source.scaleMode = "nearest";
      loaded[k] = tex;
    }),
  );
  cache = {
    floor: loaded.floor,
    wall: loaded.wall,
    desk: loaded.desk,
    door: loaded.door,
    chars: {
      claude: loaded.claude,
      codex: loaded.codex,
      cursor: loaded.cursor,
      secretary: loaded.secretary,
      generic: loaded.generic,
    },
  };
  return cache;
}
