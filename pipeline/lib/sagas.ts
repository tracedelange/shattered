// Sagas — the narrative spine that sits ABOVE opportunities.
//
// A zone-scoped depth ladder (spawns, name, quest, cave) produces zones that
// all look alike: it rewards the PRESENCE of categories, not a distinctive
// idea. A saga is the missing layer: a region-scale arc with an ordered,
// level-banded escalation. The Gardener authors one per region, then emits
// ordinary one-shot opportunities TAGGED to a saga stage; the Implementer
// builds each piece with the saga's motif and secret in context, so the
// pieces escalate coherently (haunted graveyard -> crypt -> necromancer at the
// bottom) instead of being built blind.
//
// Sagas are a pipeline concern only (Gardener/Implementer). The runtime engine
// never reads sagas.yaml — the arc is realized entirely as ordinary zones,
// mobs, quests, and sub-zones.

import yaml from 'js-yaml';
import { z } from 'zod';
import { SAGAS_FILE, fileExists, readYaml, writeYaml } from './io.ts';
import { LevelBandSchema } from './zoneStub.ts';

// proposed: authored, not yet being built. active: stages are being realized.
// complete: every stage realized.
export const SAGA_STATUSES = ['proposed', 'active', 'complete'] as const;
export const STAGE_STATUSES = ['pending', 'realized'] as const;

// One rung of the arc. `stage` is a free-form semantic id (surface | descent |
// depths | ...). The level_band climbs stage to stage — that escalation is the
// whole point, and the Implementer is shown the band above and below so a
// stage's mobs sit between its neighbors.
export const SagaStageSchema = z.object({
  stage: z.string().min(1),
  summary: z.string().min(1),
  level_band: LevelBandSchema,
  status: z.enum(STAGE_STATUSES).default('pending'),
  // Opportunity ids that built this stage (filled by the Implementer).
  realized_by: z.array(z.string()).default([]),
}).passthrough();

export const SagaSchema = z.object({
  id: z.string().regex(/^saga_[a-z0-9_]+$/, {
    message: 'saga id must match /^saga_[a-z0-9_]+$/, e.g. saga_bonefen',
  }),
  title: z.string().min(1),
  status: z.enum(SAGA_STATUSES).default('active'),
  // NOTE: no `shard`/domain field by design. The cosmology is deliberately
  // opaque (bible the_shards.defined is empty) — a saga's cause lives in its
  // motif/secret prose as an unnamed force, never a catalogued shard. The
  // schema passthrough() still tolerates a stray `shard` on legacy sagas.
  // The region this saga belongs to: the settlement/zone it radiates from.
  anchor_zone: z.string().min(1),
  // Zones the saga is allowed to touch. Advisory bound that keeps a saga
  // localized to its neighborhood (and keeps the Implementer's context small);
  // the loop also recomputes the neighborhood from anchor_zone at runtime.
  neighborhood: z.array(z.string()).default([]),
  // The through-line a player feels. Short, in the world's voice.
  motif: z.string().min(1),
  // The mystery the arc conceals — seeded as hints in zones OTHER than the
  // payoff, then paid off at the final stage. This is the cohesion engine;
  // it is deliberately NOT "ballast".
  secret: z.string().optional(),
  // Ordered rungs, low to high. min(1) so an empty arc can't masquerade as one.
  escalation: z.array(SagaStageSchema).min(1),
}).passthrough();

export const SagasFileSchema = z.object({
  generated_at: z.string().nullable().optional(),
  sagas: z.array(SagaSchema).default([]),
}).passthrough();

export type SagaStage = z.infer<typeof SagaStageSchema>;
export type Saga = z.infer<typeof SagaSchema>;
export type SagasFile = z.infer<typeof SagasFileSchema>;

// ---------------------------------------------------------------------------
// Loading + queries
// ---------------------------------------------------------------------------

/** Load and validate sagas.yaml. Returns an empty file when none exists. */
export function loadSagas(): SagasFile {
  if (!fileExists(SAGAS_FILE)) return { sagas: [] };
  const raw = readYaml<unknown>(SAGAS_FILE);
  return SagasFileSchema.parse(raw ?? { sagas: [] });
}

/** True when the saga still has work: it is not complete and has a pending stage. */
export function isSagaOpen(saga: Saga): boolean {
  return saga.status !== 'complete' && saga.escalation.some((s) => s.status !== 'realized');
}

/** The lowest unrealized stage of a saga (the next thing to build), or null. */
export function nextUnrealizedStage(saga: Saga): SagaStage | null {
  return saga.escalation.find((s) => s.status !== 'realized') ?? null;
}

/** {realized, total} stage counts — used by metrics and progress logging. */
export function sagaProgress(saga: Saga): { realized: number; total: number } {
  return {
    realized: saga.escalation.filter((s) => s.status === 'realized').length,
    total: saga.escalation.length,
  };
}

/**
 * The open saga governing a zone: one anchored on it, or one whose advisory
 * neighborhood lists it. Prefers a saga anchored exactly on the zone. Returns
 * null when no open saga covers the zone.
 */
export function activeSagaForZone(sagas: Saga[], zoneId: string): Saga | null {
  const open = sagas.filter(isSagaOpen);
  return (
    open.find((s) => s.anchor_zone === zoneId) ??
    open.find((s) => s.neighborhood.includes(zoneId)) ??
    null
  );
}

