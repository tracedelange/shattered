// MVP stub. Quest state lives in world_flags keyed by `quest:<playerId>:<questId>`.
// State machine advances on triggers (talk, kill, reach). Wired up post-MVP.

import { getFlag, setFlag } from '../../db/index.js';

export function getQuestState(playerId, questId) {
  return getFlag(`quest:${playerId}:${questId}`) || { stage: 'start' };
}

export function advanceQuest(playerId, questId, nextStage) {
  setFlag(`quest:${playerId}:${questId}`, { stage: nextStage, ts: Date.now() });
}
