# Sprite Baker Setup (M2 Mac)

## 1. Install ComfyUI

```bash
git clone https://github.com/comfyanonymous/ComfyUI
cd ComfyUI
pip install -r requirements.txt
python main.py --force-fp16   # MPS auto-detected; --force-fp16 avoids memory issues
```

ComfyUI runs at `http://localhost:8188`.

## 2. Get DreamShaperXL fp16

Download from CivitAI — search "DreamShaper XL" and grab the fp16 safetensors variant (~6.5GB). Drop it in `ComfyUI/models/checkpoints/`.

## 3. Get a pixel art LoRA

Search CivitAI for "Pixel Art XL" or "pixelsprite". A good one: "Pixel Art SDXL" by nerijs. Drop it in `ComfyUI/models/loras/`.

## 4. Build the workflow in ComfyUI

Open `http://localhost:8188` and build this node chain:

- `CheckpointLoaderSimple` → load DreamShaperXL
- `LoraLoader` → attach pixel art LoRA (weight ~0.7)
- `CLIPTextEncode` ×2 — **title one "positive", the other "negative"** (right-click node → title; this is what `inject_prompt` keys on)
- `KSampler` → connect CLIP outputs, model, latent
- `VAEDecode` → decode latent
- `SaveImage` → output

Then export as API-format JSON: enable "Dev mode options" in the UI menu → "Save (API format)". Save the result as `sprites/workflow.json`.

## 5. Set ANTHROPIC_API_KEY

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The prompt builder calls Claude Haiku once per mob to translate descriptions into SDXL prompt grammar. This is the only paid external call.

## 6. Wire up comfy_output

`sprite_baker.py` expects ComfyUI's output at `mmo/comfy_output/` (one level above `sprites/`). Easiest fix is a symlink:

```bash
ln -s /path/to/ComfyUI/output /path/to/mmo/comfy_output
```

## 7. Test with the sample

```bash
cd sprites
source env/bin/activate
python sprite_baker.py mobs_sample.json skeleton_warrior
```

A successful run prints the generated prompt, waits for ComfyUI, post-processes the image, and writes `out/skeleton_warrior.png` + updates `out/manifest.json`.

## 8. Bake all mobs and pack the atlas

```bash
python sprite_baker.py mobs_sample.json   # bake all (skips unchanged by description hash)
python pack_atlas.py                       # pack out/*.png → out/atlas.png
```
