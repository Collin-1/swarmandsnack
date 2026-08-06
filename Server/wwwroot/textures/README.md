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
| `props.png` | 512×512 | 4×4 sheet of 128px cells — dock equipment, with alpha |
| `../backdrop.jpg` | 1536×1024 | Space behind the dock, set as the page background |

`TEXTURE_SCALE` in `game.js` shrinks each pattern so features land at the right
world size — a 512px wall tile has to scale down or a single plating segment
won't fit across a 44px-thick barrier.

The backdrop is a JPEG because it is opaque and photographic, and the page
scales it with `background-size: cover` regardless. The same image as a
2880×1920 PNG was 5.1MB against 0.12MB here, for no visible difference behind
the dock.

## Only the wall still needs mirroring

Measured wrap difference against interior variation (1.0 is a perfect wrap,
past ~3 is a visible line):

| | Horizontal | Vertical |
| --- | --- | --- |
| `floor.png` | 0.93 — clean | 1.52 — clean |
| `wall.png` | 1.57 — clean | **4.42 — seam** |
| `cap.png` | 1.65 — clean | not required to tile |
| `props.png` | n/a — never tiled | n/a |

So `TEXTURE_MIRROR` now mirrors **only the wall, and only vertically**. A tile
followed by a flipped copy always meets seamlessly, because each join places
identical rows side by side; the cost is symmetry every two tiles, which on
horizontal plating glimpsed through a 44px-thick barrier is not readable.

The floor tiles honestly on both axes and is used as-is — that is what removed
the mirror symmetry the deck used to repeat every two tiles.

`getCapPattern` still mirrors the cap horizontally even though it measures
clean, because the cap's brightest feature is a continuous lit strip running its
whole length. Symmetry in the dark ribs is invisible; a break in that strip
would not be.

If art is ever regenerated so a tile wraps properly, drop its entry from
`TEXTURE_MIRROR` and it will be used as-is.

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
