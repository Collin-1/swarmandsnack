# World textures — orbital dock

The world surface is painted with these repeating textures, baked once into the
cached background layer, so texture detail costs nothing per frame.

`USE_IMAGE_TEXTURES` in `game.js` selects between this art and the procedural
fallbacks. It is currently **on**.

| File | Shipped | Role |
| --- | --- | --- |
| `floor.png` | 512×512 | Hangar decking under the whole world |
| `wall.png` | 512×512 | Bulkhead top surface, filling every wall rect |
| `cap.png` | 512×128 | Lit capping rail, drawn as a 14px lip along wall tops |
| `props.png` | 512×512 | 4×4 sheet of 128px cells — dock equipment |
| `../backdrop.png` | 2880×1920 | Space behind the dock, set as the page background |

`TEXTURE_SCALE` in `game.js` shrinks each pattern so features land at the right
world size — a 512px wall tile has to scale down or a single plating segment
won't fit across a 44px-thick barrier.

## Two of these do not tile, and are mirrored to compensate

Measured wrap difference against interior variation (1.0 is a perfect wrap,
past ~3 is a visible line):

| | Horizontal | Vertical |
| --- | --- | --- |
| `floor.png` | 1.1 — fine | **12.0 — seam** |
| `wall.png` | **7.6 — seam** | **11.3 — seam** |
| `cap.png` | 2.8 — marginal | not required to tile |
| `props.png` | perfect | perfect |

`TEXTURE_MIRROR` therefore mirrors the floor vertically and the wall on both
axes; `getCapPattern` mirrors the cap horizontally. A tile followed by a flipped
copy always meets seamlessly, because each join places identical rows or columns
side by side. The cost is mirror symmetry every two tiles, which on subtle
plating is invisible next to a bright seam line every 512px.

If the art is ever regenerated so it wraps properly, drop the corresponding
entry from `TEXTURE_MIRROR` and the tile will be used as-is.

## Prop sheet cell map

The renderer treats specific cells specially, so the order matters:

| Cells | Contents | Used as |
| --- | --- | --- |
| 3, 4, 5 | crystal formation, plasma bloom, conduit tangle | **Thickets only.** Dozens overlap into one mass, and thickets are solid — so a glowing mass always means impassable |
| 9, 10, 11 | holo-banners (magenta, cyan, amber) | Hung on barrier faces |
| 2, 15 | hull debris, shrapnel | Grouped into scatter piles |
| the rest | crates, cargo pods, drums, plating, data spire, sensor dish, power core | Single objects stood against walls and in corners |

Growth is deliberately kept off wall faces. Mixing it with walk-through scenery
would break the "glowing means solid" rule, and its cyan competes with the cyan
player token.
