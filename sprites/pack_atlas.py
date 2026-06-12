#!/usr/bin/env python3
"""
pack_atlas.py — pack baked sprites into a spritesheet atlas.

Usage:
    python pack_atlas.py          # reads out/manifest.json, writes out/atlas.png
    python pack_atlas.py --dry    # print layout without writing files
"""

import json
import math
import os
import sys

from PIL import Image

OUT_DIR       = os.path.join(os.path.dirname(__file__), "out")
MANIFEST_PATH = os.path.join(OUT_DIR, "manifest.json")
ATLAS_PATH    = os.path.join(OUT_DIR, "atlas.png")


def pack(dry: bool = False):
    with open(MANIFEST_PATH) as f:
        manifest = json.load(f)

    mobs        = manifest["mobs"]
    sprite_size = manifest["sprite_size"]
    mob_ids     = sorted(mobs.keys())
    count       = len(mob_ids)

    if count == 0:
        print("No sprites in manifest.")
        return

    # Square grid — next power-of-two cols so atlas is always PoT wide.
    cols       = 2 ** math.ceil(math.log2(math.ceil(math.sqrt(count))))
    rows       = math.ceil(count / cols)
    atlas_w    = cols * sprite_size
    atlas_h    = rows * sprite_size

    print(f"{count} sprites → {cols}×{rows} grid → {atlas_w}×{atlas_h}px atlas")

    if dry:
        for i, mob_id in enumerate(mob_ids):
            col, row = i % cols, i // cols
            x, y     = col * sprite_size, row * sprite_size
            print(f"  {mob_id:30s} ({x:4d}, {y:4d})")
        return

    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    coords = {}

    for i, mob_id in enumerate(mob_ids):
        sprite_rel = mobs[mob_id]["sprite"]
        sprite_path = os.path.join(OUT_DIR, sprite_rel)
        sprite = Image.open(sprite_path).convert("RGBA")

        col, row = i % cols, i // cols
        x, y     = col * sprite_size, row * sprite_size
        atlas.paste(sprite, (x, y))

        coords[mob_id] = {"x": x, "y": y, "w": sprite_size, "h": sprite_size}

    atlas.save(ATLAS_PATH)
    print(f"Atlas written → {ATLAS_PATH}")

    manifest["atlas"]  = os.path.relpath(ATLAS_PATH, OUT_DIR)
    manifest["coords"] = coords
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Manifest updated → {MANIFEST_PATH}")


if __name__ == "__main__":
    dry = "--dry" in sys.argv
    pack(dry=dry)
