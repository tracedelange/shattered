# Silicon Soup — Sprite Generation Pipeline

## Overview

Offline batch pipeline for generating DCSS-style pixel art portraits from mob descriptions. All sprites baked ahead of time into a static library — no image generation at runtime.

**Design constraints:**
- Local M2 MacBook — Apple Silicon (MPS backend), no discrete VRAM budget
- DCSS aesthetic: ~64×64, limited palette, hard pixel edges, front-facing
- LLM (Haiku) translates natural-language mob descriptions into SDXL prompt grammar
- Output: spritesheet atlas + JSON manifest for the canvas renderer

---

## Stack

| Component | Choice | Notes |
|---|---|---|
| Inference backend | ComfyUI | Scriptable REST API, headless, workflow-as-JSON. MPS support on Apple Silicon. |
| Base model | DreamShaperXL | Good creature/character generalization. Use fp16 weights to fit comfortably in unified memory. |
| LoRA | Pixel Art XL / pixelsprite | Can stack at partial weights (e.g. 0.6 + 0.4) |
| Post-processing | Pillow | Palette quantize + nearest-neighbor downsample |
| Prompt builder | Claude Haiku | Mob description → SDXL prompt |

**M2 memory note:** M2 MacBook shares CPU/GPU memory. 16GB models should keep peak usage under ~10GB to avoid swapping — fp16 SDXL is fine, avoid fp32. Generate at 512×512 rather than 1024×1024 to keep it snappy; expect ~15–30s per sprite rather than the 2–5s you'd get on a discrete GPU. Still fast enough for offline baking.

**Why ComfyUI over A1111:** `POST /prompt` submits a workflow, `GET /history` polls completion — clean enough to drive from a script with no GUI interaction. Also has better MPS stability than A1111 on Apple Silicon.

---

## Pipeline

```
mob_description (natural language)
        ↓
  [Haiku prompt builder]
        ↓
  ComfyUI API  (SDXL + pixel LoRA, 512×512)
        ↓
  Post-processor
    → palette quantize to 16–32 colors
    → nearest-neighbor downsample to 64×64
    → alpha-mask white background
        ↓
  sprites/{mob_id}.png
```

---

## Prompt Builder

Haiku system prompt:

```
You translate mob descriptions into SDXL prompts for pixel art game sprites.
Output ONLY valid JSON: { "positive": "...", "negative": "..." }

Rules:
- Lead positive with silhouette-defining features (body type, dominant form)
- Always append to positive: pixel art, game sprite, front-facing portrait,
  white background, clean linework, DCSS style
- Always include in negative: blurry, 3d render, photorealistic, multiple
  poses, text, watermark, anime
- Keep positive under 75 tokens
- Describe visually only — no lore proper nouns
```

**Example:**

Input: `"A shambling undead with exposed ribcage, tattered burial cloth, and eyes that glow the pale green of corpse-light."`

Output positive: `undead skeleton warrior, exposed ribcage, glowing green eyes, tattered burial robes, shambling silhouette, pixel art, game sprite, front-facing portrait, white background, DCSS style`

---

## sprite_baker.py (sketch)

```python
import anthropic, requests, json, time
from PIL import Image

COMFY_URL   = 'http://localhost:8188'
SPRITE_SIZE = 64
PALETTE_N   = 24

def build_prompt(mob: dict) -> dict:
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model='claude-haiku-4-5-20251001',
        max_tokens=256,
        system=PROMPT_BUILDER_SYSTEM,
        messages=[{'role': 'user', 'content': mob['description']}]
    )
    return json.loads(msg.content[0].text)

def submit_to_comfy(prompt: dict, workflow: dict) -> str:
    wf = inject_prompt(workflow, prompt)  # fill pos/neg nodes
    r  = requests.post(f'{COMFY_URL}/prompt', json={'prompt': wf})
    return r.json()['prompt_id']

def poll_comfy(prompt_id: str) -> str:
    while True:
        h = requests.get(f'{COMFY_URL}/history/{prompt_id}').json()
        if prompt_id in h:
            return h[prompt_id]['outputs']['save_image']['images'][0]['filename']
        time.sleep(1)

def post_process(path: str, mob_id: str):
    img = Image.open(path).convert('RGBA')
    img = img.quantize(colors=PALETTE_N, method=Image.MEDIANCUT)
    img = img.resize((SPRITE_SIZE, SPRITE_SIZE), Image.NEAREST)
    img.save(f'sprites/{mob_id}.png')

def bake(mob: dict):
    prompt   = build_prompt(mob)
    pid      = submit_to_comfy(prompt, load_workflow())
    filename = poll_comfy(pid)
    post_process(f'comfy_output/{filename}', mob['id'])
```

---

## Output Format

Atlas PNG + JSON manifest. Single fetch, canvas-friendly.

```json
{
  "atlas": "sprites/atlas.png",
  "sprite_size": 64,
  "mobs": {
    "skeleton_warrior": { "x": 0,   "y": 0, "w": 64, "h": 64 },
    "rot_blob":         { "x": 64,  "y": 0, "w": 64, "h": 64 }
  }
}
```

Canvas render:
```js
const { x, y, w, h } = manifest.mobs[mob_id];
ctx.drawImage(atlas, x, y, w, h, destX, destY, w * scale, h * scale);
```

At 64×64 per sprite, 256 mobs fits in a 1024×1024 atlas.

---

## Setup

1. Install ComfyUI: `git clone https://github.com/comfyanonymous/ComfyUI && pip install -r requirements.txt`
2. ComfyUI auto-detects MPS on Apple Silicon — no extra config needed
3. Drop DreamShaperXL **fp16** weights into `models/checkpoints/`
4. Drop pixel art LoRA(s) into `models/loras/`
5. Build baseline workflow in the UI (checkpoint → LoRA → KSampler → SaveImage), export as JSON
6. Wire exported workflow into `sprite_baker.py`
7. Test on 3–5 mobs, tune LoRA weights / CFG / steps
8. Bake full roster, pack atlas

---

## Open Questions

- **Variants:** generate 2–3 per mob at bake time, pick best manually or via CLIP score
- **Regens:** track a description hash in the manifest; re-bake on change
- **Procedural mobs:** SVG fallback — Haiku emits geometric primitives, rasterize server-side to 64×64