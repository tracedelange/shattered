import express from 'express';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIOME_REGISTRY, resolveBiomeGenOps, deriveModules, deriveOpParams } from '../../server/game/mapgen/biomes/index.ts';
import { generateZoneGrid } from '../../server/game/mapgen/index.ts';
import type { Tileset } from '../../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const TILESETS_DIR = join(ROOT, 'world', 'tilesets');
const SAVED_PATH  = join(__dirname, 'saved-seeds.json');
const ZONES_DIR   = join(ROOT, 'world', 'zones');
const PORT = 3002;

const app = express();
app.use(express.json());
app.use(express.static(__dirname));


function loadTileColors(tilesetName: string): { tiles: Record<string, string>; sprites: Record<string, string> } {
  try {
    const ts: Tileset = JSON.parse(readFileSync(join(TILESETS_DIR, `${tilesetName}.json`), 'utf8'));
    return {
      tiles:   Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color])),
      sprites: Object.fromEntries(Object.entries(ts.sprites).map(([k, v]) => [k, v.color])),
    };
  } catch {
    return { tiles: {}, sprites: {} };
  }
}

function readSaved(): unknown[] {
  try { return JSON.parse(readFileSync(SAVED_PATH, 'utf8')); }
  catch { return []; }
}
function writeSaved(data: unknown[]): void {
  writeFileSync(SAVED_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/biomes', (_req, res) => {
  const out = Object.values(BIOME_REGISTRY).map(b => ({
    id:         b.id,
    tags:       b.tags,
    tileset:    b.tileset,
    palette:    b.palette,
    modules:    deriveModules(b.pipeline, b.defaultConstraints),
    zoneParams: b.zoneParams ?? [],
    opParams:   deriveOpParams(b.pipeline, b.defaultConstraints),
  }));
  res.json(out);
});

app.post('/api/generate', (req, res) => {
  const {
    biome: biomeId,
    seed: rawSeed,
    width: widthOverride,
    height: heightOverride,
    activeModules,
    zoneParams = {},
    opParams = {},
  } = req.body as {
    biome: string;
    seed?: string;
    width?: number;
    height?: number;
    activeModules?: string[];
    zoneParams?: Record<string, number>;
    opParams?: Record<string, Record<string, number>>;
  };

  const biomeDef = BIOME_REGISTRY[biomeId];
  if (!biomeDef) return res.status(400).json({ error: `Unknown biome: ${biomeId}` });

  const seed = rawSeed || `${biomeId}_default`;
  const { ops, numericSeed } = resolveBiomeGenOps(biomeDef, seed, { activeModules, opParams });

  const opsLog = ops.map(op => {
    const o = op as Record<string, unknown>;
    const row: Record<string, unknown> = { type: op.type };
    if (o.seed       !== undefined) row.seed       = o.seed;
    if (o.tile       !== undefined) row.tile        = o.tile;
    if (o.region     !== undefined) row.region      = o.region;
    if (o.threshold  !== undefined) row.threshold   = o.threshold;
    if (o.fill       !== undefined) row.fill        = o.fill;
    if (o.iterations !== undefined) row.iterations  = o.iterations;
    if (o.count      !== undefined) row.count       = o.count;
    return row;
  });

  const inset = zoneParams.inset ?? 0;
  const zoneId = `biome_${biomeId}_${numericSeed.toString(16)}`;
  const t0 = Date.now();
  const { grid, bounds, width, height, focal, autoConnectionPortals } = generateZoneGrid({
    id: zoneId,
    seed,
    tileset: biomeDef.tileset,
    width:  widthOverride  ?? biomeDef.width,
    height: heightOverride ?? biomeDef.height,
    default_tile: biomeDef.defaultTile,
    inset,
    ops,
  });
  const genMs = Date.now() - t0;

  const { tiles: tileColors } = loadTileColors(biomeDef.tileset);

  const entrance = autoConnectionPortals[0]?.at ?? focal ?? null;
  const centroid  = focal ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  res.json({
    grid, bounds, width, height, tileColors, genMs,
    biomeId,
    opsLog,
    metadata: {
      entrance, centroid,
      tags:           biomeDef.tags,
      palette:        biomeDef.palette,
      constraints:    biomeDef.defaultConstraints,
      spawnWeights:   biomeDef.spawnWeights,
      featureWeights: biomeDef.featureWeights,
    },
  });
});

app.get('/api/saved', (_req, res) => res.json(readSaved()));

app.post('/api/saved', (req, res) => {
  const { biome, seed, zoneParams, opParams, label } = req.body;
  if (!biome || !seed) return res.status(400).json({ error: 'biome and seed required' });
  const saved = readSaved() as any[];
  const entry = {
    id:         Date.now().toString(16),
    label:      label || `${biome} — ${seed}`,
    biome, seed,
    zoneParams: zoneParams ?? {},
    opParams:   opParams   ?? {},
    savedAt:    Date.now(),
  };
  saved.unshift(entry);
  writeSaved(saved);
  res.json({ ok: true, entry });
});

app.delete('/api/saved/:id', (req, res) => {
  const saved = (readSaved() as any[]).filter((e: any) => e.id !== req.params.id);
  writeSaved(saved);
  res.json({ ok: true });
});

app.get('/api/zones', (_req, res) => {
  try {
    const ids = readdirSync(ZONES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
    res.json(ids);
  } catch {
    res.json([]);
  }
});

app.post('/api/export', (req, res) => {
  const {
    zoneId,
    zoneName,
    biome: biomeId,
    seed,
    zoneParams = {},
    opParams = {},
    activeModules,
    spawnPoint,
    connections = {},
    width,
    height,
  } = req.body as {
    zoneId: string;
    zoneName?: string;
    biome: string;
    seed: string;
    zoneParams?: Record<string, number>;
    opParams?: Record<string, Record<string, number>>;
    activeModules?: string[];
    spawnPoint?: unknown;
    connections?: Record<string, string>;
    width?: number;
    height?: number;
  };

  if (!zoneId || !biomeId || !seed) {
    return res.status(400).json({ error: 'zoneId, biome, and seed are required' });
  }
  if (!/^[a-z0-9_]+$/.test(zoneId)) {
    return res.status(400).json({ error: 'zoneId must be lowercase letters, numbers, and underscores only' });
  }

  const biomeDef = BIOME_REGISTRY[biomeId];
  if (!biomeDef) return res.status(400).json({ error: `Unknown biome: ${biomeId}` });

  const zoneDef: Record<string, unknown> = {
    id:          zoneId,
    name:        zoneName || zoneId,
    biome:       biomeId,
    seed,
    ...(width                           ? { width }         : {}),
    ...(height                          ? { height }        : {}),
    ...(Object.keys(zoneParams).length  ? { zoneParams }    : {}),
    ...(Object.keys(opParams).length    ? { opParams }      : {}),
    ...(activeModules                   ? { activeModules } : {}),
    spawn_point: spawnPoint ?? { focal: true },
    ...(Object.keys(connections).length ? { connections }    : {}),
  };

  const path = join(ZONES_DIR, `${zoneId}.json`);
  const existed = existsSync(path);
  writeFileSync(path, JSON.stringify(zoneDef, null, 2), 'utf8');
  res.json({ ok: true, path, existed });
});

app.listen(PORT, () => {
  console.log(`\n  Biome Workbench  →  http://localhost:${PORT}\n`);
});
