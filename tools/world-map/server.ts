import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZONES_DIR = join(__dirname, '../../world/zones');
const PORT = 3003;

const app = express();
app.use(express.static(__dirname));
app.use('/shared', express.static(join(__dirname, '../shared')));

const ZONE_COORD_RE = /^(zone|city|village)_(\d+)_(\d+)$/;

app.get('/api/world', (_req, res) => {
  const zones: { id: string; name: string; biome: string | null; gridX: number; gridY: number; type: string }[] = [];

  for (const file of readdirSync(ZONES_DIR)) {
    const ext = extname(file);
    try {
      let zone: Record<string, unknown>;
      if (ext === '.json') {
        zone = JSON.parse(readFileSync(join(ZONES_DIR, file), 'utf8'));
      } else if (ext === '.yaml') {
        // yaml zones are legacy; skip for now
        continue;
      } else {
        continue;
      }

      const m = ZONE_COORD_RE.exec(String(zone.id ?? ''));
      if (!m) continue;

      zones.push({
        id:    String(zone.id),
        name:  String(zone.name ?? zone.id),
        biome: zone.biome != null ? String(zone.biome) : null,
        gridX: parseInt(m[2]!, 10),
        gridY: parseInt(m[3]!, 10),
        type:  m[1]!,
      });
    } catch {
      // skip malformed files
    }
  }

  if (!zones.length) {
    res.json({ cols: 0, rows: 0, cells: [], settlements: [] });
    return;
  }

  const maxX = Math.max(...zones.map(z => z.gridX));
  const maxY = Math.max(...zones.map(z => z.gridY));
  const cols = maxX + 1;
  const rows = maxY + 1;

  const cells: (null | { worldBiome: string; zoneName: string; zoneId: string })[][] =
    Array.from({ length: rows }, () => Array(cols).fill(null));

  const settlements: { type: string; gridX: number; gridY: number; name: string }[] = [];

  for (const z of zones) {
    cells[z.gridY]![z.gridX] = {
      worldBiome: z.biome ?? 'plains',
      zoneName: z.name,
      zoneId: z.id,
    };
    if (z.type === 'city' || z.type === 'village') {
      settlements.push({ type: z.type, gridX: z.gridX, gridY: z.gridY, name: z.name });
    }
  }

  res.json({ cols, rows, cells, settlements });
});

app.listen(PORT, () => {
  console.log(`\n  World Map  →  http://localhost:${PORT}\n`);
});
