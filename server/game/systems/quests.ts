import type { World } from '../world.ts';
import type {
  MobEntity, PlayerEntity, QuestActionKind, QuestActionResponse, QuestDef,
  QuestObjective, QuestStageDef, QuestStateEntry, QuestsComponent,
} from '../../../shared/types.ts';

function ensureQuests(player: PlayerEntity): QuestsComponent {
  if (!player.components.quests) {
    player.components.quests = { active: [], completed: [] };
  }
  return player.components.quests;
}

function ensureProgress(entry: QuestStateEntry): Record<string, number> {
  if (!entry.progress || typeof entry.progress !== 'object') entry.progress = {};
  return entry.progress;
}

function findStage(def: QuestDef, stageId: string): QuestStageDef | undefined {
  return def.stages?.find((s) => s.id === stageId);
}

// When a stage omits `objective`, default to a talk-the-giver objective.
// Makes start / report_back stages work without authoring.
function resolveObjective(def: QuestDef, stage: QuestStageDef): QuestObjective | null {
  if (stage.objective) return stage.objective;
  if (def.giver) return { kind: 'talk', target_template: def.giver };
  return null;
}

export function getPlayerQuests(player: PlayerEntity): QuestsComponent {
  return ensureQuests(player);
}

export function isActive(player: PlayerEntity, questId: string): boolean {
  return ensureQuests(player).active.some((q) => q.questId === questId);
}

export function isCompleted(player: PlayerEntity, questId: string): boolean {
  return ensureQuests(player).completed.includes(questId);
}

export const TALK_RANGE = 2;

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Returns true if a mob within `radius` tiles of the player matches `giverKey`.
 *  giverKey is matched against mob.components.ai.spawn_id first; if no mob has
 *  that spawn_id in the zone, it falls back to matching template_id.  This lets
 *  quest givers target either a specific spawn entry or any mob of a template. */
function withinRangeOfGiver(
  player: PlayerEntity, world: World, giverKey: string, radius: number,
): boolean {
  const { zone, x, y } = player.position;
  let foundBySpawnId = false;
  for (const e of world.entities.values()) {
    if (e.type !== 'mob') continue;
    if (e.position.zone !== zone) continue;
    if (e.components.ai?.spawn_id === giverKey) {
      foundBySpawnId = true;
      if (chebyshev(x, y, e.position.x, e.position.y) <= radius) return true;
    }
  }
  // If any mob in the zone carries this as a spawn_id but none were in range,
  // stop here — don't fall through to template matching.
  if (foundBySpawnId) return false;
  // Fall back: treat giverKey as a template_id.
  for (const e of world.entities.values()) {
    if (e.type !== 'mob') continue;
    if (e.position.zone !== zone) continue;
    if (e.components.ai?.template_id !== giverKey) continue;
    if (chebyshev(x, y, e.position.x, e.position.y) <= radius) return true;
  }
  return false;
}

