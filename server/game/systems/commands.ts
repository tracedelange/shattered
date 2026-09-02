import type { World } from '../world.ts';
import type { PlayerEntity } from '../../../shared/types.ts';
import { equipInFirstEmpty } from '../../../shared/constants.ts';
import { PREFERRED_STARTING_ZONE } from '../../index.ts';
import { grantXp, xpForNext } from './progress.ts';
import { makePlayer } from '../entities.ts';
import { makeStack } from './inventory.ts';
import { WILD } from '../../../shared/worldgen/config.ts';

export interface CommandContext {
  player: PlayerEntity;
  world: World;
  args: string[];
}

export interface CommandResult {
  // System message to deliver back to the issuing player. Empty/undefined =
  // silent success.
  message?: string;
  // Set when the player's position changed; the chat handler emits a fresh
  // zone snapshot and updates socket room membership.
  teleported?: { fromZone: string; toZone: string };
  // Reason string when the command failed; surfaced as the message verbatim.
  error?: string;
  // Signal the client to open the world map overlay.
  openMap?: boolean;
  // Set when the handler mutated the player's record (stats, progress,
  // inventory, quests, abilities); the chat handler re-emits a fresh self +
  // quests snapshot and marks the player's zone dirty.
  refreshSelf?: boolean;
  // Set when the mutation must survive a relog regardless of the autosave
  // cadence (e.g. /reset wiping known abilities); the chat handler persists
  // the issuing character to the DB immediately.
  persist?: boolean;
}

export interface CommandDef {
  name: string;
  summary: string;
  handler: (ctx: CommandContext) => CommandResult;
}

const registry = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
  registry.set(def.name, def);
}

export function getCommand(name: string): CommandDef | undefined {
  return registry.get(name);
}

export function listCommands(): CommandDef[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Parses "/name arg1 arg2" → { name, args }. Returns null when text isn't a
// command at all (caller should treat as chat).
export function parseCommand(text: string): { name: string; args: string[] } | null {
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).trim().split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name) return null;
  return { name, args: parts.slice(1) };
}

// Resolves a zone query to a zone id: exact id, case-insensitive id, then
// display name / name. Returns undefined when nothing matches.
function resolveZoneId(world: World, query: string): string | undefined {
  if (query.toLowerCase() === WILD) return WILD;
  const zones = world.defs.zones;
  const q = query.toLowerCase();
  return (zones[query] && query) ||
    Object.keys(zones).find((id) => id.toLowerCase() === q) ||
    Object.keys(zones).find(
      (id) =>
        zones[id]!.display_name?.toLowerCase() === q ||
        zones[id]!.name?.toLowerCase() === q,
    );
}

// Case-insensitive lookup of a connected player by name, excluding the issuer
// (teleporting to yourself is a no-op worth reporting as "no match").
function findOnlinePlayer(world: World, query: string, excludeId: string): PlayerEntity | undefined {
  const q = query.toLowerCase();
  for (const e of world.entities.values()) {
    if (e.type !== 'player' || e.id === excludeId) continue;
    if (e.name.toLowerCase() === q) return e;
  }
  return undefined;
}

function describeZone(world: World, zoneId: string): string {
  if (zoneId === WILD) return 'The Wilds';
  const z = world.defs.zones[zoneId];
  return z?.display_name || z?.name || zoneId;
}

// --- Built-in commands ---


registerCommand({
  name: 'heal',
  summary: 'Restore health to full.',
  handler: ({ player }) => {
    player.components.health.current = player.components.health.max;
    const ok = true;
    if (!ok) return { error: 'Heal failed.' };
    return {
      message: 'You feel a surge of vitality course through your body.',
    };
  },
});

registerCommand({
  name: 'god',
  summary: 'Toggle god mode (negate all incoming damage).',
  handler: ({ player }) => {
    player.godMode = !player.godMode;
    return {
      message: player.godMode
        ? 'God mode enabled. You are invulnerable.'
        : 'God mode disabled. You are mortal again.',
    };
  },
});

