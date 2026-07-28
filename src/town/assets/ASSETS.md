# Town sprite assets

Every shipped asset here is **CC0** — this repo is public. Two sources:

## World tiles — Kenney "Tiny Dungeon" (1.0)

https://kenney.nl/assets/tiny-dungeon — Licensed **CC0 1.0 Universal** (public
domain). Full text in `Kenney-License.txt`. Selected 16×16 tiles
(original Tiny Dungeon index → our name):

- 48 → `floor.png` — tiled ground of the green
- 58 → `wall.png` — building wall body
- 72 → `desk.png`
- 46 → `door.png` — the door on each building's front

## Characters & leisure props — procedurally generated (CC0)

The walking characters are **generated in code** (`assets.ts` →
`buildCharFrames`): a self-authored 4-direction walk cycle (down/up/left/right,
stand + two step frames) drawn to a canvas, tinted per agent identity
(Claude / Codex / Cursor / Secretary / generic). The shared leisure-spot props
(bench / pond / campfire / garden) are likewise drawn in code
(`drawSpot`). Being authored here they are CC0 by construction, and the town
ships with real directional walk animation + leisure props and
**zero new asset downloads**.

### Swapping in richer art

The renderer consumes a `DirFrames` shape (`Record<Dir, Texture[]>`) and never
sees how it was made. To upgrade to nicer Stardew-style art, replace
`buildCharFrames` with a spritesheet slicer returning the same shape — e.g.
**Piano no Renshu "15 Top-Down Character Sprites"** (CC0 1.0, 4-direction walk,
16px/24px — https://piano-no-renshu.itch.io/top-down-character-sprites) for the
characters and **Kenney "Tiny Town"** (CC0) for a grassy overworld ground. Drop
the PNGs into this directory, record their index→name mapping here, and point
the slicer at them. Keep every shipped asset CC0.