export function handleQuestAction(
  player: PlayerEntity,
  defs: Record<string, QuestDef>,
  questId: string,
  action: QuestActionKind,
  context: { talkingTo?: string; world?: World } = {},
): QuestActionResponse {
  const quests = ensureQuests(player);
  const def = defs[questId];
  if (!def) return { ok: false, reason: 'unknown_quest' };

  if (action === 'accept') {
    if (isActive(player, questId)) return { ok: false, reason: 'already_active' };
    if (isCompleted(player, questId)) return { ok: false, reason: 'already_completed' };
    // Serial gating: all prerequisite quests must be completed first.
    if (def.unlock_after) {
      const prereqs = Array.isArray(def.unlock_after) ? def.unlock_after : [def.unlock_after];
      const done = ensureQuests(player).completed;
      if (!prereqs.every((id) => done.includes(id))) {
        return { ok: false, reason: 'locked' };
      }
    }
    if (def.giver && context.world) {
      if (!withinRangeOfGiver(player, context.world, def.giver, TALK_RANGE)) {
        return { ok: false, reason: 'out_of_range' };
      }
    }
    const firstStage = def.stages?.[0]?.id ?? 'start';
    const entry: QuestStateEntry = {
      questId, stage: firstStage, accepted_at: Date.now(), progress: {},
    };
    quests.active.push(entry);
    autoAdvanceSelfTalk(player, def, entry);
    return { ok: true, quests };
  }
  if (action === 'decline') {
    return { ok: true, quests };
  }
  if (action === 'abandon') {
    const before = quests.active.length;
    quests.active = quests.active.filter((q) => q.questId !== questId);
    if (quests.active.length === before) return { ok: false, reason: 'not_active' };
    return { ok: true, quests };
  }
  if (action === 'talk') {
    const entry = quests.active.find((q) => q.questId === questId);
    if (!entry) return { ok: false, reason: 'not_active' };
    const stage = findStage(def, entry.stage);
    if (!stage) return { ok: false, reason: 'unknown_stage' };
    const obj = resolveObjective(def, stage);
    if (!obj || obj.kind !== 'talk') return { ok: false, reason: 'not_a_talk_stage' };
    if (obj.target_template !== context.talkingTo) {
      return { ok: false, reason: 'wrong_npc' };
    }
    if (context.world && !withinRangeOfGiver(player, context.world, obj.target_template, TALK_RANGE)) {
      return { ok: false, reason: 'out_of_range' };
    }
    advanceStage(player, def, entry);
    return { ok: true, quests };
  }
  return { ok: false, reason: 'unknown_action' };
}

export interface NotifyResult {
  changed: boolean;
  rewardsGranted: { gold: number; items: string[] };
}

function emptyResult(): NotifyResult {
  return { changed: false, rewardsGranted: { gold: 0, items: [] } };
}

function mergeRewards(into: NotifyResult, from: { gold: number; items: string[] }): void {
  into.rewardsGranted.gold += from.gold;
  into.rewardsGranted.items.push(...from.items);
}

export function notifyKill(
  player: PlayerEntity,
  defs: Record<string, QuestDef>,
  mob: MobEntity,
): NotifyResult {
  const result = emptyResult();
  const quests = ensureQuests(player);
  const mobTemplate = mob.components.ai?.template_id;
  const mobZone = mob.position.zone;
  for (const entry of quests.active) {
    const def = defs[entry.questId];
    if (!def) continue;
    const stage = findStage(def, entry.stage);
    if (!stage) continue;
    const obj = resolveObjective(def, stage);
    if (!obj) continue;
    if (obj.kind === 'kill_count') {
      if (obj.template_id && obj.template_id !== mobTemplate) continue;
      if (obj.zone && obj.zone !== mobZone) continue;
      const prog = ensureProgress(entry);
      prog.killed = (prog.killed ?? 0) + 1;
      result.changed = true;
      if (prog.killed >= obj.target) mergeRewards(result, advanceStage(player, def, entry));
    } else if (obj.kind === 'kill_specific') {
      if (obj.target_id !== mob.id) continue;
      ensureProgress(entry).killed = 1;
      result.changed = true;
      mergeRewards(result, advanceStage(player, def, entry));
    }
  }
  return result;
}

export function notifyMove(
  player: PlayerEntity,
  defs: Record<string, QuestDef>,
  world: World,
): NotifyResult {
  const result = emptyResult();
  const quests = ensureQuests(player);
  const pz = player.position.zone;
  for (const entry of quests.active) {
    const def = defs[entry.questId];
    if (!def) continue;
    const stage = findStage(def, entry.stage);
    if (!stage) continue;
    const obj = resolveObjective(def, stage);
    if (!obj || obj.kind !== 'reach') continue;
    if (obj.zone && obj.zone !== pz) continue;
    if (!withinReach(player, obj, world)) continue;
    result.changed = true;
    mergeRewards(result, advanceStage(player, def, entry));
  }
  return result;
}

