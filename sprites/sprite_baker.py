#!/usr/bin/env python3
"""
sprite_baker.py — bake descriptions into pixel-art sprites.

Two kinds of subject, sharing the same ComfyUI + Haiku + Pillow plumbing:

    mob   — 64x64 full-figure creature/character sprites (default)
    item  — 64x64 single-object inventory icons (potion, sword, claw, scroll)

Usage:
    python sprite_baker.py mobs.json                  # bake all mobs
    python sprite_baker.py mobs.json skeleton         # bake one mob by id
    python sprite_baker.py --kind item items.json     # bake all item icons
    python sprite_baker.py --kind item items.json health_potion
    python sprite_baker.py --kind item items.json --force

Add --force to re-bake even if the description is unchanged.

mob icons land in   sprites/out/<id>.png        (packed into an atlas by pack_atlas.py)
item icons land in  client/public/sprites/<id>.png  (loaded directly by the client)
"""

import anthropic
import hashlib
import json
import os
import random
import sys
import time

import requests
from PIL import Image, ImageChops, ImageFilter
from rembg import remove as rembg_remove

COMFY_URL   = "http://localhost:8188"
SPRITE_SIZE = 64
PALETTE_N   = 24

HERE        = os.path.dirname(__file__)
CLIENT_SPRITES = os.path.join(HERE, "..", "client", "public", "sprites")

MOB_PROMPT_SYSTEM = """\
You translate mob descriptions into SDXL prompts for pixel art game sprites.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- Lead positive with silhouette-defining features (body type, dominant form)
- Always append to positive: pixel art, 16-bit RPG sprite, chunky pixels,
  bold outlines, limited color palette, simple shapes, full body, full figure,
  centered, fills frame, single creature, isolated subject, one single pose,
  single viewpoint, DCSS style
- For four-legged animals, specify a side profile view (a clear standing
  silhouette); for humanoids and bipeds, a front view facing the viewer
- Always include in negative: blurry, 3d render, photorealistic, multiple
  poses, character sheet, model sheet, reference sheet, turnaround, character
  turnaround, multiple views, multiple angles, side-by-side, T-pose,
  text, watermark, anime, portrait,
  cropped, cut off, partial body, close-up, headshot, detailed, fine detail,
  smooth shading, anti-aliased, realistic texture, multiple creatures,
  duplicate, duplicated, mirror, mirrored, two figures, two creatures,
  two animals, second creature, extra creature, extra subject, multiple
  subjects, group, pair, cloned, clone, repeated subject, collage,
  soft edges, noisy, muddy colors
- Keep positive under 75 tokens
- Describe visually only — no lore proper nouns
- For animals and creatures with thin features (legs, beaks, necks), simplify
  them to bold blocky shapes — describe as "stocky" or "chunky" in the prompt
"""

ITEM_PROMPT_SYSTEM = """\
You translate item descriptions into SDXL prompts for pixel-art game inventory icons.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- The subject is a SINGLE inanimate object or trophy (a potion, a sword, a claw,
  a scroll, a gem) shown as an inventory icon — never a creature, person, or scene
- Lead positive with the object's defining shape and material
- Always append to positive: game item icon, inventory icon, pixel art,
  16-bit RPG, chunky pixels, bold black outline, limited color palette,
  single object, centered, fills frame, plain background, isolated subject,
  DCSS style
- Always include in negative: creature, animal, person, character, face, hands,
  full body, scene, landscape, background scenery, multiple objects, duplicate,
  blurry, 3d render, photorealistic, text, watermark, anime, soft edges,
  smooth shading, anti-aliased, drop shadow, gradient background
- Keep positive under 60 tokens
- Describe visually only — no lore proper nouns
"""

