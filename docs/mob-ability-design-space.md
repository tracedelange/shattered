# Mob Ability Design Space — Coverage Targets

Not a schema doc (see `docs/abilities-reference.md` for how the engine actually
works). This is the sampling grid the ability generator should be checked
against: which axis values exist today, which are still empty, and what to
prioritize before/while generating so output doesn't collapse onto the same
few patterns.

## Axes

| Axis | Legal values | Covered today | Gap / priority |
|---|---|---|---|
| Targeting shape | self, target, projectile, area | self, target, projectile | **area unused** — highest priority |
| Effect kind | damage, heal, modifier, move | damage, modifier | **heal unused on any mob ability** |
| CC flag (`modifier.cc`) | stun, root, silence, confuse | stun, root | **silence, confuse unused** (confuse has bespoke AI handling in `ai.ts` — untested against real content) |
| Move motion | charge, leap, knockback, blink | charge, knockback | **leap, blink unused** |
| Brand | fire, cold, poison, electricity, acid, negative, positive | fire, cold, poison, acid, negative, positive | **electricity unused anywhere** (mob or ability) |
| Scaling grade | S, A, B, C, D, E | all used | none — fine as is |
| `hp_below` trigger (phase/enrage) | any fraction | never set | untested — no mob switches ability at a HP threshold |
| `wind_up_ticks` (telegraph) | any int | 2 of 22 abilities | fine to stay rare — telegraphs should be the exception, not the norm |

## Combination constraints (already enforced by schema, don't fight them)

- `radius` only valid when `shape: area`.
- `ranks` forbidden on `actor: mob`/`any` — mob abilities are flat, single-power.
- `cost` on mob abilities today is always `{}` (free/cooldown-only) — no mob spends mana. Fine to keep; don't invent a mob mana economy without a reason.
- A `move` effect carries no damage/status itself — pair it with a `damage` effect in the same ability for a gap-closer, or leave it bare for a pure reposition (e.g. a blink-away support mob).

## Generation priority (fill these before/while bulk-generating)

Ordered so each new ability also exercises a currently-empty mob-side gap (role, resistance) from the companion archetype TODO:

1. Area-damage ability (e.g. a radius spit/slam) — pairs with an AoE caster archetype.
2. Electricity-branded ability, ideally with a stun-chain flavor — pairs with the missing electricity brand.
3. Confuse-CC ability — exercises `maybeConfuse` for the first time in real content.
4. Silence-CC ability — needs a caster-role mob to matter (silencing a melee brute is a no-op).
5. Leap ability (gap-closer, distinct from charge's straight-line pull).
6. Blink ability (self-reposition, no target damage) — pairs with a kiter/support archetype.
7. Mob-usable heal (self or `shape: area` for group-heal) — pairs with a support/shaman archetype.
8. One `hp_below`-gated ability on an existing or new mob — proves the phase/enrage pattern works before the generator is asked to invent enrage mobs wholesale.

## How the generator should use this

Treat each row's "covered today" list as *already saturated* — don't ask the
model to freely pick targeting shape / CC / motion / brand, sample preferentially
from the gap column above until every cell has at least one real ability. Once
the grid is full, sampling can go uniform/random across all legal values instead
of gap-weighted.
