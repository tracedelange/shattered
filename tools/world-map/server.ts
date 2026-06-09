import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZONES_DIR = join(__dirname, '../../world/zones');
const PORT = 3003;

const app = express();
app.use(express.static(__dirname));

app.get('/api/world', (_req, res) => {
  const zones: Record<string, unknown>[] = [];

  for (const file of readdirSync(ZONES_DIR)) {
    const ext = extname(file);
    try {
      let zone: Record<string, unknown>;
      if (ext === '.json') {
        zone = JSON.parse(readFileSync(join(ZONES_DIR, file), 'utf8'));
      } else if (ext === '.yaml') {
        zone = yaml.load(readFileSync(join(ZONES_DIR, file), 'utf8')) as Record<string, unknown>;
      } else {
        continue;
      }
      // Only send the fields the viewer needs — keep payload small.
      zones.push({
        id:          zone.id,
        name:        zone.name ?? zone.id,
        archetype:   zone.archetype ?? null,
        biome:       zone.biome ?? null,
        connections: zone.connections ?? {},
        width:       zone.width  ?? null,
        height:      zone.height ?? null,
      });
    } catch {
      // Skip malformed files.
    }
  }

  res.json(zones);
});

app.listen(PORT, () => {
  console.log(`\n  World Map  →  http://localhost:${PORT}\n`);
});