/** The open saga anchored on a given region zone, or null. */
export function openSagaForAnchor(sagas: Saga[], anchorZone: string): Saga | null {
  return sagas.find((s) => s.anchor_zone === anchorZone && isSagaOpen(s)) ?? null;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Merge a Gardener-authored saga over its stored version, PRESERVING realized
 * progress. The Gardener may revise prose and pending stages, but a stage the
 * Implementer already built (status realized, with realized_by ids) is never
 * un-built: its stored form wins, and a realized stage the incoming saga drops
 * is kept rather than lost. New saga -> returned as-is.
 */
export function mergeSaga(stored: Saga | undefined, incoming: Saga): Saga {
  if (!stored) return incoming;

  const realizedStored = new Map(
    stored.escalation.filter((s) => s.status === 'realized').map((s) => [s.stage, s]),
  );

  // Incoming stages, but any stage already realized keeps its stored form.
  const merged = incoming.escalation.map((s) => realizedStored.get(s.stage) ?? s);

  // Re-attach realized stages the incoming saga forgot, in stored order, ahead
  // of the pending ones so the escalation still reads low-to-high.
  const incomingStages = new Set(incoming.escalation.map((s) => s.stage));
  const dropped = [...realizedStored.values()].filter((s) => !incomingStages.has(s.stage));

  return { ...incoming, escalation: [...dropped, ...merged] };
}

/**
 * Upsert authored sagas into world/lore/sagas.yaml by id (merge-preserving
 * realized progress) and write the file. Returns the saga ids that changed.
 */
export function upsertSagas(authored: Saga[]): string[] {
  if (authored.length === 0) return [];
  const file = loadSagas();
  const byId = new Map(file.sagas.map((s) => [s.id, s]));
  const changed: string[] = [];
  for (const inc of authored) {
    byId.set(inc.id, mergeSaga(byId.get(inc.id), inc));
    changed.push(inc.id);
  }
  writeYaml(SAGAS_FILE, { sagas: [...byId.values()] });
  return changed;
}

/**
 * Mark a saga stage realized by an opportunity id and write the file. Closes
 * the saga (status complete) once every stage is realized. Returns the new
 * status, or null when the saga/stage was not found.
 */
export function markStageRealized(sagaId: string, stage: string, oppId: string): Saga['status'] | null {
  const file = loadSagas();
  const saga = file.sagas.find((s) => s.id === sagaId);
  if (!saga) return null;
  const st = saga.escalation.find((s) => s.stage === stage);
  if (!st) return null;
  st.status = 'realized';
  if (!st.realized_by.includes(oppId)) st.realized_by.push(oppId);
  if (saga.escalation.every((s) => s.status === 'realized')) saga.status = 'complete';
  else if (saga.status === 'proposed') saga.status = 'active';
  writeYaml(SAGAS_FILE, { sagas: file.sagas });
  return saga.status;
}

/** Full bodies of open sagas whose anchor or neighborhood is in scope, as a
 *  context block for the Gardener (so it can continue an arc, not just see its
 *  next stage). Returns '' when none are in scope. */
export function formatSagaContext(sagas: Saga[], inScope: (zoneId: string) => boolean): string {
  const relevant = sagas.filter(
    (s) => isSagaOpen(s) && (inScope(s.anchor_zone) || s.neighborhood.some(inScope)),
  );
  if (relevant.length === 0) return '';
  const withProgress = relevant.map((s) => {
    const { realized, total } = sagaProgress(s);
    return { ...s, _progress: `${realized}/${total} stages realized` };
  });
  return (
    '# Open Sagas in this region (the narrative spine — continue these)\n\n' +
    '```yaml\n' +
    yaml.dump({ sagas: withProgress }, { lineWidth: -1, noRefs: true }).trim() +
    '\n```'
  );
}

/**
 * The Implementer-facing brief for a saga-tagged opportunity: the arc's motif
 * and secret, plus this stage shown in context with the stages immediately
 * below and above it, so the piece escalates correctly (its mobs sit between
 * the band below and the band above) and the secret is hinted, not spent, until
 * the final stage. Returns '' when the saga or stage is unknown.
 */
export function formatSagaBrief(saga: Saga | undefined, stageId: string): string {
  if (!saga) return '';
  const idx = saga.escalation.findIndex((s) => s.stage === stageId);
  if (idx < 0) return '';
  const cur = saga.escalation[idx]!;
  const prev = saga.escalation[idx - 1];
  const next = saga.escalation[idx + 1];
  const isFinal = idx === saga.escalation.length - 1;

  const lines = [
    '# Saga brief — this opportunity is part of an arc',
    '',
    `This piece realizes the **${cur.stage}** stage of "${saga.title}" (${saga.id}).`,
    'Build it so it reads as one beat of that arc, not a standalone zone.',
    '',
    `Motif: ${saga.motif.replace(/\s+/g, ' ').trim()}`,
  ];
  if (saga.secret) {
    lines.push(
      `Secret: ${saga.secret.replace(/\s+/g, ' ').trim()}`,
      isFinal
        ? 'This is the FINAL stage — the secret pays off here (the boss, the reveal, the real loot).'
        : 'Do NOT reveal the secret yet. Plant a hint toward it (a note, a carving, an NPC line), nothing more.',
    );
  }
  lines.push('', 'Escalation (this stage in context — keep levels climbing):');
  for (let i = 0; i < saga.escalation.length; i++) {
    const s = saga.escalation[i]!;
    const mark = i === idx ? '>>' : '  ';
    const band = `L${s.level_band.minLevel}-${s.level_band.maxLevel} (tier ${s.level_band.tier})`;
    lines.push(`  ${mark} ${s.stage} — ${band} — ${s.summary.replace(/\s+/g, ' ').trim()}${s.status === 'realized' ? ' [built]' : ''}`);
  }
  lines.push('', `Your mobs must sit inside L${cur.level_band.minLevel}-${cur.level_band.maxLevel}` +
    (prev ? `, above the ${prev.stage} stage` : '') +
    (next ? `, below the ${next.stage} stage` : '') + '.');
  return lines.join('\n');
}
