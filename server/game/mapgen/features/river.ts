import type { Direction, PointRef } from '../../../../shared/types.ts';
import type { FeatureOperator } from './index.ts';

// River feature variants, keyed by the edges the water crosses (mirrors the
// beach_* directional pattern). worldgen records a cell's riverEdges; the
// export picks the matching variant (river_NS, river_NE, river_S, ...). The
// blueprint paints a meandering `water` path between those edge MIDPOINTS, so a
// river leaving one zone's east edge at t=0.5 meets its neighbour's west edge at
// t=0.5 — rivers line up across zone borders. Water is impassable (BLOCKING_TILES),
// so a river needs a crossing/bridge to traverse (fast-follow).

const DIR: Record<string, Direction> = { N: 'north', S: 'south', E: 'east', W: 'west' };

const RIVER_TILE   = 'water';
const RIVER_WIDTH  = 3;
const RIVER_JITTER = 4;

function riverOp(edges: Direction[]) {
  // Two edges → flow through the zone (edge → center → edge). One edge → a
  // spring/mouth that runs from that edge into the zone center.
  const points: PointRef[] = edges.length >= 2
    ? [{ edge: edges[0]!, t: 0.5 }, { center: true }, { edge: edges[1]!, t: 0.5 }]
    : [{ edge: edges[0]!, t: 0.5 }, { center: true }];
  return { type: 'path' as const, points, tile: RIVER_TILE, width: RIVER_WIDTH, jitter: RIVER_JITTER, seed: 'feature_river' };
}

function riverVariant(code: string): FeatureOperator {
  const edges = code.split('').map((c) => DIR[c]!);
  const desc = edges.length >= 2
    ? `A river cutting across the zone (${code}).`
    : `A river running into the zone from the ${edges[0]}.`;
  return {
    id: `river_${code}`,
    note: `${desc} Impassable water — a crossing is needed to traverse it.`,
    phase: 'decorate',
    blueprint: () => [riverOp(edges)],
  };
}

// Order-independent edge pairs + single-edge source/mouth variants.
export const RIVER_CODES = ['NS', 'EW', 'NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W'] as const;

export const riverVariants: Record<string, FeatureOperator> = Object.fromEntries(
  RIVER_CODES.map((code) => [`river_${code}`, riverVariant(code)]),
);
