import type { Socket } from 'socket.io-client';
import type {
  BoardMessage, ChatMessage, ClientToServerEvents, CombatEvent, Direction, EquipSlot,
  LootCorpseResponse, PickupEvent, PlayerEntity, PostBoardResponse, QuestActionKind,
  QuestActionResponse, QuestDef, QuestsComponent, ReadBoardResponse, ServerToClientEvents,
  StatId, Tileset, TradeMessage, TradeResponse, UseItemResponse, XpEvent,
  ZoneSnapshot,
} from '../../shared/types.ts';

export type { BoardMessage, ReadBoardResponse, PostBoardResponse };

export interface CombatFloat extends CombatEvent { t: number }
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
  onlinePlayers: OnlinePlayer[];
  sendMove: (dir: Direction) => void;
  sendAttack: () => void;
  sendAutopath: (tx: number, ty: number) => void;
  sendChat: (text: string) => void;
  sendAllocate: (stat: StatId) => void;
  sendEquip: (slot: number) => void;
  sendUnequip: (slot: EquipSlot) => void;
  sendQuestAction: (questId: string, action: QuestActionKind, talkingTo?: string) => Promise<QuestActionResponse>;
  sendPokeMob: (mobId: string) => void;
  sendTrade: (msg: TradeMessage) => Promise<TradeResponse>;
  sendUseItem: (slot: number) => Promise<UseItemResponse>;
  sendLootCorpse: (corpseId: string, slotId: string) => Promise<LootCorpseResponse>;
  sendReadBoard: (boardId: string) => Promise<ReadBoardResponse>;
  sendPostToBoard: (boardId: string, text: string) => Promise<PostBoardResponse>;
  _tsRef?: Tileset;
  _tileColors?: Record<string, string>;
  _spriteColors?: Record<string, string>;
}

// The state object itself is filled in by socket.ts on import.
// game.ts imports it directly — no window.mmo global.
export const state = {} as ClientState;
