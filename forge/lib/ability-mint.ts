// The co-mint resolver — the heart of "reuse over mint". A generated mob/archetype
// proposes an ability KIT: each entry is either an existing ability id (an explicit
// reuse) or a brand-new proposed AbilityDef. This resolves that kit into the final
// list of ability ids the archetype should reference, minting new abilities into
// world/abilities/ ONLY when no existing ability already does the same thing.
//
// Order of resolution per proposed def (this is the lean-library guarantee):
//   1. findEquivalent against the live pool → reuse that id, mint nothing.
//   2. else lintAbility → blocking problems reject the ability (no ref added);
//      a clean def is minted, added to the working pool (so later kit entries can
//      reuse it), and its id referenced.
// A minted ability's id is made unique against the pool first (a non-equivalent
// id collision is a real authoring slip, but we suffix + warn rather than abort
// the whole run).
//
// Pure except for loadAbilityPool/writeMintedAbilities (the two fs seams), so the
// resolve logic is unit-testable offline — see tools/test-ability-mint.ts.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateAbilityDef } from '../../server/world/ability_schema.ts';
import { lintAbility } from './lint-ability.ts';
import { abilitySignature, findEquivalent } from './ability-dedup.ts';
import type { AbilityDef } from '../../shared/types.ts';

const ABILITIES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'world', 'abilities');

/** A kit entry: an existing ability id (reuse), or a proposed new definition. */
export type KitEntry = string | AbilityDef;

export interface ResolvedKit {
  /** Final ability ids for the archetype (order preserved, de-duplicated). */
  refs: string[];
  /** Genuinely-new defs to persist (already lint-clean, ids made unique). */
  minted: AbilityDef[];
  /** Existing ids reused instead of minting a near-duplicate (audit trail). */
  reused: string[];
  /** Blocking problems (unknown id ref, lint failure) + `warn:` advisories. */
  problems: string[];
}

/** Load every authored ability as a full, schema-valid AbilityDef — the pool
 *  findEquivalent dedups against. (engine.ts only exposes summaries.) */
export function loadAbilityPool(): AbilityDef[] {
  return readdirSync(ABILITIES_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => validateAbilityDef(yaml.load(readFileSync(join(ABILITIES_DIR, f), 'utf8')), f));
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** Resolve one archetype's proposed kit against the pool. Does not write files —
 *  the caller persists `minted` once the whole proposal is green-lit. */
export function resolveAbilityKit(kit: KitEntry[], pool: AbilityDef[]): ResolvedKit {
  const refs: string[] = [];
  const minted: AbilityDef[] = [];
  const reused: string[] = [];
  const problems: string[] = [];
  // Working pool grows as we mint, so two archetypes (or two entries) that both
  // want the same new function share ONE minted ability instead of two.
  const working = [...pool];
  const takenIds = new Set(working.map((a) => a.id));
  const addRef = (id: string) => { if (!refs.includes(id)) refs.push(id); };

  for (const entry of kit) {
    // ── Explicit reuse by id ──────────────────────────────────────────────────
    if (typeof entry === 'string') {
      if (takenIds.has(entry)) { addRef(entry); reused.push(entry); }
      else problems.push(`kit references unknown ability id '${entry}' — not in the pool`);
      continue;
    }

    // ── Proposed new def: reuse an equivalent if one exists ────────────────────
    const equivalent = findEquivalent(entry, working);
    if (equivalent) {
      addRef(equivalent.id);
      reused.push(equivalent.id);
      problems.push(`warn: proposed '${entry.id}' is functionally equivalent to existing '${equivalent.id}' — reused instead of minting`);
      continue;
    }

    // ── No equivalent: lint, then mint ────────────────────────────────────────
    const lint = lintAbility(entry);
    const blockers = lint.filter((p) => !p.startsWith('warn:'));
    problems.push(...lint.map((p) => (p.startsWith('warn:') ? `warn: [${entry.id}] ${p.slice(6)}` : `[${entry.id}] ${p}`)));
    if (blockers.length) continue; // rejected — no ref, nothing minted

    const id = uniqueId(entry.id, takenIds);
    if (id !== entry.id) problems.push(`warn: minted ability id '${entry.id}' collided — renamed to '${id}'`);
    const def = id === entry.id ? entry : { ...entry, id };
    minted.push(def);
    working.push(def);
    takenIds.add(id);
    addRef(id);
  }

  return { refs, minted, reused, problems };
}

/** Persist minted abilities to world/abilities/<id>.yaml. Refuses to overwrite an
 *  existing file (resolveAbilityKit already guaranteed unique ids, so a clash here
 *  is a bug — surfaced rather than silently clobbering an authored ability). */
export function writeMintedAbilities(minted: AbilityDef[]): string[] {
  const written: string[] = [];
  const existing = new Set(readdirSync(ABILITIES_DIR).map((f) => f.replace(/\.ya?ml$/, '')));
  for (const def of minted) {
    if (existing.has(def.id)) throw new Error(`refusing to overwrite existing ability '${def.id}.yaml'`);
    const file = join(ABILITIES_DIR, `${def.id}.yaml`);
    writeFileSync(file, yaml.dump(def, { lineWidth: 120, noRefs: true }), 'utf8');
    written.push(file);
  }
  return written;
}

export { abilitySignature };
