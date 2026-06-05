import express from 'express';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { generateZoneGrid } from '../../server/game/mapgen/index.ts';
import type { ZoneDef, MobTemplate, Tileset } from '../../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const WORLD_DIR = join(ROOT, 'world');
const ZONES_DIR = join(WORLD_DIR, 'zones');
const MOBS_DIR = join(WORLD_DIR, 'entities', 'mobs');
const TILESETS_DIR = join(WORLD_DIR, 'tilesets');
const PORT = 3001;

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

function writeYaml(path: string, data: unknown): void {
  writeFileSync(path, yaml.dump(data, { lineWidth: 120, noRefs: true }), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function zoneFilePath(id: string): string {
  for (const f of walk(ZONES_DIR)) {
    if (extname(f) !== '.yaml') continue;
    try {
      const z = readYaml<ZoneDef>(f);
      if (z.id === id) return f;
    } catch {}
  }
  throw new Error(`Zone not found: ${id}`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/zones', (_req, res) => {
  const zones: { id: string; name: string }[] = [];
  for (const f of walk(ZONES_DIR)) {
    if (extname(f) !== '.yaml') continue;
    try {
      const z = readYaml<ZoneDef>(f);
      zones.push({ id: z.id, name: z.name || z.id });
    } catch {}
  }
  res.json(zones.sort((a, b) => a.name.localeCompare(b.name)));
});

app.get('/api/zones/:id', (req, res) => {
  try {
    const path = zoneFilePath(req.params.id!);
    const def = readYaml<ZoneDef>(path);
    const { grid, bounds, width, height } = generateZoneGrid(def);

    let tileColors: Record<string, string> = {};
    let spriteColors: Record<string, string> = {};
    if (def.tileset) {
      try {
        const ts: Tileset = JSON.parse(readFileSync(join(TILESETS_DIR, `${def.tileset}.json`), 'utf8'));
        tileColors = Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color]));
        spriteColors = Object.fromEntries(Object.entries(ts.sprites).map(([k, v]) => [k, v.color]));
      } catch {}
    }

    res.json({ def, grid, bounds, width, height, tileColors, spriteColors });
  } catch (e: unknown) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.get('/api/entities', (_req, res) => {
  const mobs: { id: string; name: string; sprite: string; role: string; fixture?: boolean }[] = [];
  for (const f of walk(MOBS_DIR)) {
    if (extname(f) !== '.yaml') continue;
    try {
      const m = readYaml<MobTemplate>(f);
      mobs.push({ id: m.id, name: m.name, sprite: m.sprite, role: m.role, fixture: m.fixture });
    } catch {}
  }
  res.json(mobs.sort((a, b) => a.name.localeCompare(b.name)));
});

// Add a spawn entry
app.post('/api/zones/:id/spawn', (req, res) => {
  try {
    const path = zoneFilePath(req.params.id!);
    const def = readYaml<ZoneDef>(path);
    if (!def.spawns) def.spawns = [];
    const { entity, region, at, count, spawn_id, respawn_seconds } = req.body;
    if (!entity) return res.status(400).json({ error: 'entity required' });
    if (!region && !at) return res.status(400).json({ error: 'region or at required' });
    const entry: Record<string, unknown> = { entity };
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      // Exact-tile placement (e.g. a torch) — single entity, no region scatter.
      entry.at = { x: Number(at.x), y: Number(at.y) };
    } else {
      entry.region = region;
      if (count && count > 1) entry.count = Number(count);
    }
    if (spawn_id) entry.spawn_id = spawn_id;
    if (respawn_seconds) entry.respawn_seconds = Number(respawn_seconds);
    def.spawns.push(entry as any);
    writeYaml(path, def);
    res.json({ ok: true, index: def.spawns.length - 1 });
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Remove a spawn entry
app.delete('/api/zones/:id/spawn/:idx', (req, res) => {
  try {
    const path = zoneFilePath(req.params.id!);
    const def = readYaml<ZoneDef>(path);
    const idx = Number(req.params.idx);
    if (!def.spawns || idx < 0 || idx >= def.spawns.length)
      return res.status(400).json({ error: 'Invalid spawn index' });
    def.spawns.splice(idx, 1);
    writeYaml(path, def);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Append an op
app.post('/api/zones/:id/op', (req, res) => {
  try {
    const path = zoneFilePath(req.params.id!);
    const def = readYaml<ZoneDef>(path);
    if (!def.ops) def.ops = [];
    def.ops.push(req.body);
    writeYaml(path, def);
    res.json({ ok: true, index: def.ops.length - 1 });
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Remove an op
app.delete('/api/zones/:id/op/:idx', (req, res) => {
  try {
    const path = zoneFilePath(req.params.id!);
    const def = readYaml<ZoneDef>(path);
    const idx = Number(req.params.idx);
    if (!def.ops || idx < 0 || idx >= def.ops.length)
      return res.status(400).json({ error: 'Invalid op index' });
    def.ops.splice(idx, 1);
    writeYaml(path, def);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Zone Editor  →  http://localhost:${PORT}\n`);
});
