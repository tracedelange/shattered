// Closed sprite vocabulary + role → atlas-sprite resolution.
//
// The client renders a mob as a colored square keyed by the tileset's sprite map
// (world/tilesets/overworld.json → sprites[id].color); an off-atlas id renders
// white. Deterministic Tier-3 pins sprites from the frozen grammar; this module
// resolves the fallback (role-derived) and is the single source of truth for the
// atlas vocabulary (also used by the stager as a safety net).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORLD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'world');

let _valid: Set<string> | null = null;
/** The atlas sprite ids the client can color. */
export function validSprites(): Set<string> {
  if (_valid) return _valid;
  try {
    const ts = JSON.parse(readFileSync(join(WORLD, 'tilesets', 'overworld.json'), 'utf8')) as { sprites?: Record<string, unknown> };
    _valid = new Set(Object.keys(ts.sprites ?? {}));
  } catch { _valid = new Set(); }
  return _valid;
}

// Per-role palettes from existing atlas creatures, so a role-derived sprite stays
// plausible and varied (different ids → different colors → a varied map).
const ROLE_SPRITES: Record<string, string[]> = {
  pest:       ['rat_01', 'giant_rat_01', 'slime_01', 'swamp_slime_01', 'squirrel_01'],
  skirmisher: ['goblin_01', 'bandit_01', 'march_scout_01', 'wolf_01'],
  soldier:    ['hobgoblin_01', 'guard_01', 'goblin_shaman_01', 'warden_01'],
  brute:      ['hobgoblin_warlord_01', 'warden_captain_01'],
  tank:       ['warden_captain_01', 'guard_captain_01'],
  npc:        ['merchant_01', 'barkeep_01', 'patron_01', 'prisoner_01'],
  passive:    ['deer_01', 'squirrel_01'],
};
const FALLBACK_SPRITE = 'goblin_01';

/** Stable index from an id so the same entity always maps to the same sprite. */
function hashIndex(id: string, n: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return n ? Math.abs(h) % n : 0;
}

export function spriteForRole(role: string, id: string): string {
  const pool = ROLE_SPRITES[role] ?? ROLE_SPRITES.skirmisher;
  return pool[hashIndex(id, pool.length)] ?? FALLBACK_SPRITE;
}

/** A mob's render sprite: the grammar-pinned sprite when it's a real atlas id,
 *  else a role-derived atlas sprite. Never returns an off-atlas id. */
export function resolveMobSprite(pinned: string | undefined, role: string, id: string): string {
  if (pinned && validSprites().has(pinned)) return pinned;
  return spriteForRole(role, id);
}
