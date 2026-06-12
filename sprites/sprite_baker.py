#!/usr/bin/env python3
"""
sprite_baker.py — bake mob descriptions into 64×64 pixel-art sprites.

Usage:
    python sprite_baker.py mobs.json            # bake all mobs
    python sprite_baker.py mobs.json skeleton   # bake one mob by id
"""

import anthropic
import hashlib
import json
import os
import sys
import time

import requests
from PIL import Image

COMFY_URL   = "http://localhost:8188"
OUT_DIR     = os.path.join(os.path.dirname(__file__), "out")
SPRITE_SIZE = 64
PALETTE_N   = 24

PROMPT_BUILDER_SYSTEM = """\
You translate mob descriptions into SDXL prompts for pixel art game sprites.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- Lead positive with silhouette-defining features (body type, dominant form)
- Always append to positive: pixel art, game sprite, front-facing portrait,
  green background, clean linework, DCSS style
- Always include in negative: blurry, 3d render, photorealistic, multiple
  poses, text, watermark, anime
- Keep positive under 75 tokens
- Describe visually only — no lore proper nouns
"""


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------

def build_prompt(mob: dict) -> dict:
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=256,
        system=PROMPT_BUILDER_SYSTEM,
        messages=[{"role": "user", "content": mob["description"]}],
    )
    return json.loads(msg.content[0].text)


# ---------------------------------------------------------------------------
# ComfyUI interaction
# ---------------------------------------------------------------------------

def load_workflow() -> dict:
    wf_path = os.path.join(os.path.dirname(__file__), "workflow.json")
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
    return wf


def submit_to_comfy(workflow: dict) -> str:
    r = requests.post(f"{COMFY_URL}/prompt", json={"prompt": workflow}, timeout=10)
    r.raise_for_status()
    return r.json()["prompt_id"]


def poll_comfy(prompt_id: str, timeout: int = 300) -> str:
    """Return the output filename, polling until done or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(f"{COMFY_URL}/history/{prompt_id}", timeout=10).json()
        if prompt_id in resp:
            outputs = resp[prompt_id]["outputs"]
            # Find the first node that has images output, regardless of node name.
            for node_out in outputs.values():
                images = node_out.get("images")
                if images:
                    return images[0]["filename"]
            raise RuntimeError(f"No image output found for prompt {prompt_id}")
        time.sleep(1)
    raise TimeoutError(f"ComfyUI did not finish prompt {prompt_id} within {timeout}s")


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

CHROMA_KEY_COLOR = (0, 255, 0)   # pure green — matches background in positive prompt
CHROMA_THRESHOLD = 80            # per-channel tolerance


def remove_green_background(img: Image.Image) -> Image.Image:
    """Replace solid green background pixels with transparency."""
    rgba = img.convert("RGBA")
    pixels = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if (
                abs(r - CHROMA_KEY_COLOR[0]) < CHROMA_THRESHOLD
                and abs(g - CHROMA_KEY_COLOR[1]) < CHROMA_THRESHOLD
                and abs(b - CHROMA_KEY_COLOR[2]) < CHROMA_THRESHOLD
            ):
                pixels[x, y] = (0, 0, 0, 0)
    return rgba


def post_process(src_path: str, mob_id: str) -> str:
    """Downsample → chroma-key → palette quantize. Returns output path."""
    img = Image.open(src_path).convert("RGB")

    # 1. Downsample first so quantize works on final pixels.
    img = img.resize((SPRITE_SIZE, SPRITE_SIZE), Image.NEAREST)

    # 2. Remove green background to get RGBA.
    img = remove_green_background(img)

    # 3. Quantize palette on RGB channel, then restore alpha.
    alpha = img.split()[3]
    rgb   = img.convert("RGB").quantize(colors=PALETTE_N, method=Image.MEDIANCUT)
    rgb   = rgb.convert("RGBA")
    rgb.putalpha(alpha)

    out_path = os.path.join(OUT_DIR, f"{mob_id}.png")
    rgb.save(out_path)
    return out_path


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

MANIFEST_PATH = os.path.join(OUT_DIR, "manifest.json")


def load_manifest() -> dict:
    if os.path.exists(MANIFEST_PATH):
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    return {"sprite_size": SPRITE_SIZE, "mobs": {}}


def save_manifest(manifest: dict):
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)


def description_hash(mob: dict) -> str:
    return hashlib.sha256(mob["description"].encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Core bake
# ---------------------------------------------------------------------------

def bake(mob: dict, manifest: dict, force: bool = False) -> bool:
    """Bake one mob. Returns True if a new sprite was generated."""
    mob_id   = mob["id"]
    new_hash = description_hash(mob)

    existing = manifest["mobs"].get(mob_id, {})
    if not force and existing.get("hash") == new_hash:
        print(f"  skip {mob_id} (unchanged)")
        return False

    print(f"  building prompt for {mob_id}...")
    prompt = build_prompt(mob)

    print(f"  submitting to ComfyUI...")
    workflow  = load_workflow()
    wf        = inject_prompt(workflow, prompt)
    prompt_id = submit_to_comfy(wf)

    print(f"  waiting for {prompt_id}...")
    filename = poll_comfy(prompt_id)

    comfy_output_dir = os.path.join(os.path.dirname(__file__), "..", "comfy_output")
    src_path = os.path.join(comfy_output_dir, filename)

    print(f"  post-processing...")
    out_path = post_process(src_path, mob_id)

    manifest["mobs"][mob_id] = {
        "hash":   new_hash,
        "prompt": prompt,
        "sprite": os.path.relpath(out_path, os.path.dirname(MANIFEST_PATH)),
    }

    print(f"  done → {out_path}")
    return True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    mobs_path = sys.argv[1]
    filter_id = sys.argv[2] if len(sys.argv) > 2 else None

    with open(mobs_path) as f:
        mobs = json.load(f)

    if filter_id:
        mobs = [m for m in mobs if m["id"] == filter_id]
        if not mobs:
            print(f"No mob with id '{filter_id}' found.")
            sys.exit(1)

    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = load_manifest()

    baked = 0
    for mob in mobs:
        print(f"[{mob['id']}]")
        if bake(mob, manifest):
            baked += 1
            save_manifest(manifest)  # save after each so partial runs aren't lost

    print(f"\nDone. {baked}/{len(mobs)} sprites (re)baked.")


if __name__ == "__main__":
    main()
