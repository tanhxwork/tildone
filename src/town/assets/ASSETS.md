# Town sprite assets

Every shipped asset here is **CC0** — this repo is public. Two sources:

## World tiles — Kenney "Tiny Town" (CC0 1.0)

https://kenney.nl/assets/tiny-town — Licensed **CC0 1.0 Universal** (public
domain); full text in `world/Kenney-TinyTown-License.txt`. Selected 16×16 tiles
live in `world/` (original Tiny Town tile index → our name):

- 0 → `grass0.png`, 1 → `grass1.png`, 2 → `grass2.png` — grass ground + variation
- 12 → `dirt.png` — the dirt doorstep under each door
- 48 → `roofL.png`, 49 → `roofM.png`, 50 → `roofR.png` — grey shingle roof,
  **tinted per project** by the renderer (neutral grey so any colour reads)
- 72 → `wall.png` — house wall body
- 73 → `door2.png` — the arched door
- 55 → `window.png` — house window
- 3 → `tree_orange.png`, 4 → `tree_pine.png` — scattered trees
- 5 → `bush.png`, 29 → `mushrooms.png` — scattered decorations
- 44 → `fence.png`, 57 → `barrel.png` — props

The renderer (`pixiScene.ts`) composes houses from wall + tinted-roof + door +
window tiles, tiles the ground in grass (with sprinkled variation), and scatters
the tree/bush/mushroom decorations deterministically across the green.

## Characters, leisure props & interiors — procedurally generated (CC0)

The walking characters are **generated in code** (`assets.ts` →
`buildCharFrames`): a self-authored 4-direction walk cycle (down/up/left/right,
stand + two step frames) drawn to a canvas, tinted per agent identity
(Claude / Codex / Cursor / Secretary / generic). The shared leisure-spot props
(bench / pond / campfire / garden) are likewise drawn in code (`drawSpot`).

The house **interior furnishings** are the same technique — each is one 16px
tile drawn to a canvas (`assets.ts` → `drawFloor` / `drawWall` / `drawDesk` /
`drawComputer` / `drawPlant` / `drawBookshelf` / `drawRug` / `drawPicture`).
The renderer (`pixiScene.ts` → `drawBuilding`) composes them into each house's
open cutaway: a project-tinted roof over a furnished office — a desk with a
glowing computer in the door column (where the `working` character sits, facing
up into it), a bookshelf and framed picture on the back wall, plants at the
corners, a rug under the desk.

Being authored here they are all CC0 by construction.

### Swapping in richer character art

The renderer consumes a `DirFrames` shape (`Record<Dir, Texture[]>`) and never
sees how it was made. To upgrade the *characters* to nicer Stardew-style
sprites, replace `buildCharFrames` with a spritesheet slicer returning the same
shape — e.g. **Piano no Renshu "15 Top-Down Character Sprites"** (CC0 1.0,
4-direction walk, 16/24px — https://piano-no-renshu.itch.io/top-down-character-sprites).
Drop the PNGs into `world/` (or a `chars/` dir), record their index→name mapping
here, and point the slicer at them. Keep every shipped asset CC0.
