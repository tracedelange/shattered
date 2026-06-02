// Builds the static, cacheable "this is the world" context block for both
// pipelines. Reads raw YAML text where possible so the LLM sees the same
// representation that humans edit.

import { basename } from 'node:path';
import { join } from 'node:path';
import {
  listYamlFiles, listJsonFiles, readText, fileExists,
  WORLD_DIR, LORE_FILE, TILESETS_DIR, OPPS_FILE, HISTORY_FILE,
} from './io.ts';

export interface WorldBundle {
  loreBible: string;
  zones: { id: string; path: string; body: string }[];
  mobs: { id: string; path: string; body: string }[];
  quests: { id: string; path: string; body: string }[];
  tilesets: { id: string; path: string; body: string }[];
  opportunitiesRaw: string;
  historyRaw: string;
}

function loadDir(dir: string): { id: string; path: string; body: string }[] {
  return listYamlFiles(dir).map((path) => {
    const body = readText(path);
    const idMatch = body.match(/^id:\s*([A-Za-z0-9_]+)/m);
    const id = idMatch ? idMatch[1] : path;
    return { id, path, body };
  });
}

function loadTilesets(): { id: string; path: string; body: string }[] {
  return listJsonFiles(TILESETS_DIR).map((path) => {
    const body = readText(path);
    let id = basename(path, '.json');
    const m = body.match(/"name"\s*:\s*"([^"]+)"/);
    if (m) id = m[1];
    return { id, path, body };
  });
}

export function loadWorldBundle(): WorldBundle {
  return {
    loreBible: fileExists(LORE_FILE) ? readText(LORE_FILE) : '',
    zones: loadDir(join(WORLD_DIR, 'zones')),
    mobs: loadDir(join(WORLD_DIR, 'entities', 'mobs')),
    quests: loadDir(join(WORLD_DIR, 'quests')),
    tilesets: loadTilesets(),
    opportunitiesRaw: fileExists(OPPS_FILE) ? readText(OPPS_FILE) : '',
    historyRaw: fileExists(HISTORY_FILE) ? readText(HISTORY_FILE) : '',
  };
}

// Big cacheable text block of every world YAML, prefixed with the file path
// so the LLM can reason about layout.
export function formatWorldContext(b: WorldBundle): string {
  const sections: string[] = [];
  sections.push('# Lore Bible\n\n```yaml\n' + b.loreBible + '\n```');

  sections.push('# Zones\n');
  for (const z of b.zones) {
    sections.push(`## ${z.id} (${z.path})\n\n\`\`\`yaml\n${z.body}\n\`\`\``);
  }

  sections.push('# Mobs\n');
  for (const m of b.mobs) {
    sections.push(`## ${m.id} (${m.path})\n\n\`\`\`yaml\n${m.body}\n\`\`\``);
  }

  sections.push('# Quests\n');
  for (const q of b.quests) {
    sections.push(`## ${q.id} (${q.path})\n\n\`\`\`yaml\n${q.body}\n\`\`\``);
  }

  sections.push('# Tilesets\n');
  for (const t of b.tilesets) {
    sections.push(`## ${t.id} (${t.path})\n\n\`\`\`json\n${t.body}\n\`\`\``);
  }

  return sections.join('\n\n');
}

export function formatPipelineState(b: WorldBundle): string {
  return [
    '# Current opportunities.yaml\n\n```yaml\n' + b.opportunitiesRaw + '\n```',
    '# Implementation history\n\n```yaml\n' + b.historyRaw + '\n```',
  ].join('\n\n');
}
