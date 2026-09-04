import { describe, expect, it } from 'vitest';
import type { DungeonSite } from '../../../shared/worldgen/atlas.ts';
import { clearReveals, pickRevealTarget, revealedSites, revealSite } from './scrolls.ts';

function site(id: string): DungeonSite {
  return { id, name: id, worldX: 0, worldY: 0, band: 1, minLevel: 1, maxLevel: 5 };
}

describe('pickRevealTarget', () => {
  const sites = [site('a'), site('b'), site('c')];

  it('never picks a site the character already knows', () => {
    const known = new Set(['a', 'b']);
    for (let roll = 0; roll < 1; roll += 0.05) {
      expect(pickRevealTarget(sites, known, () => roll)?.id).toBe('c');
    }
  });

  it('returns null when every site is known — the scroll must not be spent', () => {
    expect(pickRevealTarget(sites, new Set(['a', 'b', 'c']))).toBeNull();
    expect(pickRevealTarget([], new Set())).toBeNull();
  });

  it('can reach every unknown site', () => {
    const seen = new Set<string>();
    for (let roll = 0; roll < 1; roll += 0.01) {
      seen.add(pickRevealTarget(sites, new Set(), () => roll)!.id);
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('stays in range when the rng returns its exclusive upper bound', () => {
    expect(pickRevealTarget(sites, new Set(), () => 0.999999)?.id).toBe('c');
  });
});

describe('reveal store', () => {
  it('remembers a reveal within the epoch it was bought in', () => {
    clearReveals();
    revealSite('char1', 7, 'a');
    revealSite('char1', 7, 'b');
    expect(revealedSites('char1', 7).sort()).toEqual(['a', 'b']);
    expect(revealedSites('char2', 7)).toEqual([]);
  });

  it('expires on the epoch, not on an explicit clear — a reveal is a position', () => {
    clearReveals();
    revealSite('char1', 7, 'a');
    expect(revealedSites('char1', 8)).toEqual([]);
    // ... and the stale record is gone, so the next epoch starts clean.
    expect(revealedSites('char1', 7)).toEqual([]);
  });

  it('starts a fresh set when revealing into a later epoch', () => {
    clearReveals();
    revealSite('char1', 7, 'a');
    revealSite('char1', 8, 'b');
    expect(revealedSites('char1', 8)).toEqual(['b']);
  });
});
