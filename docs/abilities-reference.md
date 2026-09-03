# Abilities / Modifiers / Damage Types — Source of Truth

Snapshot of the ability system as implemented today. Regenerate the tables below
by re-reading the cited files if this drifts — this doc is a reference, not the
schema itself.

- Type definitions: `shared/types.ts` (`AbilityDef`, `AbilityEffect`, `TimedModifier`, `MobTemplate`)
- Runtime engine: `server/game/systems/abilities.ts` (executor), `server/game/systems/combat.ts` (damage/resistance), `server/game/systems/stats.ts` (effective-stat + cc aggregation), `server/game/systems/ai.ts` (mob usage), `server/game/systems/movement.ts` (root/stun movement gate)
- Load-time validation: `server/world/ability_schema.ts` (zod schema — the strict gate; if a field isn't here, the world fails to load)
- Content: `world/abilities/*.yaml` (ability defs), `world/entities/mobs/*.yaml` (`abilities: [{ability, weight?, hp_below?}]` wiring)
- Design history: `docs/plan-abilities.md`, `docs/plan-class-abilities.md`, `docs/plan-combat-retune.md`

## Ability anatomy

```yaml
id: ember_spit                       # kebab/snake, unique, matches filename
name: "Ember Spit"                   # display name
actor: mob                           # player | mob | any (omit = any)
class: wizard                        # required if actor: player — ClassId | 'global'
targeting: { shape: projectile, range: 6, radius: 3 }   # radius only used when shape: area
cast: { cost: { mana: 6 }, cooldown_ticks: 40, wind_up_ticks: 8 }  # cost omitted/{} = free
effects: [ ...one or more AbilityEffect... ]
ranks:                                # player abilities only; mob abilities omit this
  - { rank: 1, requires_level: 1, cost_gold: 0, power_mult: 1.0 }
```

- **`targeting.shape`**: `self` (caster only) | `target` (melee/close range, gated by `range`) | `projectile` (same resolution as `target`, `shape` is currently cosmetic — only `range` matters) | `area` (every living, same-zone, non-fixture combatant within `radius` tiles of the resolved target, Chebyshev distance; requires `radius` or it behaves like a single-target hit).
- **`cast.cost`**: only `mana` exists today. `{}` or omitted = free, cooldown-only (every mob ability today is free).
- **`cast.wind_up_ticks`**: telegraphs the cast — visible before it lands, makes it dodgeable by moving. Optional; only 2 abilities use it today (`ember_spit`, `gore_charge`).
- **`ranks`**: required when `actor: player` (and a `class`); forbidden/absent for `mob`/`any`. Ranks scale only the flat `base` of `damage`/`heal` effects via `power_mult` — never the stat-scaled bonus. Mob abilities are always effectively rank 1 / mult 1.
- **Mob ability selection** (`castMobAbility`, `ai.ts`): a mob's `abilities: [{ability, weight?, hp_below?}]` list picks the highest-`weight` entry that's off cooldown, affordable, in range, and (if `hp_below` set) only eligible below that HP fraction. Ties/no eligible ability fall through to melee/movement.

## Effect kinds (`AbilityEffect`, one ability can have several)

| kind | shape | fields | notes |
|---|---|---|---|
| `damage` | — | `base: [lo,hi]`, `scaling?`, `brand?` | Routes through `applyResolvedDamage`: brand-resistance mult → dodge roll → armor mitigation (25% min-damage floor). `from_weapon: true` is code-only (ability 0's basic attack), never set in YAML. |
| `heal` | — | `base: [lo,hi]`, `scaling?` | Clamped to `effectiveMaxHealth`. No brand (heals aren't typed). |
| `modifier` | — | `stats: {statKey: delta}`, `duration_ticks`, `tick_effect?`, `cc?` | A timed buff/debuff. `stats` deltas are read by `effectiveStat`/`effectiveMaxHealth`/`effectiveMaxMana` for the duration. `tick_effect` (a nested `damage`/`heal`) fires every `MODIFIER_TICK_INTERVAL_TICKS` (10 ticks / 1s) — this is how DoTs/HoTs work; DoT ticks bypass dodge/armor but **do** apply brand resistance. `cc` is a list of semantic flags (see below) — a single modifier can carry more than one. |
| `move` | `charge`/`leap`/`knockback`/`blink` | `distance` | Repositioning. charge/leap pull the actor to the target (stop adjacent); knockback pushes the target away from the actor; blink dashes the actor along its facing. No damage/status by itself — pair with a `damage` effect in the same ability for a gap-closer. |

Effects apply in array order to every resolved target. A `damage` + `modifier{tick_effect}` pair (hit + DoT) is the standard "poison/bleed" pattern.

## Scaling grades (`SCALING_COEFFS`, `shared/constants.ts`)

Every `scaling` map is `{ strength?|dexterity?|intelligence?|constitution?: grade }`. Bonus = `effectiveStat(stat) × coefficient`, summed across listed stats.

| Grade | Coefficient |
|---|---|
| S | 1.5 |
| A | 1.0 |
| B | 0.6 |
| C | 0.4 |
| D | 0.25 |
| E | 0.15 |

Rough intent: S/A = signature nuke, B = standard rank-2+ hit, C = starter hit, D/E = a poke or a secondary effect riding along with a modifier (see `web_shot`'s E-grade chip damage ahead of its root).

## Damage types — "brands" (`BRAND_KEYS`, `shared/constants.ts`)

```
fire_damage | cold_damage | poison_damage | electricity_damage | acid_damage | negative_damage | positive_damage
```

DCSS-aligned array: elemental opposites (fire/cold, electricity/acid) plus poison and the negative/positive axis. Physical (untyped, `brand` undefined) is implicit — armor is its only mitigation, it's not in `BRAND_KEYS` and has no resistance stat. `lightning_damage` was renamed `electricity_damage`; `arcane_damage` was folded into `negative_damage` (`arcane_blast` kept its name/flavor, only the brand tag changed).

- Set via `damage.brand` or a DoT's `tick_effect.brand`. Omit `brand` for untyped physical damage (basic melee swings without an imbued weapon, `mauling_bleed`'s bleed, `rend`'s bleed).

### Resistance (asymmetric: mobs are hand-tuned, players are gear-emergent)

- **Mobs** — `MobTemplate.resistances: { <brand_key>: multiplier }`: `0` = immune, `1` = normal (default for any brand not listed), `>1` = vulnerable. **Uncapped** — a hand-authored `0` is a real, design-intent immunity.
- **Players** — no direct authoring; instead, gear rolls `<type>_resistance` affixes (percentage points, e.g. `fire_resistance: 12`) that sum across every equipped slot via `sumEquipRolled()` (already summed generically, no new aggregation code needed). Converted to a multiplier and **capped at `PLAYER_RESIST_CAP_PCT` = 90%** (`shared/constants.ts`) — gear stacking can never reach true immunity, only a hand-tuned mob can be.
- Both paths converge on one function: `resistanceMult(entity, brand)` in `combat.ts` — branches on `entity.type`. Applied in `applyResolvedDamage`/DoT ticks before the dodge/armor pipeline.
- Resistance affixes today (`world/entities/items/affixes/suffixes.yaml`): `of_fire_warding`, `of_frost_warding`, `of_venom_warding`, `of_storm_warding`, `of_acid_warding` (uncommon, 5-12 base) and `of_the_grave` (negative), `of_the_dawn` (positive) (rare, 8-16 base) — all jewelry/armor.

### Weapon-imbue (single type per weapon)

A weapon can roll an elemental prefix affix (`flaming`, `frost`, `venomous`, `shocking`, `withering`, `caustic`, `hallowed` — one of each brand, `world/entities/items/affixes/prefixes.yaml`). When it does, `generateItem()` (`server/game/items/generator.ts`) stamps `rolled.weapon_brand` with that brand — the **entire** swing (base + STR/scaling + the affix's own flat bonus) is tagged as that element for resistance purposes, not just an untyped bonus riding along. `pickAffixes()` enforces at most one element per item (a legendary rolling 2 prefixes can't get two conflicting types). Threaded through in `abilities.ts`'s `applyEffect`: a `from_weapon: true` damage effect (the basic attack) takes `weaponBrand(actor)` when the ability itself has no static `brand`. **Jewelry/armor elemental affixes still deal flat untyped bonus damage** (bypasses resistance) — a known, deliberately deferred gap; only the mainhand weapon determines the swing's type.

| Brand | Weapon-imbue prefix | Resistance suffix | Used by (abilities) |
|---|---|---|---|
| `fire_damage` | `flaming` | `of_fire_warding` | `firebolt` (player/wizard), `ember_spit` (mob), `ember_wisp` |
| `cold_damage` | `frost` | `of_frost_warding` | `frost_shard` (player/wizard) |
| `poison_damage` | `venomous` | `of_venom_warding` | `venom_bite` (mob, DoT), `venom_strike` (player/rogue, DoT) |
| `electricity_damage` | `shocking` | `of_storm_warding` | *(no ability yet — still a free slot)* |
| `acid_damage` | `caustic` | `of_acid_warding` | `corrode_spray` (mob, `acid_ooze`) |
| `negative_damage` | `withering` | `of_the_grave` | `arcane_blast` (player/wizard) |
| `positive_damage` | `hallowed` | `of_the_dawn` | `radiant_smite` (mob, `hollow_warden`) |
| *(untyped/physical)* | — | — (armor only) | basic attack (unarmed/unimbued), `backstab`, `power_strike`, `cleave`, `rend` (+bleed), `gore_charge`, `shadowstrike`, `mauling_bleed` (+bleed), `arrow_shot`, `shieldbash`, `web_shot` |

## Crowd control — `cc` flags (`CcKind`, `shared/types.ts`)

```
stun | root | silence | confuse
```

Carried on a `modifier` effect (`cc: [stun]`, can combine e.g. `[stun, silence]`). Aggregated per-entity via `ccFlags()` (`server/game/systems/stats.ts`), which unions `cc` across every active `TimedModifier`.

| Flag | Enforced at | Effect |
|---|---|---|
| `stun` | `applyMovement` (movement.ts) + `executeAbility` (abilities.ts) | Blocks movement AND every cast, including the basic attack. |
| `root` | `applyMovement` (movement.ts) | Blocks movement only — can still attack/cast. |
| `silence` | `executeAbility` (abilities.ts) | Blocks ability casts, but the basic attack still works. |
| `confuse` | `stepMob` (ai.ts), mobs only | Chase/flee/kite direction is replaced with a random one. No player-side confuse yet (would need input-handling changes). |

No `resist_cc` / CC-immunity authoring exists yet — deliberately deferred until real CC mobs are in the wild and balance data justifies it. Keep CC durations short (~15-30 ticks / 1.5-3s) and cooldowns long (~60-80 ticks) — it's the most frustrating dimension to face if overtuned.

## Mob-only encounter-dimension fields (`MobTemplate`, `shared/types.ts`)

These pair with the ability system to give a mob a distinct fight identity — see `.claude/skills/new-mob/SKILL.md`'s "Encounter dimensions" checklist before adding more.

| Field | Purpose | Example |
|---|---|---|
| `preferred_range?: number` | Mob backs away (kites) instead of closing to melee while it has a ready ranged ability and the target is closer than this. Needs a paired ability with `targeting.range >= preferred_range`. | `bandit_archer` (4), `ember_wisp` (5) |
| `resistances?: { brand: mult }` | Per-brand damage multiplier, see Damage Types above. | `ember_wisp` (immune fire, weak cold) |
| `abilities?: [{ability, weight?, hp_below?}]` | Special attacks/buffs beyond the basic attack. | see table below |

**Not yet supported by the engine** (don't hand-roll a workaround in YAML): true multi-body "packs" with shared aggro, mid-fight flee-below-HP kiting, phase/untargetable states, terrain hazards. These are scoped for a later phase — see project memory / `docs/plan-encounter-dimensions.md` if present.

## All abilities today (`world/abilities/*.yaml`)

| id | actor/class | shape/range | cost/cooldown | effects | brand | cc |
|---|---|---|---|---|---|---|
| `arcane_blast` | player/wizard | projectile 7 | 12 mana / 45 | dmg 10-16 (INT A) | negative | — |
| `firebolt` | player/wizard | projectile 6 | 4 mana / 20 | dmg 5-8 (INT B) | fire | — |
| `frost_shard` | player/wizard | projectile 6 | 6 mana / 30 | dmg 4-7 (INT B) + slow (speed -0.3, 40t) | cold | — |
| `mending_touch` | mob | target 4 | 8 mana / 20 | heal 10-16 (INT B) | — | — |
| `backstab` | player/rogue | target 1 | free / 32 | dmg 5-9 (DEX A) | — | — |
| `venom_strike` | player/rogue | target 1 | free / 38 | dmg 4-7 (DEX C) + poison DoT 2-3/tick, 70t | poison | — |
| `shadowstrike` | player/rogue | target 5 (charge) | free / 50 | charge 5 + dmg 7-11 (DEX B) | — | — |
| `stone_throw` | player/global | projectile 5 | free / 25 | dmg 3-6 (DEX D) | — | — |
| `power_strike` | player/fighter | target 1 | 10 mana / 30 | dmg 6-10 (STR B) | — | — |
| `cleave` | player/fighter | target 1 | 10 mana / 45 | dmg 8-13 (STR B) + knockback 1 | — | — |
| `rend` | player/fighter | target 1 | free / 40 | dmg 5-8 (STR C) + bleed 2-4/tick, 60t | — | — |
| `second_wind` | player/global | self | free / 80 | heal 12-18 (CON C) | — | — |
| `ember_spit` | mob | projectile 6 (wind-up 8) | free / 40 | dmg 4-7 (STR D) | fire | — |
| `gore_charge` | mob | target 5 (wind-up 6) | free / 50 | charge 5 + dmg 6-10 (STR B) | — | — |
| `rallying_roar` | mob | self | free / 120 | self-buff +6 STR, 80t | — | — |
| `venom_bite` | mob | target 1 | free / 30 | dmg 2-4 (DEX D) + poison DoT 1-2/tick, 50t | poison | — |
| `arrow_shot` | mob | projectile 5 | free / 25 | dmg 3-6 (DEX C) | — | — |
| `web_shot` | mob | projectile 4 | free / 70 | dmg 1-2 (DEX E) + **root** 30t | — | root |
| `shieldbash` | mob | target 1 | free / 80 | dmg 3-5 (STR D) + **stun** 15t | — | stun |
| `mauling_bleed` | mob | target 1 | free / 45 | dmg 4-7 (STR D) + bleed 2-3/tick, 50t | — | — |
| `corrode_spray` | mob | projectile 4 | free / 40 | dmg 3-6 (DEX D) + acid DoT 1-3/tick, 40t | acid | — |
| `radiant_smite` | mob | target 1 | free / 55 | dmg 6-10 (STR C) | positive | — |

## Which mobs use which abilities today

| Mob | Ability | Dimension |
|---|---|---|
| `bandit_archer` | `arrow_shot` (preferred_range 4) | Range |
| `ember_wisp` | `ember_spit` (preferred_range 5) | Range + Conditional (immune fire, weak cold) |
| `highway_thug` | `shieldbash` | Control (stun) |
| `cave_spider` | `web_shot` | Control (root) |
| `bear` | `mauling_bleed` | Attrition |
| `giant_rat` | `venom_bite` | Attrition |
| `acid_ooze` | `corrode_spray` (preferred_range 3) | Attrition + Conditional (immune acid, weak fire) |
| `hollow_warden` | `radiant_smite` | Conditional (resists positive, vulnerable to negative) |

Every other mob (`rabbit`, `squirrel`, `deer`, NPCs, trainers, fixtures) uses only the basic attack or no combat at all.

## Basic attack (ability 0)

`BASIC_ATTACK_ID = 'basic_attack'` (`server/game/systems/abilities.ts`) — a code constant, not a YAML file. `targeting: { shape: target, range: 1 }`, free, 0 cooldown (cadence is governed by `nextActTick`/`speed`, not the ability cooldown). Damage is `from_weapon: true` — derived from whatever the actor wields (or STR fallback if unarmed/a mob).

Its **range is the one property not read off the def**: `basicAttackFor(actor)` rebuilds the def per-actor with `combat.attackRange(actor)`, which is `max(class floor, mainhand's `attack_range`)` via the shared `basicAttackRange` helper. A wizard's ability 0 is a 4-tile bolt (`CLASS_ATTACK_RANGE`), a fighter's is a 1-tile swing, and a `staff` (or a future bow) carries reach to any class. The client mirrors the same helper so it knows not to walk a ranged attacker into melee. Mobs are always melee here — a ranged mob holds distance with `preferred_range` plus a ranged *ability*, never a ranged basic attack.

## Open slots / ideas for new content

- `electricity_damage` has zero abilities — an obvious next brand to use (a chain-hit AoE would also be the first real use of the new `area` targeting shape).
- No ability uses `targeting.shape: area` / `radius` yet — the primitive exists (`resolveTargets` in `abilities.ts`) but nothing exercises it.
- No `confuse` ability exists yet (only `stun`/`root` are authored).
- Jewelry/armor elemental affixes still deal flat untyped bonus damage that bypasses resistance entirely (only the mainhand weapon's `weapon_brand` is typed) — a real gap if a future pass wants every brand source independently resisted (see the "full multi-component typed damage" alternative considered and deferred when this system was designed).
- No `shocking` (electricity) mob/ability exists yet, unlike every other brand — the affix exists but nothing uses it as a weapon-imbue or ability brand.
