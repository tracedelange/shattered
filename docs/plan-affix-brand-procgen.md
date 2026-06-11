# Plan 3 — Affix / brand proc-gen (DCSS-flavored)

**Priority:** last. Generating great items nobody can obtain is wasted effort —
this only matters once Plan 2 distributes loot.

## Goal

Loot feels generative: brands matter, the affix pool is deep, and rarity scales
power.

## Background

The generator skeleton already exists in `server/game/items/generator.ts`:
`generateItem`, `rollRarity` (common/uncommon/rare/legendary), affix prefixes
with `applies_to` tag-matching, and a rarity→prefix-count mapping. `dropLootFromMob`
(`server/game/systems/loot.ts:69`) already calls `generateItem` with a rolled
rarity. The engine-side proc-gen is ~70% built. What's missing vs DCSS:

| DCSS feature        | Current state                                          | Gap |
|---------------------|--------------------------------------------------------|-----|
| Base item tiers     | ~12 hand-authored bases                                | no tier/ilvl concept; bases aren't level-gated |
| Affixes             | prefixes only, ~7 of them (`prefixes.yaml`)            | no suffixes; tiny pool |
| Brands              | `flaming` rolls `fire_damage` but combat never reads it| brand stats roll but do nothing in `resolveAttack` |
| Enchant level (+N)  | none                                                   | no enchant axis |
| Rarity→power        | rarity sets affix *count* only                         | doesn't scale affix *magnitude* or gate eligibility |
| Random artefacts    | `sword_of_heros` is a static base                      | no random-artefact generation |

## Steps (small → large)

1. **Make brands actually do something** — `flaming` rolls `fire_damage: [1,4]`
   but `resolveAttack` (`combat.ts:99-132`) never reads it. Add brand damage
   application in the damage calc. **Highest-impact fix** — affixes that roll
   combat stats are currently inert.
   - verify: a Flaming weapon deals measurably more than its base against a
     target.

2. **Add a suffix pool** — `affixes.prefixes` is the only key in
   `prefixes.yaml`; `generateItem` only pulls prefixes. Mirror the prefix logic
   for `suffixes` (it's a copy-paste of `pickAffixes`).
   - verify: a rare item can roll "Flaming Sword of the Bear" (prefix + suffix).

3. **Expand the affix pool** — only ~7 prefixes exist. Add more across
   weapon/armor tags. Pure data.
   - verify: repeated rolls produce visible variety.

4. **Scale affix magnitude by rarity** — currently rarity only sets affix
   *count* (`rarityPrefixCount`, `generator.ts:16-21`). Make rarer items roll
   *stronger* affix values, and/or gate which affixes are eligible by rarity.
   - verify: legendary rolls are statistically stronger than common, not just
     more-affixed.

5. **(Optional, larger) item-level gating + enchant axis** — tie base/affix
   eligibility to mob level and add a `+N` enchant. Needs a new field on bases
   and a roll step. Pairs naturally with Plan 2 Track A's level-band validation.

6. **(After Plan 4) accuracy affixes** — once the hit-chance layer exists
   (Plan 4), add an affix family that grants accuracy / weapon-skill bonuses.
   This gives gear an explicit lever on the punch-up axis, not just damage and
   defense. Blocked on Plan 4 landing.

## Scope

Steps 1–3 are days of work, mostly in `generator.ts` + YAML, plus the one combat
hook for brands. Steps 4–5 are larger and benefit from Plan 2's level-band
infrastructure existing first.

## Dependencies

- Plan 2 must distribute loot before this pays off.
- Step 5 wants Plan 2 Track A's level-band validation in place.

## Out of scope

- ID / curse mechanics (DCSS-style item identification) — likely skip.