# Per-kind config. `out` is where the finished PNGs land; `manifest` is the
# hash-skip cache (kept out of any web-served dir). `section` names the entry
# bucket inside the manifest so kinds never collide.
KINDS = {
    "mob": {
        "out":      os.path.join(HERE, "out"),
        "manifest": os.path.join(HERE, "out", "manifest.json"),
        "system":   MOB_PROMPT_SYSTEM,
        "section":  "mobs",
    },
    "item": {
        "out":      CLIENT_SPRITES,
        "manifest": os.path.join(HERE, "items_manifest.json"),
        "system":   ITEM_PROMPT_SYSTEM,
        "section":  "items",
    },
}


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

def build_prompt(subject: dict, system: str) -> dict:
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=600,
        system=system,
        messages=[{"role": "user", "content": subject["description"]}],
    )
    raw = msg.content[0].text if msg.content else ""
    # strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    return json.loads(raw)


# ---------------------------------------------------------------------------
# ComfyUI interaction
# ---------------------------------------------------------------------------

def load_workflow() -> dict:
    wf_path = os.path.join(HERE, "workflow.json")
    with open(wf_path) as f:
        return json.load(f)


def inject_prompt(workflow: dict, prompt: dict) -> dict:
    """
    Find CLIPTextEncode nodes by their _meta title and inject pos/neg text.
    Titles must be 'positive' and 'negative' in the exported workflow JSON.
    """
    wf = json.loads(json.dumps(workflow))  # deep copy
    for node in wf.values():
        title = node.get("_meta", {}).get("title", "").lower()
        if title == "positive" and node.get("class_type") == "CLIPTextEncode":
            node["inputs"]["text"] = prompt["positive"]
        elif title == "negative" and node.get("class_type") == "CLIPTextEncode":
            node["inputs"]["text"] = prompt["negative"]
        # Randomize the seed each bake — a fixed seed locks the composition
        # (notably the two-figure "character sheet" layout) across re-runs.
        elif node.get("class_type") == "KSampler":
            node["inputs"]["seed"] = random.randint(0, 2**63 - 1)
    return wf


def submit_to_comfy(workflow: dict) -> str:
    r = requests.post(f"{COMFY_URL}/prompt", json={"prompt": workflow}, timeout=10)
    r.raise_for_status()
    return r.json()["prompt_id"]


def poll_comfy(prompt_id: str, timeout: int = 300) -> dict:
    """Return the first output image dict (filename, subfolder, type), polling until done."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(f"{COMFY_URL}/history/{prompt_id}", timeout=10).json()
        if prompt_id in resp:
            outputs = resp[prompt_id]["outputs"]
            for node_out in outputs.values():
                images = node_out.get("images")
                if images:
                    return images[0]
            raise RuntimeError(f"No image output found for prompt {prompt_id}")
        time.sleep(1)
    raise TimeoutError(f"ComfyUI did not finish prompt {prompt_id} within {timeout}s")


def fetch_comfy_image(image_info: dict) -> Image.Image:
    """Download an image from ComfyUI's /view endpoint."""
    params = {
        "filename": image_info["filename"],
        "subfolder": image_info.get("subfolder", ""),
        "type": image_info.get("type", "output"),
    }
    resp = requests.get(f"{COMFY_URL}/view", params=params, timeout=30)
    resp.raise_for_status()
    from io import BytesIO
    return Image.open(BytesIO(resp.content))


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def remove_background(img: Image.Image) -> Image.Image:
    return rembg_remove(img)


# Near-black outline traced around the sprite silhouette for that hand-drawn,
# DCSS-style read. Computed from the alpha mask so it hugs the actual shape.
OUTLINE_COLOR = (26, 22, 30, 255)


def add_outline(img: Image.Image, thickness: int = 1) -> Image.Image:
    alpha   = img.split()[3]
    mask    = alpha.point(lambda a: 255 if a > 128 else 0)
    dilated = mask.filter(ImageFilter.MaxFilter(2 * thickness + 1))
    edge    = ImageChops.subtract(dilated, mask)  # ring just outside the shape

    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", img.size, OUTLINE_COLOR), (0, 0), edge)
    out.paste(img, (0, 0), img)  # subject on top, keeping its interior
    return out


