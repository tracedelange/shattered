import type { ClassId } from '../../shared/types.ts';

// Procedural player sprite compositor (Phase 1 of docs/plan-player-sprites.md).
//
// Each class has a hand-authored 32x32 pixel template rendered to a 64x64
// offscreen canvas (2px cells). Templates are stored as the LEFT half only
// (32 rows x 16 cols) and mirrored — symmetry for free, half the authoring.
// Garment cells (L/g/G) are painted with a 3-shade ramp derived from the
// player's chosen color, so every (class, color) pair composites to a
// distinct sprite. Composites are cached; later phases layer equipment and
// FX on top. Pose contract for overlay phases: head rows 3-13, shoulders
// row 14, hands rows 19-20 at the arm columns, belt rows 20-22, feet row 29.

export const GRID = 32;
const CELL = 2;
export const SPRITE_SIZE = GRID * CELL;

// Template legend (left half; each row mirrors to 32 cols):
//   .  transparent          o  outline           d  face shadow
//   s  skin                 S  skin shade        w  eye white   e  eye dark
//   h  hair/beard accent    b  leather           B  leather shade
//   m  metal                M  metal shade
//   L  garment light        g  garment mid       G  garment dark
export const TEMPLATES: Record<ClassId, string[]> = {
  fighter: [
    '................',
    '................',
    '................',
    '............oooo',
    '..........oohhhh',
    '..........ohhhhh',
    '..........ohgggg',
    '..........ohssss',
    '..........osssss',
    '..........osswes',
    '..........osssss',
    '..........oSssss',
    '...........oSSSS',
    '............ooss',
    '.......ommmmggss',
    '......ommmmggggg',
    '......omMMoGgggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......ossoGggggL',
    '......ossoBbbbmm',
    '.......ooobbbbbb',
    '.........oGGGGo.',
    '.........oGGGGo.',
    '.........oGgGGo.',
    '.........oBBBBo.',
    '.........oBbbBo.',
    '........obbbbbo.',
    '........oooooo..',
    '................',
    '................',
  ],
  rogue: [
    '................',
    '................',
    '................',
    '............oooo',
    '...........ogggg',
    '..........ogGggg',
    '..........oggggg',
    '..........ogdddd',
    '..........ogdddd',
    '..........ogdwwd',
    '..........ogdddd',
    '..........ogGddd',
    '...........oGGGG',
    '............ooGG',
    '........oggggggg',
    '.......oGGoggggL',
    '.......oGGoGgggL',
    '.......oGGoGgggL',
    '.......oGGoGgggL',
    '.......ossoggggL',
    '.......ossoBbbbb',
    '........oobbbbbb',
    '..........oGGGo.',
    '..........oGGGo.',
    '..........oGGGo.',
    '..........oGGGo.',
    '..........oBBBo.',
    '..........obbBo.',
    '.........obbbbo.',
    '.........ooooo..',
    '................',
    '................',
  ],
  wizard: [
    '...............o',
    '..............og',
    '.............ogg',
    '.............ogg',
    '............oggg',
    '............oggg',
    '........ooGggggg',
    '..........osssss',
    '..........osswes',
    '..........osssss',
    '..........ohhsss',
    '..........ohhhss',
    '...........ohhhh',
    '............ohhh',
    '.......ogggggggg',
    '......oGGogggggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......oGGoGggggL',
    '......oGGogggggL',
    '......ossogggggL',
    '.......ooobbbbbb',
    '........oGgggggL',
    '........oGgggggL',
    '........oGgggggL',
    '........oGGggggL',
    '........oGGggggL',
    '........oGGGgggg',
    '........oGGGGGGG',
    '........oooooooo',
    '................',
    '................',
  ],
};

const BASE_COLORS: Record<string, string> = {
  o: '#1a1410',
  d: '#241d18',
  w: '#f0ead8',
  e: '#20180f',
  s: '#d9a06b',
  S: '#b07c4e',
  h: '#6b3f1d',
  b: '#7a5632',
  B: '#57391f',
  m: '#b9bfc7',
  M: '#7e858e',
};

// Per-class overrides for skin tone and hair/beard accent.
const CLASS_COLORS: Record<ClassId, Record<string, string>> = {
  fighter: {},
  rogue: { w: '#e8d9a0' },
  wizard: { s: '#e6c39a', S: '#c49b6f', h: '#ddd8ce' },
};

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [110, 198, 240]; // server default #6ec6f0
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function mix(rgb: [number, number, number], toward: number, t: number): string {
  const [r, g, b] = rgb.map((c) => Math.round(c + (toward - c) * t));
  return `rgb(${r},${g},${b})`;
}

/** Full palette for a class + player color, keyed by legend char. */
export function buildPalette(klass: ClassId, color: string): Record<string, string> {
  const rgb = parseHex(color);
  return {
    ...BASE_COLORS,
    ...CLASS_COLORS[klass],
    L: mix(rgb, 255, 0.35),
    g: mix(rgb, 0, 0),
    G: mix(rgb, 0, 0.4),
  };
}

/** Expand a left-half template row to the full mirrored 32-char row. */
export function expandRow(half: string): string {
  return half + [...half].reverse().join('');
}

const cache = new Map<string, HTMLCanvasElement>();

export function getPlayerSprite(klass: ClassId | undefined, color: string | undefined): HTMLCanvasElement {
  const k: ClassId = klass && klass in TEMPLATES ? klass : 'fighter';
  const c = color || '#6ec6f0';
  const key = `${k}|${c}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const palette = buildPalette(k, c);
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const c2d = canvas.getContext('2d')!;
  const rows = TEMPLATES[k];
  for (let y = 0; y < GRID; y++) {
    const row = expandRow(rows[y]);
    for (let x = 0; x < GRID; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      c2d.fillStyle = palette[ch] ?? palette.g;
      c2d.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
  cache.set(key, canvas);
  return canvas;
}
