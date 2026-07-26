# World textures

The world floor and walls are painted with repeating textures baked into the
cached background layer, so texture detail costs nothing per frame.

`USE_IMAGE_TEXTURES` in `game.js` selects between the art in this folder and the
procedural fallbacks (`buildFloorTexture` / `buildWallTexture`). It is currently
**on**, using the four files below.

| File | Shipped | Requirements |
| --- | --- | --- |
| `floor.png` | 512×512 | **Seamlessly tiling.** Top-down dirt/flagstone, flat even lighting — no baked shadows or highlights, they will repeat visibly. |
| `wall.png` | 512×512 | **Seamlessly tiling.** Top-down mossy stone blocks. Keep it darker than the floor so walls read as solid. |
| `cap.png` | 512×128 | Capstone strip drawn as a lip along wall tops. Should tile left–right; see the note below. |
| `props.png` | 512×512 | 4×4 sheet of 128px cells, transparent background. Cells 9–11 are treated as banners and hung on walls; the rest are scattered on open floor. |

Sizes here are larger than they appear in game — `TEXTURE_SCALE` in `game.js`
shrinks each pattern so features land at the right world size (walls are only
44px thick, so a 512px tile must scale down or one stone course won't fit
across a wall).

## The cap tile does not wrap, and is mirrored to compensate

`cap.png` as exported has a real horizontal seam: its edge columns differ by
about 21× its interior variation, which shows up as a line every tile. Rather
than depend on the art being fixed, `getCapPattern` mirrors the tile — a tile
followed by a flipped copy always meets seamlessly, because each join places
identical columns side by side. Measured after mirroring: 0× (perfect).

If the generator is fixed at source, the mirror can be dropped. The likely bug
is that capstone *tone* is indexed with `Math.floor(px / blockWidth)` while the
joint positions are jittered, so at the wrap two differently-toned capstones
meet with no mortar line between them. Deriving the tone from the same jittered
block index used for the joints should fix it.

Notes for whoever makes the art:

- Tiling is the hard requirement. A beautiful non-tiling texture will show a
  grid of seams across the whole world.
- Scale: walls are 44px thick, so roughly 5–6 stone courses should fit across
  a 256px tile for the blocks to read at gameplay size.
- Keep both textures low-contrast and mid-to-dark. Player colours (cyan, rose,
  amber, violet, lime, orange, sky, fuchsia) must stay readable on top.
- Relief is added in code (drop shadow, lit top lip, shaded base), so the art
  does not need baked-in edge lighting.

Optional extras that would need a small amount of new drawing code — say the
word and they can be wired up the same way: prop sprite sheet (rubble,
foliage, banners, crates) and floor decals.
