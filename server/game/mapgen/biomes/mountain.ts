import type { BiomeDef } from './index.ts';

export const mountain: BiomeDef = {
  id: 'mountain',
  tileset: 'overworld',
  tags: ['outdoor'],
  palette: { floor: 'stone_floor', wall: 'wall', accent: 'cracked_stone_floor' },
  defaultTile: 'stone_floor',
  width: 60,
  height: 50,
  basePipeline: [
    // Rock formation walls
    {
      kind: 'fixed',
      id: 'mountain_rock',
      params: [
        { field: 'threshold', label: 'Rock density', min: 0.30, max: 0.65, step: 0.01, default: 0.45 },
      ],
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'wall',
        threshold: 0.45,
        scale: 4.0,
        seed: 'mountain_rock',
      },
    },
    // Cracked stone surface variation
    {
      kind: 'fixed',
      op: {
        type: 'noise_patch',
        bounds: { all: true },
        tile: 'cracked_stone_floor',
        threshold: 0.60,
        scale: 5.5,
        seed: 'mountain_crack',
        over: 'stone_floor',
      },
    },
    // A narrow pass through the rock
    {
      kind: 'fixed',
      op: {
        type: 'path',
        points: [{ edge: 'west', t: 0.5 }, { edge: 'east', t: 0.5 }],
        tile: 'dirt',
        width: 2,
        jitter: 3,
        seed: 'mountain_pass',
      },
    },
  ],
  features: [],
};