function withinReach(
  player: PlayerEntity,
  obj: Extract<QuestObjective, { kind: 'reach' }>,
  world: World,
): boolean {
  if (obj.template_id) return withinRangeOfGiver(player, world, obj.template_id, obj.radius);
  if (typeof obj.x === 'number' && typeof obj.y === 'number') {
    const { x, y } = player.position;
    return chebyshev(x, y, obj.x, obj.y) <= obj.radius;
  }
  return false;
}

export function notifyPickup(
  player: PlayerEntity,
  defs: Record<string, QuestDef>,
  itemBase: string,
  qty = 1,
): NotifyResult {
  const result = emptyResult();
  const quests = ensureQuests(player);
  for (const entry of quests.active) {
    const def = defs[entry.questId];
    if (!def) continue;
    const stage = findStage(def, entry.stage);
    if (!stage) continue;
    const obj = resolveObjective(def, stage);
    if (!obj || obj.kind !== 'collect_count') continue;
    if (obj.item_base !== itemBase) continue;
    const prog = ensureProgress(entry);
    prog.collected = (prog.collected ?? 0) + qty;
    result.changed = true;
    if (prog.collected >= obj.target) mergeRewards(result, advanceStage(player, def, entry));
  }
  return result;
}

type Rewards = { gold: number; items: string[] };
const NO_REWARDS: Rewards = { gold: 0, items: [] };

function advanceStage(player: PlayerEntity, def: QuestDef, entry: QuestStateEntry): Rewards {
  const stage = findStage(def, entry.stage);
  if (!stage) return NO_REWARDS;
  const next = stage.on_complete;
  if (!next || next === 'done') return completeQuest(player, def, entry);
  entry.stage = next;
  entry.progress = {};
  return autoAdvanceSelfTalk(player, def, entry);
}

// If the current stage is the just-accepted talk-the-giver default, skip it
// — accepting the quest IS the talk. Only applies to the very first stage;
// later talk stages require an explicit click.
function autoAdvanceSelfTalk(player: PlayerEntity, def: QuestDef, entry: QuestStateEntry): Rewards {
  while (true) {
    const stage = findStage(def, entry.stage);
    if (!stage) return NO_REWARDS;
    const obj = resolveObjective(def, stage);
    if (!obj) return NO_REWARDS;
    if (obj.kind !== 'talk' || stage.id !== def.stages?.[0]?.id) return NO_REWARDS;
    const next = stage.on_complete;
    if (!next || next === 'done') return completeQuest(player, def, entry);
    entry.stage = next;
    entry.progress = {};
  }
}

function completeQuest(player: PlayerEntity, def: QuestDef, entry: QuestStateEntry): Rewards {
  const quests = ensureQuests(player);
  quests.active = quests.active.filter((q) => q.questId !== entry.questId);
  if (!quests.completed.includes(entry.questId)) quests.completed.push(entry.questId);
  return grantRewards(player, def);
}

function grantRewards(player: PlayerEntity, def: QuestDef): Rewards {
  const granted: Rewards = { gold: 0, items: [] };
  if (!def.rewards) return granted;
  for (const r of def.rewards) {
    if (r.gold) {
      player.components.wallet.gold = (player.components.wallet.gold || 0) + r.gold;
      granted.gold += r.gold;
    }
    if (r.item) {
      const slots = player.components.inventory.slots;
      const slot = slots.findIndex((s) => !s);
      if (slot !== -1) {
        slots[slot] = { base: r.item, item: null, name: r.item, sprite: 'item_misc' };
        granted.items.push(r.item);
      }
      // Inventory full → item is silently lost. Wiring a ground drop here
      // would couple this module to World; deferred.
    }
  }
  return granted;
}

export function buildGiverIndex(defs: Record<string, QuestDef>): Record<string, string[]> {
  const byGiver: Record<string, string[]> = {};
  for (const def of Object.values(defs)) {
    const giver = typeof def.giver === 'string' ? def.giver : null;
    if (!giver) continue;
    (byGiver[giver] ??= []).push(def.id);
  }
  return byGiver;
}
