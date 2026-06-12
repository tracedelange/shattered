# Plan 3 — Procedural gear & loot (ilvl-driven)

**Status:** active (design agreed 2026-06-12). Supersedes the original DCSS-step
plan below the line.

## Goal

Loot is generative and drops from every combat mob. Rarity scales power, brands
matter, and the affix pool is deep across **all** equipment slots (weapons,
armor, jewelry). Powerful drops can come from weak mobs — rarely.

## Agreed decisions

- **Base generation: Hybrid.** Procedural `material × archetype` composition is
  the default pool; hand-authored bases (uniques, quest items) coexist and win
  on id collision.
- **Drops: universal by level.** Every combat-role mob auto-rolls a generated
  equip drop keyed to its level. `loot_table` is kept for guaranteed
  quest/currency/signature drops only.
- **Power tail: moderate.** ilvl centers on mob level with small variance and a
  ~2% chance of a meaningful upward jump (godrolls from weak mobs, rare).
- **Brands: simple flat bonus now.** Brand damage adds flat to the swing; no
  resistances yet.
- **Equipment hook: unified aggregation.** One pass sums rolled combat stats
  across ALL equipped slots (weapon brands, armor `armor`, jewelry/armor
  `+str/+dex/...`) and combat reads from it — so every slot's affixes matter
  through one path.

## Model spine

1. **Procedural bases** — `materials.yaml` (tiers: class, `min_ilvl`, stat
   multipliers, weight tags) × `archetypes.yaml` (slot, tags, base stat profile,
   scaling, sprite, eligible material classes). Composed into `defs.itemBases`
   at load (`loader.ts`), skipping ids already hand-authored.
2. **ilvl sampling** — `ilvl = mobLevel + (rand<0.02 ? roll[5,12] : roll[-1,2])`,
   clamped. Drives base-tier eligibility, rarity weights, affix magnitude.
3. **Base pick** — eligible bases have `min_ilvl ≤ ilvl`; weighted toward tiers
   near ilvl so high rolls feel special.
4. **Rarity** — weights shift modestly better with ilvl.
5. **Affixes** — prefixes + suffixes; affix `rarity` field gates eligibility
   (finally read); magnitude scales with rarity × ilvl; legendaries get more
   affixes, bigger numbers, and a generated name.
6. **Combat** — `sumEquipRolled(entity)` aggregates rolled numeric stats across
   all slots: brand keys → flat swing bonus; `armor` → defense; stat keys →
   effective stats (feed scaling, dodge). Mobs have no equipment → zero.
7. **Naming** — `resolveItemName` handles prefixes + suffixes
   ("Flaming Iron Sword of the Bear") and is wired into the drop path so names
   actually surface (currently drops use `base.name`).

## Files
- New: `world/entities/items/materials.yaml`, `.../archetypes.yaml`,
  `.../affixes/suffixes.yaml`; `server/game/items/bases.ts` (composer).
- `server/world/loader.ts` — compose + merge after hand-authored bases.
- `server/game/items/generator.ts` — ilvl, base pick, rarity-by-ilvl, suffixes,
  magnitude scaling, suffix naming, `generateDrop`.
- `server/game/systems/loot.ts` — universal drop path + `resolveItemName`.
- `server/game/systems/combat.ts` — `sumEquipRolled` + brand/stat/armor reads.
- `world/entities/items/affixes/prefixes.yaml` — expanded pool.
- `shared/types.ts` / `shared/constants.ts` — `min_ilvl` on `ItemBase`,
  `name_suffix`/`rarity` on `Affix`, material/archetype types, `BRAND_KEYS`,
  ilvl/magnitude/drop constants.

## Verification
- Flaming weapon out-damages its base (brands live).
- +str ring raises a player's hit damage (jewelry lives via aggregation).
- Repeated drops show base/rarity/prefix/suffix variety; legendaries are
  statistically stronger, not just more-affixed.
- A low-level mob can rarely drop a high-ilvl item.

## Out of scope
- ID / curse mechanics.
- Typed damage / resistances (brands are flat for now).
- Accuracy affixes (blocked on Plan 4's hit-chance layer).

---

# Original plan (superseded — kept for reference)

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
