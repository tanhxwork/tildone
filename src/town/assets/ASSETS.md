# Town sprite assets

Every shipped asset here is **CC0** — this repo is public. The photographic-style
tiles (ground, roof, green decorations, characters) are Kenney (CC0 1.0
Universal, public domain); everything drawn procedurally in `assets.ts` is
self-authored (also CC0): the desktop computer, the leisure-spot props, the
road/plaza/facade tiles, the fountain, the street lamp, and the cloud shadow.

## Ground, roof & decorations — Kenney "Tiny Town" (CC0 1.0)

https://kenney.nl/assets/tiny-town — full licence text in
`world/Kenney-TinyTown-License.txt`. Selected 16×16 tiles live in `world/`
(original Tiny Town tile index → our name):

- 0 → `grass0.png`, 1 → `grass1.png`, 2 → `grass2.png` — grass ground + variation
- 3 → `tree_orange.png`, 4 → `tree_pine.png` — scattered trees
- 5 → `bush.png`, 29 → `mushrooms.png` — scattered decorations

The renderer (`pixiScene.ts`) uses these for the ground and for the
tree/bush/mushroom decorations, which are scattered in **clumps** (a coarse grove
mask) rather than by an independent per-tile roll, and never on a lot, a path or
up against a street.

The **roof** used to be three Kenney Tiny Town tiles (48/49/50). It is now drawn
in code (`drawRoof`, self-authored → CC0) in three parts — `ridge`, `body`,
`eave` — because a house deep enough to hold rooms needs several roof rows, and
repeating a single ridge tile down them read as a stack of separate bars rather
than one sloped surface. Still tinted per project (drawn light grey so any colour
multiplies cleanly).

## Interiors & characters — Kenney "Roguelike Indoors" + "RPG Urban" (CC0 1.0)

Both are **CC0 1.0** (licence files: `kenney/roguelike-indoors-License.txt`,
`kenney/rpg-urban-License.txt`). The full spritesheets ship as-is —
`kenney/roguelike-indoors.png` and `kenney/rpg-urban.png` — and `assets.ts`
slices 16×16 sub-textures from them (the sheets are 16px tiles with a 1px gap,
so grid `(col,row)` is at pixel `(col*17, row*17)`; `sub()` does the slice).

**Interior furnishings** (`InteriorTiles`, from Roguelike Indoors unless noted),
composed by `pixiScene.ts → drawBuilding` into each house's open cutaway — a
project-tinted roof over a furnished office:

- `floor` = `24,0` (wood plank floor — the walkable aisle the workers sit on)
- `wall` = `18,4` **from RPG Urban** (tan brick back wall)
- `deskL`/`deskR` = `0,0` / `1,0` (two table halves, tiled to form a long desk
  counter across the workstation columns)
- `plant` = `16,0` (potted plant, at both back corners)
- `rug` = `5,9` (bordered rug)
- `artA`/`artB` = `20,12` / `19,12` (framed landscapes on the back wall)

The **desktop computer** is drawn in code (`assets.ts → drawComputer`) — the
rustic roguelike packs ship no monitor — so it stays CC0. One monitor sits on
the desk counter at **each** workstation column; a `working` character walks in
through the building's **single door** and sits on the seat tile below its
monitor, facing up into it (several sessions on one project fill several desks).
Offices are now **enclosed**: the front is a wall with one door, so the aisle is
a cul-de-sac — the size of the office (2 / 4 / 6 desks) scales with the
project's open-task count (`world.ts → tierFor`).

**Pavement & facade** (`PavementTiles` + `FacadeTiles`, all self-authored → CC0,
drawn in `assets.ts`): `road` and `plaza` pavement tiles (the street lattice and
the central commons), a `door` for the front-wall gap, a dark `window` on the
facade, and a warm additive `windowGlow` the renderer lays over a window when
the project has a live session — so a busy office literally lights up, brighter
as the day/night cycle darkens (`daynight.ts`).

**Characters** (`assets.ts → sliceChar`) come from RPG Urban, which stacks six
people three walk-frame rows each, with columns left/down/up/right at grid cols
`23/24/25/26`. Each agent identity maps to one person (`CHAR_INDEX`): claude=0
(green), codex=1 (red), cursor=2 (grey-hair), generic=3 (hard hat),
secretary=5 (headband). The walk cycle bobs stand→stepA→stand→stepB.

The shared **leisure-spot props** (bench / pond / campfire / garden) are still
drawn in code (`assets.ts → drawSpot`) — also CC0. Each kind is a frame array;
the campfire (flame flicker) and pond (glint ripple) carry 3 frames the renderer
cycles, while bench and garden are single-frame. The plaza's **fountain**
centrepiece (`assets.ts → drawFountain`, a 3-frame water shimmer the renderer
cycles) is likewise self-authored → CC0; it sits on the plaza's centre tile,
which `world.ts` blocks so idle characters gather around it rather than stand in
the water. **Street lamps**
(`assets.ts → drawLamp`, self-authored → CC0) line the south side of the roads;
`pixiScene.ts` gives each a warm glow that the day/night cycle lights at dusk
(reusing the window-glow texture), so the streets come alive at night too. Lamp
positions come from `world.ts` (`TownWorld.lamps`) and are blocked tiles, so
pathfinding routes characters around a post rather than through it. Soft
**cloud shadows** (`assets.ts → drawCloudShadow`, self-authored → CC0) drift
slowly across the terrain — a render-only layer between the ground and the
buildings, so shadows sweep the land without muddying the sprites on top.

### Swapping art

Everything is a texture behind a stable shape (`DirFrames` for characters,
`InteriorTiles` for furniture), so swapping art is contained: repoint the grid
coordinates in `assets.ts`, or replace `sub(...)` with a different slicer / a
`canvasTexture(...)`. Keep every shipped asset CC0.

## Home furniture, lots and the commons (self-authored → CC0)

Everything below is drawn in code in `assets.ts`, so it stays CC0 and stays
consistent — the Kenney roguelike pack is rustic and ships no coherent modern set
(a bed that matches the sofa that matches the kitchen counter).

- **`drawFurniture`** — `counter`, `sink`, `table`, `chair`, `sofa`, `bookshelf`,
  `bed`, `nightstand`. Top-down, one light direction. `desk`, `rug` and `plant`
  still come from the Kenney interior sheet. These furnish the room plan
  `world.ts → placeBuilding` lays out: a workroom of desks across the back, then
  a kitchen and a lounge off a hall, with a bed nook in the larger tiers.
- **`drawProp`** — `planter`, `noticeboard`, `market`, `coffeecart`, `cafetable`:
  the blocked furnishings of the commons. They are "triangulation" objects —
  something to stand at and around, which is what makes a group form in a square.
- **`drawFence`** — the picket fence ringing each lot. The gaps between pickets
  are transparent so the ground shows through; a solid block of pickets reads as
  masonry rather than as a fence.
- **`drawYard` / `drawPath`** — mown lot grass and the worn route from a front
  door to its gate. The contrast against wild grass is the point: managed ground
  is the cheapest signal that somebody lives there.