registerCommand({
  name: 'recall',
  summary: 'Teleport to the Firdale.',
  handler: ({ player, world }) => {
    const STARTING_ZONE = PREFERRED_STARTING_ZONE;
    const sp = world.getZoneSpawnPoint(STARTING_ZONE);
    const fromZone = player.position.zone;
    const ok = world.teleportPlayer(player, STARTING_ZONE, sp.x, sp.y);
    if (!ok) return { error: 'Recall failed: starting zone unavailable.' };
    return {
      message: 'You feel the world fold, and find yourself in a familiar place.',
      teleported: { fromZone, toZone: STARTING_ZONE },
    };
  },
});

registerCommand({
  name: 'tp',
  summary: 'Teleport: /tp <zone>, /tp <x> <y>, /tp <zone> <x> <y>, or /tp <player name>.',
  handler: ({ player, world, args }) => {
    const USAGE = 'Usage: /tp <zone>, /tp <x> <y>, /tp <zone> <x> <y>, or /tp <player name>';
    if (args.length === 0) return { error: USAGE };
    const fromZone = player.position.zone;

    // Trailing "<x> <y>" pair, when present, splits the args: everything before
    // it is the destination zone (empty = stay in the current zone).
    const tail = args.slice(-2);
    const hasCoords = args.length >= 2 && tail.every((a) => /^-?\d+$/.test(a));
    const coords = hasCoords
      ? { x: parseInt(tail[0]!, 10), y: parseInt(tail[1]!, 10) }
      : null;
    const query = (hasCoords ? args.slice(0, -2) : args).join(' ').trim();

    // Resolve the destination zone: explicit query, else stay put.
    let toZoneId: string | undefined;
    if (query) {
      toZoneId = resolveZoneId(world, query);
      // No zone by that name — with coords given it can only have been a zone,
      // so fail; otherwise fall through to an online-player lookup.
      if (!toZoneId) {
        if (hasCoords) return { error: `No zone found matching "${query}".` };
        const target = findOnlinePlayer(world, query, player.id);
        if (!target) return { error: `No zone or online player matching "${query}".` };
        const ok = world.teleportPlayer(player, target.position.zone, target.position.x, target.position.y);
        if (!ok) return { error: `Teleport failed: ${target.name} is somewhere unreachable.` };
        return {
          message: `Teleported to ${target.name} (${describeZone(world, target.position.zone)} ${player.position.x}, ${player.position.y}).`,
          teleported: { fromZone, toZone: player.position.zone },
        };
      }
    } else {
      toZoneId = fromZone;
    }

    // Zone with no coords keeps the original behaviour: land on its spawn point.
    const dest = coords ?? world.getZoneSpawnPoint(toZoneId);

    // Grid zones have hard bounds; teleportPlayer would silently clamp, which
    // reads as "the command ignored me". Reject instead. WILD is unbounded.
    if (toZoneId !== WILD) {
      const rt = world.zones[toZoneId];
      if (!rt) return { error: `Teleport failed: zone "${toZoneId}" unavailable.` };
      if (dest.x < 0 || dest.y < 0 || dest.x >= rt.width || dest.y >= rt.height) {
        return { error: `(${dest.x}, ${dest.y}) is outside ${toZoneId} (0-${rt.width - 1}, 0-${rt.height - 1}).` };
      }
    }

    const ok = world.teleportPlayer(player, toZoneId, dest.x, dest.y);
    if (!ok) return { error: `Teleport failed: zone "${toZoneId}" unavailable.` };
    // teleportPlayer nudges to the nearest free tile, so report where we landed.
    const { x, y } = player.position;
    return {
      message: `Teleported to ${describeZone(world, toZoneId)} (${x}, ${y}).`,
      teleported: { fromZone, toZone: toZoneId },
    };
  },
});

registerCommand({
  name: 'help',
  summary: 'List available chat commands.',
  handler: () => {
    const lines = listCommands().map((c) => `/${c.name} — ${c.summary}`);
    return { message: lines.join('\n') };
  },
});

registerCommand({
  name: 'xp',
  summary: 'Grant yourself XP for testing (default 100).',
  handler: ({ player, args }) => {
    const parsed = args[0] ? parseInt(args[0], 10) : 100;
    const amount = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
    const result = grantXp(player, amount);
    const prog = player.components.progress;
    const message = result.leveled > 0
      ? `Granted ${amount} XP. Leveled up to ${result.toLevel}!`
      : `Granted ${amount} XP (level ${prog.level}, ${prog.xp}/${xpForNext(prog.level)}).`;
    return { message, refreshSelf: true };
  },
});

