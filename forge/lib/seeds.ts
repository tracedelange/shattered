// Loads the forge inputs: the lore seed bible + the zone graph (the programmatic
// Tier-0 skeleton). Reuses the pipeline's yaml reader.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readYaml } from '../../pipeline/lib/io.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = join(__dirname, '..', 'seeds');

export const LevelBandSchema = z.object({
  tier: z.number().int().min(1),
  minLevel: z.number().int(),
  maxLevel: z.number().int(),
});

export const ZoneNodeSchema = z.object({
  id: z.string().min(1),
  biome: z.string().min(1),
  seed: z.number().int(),
  level_band: LevelBandSchema,
  links: z.array(z.string().min(1)).default([]),
});

export const ZoneGraphSchema = z.object({
  zones: z.array(ZoneNodeSchema).min(1),
});

export type ZoneNode = z.infer<typeof ZoneNodeSchema>;

export interface Seed {
  // Freeform lore axioms — Tier 1's raw material.
  bible: Record<string, unknown>;
  graph: z.infer<typeof ZoneGraphSchema>;
}

export function loadSeed(): Seed {
  const bible = readYaml<Record<string, unknown>>(join(SEEDS_DIR, 'bible.yaml'));
  const graph = ZoneGraphSchema.parse(readYaml(join(SEEDS_DIR, 'zone_graph.yaml')));
  return { bible, graph };
}

/** Find a zone node by id (Tier 3 needs the level band for scaling). */
export const zoneById = (seed: Seed, id: string): ZoneNode | undefined =>
  seed.graph.zones.find((z) => z.id === id);
