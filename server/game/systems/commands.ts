import type { World } from '../world.ts';
import type { PlayerEntity } from '../../../shared/types.ts';

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

// --- Built-in commands ---

registerCommand({
  name: 'recall',
  summary: 'Teleport to the Firdale.',
  handler: ({ player, world }) => {
    const STARTING_ZONE = 'starting_village';
    if (player.position.zone === STARTING_ZONE) {
      return { error: 'You are already in the Firdale.' };
    }
    const sp = world.getZoneSpawnPoint(STARTING_ZONE);
    const fromZone = player.position.zone;
    const ok = world.teleportPlayer(player, STARTING_ZONE, sp.x, sp.y);
    if (!ok) return { error: 'Recall failed: starting zone unavailable.' };
    return {
      message: 'You feel the world fold, and find yourself in the village square.',
      teleported: { fromZone, toZone: STARTING_ZONE },
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
