// Structural lint for BuildPlan and zone op YAML.
//
// Two lint passes run in the two-shot Implementer flow:
//
//   1. Plan lint  — runs after the plan call returns. Checks structural
//      invariants that can be verified without running mapgen: unknown
//      connection targets, unknown tilesets, and heuristic detection of
//      non-rect+walls intent in layout_sketch prose.
//      Warnings are appended to the execute user message so the LLM can
//      course-correct before producing YAML.
//
//   2. Op lint    — runs after the execute call returns, before writing
//      files. Parses each zone YAML body and flags the two main silent
//      failure modes: walls on non-rect region shapes, and polygon `at`
//      fields (which are always ignored by the engine).
//      Warnings are logged to stderr and returned for history storage.
//
// Neither pass is fatal — the pipeline continues regardless. The goal is
// surfacing known engine pitfalls early enough to be actionable.

import yaml from 'js-yaml';
import type { BuildPlan } from './schemas.ts';

// ---------------------------------------------------------------------------
// Plan lint
// ---------------------------------------------------------------------------

export interface PlanWarning {
  zone: string;
  code: string;
  message: string;
}

/**
 * Lint a BuildPlan for detectable structural problems. Returns an array of
 * warnings. Call this immediately after the plan LLM call and inject any
 * warnings into the execute user message so the LLM can self-correct.
 *
 * @param plan           The validated BuildPlan returned by the plan call.
 * @param knownZoneIds   Zone IDs that currently exist in the world.
 * @param knownTilesets  Tileset names that currently exist in the world.
 */
export function lintBuildPlan(
  plan: BuildPlan,
  knownZoneIds: Set<string>,
  knownTilesets: Set<string>,
): PlanWarning[] {
  const warnings: PlanWarning[] = [];

  // IDs being created in this plan — valid targets for intra-plan connections.
  const coCreated = new Set(plan.zones.map((z) => z.id));

  for (const z of plan.zones) {
    // --- Connection targets must exist or be co-created ---
    for (const [dir, target] of Object.entries(z.connections ?? {})) {
      if (!knownZoneIds.has(target) && !coCreated.has(target)) {
        warnings.push({
          zone: z.id,
          code: 'unknown_connection_target',
          message:
            `connections.${dir} references "${target}" which does not exist ` +
            `in the current world and is not being created in this plan.`,
        });
      }
    }

    // --- Tileset must be known ---
    if (z.tileset && !knownTilesets.has(z.tileset)) {
      warnings.push({
        zone: z.id,
        code: 'unknown_tileset',
        message:
          `tileset "${z.tileset}" does not exist. ` +
          `Available tilesets: ${[...knownTilesets].sort().join(', ')}.`,
      });
    }

    // --- Heuristic: non-rect shape co-mentioned with walls in layout_sketch ---
    // The engine silently discards the walls field for any region whose shape
    // is not rect. If the sketch prose mentions both a non-rect shape AND walls,
    // that's a plan-time red flag worth surfacing before the execute call.
    const sketch = (z.layout_sketch ?? '').toLowerCase();
    const nonRectShapes = ['circle', 'ellipse', 'polygon'];
    const mentionsWalls = sketch.includes('wall');
    if (mentionsWalls) {
      for (const shape of nonRectShapes) {
        if (sketch.includes(shape)) {
          warnings.push({
            zone: z.id,
            code: 'non_rect_walls_risk',
            message:
              `layout_sketch mentions a ${shape} region with walls. ` +
              `The engine silently discards the walls field for non-rect shapes (circle, ellipse, polygon). ` +
              `Use separate shape ops to paint wall tiles around the border instead.`,
          });
          break; // one warning per zone for this category is enough
        }
      }
    }
  }

  return warnings;
}

/**
 * Formats plan warnings as a Markdown section to append to the execute
 * user message. Returns an empty string when there are no warnings.
 */
export function formatPlanWarnings(warnings: PlanWarning[]): string {
  if (warnings.length === 0) return '';
  const lines = [
    '',
    '## Plan Warnings (auto-detected — address these in your YAML)',
    '',
    'The following structural issues were detected in your build plan.',
    'They describe known engine constraints that produce SILENT failures.',
    'Correct them in the YAML you produce — do not reproduce the same mistakes.',
    '',
  ];
  for (const w of warnings) {
    lines.push(`- **[${w.code}] ${w.zone}**: ${w.message}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Op lint (post-execute)
// ---------------------------------------------------------------------------

export interface OpWarning {
  zone: string;
  op_index: number;
  op_id?: string;
  code: string;
  message: string;
}

/**
 * Parse a raw zone YAML body and lint the ops array for known silent failure
 * modes. Returns an array of warnings.
 *
 * Currently checks:
 *   - walls on a non-rect region shape (silently discarded by engine)
 *   - polygon region with a non-trivial `at` field (silently ignored)
 *
 * @param zoneId  Zone ID for error attribution.
 * @param body    Raw YAML string (the zone file content as returned by the LLM).
 */
export function lintZoneOps(zoneId: string, body: string): OpWarning[] {
  const warnings: OpWarning[] = [];

  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch {
    // Malformed YAML — schema validation will catch this; skip here.
    return warnings;
  }

  const ops = (parsed as { ops?: unknown[] })?.ops;
  if (!Array.isArray(ops)) return warnings;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Record<string, unknown>;
    if (op.type !== 'region') continue;

    const shape = op.shape as Record<string, unknown> | undefined;
    if (!shape) continue;
    const kind = shape.kind as string | undefined;

    // walls on non-rect region — engine silently discards it.
    if (op.walls !== undefined && kind !== 'rect') {
      warnings.push({
        zone: zoneId,
        op_index: i,
        op_id: typeof op.id === 'string' ? op.id : undefined,
        code: 'walls_on_non_rect_region',
        message:
          `region "${op.id ?? `#${i}`}" has shape.kind="${kind}" with walls set. ` +
          `The engine only applies walls to rect shapes — this walls field will be silently discarded. ` +
          `Use separate shape ops to paint wall tiles manually.`,
      });
    }

    // Polygon `at` — silently ignored by engine; points must be absolute.
    if (kind === 'polygon') {
      const at = op.at as Record<string, unknown> | undefined;
      if (at) {
        const isNonTrivial =
          'center' in at ||
          'relative_to' in at ||
          ('x' in at && ((at.x as number) !== 0 || ((at as { y?: number }).y ?? 0) !== 0));
        if (isNonTrivial) {
          warnings.push({
            zone: zoneId,
            op_index: i,
            op_id: typeof op.id === 'string' ? op.id : undefined,
            code: 'polygon_at_ignored',
            message:
              `region "${op.id ?? `#${i}`}" is a polygon with at=${JSON.stringify(at)}. ` +
              `The at field is silently ignored for polygons — points must be in absolute zone coordinates.`,
          });
        }
      }
    }
  }

  return warnings;
}