registerCommand({
  name: 'gp',
  summary: 'Grant yourself 100 gold for testing.',
  handler: ({ player }) => {
    player.components.wallet.gold += 100;
    return {
      message: `Granted 100 gold (${player.components.wallet.gold} total).`,
      refreshSelf: true,
    };
  },
});

registerCommand({
  name: 'reset',
  summary: 'Reset your character to a fresh level-1 state (inventory, quests, stats, abilities).',
  handler: ({ player }) => {
    // Rebuild a fresh class-default record while preserving identity and
    // current position; copy its components over the live entity.
    const fresh = makePlayer({
      id: player.id,
      zone: player.position.zone,
      x: player.position.x,
      y: player.position.y,
      name: player.name,
      klass: player.klass,
    });
    player.components = fresh.components;
    player.abilityCooldowns = {};
    player.godMode = false;
    return {
      message: 'Your character has been reset to a fresh level-1 state.',
      refreshSelf: true,
      persist: true, // wipe must survive a relog, not wait for the next autosave
    };
  },
});

registerCommand({
  name: 'spell',
  summary: 'Learn a spell/ability by id for testing (e.g. /spell blink).',
  handler: ({ player, world, args }) => {
    const q = args[0]?.toLowerCase().trim();
    if (!q) return { error: 'Usage: /spell <ability id> (e.g. /spell blink)' };
    const abilities = world.defs.abilities ?? {};
    // Match by id (case-insensitive). Only player-castable abilities are worth
    // granting — a mob-only ability lands in knownAbilities but can't be cast.
    const id = abilities[q] ? q : Object.keys(abilities).find((a) => a.toLowerCase() === q);
    const def = id ? abilities[id] : undefined;
    if (!def || !id) {
      const learnable = Object.values(abilities)
        .filter((a) => a.actor === 'player')
        .map((a) => a.id)
        .sort();
      return { error: `No ability "${q}". Learnable: ${learnable.join(', ') || '(none)'}` };
    }
    if (def.actor && def.actor !== 'player' && def.actor !== 'any') {
      return { error: `"${id}" is not a player-castable ability.` };
    }
    if (player.components.knownAbilities[id]) {
      return { message: `You already know ${def.name}.` };
    }
    player.components.knownAbilities[id] = 1; // rank 1
    if (player.components.hotbar) equipInFirstEmpty(player.components.hotbar, id);
    return {
      message: `Learned ${def.name}.`,
      refreshSelf: true, // rebuild the hotbar from the new known set
      persist: true,     // survive a relog like /reset, not wait for autosave
    };
  },
});

registerCommand({
  name: 'give',
  summary: 'Give yourself an item by base id for testing (e.g. /give potion_of_haste).',
  handler: ({ player, world, args }) => {
    const q = args[0]?.toLowerCase().trim();
    if (!q) return { error: 'Usage: /give <item base id> (e.g. /give potion_of_haste)' };
    const bases = world.defs.itemBases ?? {};
    const id = bases[q] ? q : Object.keys(bases).find((b) => b.toLowerCase() === q);
    const base = id ? bases[id] : undefined;
    if (!base || !id) return { error: `No item base "${q}".` };
    const slots = player.components.inventory.slots;
    const freeSlot = slots.findIndex((s) => !s);
    if (freeSlot === -1) return { error: 'Inventory full.' };
    slots[freeSlot] = makeStack(world.defs, id, null);
    return { message: `Gave you ${base.name || id}.`, refreshSelf: true };
  },
});

registerCommand({
  name: 'map',
  summary: 'Open the world map.',
  handler: () => ({ openMap: true }),
});

registerCommand({
  name: 'settime',
  summary: 'Set the in-game time (format: HH:MM, e.g. 14:30).',
  handler: ({ world, args }) => {
    const timeStr = args.join('').trim();
    if (!timeStr) return { error: 'Usage: /settime HH:MM (e.g., /settime 14:30)' };

    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return { error: 'Invalid format. Use HH:MM (e.g., 14:30)' };

    const hours = parseInt(match[1]!, 10);
    const minutes = parseInt(match[2]!, 10);

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return { error: 'Hours must be 0-23, minutes must be 0-59.' };
    }

    const totalMinutes = hours * 60 + minutes;
    world.timeOfDay = totalMinutes / (24 * 60);

    return { message: `Time set to ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}.` };
  },
});
