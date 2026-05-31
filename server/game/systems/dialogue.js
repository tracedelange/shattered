// Passive NPC chatter. Each living mob with a non-empty `dialogue` array
// utters a random phrase on a jittered cadence. The first chatter for a mob
// is scheduled the first time we see it (avoids everyone shouting at t=0).

const BASE_CHATTER_TICKS = 400;   // 40s baseline cadence
const CHATTER_JITTER = 200;       // ±20s, so 20–60s per NPC

function scheduleNext(currentTick) {
  return currentTick + BASE_CHATTER_TICKS + Math.floor((Math.random() * 2 - 1) * CHATTER_JITTER);
}

export function dialogueTick(world, currentTick) {
  const utterances = []; // { entityId, text }
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
    const text = lines[Math.floor(Math.random() * lines.length)];
    utterances.push({ entityId: e.id, text });
  }
  return utterances;
}
