// Loot Lab — a standalone dev tool (like tools/ability-editor) for the procedural
// LOOT pipeline. Browse the archetypes / materials / affixes / rarity odds that
// feed drops, rapidly re-roll drops for a given input to eyeball the variety of
// output, and tweak the roll tunables live to see how the distribution shifts.
//
// It reuses the SAME generator the game runs (server/game/items/generator.ts),
// threading a LootTuning override in so the numbers you tweak here are exactly
// the numbers the game would use — no duplicated roll logic. Run with:
//   npm run loot-lab   →   http://localhost:3003
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadWorld } from '../../server/world/loader.ts';
import {
  generateDrop, generateItem, resolveItemName, rollRarityForIlvl, sampleIlvl,
  rollMobGold, DEFAULT_TUNING, AFFINITY_TAGS,
} from '../../server/game/items/generator.ts';
import type { LootTuning } from '../../server/game/items/generator.ts';
import { GENERIC_DROP_CHANCE, BRAND_KEYS } from '../../shared/constants.ts';
import type { Archetype, ItemEntity, Material, Rarity, WorldDefs } from '../../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const WORLD_DIR = process.env.WORLD_DIR ? resolve(process.env.WORLD_DIR) : join(ROOT, 'world');
const ITEMS_DIR = join(WORLD_DIR, 'entities', 'items');
const PORT = 3003;

// Load the composed defs the game uses (itemBases = materials × archetypes,
// affixes, mobs). Kept mutable so a config reload could re-read; loaded once here.
let defs: WorldDefs = loadWorld(WORLD_DIR);

function readYaml<T>(p: string): T {
  return yaml.load(readFileSync(p, 'utf8')) as T;
}

// Raw material/archetype lists (loadWorld composes them away into itemBases, but
// the reference panels want the source rows).
function rawMaterials(): Material[] {
  const p = join(ITEMS_DIR, 'materials.yaml');
  return existsSync(p) ? (readYaml<{ materials: Material[] }>(p).materials ?? []) : [];
}
function rawArchetypes(): Archetype[] {
  const p = join(ITEMS_DIR, 'archetypes.yaml');
  return existsSync(p) ? (readYaml<{ archetypes: Archetype[] }>(p).archetypes ?? []) : [];
}

// Merge a partial tuning from the client onto the shipped defaults so any field
// the UI omits falls back to the real game value.
function mergeTuning(partial: Partial<LootTuning> | undefined): LootTuning {
  return {
    ...DEFAULT_TUNING,
    ...(partial ?? {}),
    rarity: { ...DEFAULT_TUNING.rarity, ...(partial?.rarity ?? {}) },
    rarityMagnitude: { ...DEFAULT_TUNING.rarityMagnitude, ...(partial?.rarityMagnitude ?? {}) },
  };
}

// Flatten a rolled item into a compact display record.
function summarize(item: ItemEntity, ilvl: number): Record<string, unknown> {
  const eq = item.components.equipment;
  const base = defs.itemBases[eq.base];
  const r = eq.rolled ?? {};
  const affixNames = (eq.affixes ?? []).map((id) => {
    const p = defs.affixes.prefixes.find((a) => a.id === id);
    const s = defs.affixes.suffixes.find((a) => a.id === id);
    return p?.name_prefix ?? s?.name_suffix ?? id;
  });
  // Stat bonuses = rolled keys that aren't the structural damage/defense/speed/scaling.
  const structural = new Set(['damage', 'defense', 'speed', 'scaling', 'weapon_brand']);
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!structural.has(k) && typeof v === 'number') stats[k] = v;
  }
  return {
    name: resolveItemName(item, defs),
    base: eq.base,
    baseName: base?.name ?? eq.base,
    slot: base?.slot ?? '?',
    tags: base?.tags ?? [],
    rarity: eq.rarity,
    ilvl,
    affixes: eq.affixes ?? [],
    affixNames,
    damage: r.damage ?? null,
    defense: r.defense ?? null,
    speed: typeof r.speed === 'number' ? r.speed : null,
    weaponBrand: r.weapon_brand ?? null,
    stats,
    sellValue: base?.sell_value ?? base?.value ?? 0,
  };
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// Everything the reference panels + control defaults need.
app.get('/api/catalog', (_req, res) => {
  const bases = Object.values(defs.itemBases)
    .filter((b) => ['mainhand', 'helmet', 'chest', 'gloves', 'leggings', 'boots', 'ring', 'amulet'].includes(b.slot))
    .map((b) => ({ id: b.id, name: b.name, slot: b.slot, tags: b.tags, min_ilvl: b.min_ilvl ?? 1, sell_value: b.sell_value ?? 0 }))
    .sort((a, b) => a.min_ilvl - b.min_ilvl || a.id.localeCompare(b.id));
  const mobs = Object.values(defs.mobs)
    .filter((m) => m.role && m.role !== 'npc' && m.role !== 'passive')
    .map((m) => ({ id: m.id, name: m.name, level: m.level ?? 1, role: m.role, loot_affinity: m.loot_affinity ?? [], loot_brand: m.loot_brand ?? [] }))
    .sort((a, b) => (a.level) - (b.level) || a.id.localeCompare(b.id));
  res.json({
    materials: rawMaterials(),
    archetypes: rawArchetypes(),
    affixes: defs.affixes,
    bases,
    mobs,
    brandKeys: BRAND_KEYS,
    affinityKeys: Object.keys(AFFINITY_TAGS),
    affinityTags: AFFINITY_TAGS,
    defaultTuning: DEFAULT_TUNING,
    genericDropChance: GENERIC_DROP_CHANCE,
  });
});

