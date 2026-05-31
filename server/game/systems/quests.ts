import { getFlag, setFlag } from '../../db/index.ts';

export function getQuestState(playerId: string, questId: string): { stage: string } {
  return (getFlag(`quest:${playerId}:${questId}`) as { stage: string } | null) || { stage: 'start' };
}

export function advanceQuest(playerId: string, questId: string, nextStage: string): void {
  setFlag(`quest:${playerId}:${questId}`, { stage: nextStage, ts: Date.now() });
}
