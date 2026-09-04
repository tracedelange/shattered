// Ability editor — a standalone dev tool (like tools/zone-editor) for viewing,
// balancing, and authoring the player/mob abilities in world/abilities/*.yaml.
//
// The whole point over hand-editing YAML: every save runs through the SAME
// validateAbilityDef the game uses at load (server/world/ability_schema.ts), so
// the tool can never write a file the game would reject. Run with:
//   npm run ability-editor   →   http://localhost:3002
import express from 'express';
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateAbilityDef } from '../../server/world/ability_schema.ts';
import { SCALING_COEFFS, BRAND_KEYS, CLASSES, CLASS_STARTERS, MODIFIER_TICK_INTERVAL_TICKS } from '../../shared/constants.ts';
import type { AbilityDef } from '../../shared/types.ts';
import { abilityIconPng } from '../lib/abilityIconPng.ts';
import type { IconSpec } from '../../shared/abilityIcon.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const ABILITIES_DIR = join(ROOT, 'world', 'abilities');
const PORT = 3002;

const ID_RE = /^[a-z][a-z0-9_]*$/;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function abilityPath(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`invalid ability id: ${id}`);
  return join(ABILITIES_DIR, `${id}.yaml`);
}

function listAbilities(): AbilityDef[] {
  return readdirSync(ABILITIES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const def = yaml.load(readFileSync(join(ABILITIES_DIR, f), 'utf8')) as AbilityDef;
      // Trust the filename as the canonical id (matches how the loader keys them).
      def.id = basename(f, '.yaml');
      return def;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Validate, then write. Returns the validation error string, or null on success.
function saveAbility(def: AbilityDef): string | null {
  try {
    validateAbilityDef(def, `${def.id}.yaml`);
  } catch (err) {
    return (err as Error).message;
  }
  writeFileSync(abilityPath(def.id), yaml.dump(def, { lineWidth: 120, noRefs: true }), 'utf8');
  return null;
}

app.get('/api/abilities', (_req, res) => {
  try { res.json(listAbilities()); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get('/api/meta', (_req, res) => {
  res.json({
    scalingCoeffs: SCALING_COEFFS,
    scalingGrades: Object.keys(SCALING_COEFFS),
    brandKeys: BRAND_KEYS,
    classes: Object.keys(CLASSES),
    // Full templates (start_stats) — the class-progression view builds a
    // level-N stat block from these to price each ability's damage per cast.
    classTemplates: CLASSES,
    classStarters: CLASS_STARTERS,
    modifierTickInterval: MODIFIER_TICK_INTERVAL_TICKS,
    stats: ['strength', 'dexterity', 'intelligence', 'constitution'],
    effectKinds: ['damage', 'heal', 'modifier', 'move'],
    shapes: ['self', 'target', 'projectile', 'area'],
    motions: ['charge', 'leap', 'knockback', 'blink'],
  });
});

// Render a procedural ability icon to PNG. Takes the working copy in the body
// (so live edits + re-rolls preview without saving). Pixel-art, scaled up.
app.post('/api/icon', (req, res) => {
  const spec = req.body as Partial<IconSpec>;
  if (!spec?.id || !spec.kind || !spec.shape) return res.status(400).json({ error: 'icon spec needs id, kind, shape' });
  try {
    const png = abilityIconPng({
      id: spec.id,
      brand: spec.brand,
      kind: spec.kind,
      shape: spec.shape,
      rank: spec.rank ?? 1,
      seed: spec.seed ?? 0,
      motif: spec.motif,
      symmetry: spec.symmetry,
      ramp: spec.ramp,
      spikes: spec.spikes,
      rotation: spec.rotation,
      fill: spec.fill,
      colors: spec.colors,
      layers: spec.layers,
      glow: spec.glow,
      grid: spec.grid,
    }, 96);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.end(png);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Update an existing ability (id from the route is authoritative for the file).
app.put('/api/abilities/:id', (req, res) => {
  const def = req.body as AbilityDef;
  def.id = req.params.id;
  if (!ID_RE.test(def.id)) return res.status(400).json({ error: `invalid id: ${def.id}` });
  const error = saveAbility(def);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
});

// Create a new ability (refuses to clobber an existing file).
app.post('/api/abilities', (req, res) => {
  const def = req.body as AbilityDef;
  if (!def?.id || !ID_RE.test(def.id)) return res.status(400).json({ error: `invalid id: ${def?.id}` });
  if (existsSync(abilityPath(def.id))) return res.status(409).json({ error: `ability '${def.id}' already exists` });
  const error = saveAbility(def);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
});

app.delete('/api/abilities/:id', (req, res) => {
  try {
    const p = abilityPath(req.params.id);
    if (!existsSync(p)) return res.status(404).json({ error: 'not found' });
    unlinkSync(p);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

app.listen(PORT, () => {
  console.log(`[ability-editor] http://localhost:${PORT}  (editing ${ABILITIES_DIR})`);
});
