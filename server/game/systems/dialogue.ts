import type { World } from '../world.ts';

const BASE_CHATTER_TICKS = 400;
const CHATTER_JITTER = 200;

function scheduleNext(currentTick: number): number {
  return currentTick + BASE_CHATTER_TICKS + Math.floor((Math.random() * 2 - 1) * CHATTER_JITTER);
}

export interface Utterance { entityId: string; text: string }

export function dialogueTick(world: World, currentTick: number): Utterance[] {
  const utterances: Utterance[] = [];
  for (const e of world.entities.values()) {
    if (e.type !== 'mob') continue;
    if ((e.components.health?.current ?? 0) <= 0) continue;
    const lines = e.dialogue;
    if (!lines || lines.length === 0) continue;
    if (e.nextChatterTick == null) {
      e.nextChatterTick = scheduleNext(currentTick);
      continue;
    }
    if (currentTick < e.nextChatterTick) continue;
    e.nextChatterTick = scheduleNext(currentTick);
    const text = lines[Math.floor(Math.random() * lines.length)]!;
    utterances.push({ entityId: e.id, text });
  }
  return utterances;
}
