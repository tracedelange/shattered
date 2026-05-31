import type { Socket } from 'socket.io-client';
import type {
  ChatMessage, ClientToServerEvents, CombatEvent, Direction, EquipSlot,
  PickupEvent, PlayerEntity, QuestActionKind, QuestActionResponse,
  QuestDef, QuestsComponent, ServerToClientEvents, StatId, Tileset, XpEvent,
  ZoneSnapshot,
} from '../../shared/types.ts';

export interface CombatFloat extends CombatEvent { t: number }
export interface PickupFloat extends PickupEvent { t: number }
export interface XpFloat { amount: number; t: number }
export interface LevelUpFloat { level: number; t: number }
export interface ZoneBanner { name: string; t: number }
export interface ChatLogEntry extends ChatMessage { recvAt: number }

export interface ClientState {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  session_token: string | null;
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
  died: boolean;
  diedAt: number | null;
  chatLog: ChatLogEntry[];
  speech: Map<string, { text: string; t: number }>;
  quests: QuestsComponent;
  questDefs: Record<string, QuestDef>;
  questsByGiver: Record<string, string[]>;
  sendMove: (dir: Direction) => void;
  sendAttack: () => void;
  sendChat: (text: string) => void;
  sendAllocate: (stat: StatId) => void;
  sendEquip: (slot: number) => void;
  sendUnequip: (slot: EquipSlot) => void;
  sendQuestAction: (questId: string, action: QuestActionKind, talkingTo?: string) => Promise<QuestActionResponse>;
  _tsRef?: Tileset;
  _tileColors?: Record<string, string>;
  _spriteColors?: Record<string, string>;
}

// The state object itself is filled in by socket.ts on import.
// game.ts imports it directly — no window.mmo global.
export const state = {} as ClientState;