/**
 * Roll a batch of drops. Body:
 *   count            how many to roll
 *   ilvl             fixed item-level (mutually exclusive with mobLevel)
 *   mobLevel         sample ilvl per drop from this level (variance + jumps)
 *   theme            { affinity: string[], brand: string[] }
 *   forceBaseId      pin the base (else pickDropBase)
 *   forceRarity      pin the rarity (else rollRarityForIlvl)
 *   respectDropChance  simulate real kills: each roll gates on genericDropChance
 *                      and also rolls gold; misses produce no item
 *   genericDropChance  drop chance when respectDropChance (defaults to shipped)
 *   tuning           Partial<LootTuning> overrides
 */
app.post('/api/roll', (req, res) => {
  try {
    const b = req.body ?? {};
    const count = Math.max(1, Math.min(2000, Number(b.count) || 24));
    const tuning = mergeTuning(b.tuning);
    const theme = { affinity: b.theme?.affinity ?? [], brand: b.theme?.brand ?? [] };
    const useMob = b.mobLevel != null && b.ilvl == null;
    const fixedIlvl = Number(b.ilvl) || 1;
    const mobLevel = Number(b.mobLevel) || 1;
    const forceRarity: Rarity | undefined = b.forceRarity || undefined;
    const forceBaseId: string | undefined = b.forceBaseId || undefined;
    const respect = Boolean(b.respectDropChance);
    const dropChance = b.genericDropChance != null ? Number(b.genericDropChance) : GENERIC_DROP_CHANCE;

    const items: Record<string, unknown>[] = [];
    let goldTotal = 0;
    let goldDrops = 0;
    let kills = 0;

    for (let i = 0; i < count; i++) {
      const ilvl = useMob ? sampleIlvl(mobLevel, tuning) : fixedIlvl;
      if (respect) {
        kills++;
        // Gold rolls independently of the equip drop (matches loot.ts ordering).
        const gold = rollMobGold(mobLevel, tuning);
        if (gold > 0) { goldTotal += gold; goldDrops++; }
        if (Math.random() >= dropChance) continue; // no equip this kill
      }
      let item: ItemEntity | null;
      if (forceBaseId) {
        const rarity = forceRarity ?? rollRarityForIlvl(ilvl, tuning);
        item = generateItem({ baseId: forceBaseId, defs, rarity, ilvl, brand: theme.brand, tuning });
      } else if (forceRarity) {
        // Pin rarity but let pickDropBase choose the base: roll a drop then re-roll
        // its affixes at the forced rarity via generateItem.
        const dropped = generateDrop(defs, ilvl, theme, tuning);
        item = dropped
          ? generateItem({ baseId: dropped.components.equipment.base, defs, rarity: forceRarity, ilvl, brand: theme.brand, tuning })
          : null;
      } else {
        item = generateDrop(defs, ilvl, theme, tuning);
      }
      if (item) items.push(summarize(item, ilvl));
    }

    res.json({
      items,
      gold: respect ? { total: goldTotal, drops: goldDrops, kills, avgPerKill: kills ? goldTotal / kills : 0 } : null,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[loot-lab] http://localhost:${PORT}  (world: ${WORLD_DIR})`);
});
