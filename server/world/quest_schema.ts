import { z } from 'zod';

const killCountObjective = z.object({
  kind: z.literal('kill_count'),
  target: z.number().int().positive(),
  template_id: z.string().optional(),
  zone: z.string().optional(),
});

const killSpecificObjective = z.object({
  kind: z.literal('kill_specific'),
  target_id: z.string(),
});

const collectCountObjective = z.object({
  kind: z.literal('collect_count'),
  item_base: z.string(),
  target: z.number().int().positive(),
});

const talkObjective = z.object({
  kind: z.literal('talk'),
  target_template: z.string(),
});

// reach: must have template_id, x+y pair, OR at least a zone (zone-entry reach).
const reachObjective = z.object({
  kind: z.literal('reach'),
  radius: z.number().nonnegative(),
  zone: z.string().optional(),
  template_id: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
}).refine(
  (o) => o.template_id !== undefined || (o.x !== undefined && o.y !== undefined) || o.zone !== undefined,
  { message: 'reach objective must specify template_id, x+y coordinates, or a zone' },
).refine(
  (o) => !(o.x !== undefined && o.y === undefined) && !(o.y !== undefined && o.x === undefined),
  { message: 'reach objective: x and y must both be present' },
);

const questObjective = z.discriminatedUnion('kind', [
  killCountObjective,
  killSpecificObjective,
  collectCountObjective,
  talkObjective,
  reachObjective,
]);

const questStage = z.object({
  id: z.string(),
  text: z.string(),
  on_complete: z.string().optional(),
  objective: questObjective.optional(),
});

const questReward = z.object({
  gold: z.number().positive().optional(),
  item: z.string().optional(),
  xp: z.number().positive().optional(),
});

const questDef = z.object({
  id: z.string(),
  name: z.string().optional(),
  giver: z.string().optional(),
  zone: z.string().optional(),
  description: z.string().optional(),
  stages: z.array(questStage).optional(),
  rewards: z.array(questReward).optional(),
  unlock_after: z.union([z.string(), z.array(z.string())]).optional(),
  repeatable: z.boolean().optional(),
}).passthrough();

function validateStageGraph(def: z.infer<typeof questDef>, file: string): void {
  const stages = def.stages;
  if (!stages || stages.length === 0) return;
  const ids = new Set(stages.map((s) => s.id));

  // Duplicate stage ids
  if (ids.size !== stages.length) {
    const seen = new Set<string>();
    for (const s of stages) {
      if (seen.has(s.id)) throw new Error(`Quest "${def.id}" (${file}): duplicate stage id "${s.id}"`);
      seen.add(s.id);
    }
  }

  // on_complete references must exist or equal "done"
  for (const s of stages) {
    if (s.on_complete && s.on_complete !== 'done' && !ids.has(s.on_complete)) {
      throw new Error(
        `Quest "${def.id}" (${file}): stage "${s.id}" on_complete "${s.on_complete}" is not a valid stage id`,
      );
    }
  }
}

export function validateQuestDef(raw: unknown, file: string): void {
  const result = questDef.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Quest validation failed (${file}):\n${issues}`);
  }
  validateStageGraph(result.data, file);
}
