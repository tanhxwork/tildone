# Town sprite assets

Every shipped asset here is **CC0** — this repo is public. All art is Kenney
(CC0 1.0 Universal, public domain); only the desktop computer and the
leisure-spot props are self-authored (also CC0).

## Ground, roof & decorations — Kenney "Tiny Town" (CC0 1.0)

https://kenney.nl/assets/tiny-town — full licence text in
`world/Kenney-TinyTown-License.txt`. Selected 16×16 tiles live in `world/`
(original Tiny Town tile index → our name):

- 0 → `grass0.png`, 1 → `grass1.png`, 2 → `grass2.png` — grass ground + variation
- 48 → `roofL.png`, 49 → `roofM.png`, 50 → `roofR.png` — grey shingle roof,
  **tinted per project** by the renderer (neutral grey so any colour reads)
- 3 → `tree_orange.png`, 4 → `tree_pine.png` — scattered trees
- 5 → `bush.png`, 29 → `mushrooms.png` — scattered decorations

The renderer (`pixiScene.ts`) uses these for the ground, the project-tinted roof
over each house, and the tree/bush/mushroom decorations scattered across the
green. The house bodies below the roof are furnished cutaways (next section).

## Interiors & characters — Kenney "Roguelike Indoors" + "RPG Urban" (CC0 1.0)

Both are **CC0 1.0** (licence files: `kenney/roguelike-indoors-License.txt`,
`kenney/rpg-urban-License.txt`). The full spritesheets ship as-is —
`kenney/roguelike-indoors.png` and `kenney/rpg-urban.png` — and `assets.ts`
slices 16×16 sub-textures from them (the sheets are 16px tiles with a 1px gap,
so grid `(col,row)` is at pixel `(col*17, row*17)`; `sub()` does the slice).

**Interior furnishings** (`InteriorTiles`, from Roguelike Indoors unless noted),
composed by `pixiScene.ts → drawBuilding` into each house's open cutaway — a
project-tinted roof over a furnished office:

- `floor` = `24,0` (wood plank floor)
- `wall` = `18,4` **from RPG Urban** (tan brick back wall)
- `deskL`/`deskR` = `0,0` / `1,0` (a two-tile table = the desk)
- `plant` = `16,0` (potted plant, at both corners)
- `rug` = `5,9` (bordered rug under the desk)
- `artA`/`artB` = `20,12` / `19,12` (framed landscapes on the back wall)

The **desktop computer** is the one interior piece drawn in code (`assets.ts →
drawComputer`) — the rustic roguelike packs ship no monitor — so it stays CC0
and sits on the desk in the door column, where the `working` character rests
facing up into it.

**Characters** (`assets.ts → sliceChar`) come from RPG Urban, which stacks six
people three walk-frame rows each, with columns left/down/up/right at grid cols
`23/24/25/26`. Each agent identity maps to one person (`CHAR_INDEX`): claude=0
(green), codex=1 (red), cursor=2 (grey-hair), generic=3 (hard hat),
secretary=5 (headband). The walk cycle bobs stand→stepA→stand→stepB.

The shared **leisure-spot props** (bench / pond / campfire / garden) are still
drawn in code (`assets.ts → drawSpot`) — also CC0.

### Swapping art

Everything is a texture behind a stable shape (`DirFrames` for characters,
`InteriorTiles` for furniture), so swapping art is contained: repoint the grid
coordinates in `assets.ts`, or replace `sub(...)` with a different slicer / a
`canvasTexture(...)`. Keep every shipped asset CC0.
