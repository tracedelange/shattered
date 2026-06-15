// Validate a generated artifact body against the EXACT schemas the game engine
// writes — the same Zod schemas the real mutation/loader pipeline enforces, so
// "valid here" means "the engine would accept this". No repair: we report where
// the output goes wrong and leave it. Tier 3 also stages outputs in the engine's
// directory layout, so a high-quality run can be copied straight into world/.

import { MobBodySchema, ItemBodySchema } from '../../pipeline/lib/mutations.ts';
import { QuestBodySchema, validateStageGraph } from '../../server/world/quest_schema.ts';
import { NewZoneSpecSchema } from '../../pipeline/lib/zoneStub.ts';
import { validateAgainst, type Validation } from './trace.ts';

// Where each artifact type lives under world/. Staging mirrors this 1:1.
export const ENGINE_DIR: Record<string, string> = {
  mob: 'entities/mobs',
  item: 'entities/items/bases',
  quest: 'quests',
  zone: 'zones',
};

/** Check a generated body against the engine schema for its type. */
export function validateEngineBody(type: string, content: unknown): Validation {
  switch (type) {
    case 'mob':
      return validateAgainst(MobBodySchema, 'MobBodySchema', content, 'engine mob template (strict).');
    case 'item':
      return validateAgainst(ItemBodySchema, 'ItemBodySchema', content, 'engine item base (strict).');
    case 'quest': {
      const v = validateAgainst(QuestBodySchema, 'QuestBodySchema', content, 'engine quest body + stage graph.');
      if (!v.ok) return v;
      // Stage graph is a structural check beyond the schema (dangling on_complete,
      // duplicate stage ids) — throws rather than returning, so catch and report.
      try {
        validateStageGraph(content as Parameters<typeof validateStageGraph>[0], '(forge)');
      } catch (e) {
        return { schema: 'QuestBodySchema + stageGraph', ok: false, note: 'stage-graph reachability check', error: e instanceof Error ? e.message : String(e) };
      }
      return { ...v, schema: 'QuestBodySchema + stageGraph' };
    }
    case 'zone':
      return validateAgainst(NewZoneSpecSchema, 'NewZoneSpecSchema', content, 'engine zone stub (strict).');
    default:
      return { schema: '(none)', ok: false, error: `no engine schema registered for artifact type "${type}"` };
  }
}
