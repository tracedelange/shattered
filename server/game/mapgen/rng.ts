// Deterministic PRNG + seeded value noise.
//
// The implementation moved to shared/worldgen/noise.ts so the client can compute
// identical terrain (the determinism contract, R8.7). This file re-exports it so
// existing mapgen importers keep working unchanged.
export * from '../../../shared/worldgen/noise.ts';
