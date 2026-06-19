// Deterministic prefab linter — the "eyes" of the generate loop. An LLM emits a
// grid char-by-char and never sees the 2D result, so it ships hollow boxes and
// disconnected pockets. This computes the ground-truth structural facts a vision
// model would only estimate (connectivity, wall ratio, anchor placement) and
// feeds them back as concrete defects the model can fix.

import type { LintResult, PrefabBrief, PrefabCandidate } from './types.ts';

/** Parse the grid into a rectangular char matrix, right-padding short rows with
 *  spaces so downstream indexing is safe. Returns rows of equal length. */
function toMatrix(data: string): { cells: string[][]; ragged: boolean } {
  const lines = data.replace(/\r/g, '').split('\n');
  // Drop a trailing empty line (common with block scalars) but keep interior ones.
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const width = lines.reduce((m, l) => Math.max(m, l.length), 0);
  let ragged = false;
  const cells = lines.map((l) => {
    if (l.length !== width) ragged = true;
    return [...l.padEnd(width, ' ')];
  });
  return { cells, ragged };
}

/** Flood-fill count of connected walkable regions (4-connectivity). */
function countRegions(walk: boolean[][]): number {
  const h = walk.length;
  const w = h ? walk[0]!.length : 0;
  const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  let regions = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!walk[y]![x] || seen[y]![x]) continue;
      regions++;
      const stack = [[x, y]];
      seen[y]![x] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (walk[ny]![nx] && !seen[ny]![nx]) { seen[ny]![nx] = true; stack.push([nx, ny]); }
        }
      }
    }
  }
  return regions;
}

export interface LintOptions {
  /** Tile names that block movement (walls/water/void), built from the tileset. */
  blockingTiles: Set<string>;
  /** Every tile name that exists in the brief's tileset; legend values must be in here. */
  validTiles: Set<string>;
  /** Flag a structureless interior as a defect. Default true. Off for the staged
   *  pipeline, where geometry is deterministic and a bare room is a valid output. */
  checkHollow?: boolean;
}

export function lintPrefab(prefab: PrefabCandidate, brief: PrefabBrief, opts: LintOptions): LintResult {
  const defects: string[] = [];
  const legend = prefab.legend ?? {};
  const { cells, ragged } = toMatrix(prefab.data ?? '');
  const rows = cells.length;
  const cols = rows ? cells[0]!.length : 0;

  if (ragged) defects.push('Grid is ragged — rows have unequal length; pad every row to the same width.');
  if (rows !== brief.height || cols !== brief.width) {
    defects.push(`Dimensions are ${cols}×${rows} but the brief asked for ${brief.width}×${brief.height}.`);
  }

  // Legend completeness: every non-space char in the grid must map to a tile.
  const used = new Set<string>();
  for (const row of cells) for (const ch of row) if (ch !== ' ') used.add(ch);
  const unmapped = [...used].filter((ch) => !(ch in legend));
  if (unmapped.length) defects.push(`Legend is missing entries for: ${unmapped.map((c) => `'${c}'`).join(', ')}.`);

  // Legend tiles must be real tiles in the brief's tileset — a hallucinated tile
  // (e.g. 'chest' in a tileset that lacks it) renders as a fallback / breaks load.
  const badTiles = [...new Set(Object.values(legend))].filter((t) => !opts.validTiles.has(t));
  if (badTiles.length) {
    defects.push(`Legend uses tiles not in the '${brief.tileset}' tileset: ${badTiles.map((t) => `'${t}'`).join(', ')}. Use only the listed tiles.`);
  }

  // Walkability map: a cell is walkable if its tile exists and isn't blocking.
  // Spaces and unmapped chars are treated as non-walkable (outside the footprint).
  const walk = cells.map((row) =>
    row.map((ch) => {
      const tile = legend[ch];
      return !!tile && !opts.blockingTiles.has(tile);
    }),
  );
  let walkable = 0;
  let blocked = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cells[y]![x] === ' ') continue; // outside footprint, ignore
      if (walk[y]![x]) walkable++; else blocked++;
    }
  }
  const total = walkable + blocked;
  const wallFraction = total ? blocked / total : 0;
  const walkableRegions = countRegions(walk);

  if (walkable === 0) {
    defects.push('No walkable tiles at all — the prefab is solid.');
  } else if (walkableRegions > 1) {
    defects.push(`Walkable space is split into ${walkableRegions} disconnected regions — every open tile must be reachable from every other (add doors/corridors).`);
  }

  // Hollow-box detector: a big footprint whose only blocked cells are the outer
  // border has no internal structure. Interior = cells not on the edge.
  if (opts.checkHollow !== false && rows >= 5 && cols >= 5) {
    let interiorBlocked = 0;
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (cells[y]![x] !== ' ' && !walk[y]![x]) interiorBlocked++;
      }
    }
    if (interiorBlocked === 0 && walkable > 0) {
      defects.push('Hollow box: the interior is one empty room with no internal walls, pillars, or sub-rooms. Add structure.');
    }
  }

  if (wallFraction > 0.7) {
    defects.push(`Too solid: ${(wallFraction * 100).toFixed(0)}% of the footprint is blocking. Open it up.`);
  }

  // Anchors: each anchor char must appear in the grid and sit on a walkable tile.
  const anchors = prefab.anchors ?? {};
  for (const [ch, tag] of Object.entries(anchors)) {
    let found = false;
    let onWalkable = false;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (cells[y]![x] === ch) { found = true; if (walk[y]![x]) onWalkable = true; }
      }
    }
    if (!found) defects.push(`Anchor '${ch}' (${tag}) is declared but never appears in the grid.`);
    else if (!onWalkable) defects.push(`Anchor '${ch}' (${tag}) sits on a blocking tile — anchors must be walkable.`);
  }

  return {
    ok: defects.length === 0,
    defects,
    stats: { rows, cols, walkable, blocked, wallFraction, walkableRegions, anchors: Object.keys(anchors).length },
  };
}