def post_process(img: Image.Image, sprite_id: str, out_dir: str) -> str:
    """Cut background → fit to square. Returns output path.

    The image arrives already grid-clean and palette-reduced from the
    PixelArtDetector node, so no downsample/quantize is needed here — we just
    drop the background and center it in a square SPRITE_SIZE frame.
    """
    img = remove_background(img.convert("RGB"))  # RGBA

    # Fit into a square SPRITE_SIZE canvas preserving aspect ratio (NEAREST so
    # the clean pixels stay crisp), centered. Leave a 1px margin so the outline
    # pass below never clips at the frame edge.
    fit = SPRITE_SIZE - 2
    img.thumbnail((fit, fit), Image.NEAREST)
    canvas = Image.new("RGBA", (SPRITE_SIZE, SPRITE_SIZE), (0, 0, 0, 0))
    canvas.paste(img, ((SPRITE_SIZE - img.width) // 2,
                       (SPRITE_SIZE - img.height) // 2))

    canvas = add_outline(canvas)

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{sprite_id}.png")
    canvas.save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def load_manifest(path: str, section: str) -> dict:
    if os.path.exists(path):
        with open(path) as f:
            manifest = json.load(f)
        manifest.setdefault(section, {})
        return manifest
    return {"sprite_size": SPRITE_SIZE, section: {}}


def save_manifest(manifest: dict, path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)


def description_hash(subject: dict) -> str:
    return hashlib.sha256(subject["description"].encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Core bake
# ---------------------------------------------------------------------------

def bake(subject: dict, manifest: dict, cfg: dict, force: bool = False) -> bool:
    """Bake one subject. Returns True if a new sprite was generated."""
    section  = cfg["section"]
    sub_id   = subject["id"]
    new_hash = description_hash(subject)

    existing = manifest[section].get(sub_id, {})
    if not force and existing.get("hash") == new_hash:
        print(f"  skip {sub_id} (unchanged)")
        return False

    print(f"  building prompt for {sub_id}...")
    prompt = build_prompt(subject, cfg["system"])

    print(f"  submitting to ComfyUI...")
    workflow  = load_workflow()
    wf        = inject_prompt(workflow, prompt)
    prompt_id = submit_to_comfy(wf)

    print(f"  waiting for {prompt_id}...")
    image_info = poll_comfy(prompt_id)

    print(f"  downloading {image_info['filename']}...")
    img = fetch_comfy_image(image_info)

    print(f"  post-processing...")
    out_path = post_process(img, sub_id, cfg["out"])

    manifest[section][sub_id] = {
        "hash":   new_hash,
        "prompt": prompt,
        "sprite": os.path.relpath(out_path, os.path.dirname(cfg["manifest"])),
    }

    print(f"  done → {out_path}")
    return True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    force = "--force" in args
    args = [a for a in args if a != "--force"]

    kind = "mob"
    if "--kind" in args:
        i = args.index("--kind")
        kind = args[i + 1]
        del args[i:i + 2]

    if kind not in KINDS:
        print(f"Unknown kind '{kind}'. Choose one of: {', '.join(KINDS)}")
        sys.exit(1)
    cfg = KINDS[kind]

    if not args:
        print("Missing input JSON path.")
        sys.exit(1)

    subjects_path = args[0]
    filter_id = args[1] if len(args) > 1 else None

    with open(subjects_path) as f:
        subjects = json.load(f)

    if filter_id:
        subjects = [s for s in subjects if s["id"] == filter_id]
        if not subjects:
            print(f"No {kind} with id '{filter_id}' found.")
            sys.exit(1)

    manifest = load_manifest(cfg["manifest"], cfg["section"])

    baked = 0
    for subject in subjects:
        print(f"[{subject['id']}]")
        if bake(subject, manifest, cfg, force=force):
            baked += 1
            save_manifest(manifest, cfg["manifest"])  # save after each so partial runs aren't lost

    print(f"\nDone. {baked}/{len(subjects)} {kind} sprites (re)baked.")


if __name__ == "__main__":
    main()
