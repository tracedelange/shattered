// The Ideate step. An "architect" LLM proposes a diverse BATCH of structured
// prefab briefs covering distinct functional roles, so the library gets breadth
// instead of 30 variations of one room. Coverage is imposed by handing the model
// a function taxonomy + the available tilesets and asking it to span them; its
// job is flavor per role, not deciding what to make (where it would cluster).

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { callAndValidate } from '../../pipeline/lib/validate.ts';
import type { ArchitectEmit, PrefabBrief } from './types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prefab-briefs');

/** The coverage spine — functional roles a set-piece library should span. */
export const PREFAB_FUNCTIONS = [
  'entrance', 'boss_arena', 'treasure_vault', 'shrine', 'combat_room',
  'prison', 'crypt', 'archive', 'water_feature', 'chokepoint', 'safe_room', 'monument',
] as const;

/** Anchor tags a brief may require (gameplay hook points). */
export const ANCHOR_VOCAB = ['descend', 'ascend', 'loot', 'boss', 'npc', 'entrance'] as const;

const BriefSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  shape: z.enum(['rect', 'circle', 'bsp']),
  tileset: z.string(),
  width: z.number().int().min(6).max(16),
  height: z.number().int().min(6).max(16),
  theme: z.string(),
  required_anchors: z.array(z.string()).default([]),
  notes: z.string(),
});
const BriefsSchema = z.object({ briefs: z.array(BriefSchema) });

const architectModel = () =>
  process.env.FORGE_PREFAB_ARCHITECT_MODEL ||
  process.env.FORGE_PREFAB_MODEL ||
  process.env.PIPELINE_MODEL ||
  'claude-sonnet-4-6';

/** Available tilesets and their tile names, for the architect to target. */
function tilesetSummary(): string {
  const dir = join(ROOT, 'world', 'tilesets');
  if (!existsSync(dir)) return '(no tilesets found)';
  const lines: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = basename(f, '.json');
    try {
      const ts = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      lines.push(`  - ${name}: ${Object.keys(ts.tiles).join(', ')}`);
    } catch { /* skip unreadable */ }
  }
  return lines.join('\n');
}

function systemPrompt(): string {
  return [
    'You are a level-design architect for a top-down grid MMO. Propose a diverse',
    'batch of PREFAB set-piece briefs — small, reusable hand-scale rooms (6–16 tiles',
    'per side), NOT whole dungeons.',
    '',
    'FUNCTION TAXONOMY — span as many distinct roles as the count allows:',
    PREFAB_FUNCTIONS.map((f) => `  - ${f}`).join('\n'),
    '',
    'TILESETS (use tileset names from here; theme should fit the tileset):',
    tilesetSummary(),
    '',
    `ANCHOR TAGS available for required_anchors: ${ANCHOR_VOCAB.join(', ')}.`,
    '',
    'BASE SHAPE — pick the primitive whose geometry fits the function. The engine',
    'stamps it deterministically (you are NOT drawing the room):',
    '  - rect: halls, vaults, archives, cells — anything rectangular.',
    '  - circle: towers, shrines, arenas, wells — anything rounded/radial.',
    '  - bsp: multi-room layouts — crypts, prisons, complexes with sub-rooms.',
    '',
    'COVERAGE RULES:',
    '  - Maximize spread across FUNCTION, SHAPE, and THEME — do not cluster.',
    '  - Vary tileset and size (some small ~8×8, some medium ~12–14).',
    '  - Each brief needs a concrete, evocative theme (ruined, flooded, holy, corrupted…).',
    '  - notes: 1–2 sentences of layout intent the builder can act on.',
    '',
    'OUTPUT — one ```yaml fenced block, an object with a `briefs` array:',
    '```yaml',
    'briefs:',
    '  - name: "Flooded Crypt"',
    '    purpose: crypt',
    '    shape: bsp',
    '    tileset: dungeon',
    '    width: 12',
    '    height: 10',
    '    theme: flooded ruin',
    '    required_anchors: [descend, loot]',
    '    notes: "Sunken burial chamber, broken sarcophagi, water pooled in the nave."',
    '```',
  ].join('\n');
}

export async function generateBriefs(
  count: number,
  emit: ArchitectEmit,
  signal?: AbortSignal,
): Promise<PrefabBrief[]> {
  const model = architectModel();
  emit({ type: 'architect_start', count, model });
  try {
    const { value } = await callAndValidate({
      label: 'prefab-architect',
      model,
      signal,
      system: [systemPrompt()],
      user: `Produce ${count} briefs that maximize coverage of the function taxonomy and themes.`,
      schema: BriefsSchema,
    });
    const briefs = value.briefs as PrefabBrief[];
    let savedTo: string | undefined;
    try {
      mkdirSync(BRIEFS_DIR, { recursive: true });
      savedTo = join(BRIEFS_DIR, `briefs_${Date.now()}.json`);
      writeFileSync(savedTo, JSON.stringify(briefs, null, 2));
    } catch { /* disk best-effort */ }
    emit({ type: 'architect_done', briefs, savedTo });
    return briefs;
  } catch (err) {
    emit({ type: 'architect_error', message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
