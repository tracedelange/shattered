import type { Socket } from 'socket.io-client';
import type {
  AbilityCastEvent, AbilityDef, BoardMessage, ChatMessage, ClientToServerEvents, CombatEvent, Direction, EquipSlot,
  HealSocketEvent, LootCorpseResponse, PickupEvent, PlayerEntity, PostBoardResponse, QuestActionKind,
  QuestActionResponse, QuestDef, QuestsComponent, ReadBoardResponse, ServerToClientEvents,
  StatId, Tileset, TradeMessage, TradeResponse, TrainMessage, TrainResponse, TrainListResponse,
  UseItemResponse, XpEvent,
  ZoneSnapshot,
} from '../../shared/types.ts';

export type { BoardMessage, ReadBoardResponse, PostBoardResponse };

export interface CombatFloat extends CombatEvent { t: number }
export interface HealFloat extends HealSocketEvent { t: number }
export interface AbilityCastFloat extends AbilityCastEvent { t: number }
export interface PickupFloat extends PickupEvent { t: number }
export interface XpFloat { amount: number; t: number }
export interface LevelUpFloat { level: number; t: number }
export interface ZoneBanner { name: string; t: number }
export interface ChatLogEntry extends ChatMessage { recvAt: number }

export interface QuestCompletion { name: string; t: number }
export interface QuestStageAdvance { questId: string; stage: string; t: number }
export interface OnlinePlayer { id: string; name: string; zone: string; level: number; klass: string }

export interface ClientState {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  entityId: string | null;
  self: PlayerEntity | null;
  zone: ZoneSnapshot | null;
  tileset: Tileset | null;
  combatEvents: CombatFloat[];
  healFloats: HealFloat[];
  abilityCastFloats: AbilityCastFloat[];
  pickupFloats: PickupFloat[];
  xpFloats: XpFloat[];
  lastXp: XpEvent | null;
  levelUp: LevelUpFloat | null;
  zoneBanner: ZoneBanner | null;
  questCompletions: QuestCompletion[];
  questStageAdvances: QuestStageAdvance[];
  died: boolean;
  diedAt: number | null;
  chatLog: ChatLogEntry[];
  speech: Map<string, { text: string; t: number }>;
  quests: QuestsComponent;
  questDefs: Record<string, QuestDef>;
  questsByGiver: Record<string, string[]>;
  abilityDefs: Record<string, AbilityDef>;
  onlinePlayers: OnlinePlayer[];
  sendMove: (dir: Direction) => void;
  sendAttack: (targetId?: string) => void;
  sendAbility: (abilityId: string, targetId?: string, tx?: number, ty?: number) => void;
  sendAutopath: (tx: number, ty: number, chaseTargetId?: string) => void;
  sendChat: (text: string) => void;
  sendAllocate: (stat: StatId) => void;
  sendEquip: (slot: number) => void;
  sendUnequip: (slot: EquipSlot) => void;
  sendDropItem: (slot: number) => void;
  sendQuestAction: (questId: string, action: QuestActionKind, talkingTo?: string) => Promise<QuestActionResponse>;
  sendPokeMob: (mobId: string) => void;
  sendTrade: (msg: TradeMessage) => Promise<TradeResponse>;
  sendTrainList: (mobId: string) => Promise<TrainListResponse>;
  sendTrain: (msg: TrainMessage) => Promise<TrainResponse>;
  sendUseItem: (slot: number) => Promise<UseItemResponse>;
  sendLootCorpse: (corpseId: string, slotId: string) => Promise<LootCorpseResponse>;
  sendReadBoard: (boardId: string) => Promise<ReadBoardResponse>;
  sendPostToBoard: (boardId: string, text: string) => Promise<PostBoardResponse>;
  sendHotbar: (hotbar: (string | null)[]) => Promise<{ ok: boolean; reason?: string }>;
  _tsRef?: Tileset | null;
  _tileColors?: Record<string, string>;
  _spriteColors?: Record<string, string>;
  _loadedTileset?: string;
  /** performance.now() when the current state.zone snapshot arrived — paired
   *  with state.zone.tick so the render loop can extrapolate the current
   *  server tick between snapshots (for modifier countdown display). */
  _zoneSnapshotAtMs?: number;
}

// The state object itself is filled in by socket.ts on import.
// game.ts imports it directly — no window.mmo global.
export const state = {} as ClientState;
