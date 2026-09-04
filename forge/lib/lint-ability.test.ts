import { describe, it, expect } from 'vitest';
import { lintAbility, lintAbilityRaw } from './lint-ability.ts';
import type { AbilityDef } from '../../shared/types.ts';

// A minimal schema-valid mob ability to mutate per-case, so each test states
// only the thing it is actually about.
function ability(over: Partial<AbilityDef> = {}): AbilityDef {
  return {
    id: 'test_ability',
    name: 'Test Ability',
    targeting: { shape: 'target', range: 3 },
    cast: { cooldown_ticks: 30 },
    effects: [{ kind: 'damage', base: [4, 8] }],
    ...over,
  } as AbilityDef;
}

const blocking = (problems: string[]) => problems.filter((p) => !p.startsWith('warn:'));

describe('lintAbility — targeting coherence', () => {
  // resolveTargets reads `radius` and `origin` ONLY on the area branch, so
  // setting either elsewhere is intent that silently never runs. Both are the
  // same class of bug and both must be caught.
  it('flags a radius on a non-area shape', () => {
    const problems = lintAbility(ability({ targeting: { shape: 'target', range: 3, radius: 2 } }));
    expect(blocking(problems)).toHaveLength(1);
    expect(problems[0]).toContain('radius only applies to shape: area');
  });

  it('flags an area with no radius, which degrades to a single target', () => {
    const problems = lintAbility(ability({ targeting: { shape: 'area', range: 3 } }));
    expect(blocking(problems)).toHaveLength(1);
    expect(problems[0]).toContain('needs a radius');
  });

  it('flags origin on a non-area shape', () => {
    const problems = lintAbility(ability({ targeting: { shape: 'projectile', range: 5, origin: 'caster' } }));
    expect(blocking(problems)).toHaveLength(1);
    expect(problems[0]).toContain('origin only applies to shape: area');
  });

  it('accepts origin on an area shape, both ways round', () => {
    for (const origin of ['caster', 'target'] as const) {
      const problems = lintAbility(ability({ targeting: { shape: 'area', range: 5, radius: 2, origin } }));
      expect(blocking(problems)).toHaveLength(0);
    }
  });

  it('accepts an area that omits origin — the field is optional, default target', () => {
    const problems = lintAbility(ability({ targeting: { shape: 'area', range: 5, radius: 2 } }));
    expect(blocking(problems)).toHaveLength(0);
  });
});

describe('lintAbility — disposition coherence', () => {
  // side defaults to 'enemy', so a heal that forgets to set it heals whoever
  // you are fighting. That has no legitimate use, hence blocking.
  it('blocks a heal left on the default enemy side', () => {
    const problems = lintAbility(ability({
      targeting: { shape: 'target', range: 4 },
      effects: [{ kind: 'heal', base: [10, 16] }],
    }));
    expect(blocking(problems)).toHaveLength(1);
    expect(problems[0]).toContain('set side: ally');
  });

  it('exempts a self-heal, which never reads side at all', () => {
    const problems = lintAbility(ability({
      targeting: { shape: 'self', range: 0 },
      effects: [{ kind: 'heal', base: [10, 16] }],
    }));
    expect(blocking(problems)).toHaveLength(0);
  });

  it('warns rather than blocks on ally-side damage — friendly fire may be intended', () => {
    const problems = lintAbility(ability({ targeting: { shape: 'target', range: 3, side: 'ally' } }));
    expect(blocking(problems)).toHaveLength(0);
    expect(problems.some((p) => p.startsWith('warn:') && p.includes('friendly fire'))).toBe(true);
  });
});

describe('lintAbility — base ranges', () => {
  // rangeSchema is z.tuple([number, number]) — it checks neither order nor
  // sign, so a generator can emit either and the engine would roll it.
  it('flags an inverted base', () => {
    const problems = lintAbility(ability({ effects: [{ kind: 'damage', base: [12, 4] }] }));
    expect(blocking(problems).some((p) => p.includes('inverted'))).toBe(true);
  });

  it('flags a negative base', () => {
    const problems = lintAbility(ability({ effects: [{ kind: 'damage', base: [-5, 3] }] }));
    expect(blocking(problems).some((p) => p.includes('negative'))).toBe(true);
  });

  it('reaches a dot base nested inside a modifier, not just top-level effects', () => {
    const problems = lintAbility(ability({
      effects: [{ kind: 'modifier', stats: {}, duration_ticks: 60, tick_effect: { kind: 'damage', base: [9, 2] } }],
    }));
    expect(blocking(problems).some((p) => p.includes('tick_effect') && p.includes('inverted'))).toBe(true);
  });
});

describe('lintAbility — actor/rank coherence', () => {
  it('forbids a rank ladder on a mob ability', () => {
    const problems = lintAbility(ability({
      actor: 'mob',
      ranks: [{ rank: 1, requires_level: 1, cost_gold: 0, power_mult: 1 }],
    }));
    expect(blocking(problems).some((p) => p.includes('ranks are forbidden'))).toBe(true);
  });
});

describe('lintAbilityRaw — schema gate runs first', () => {
  it('throws on a schema failure rather than returning problems', () => {
    expect(() => lintAbilityRaw({ id: 'no_name_or_effects' }, 'bad.yaml')).toThrow(/validation failed/i);
  });

  it('rejects an unknown targeting field, so a typo cannot pass as intent', () => {
    const raw = { ...ability(), targeting: { shape: 'area', range: 5, radius: 2, orign: 'caster' } };
    expect(() => lintAbilityRaw(raw, 'typo.yaml')).toThrow(/validation failed/i);
  });

  it('passes a well-formed caster-centred area end to end', () => {
    const raw = {
      ...ability(),
      actor: 'player',
      class: 'fighter',
      targeting: { shape: 'area', range: 1, radius: 1, origin: 'caster' },
      ranks: [{ rank: 1, requires_level: 10, cost_gold: 800, power_mult: 1.0 }],
    };
    const { def, problems } = lintAbilityRaw(raw, 'ok.yaml');
    expect(def.targeting.origin).toBe('caster');
    expect(blocking(problems)).toHaveLength(0);
  });
});
