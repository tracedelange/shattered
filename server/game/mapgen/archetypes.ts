// Structural archetype library. An archetype is a zone's internal spatial
// grammar — not a tile layout, but a set of rules about how the zone organizes
// itself: where flow enters and exits, where the focal point sits, what kind of
// internal variety exists. The Implementer selects one per zone; it drives the
// default focal point and the authoring guidance shown in the prompt.
//
// Pure data + pure helpers. No tile painting happens here — the archetype
// guides where the LLM places structure and where narrative content anchors.

import type { ZoneArchetype } from '../../../shared/types.ts';

export interface ArchetypeSpec {
  id: ZoneArchetype;
  /** One-line summary of the archetype's purpose. */
  summary: string;
  /** Typical zone kinds that fit this archetype. */
  typical: string;
  /** Where the focal point sits, in words (drives narrative anchoring). */
  focal: string;
  /**
   * Default focal offset from the anchor (landmark, else zone center), as a
   * fraction of zone dimensions. Most archetypes anchor the focal point AT the
   * landmark (offset 0); the value exists so the offset is data, not a magic
   * number, and so an author can reason about it. Resolved by
   * resolveFocalPoint in index.ts.
   */
  focalOffset: { fx: number; fy: number };
  /** Authoring guidance injected into the Implementer prompt. */
  guidance: string;
}

export const ARCHETYPES: Record<ZoneArchetype, ArchetypeSpec> = {
  approach: {
    id: 'approach',
    summary: 'A zone designed to be traversed.',
    typical: 'corridors, passes, ravines',
    focal: 'the far-end payoff, opposite the entry',
    focalOffset: { fx: 0, fy: 0 },
    guidance:
      'Give it a clear entry and exit and a progression of openings and choke ' +
      'points between them, with the payoff at the far end. Place the landmark ' +
      'at the far-end payoff and route the main path entry → chokes → landmark.',
  },
  crucible: {
    id: 'crucible',
    summary: 'A zone designed to be fought in.',
    typical: 'arenas, courtyards, siege grounds',
    focal: 'the central contested ground (a raised platform, a well, a dais)',
    focalOffset: { fx: 0, fy: 0 },
    guidance:
      'Give it a defensible perimeter, multiple internal cover positions, and ' +
      'sightlines that reward positioning. Put the landmark on the central ' +
      'contested ground and arrange cover and approaches around it.',
  },
  sanctuary: {
    id: 'sanctuary',
    summary: 'A zone that invites exploration over a contained area.',
    typical: 'forests, ruins, caverns',
    focal: 'a hidden interior clearing or chamber',
    focalOffset: { fx: 0, fy: 0 },
    guidance:
      'Give it a dense interior with branching paths and pockets of interest ' +
      'scattered throughout, with no dominant axis of movement. Place the ' +
      'landmark at a tucked-away interior clearing the player discovers. A ' +
      'voronoi op is a strong fit for the irregular interior subdivision.',
  },
  threshold: {
    id: 'threshold',
    summary: 'A transitional zone between two meaningfully different areas.',
    typical: 'gates, fords, border posts',
    focal: 'the crossing point at its middle',
    focalOffset: { fx: 0, fy: 0 },
    guidance:
      'Make one face echo the zone it connects FROM and the other anticipate ' +
      'the zone it connects TO. Keep it thin but not featureless. Put the ' +
      'landmark at the crossing point in the middle.',
  },
  hearth: {
    id: 'hearth',
    summary: 'A zone designed for habitation or rest.',
    typical: 'camps, shrines, settlements',
    focal: 'the center of gravity (fire, altar, well)',
    focalOffset: { fx: 0, fy: 0 },
    guidance:
      'Give it a center of gravity (a fire, altar, or well), secondary ' +
      'activity areas arranged around it, and a clear perimeter. Place the ' +
      'landmark on the center of gravity itself.',
  },
};

export function isArchetype(value: unknown): value is ZoneArchetype {
  return typeof value === 'string' && value in ARCHETYPES;
}

/** Compact list of archetype names for prompts and error messages. */
export const ARCHETYPE_NAMES: ZoneArchetype[] = Object.keys(ARCHETYPES) as ZoneArchetype[];

/**
 * Formats the archetype library as a guidance block for the Implementer
 * prompt. Kept here so the canonical description lives with the data.
 */
export function formatArchetypeGuide(): string {
  const lines: string[] = [];
  for (const a of Object.values(ARCHETYPES)) {
    lines.push(
      `- **${a.id}** — ${a.summary} Typical: ${a.typical}. ` +
      `Focal point: ${a.focal}. ${a.guidance}`,
    );
  }
  return lines.join('\n');
}
