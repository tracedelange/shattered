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

    // --- New zones should declare a structural archetype ---
    // The archetype drives focal-point placement and internal spatial grammar.
    // A created zone without one falls back to a featureless tile-first layout.
    if (z.mode === 'create' && !z.archetype) {
      warnings.push({
        zone: z.id,
        code: 'missing_archetype',
        message:
          `created zone has no archetype. Pick one of approach, crucible, ` +
          `sanctuary, threshold, hearth so the zone has an internal spatial ` +
          `grammar and a defined focal point.`,
      });
    }

    // --- Adjacency constraints imply a matching connection ---
    // An adjacency relationship is only structurally real in the current graph
    // model if the two zones actually connect. Flag any adjacency constraint
    // whose target isn't among this zone's connections (or co-created here).
    const connTargets = new Set(Object.values(z.connections ?? {}));
    for (const c of z.spatial_constraints ?? []) {
      if (c.type !== 'adjacency') continue;
      if (!connTargets.has(c.target)) {
        warnings.push({
          zone: z.id,
          code: 'adjacency_without_connection',
          message:
            `adjacency constraint targets "${c.target}" but no connection to ` +
            `it is declared. Add a connections.<dir> = "${c.target}" entry ` +
            `(and the matching reverse connection on "${c.target}") so the ` +
            `narrative adjacency is also a traversable one.`,
        });
      }
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

  const doc = parsed as { ops?: unknown[]; default_tile?: string; width?: number; height?: number };
  const ops = doc.ops;
  if (!Array.isArray(ops)) return warnings;

  lintGeneratorOps(zoneId, doc, ops as Array<Record<string, unknown>>, warnings);

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

// Tiles that make a sensible solid background for carving generators (cave/bsp).
const SOLID_DEFAULTS = new Set(['wall', 'void']);

/**
 * Lints the geometry-first generator ops within a zone: tag wiring between
 * producers (scatter_sites/stamp/network/bsp) and consumers (route/network/
 * stamp/ensure_reach), carving-generator backgrounds, scatter over-subscription,
 * and route mode sanity. All non-fatal — surfaces silent mis-wirings early.
 */
function lintGeneratorOps(
  zoneId: string,
  doc: { default_tile?: string; width?: number; height?: number },
  ops: Array<Record<string, unknown>>,
  warnings: OpWarning[],
): void {
  const width = doc.width ?? 40;
  const height = doc.height ?? 30;

  // First pass: which tags does each op PRODUCE, and at what earliest index.
  const produced = new Map<string, number>();
  const add = (tag: unknown, idx: number) => {
    if (typeof tag === 'string' && tag && !produced.has(tag)) produced.set(tag, idx);
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.type === 'scatter_sites' && Array.isArray(op.tags)) for (const t of op.tags) add(t, i);
    if (op.type === 'bsp' && Array.isArray(op.tags)) for (const t of op.tags) add(t, i);
    if (op.type === 'stamp') {
      const anchors = (op.prefab as { anchors?: Record<string, string> } | undefined)?.anchors;
      if (anchors) for (const v of Object.values(anchors)) add(v, i);
    }
    if (op.type === 'network') add((op.edge_tag as string) ?? 'road', i);
  }

  const consume = (tag: unknown, field: string, idx: number, opId?: string) => {
    if (typeof tag !== 'string' || !tag) return;
    const p = produced.get(tag);
    if (p === undefined) {
      warnings.push({
        zone: zoneId, op_index: idx, op_id: opId, code: 'unresolved_tag',
        message: `${field} references tag "${tag}" but no earlier op produces it. ` +
          `Produce it first (scatter_sites tags / stamp anchors / network edge_tag).`,
      });
    } else if (p > idx) {
      warnings.push({
        zone: zoneId, op_index: idx, op_id: opId, code: 'tag_ordering',
        message: `${field} consumes tag "${tag}" at op #${idx} but it is only produced at op #${p}. ` +
          `Move the producing op earlier.`,
      });
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const id = typeof op.id === 'string' ? op.id : undefined;

    if (op.type === 'route') {
      const modes = [op.from, op.from_tag, op.edges].filter((x) => x != null).length;
      if (modes === 0) {
        warnings.push({ zone: zoneId, op_index: i, op_id: id, code: 'route_no_source',
          message: 'route needs one of from, from_tag, or edges.' });
      }
      if ((op.from || op.from_tag) && op.to == null) {
        warnings.push({ zone: zoneId, op_index: i, op_id: id, code: 'route_no_target',
          message: 'route with from/from_tag also needs a `to`.' });
      }
      consume(op.from_tag, 'route.from_tag', i, id);
      consume(op.edges, 'route.edges', i, id);
    }
    if (op.type === 'network') consume(op.nodes_tag, 'network.nodes_tag', i, id);
    if (op.type === 'stamp') consume(op.at_tag, 'stamp.at_tag', i, id);
    if (op.type === 'ensure_reach' && Array.isArray(op.ensure_tags)) {
      for (const t of op.ensure_tags) consume(t, 'ensure_reach.ensure_tags', i, id);
    }

    // Carving generators want a solid background so only carved space is walkable.
    if ((op.type === 'cave' || op.type === 'bsp') && op.wall === undefined) {
      const dt = doc.default_tile;
      if (dt && !SOLID_DEFAULTS.has(dt)) {
        warnings.push({ zone: zoneId, op_index: i, op_id: id, code: 'carver_walkable_background',
          message: `${op.type} with default_tile "${dt}" (walkable) and no \`wall:\` fill — ` +
            `background stays traversable. Use default_tile: wall/void or set wall: on the op.` });
      }
    }

    // scatter_sites over-subscription: count·spacing² exceeding the place area.
    if (op.type === 'scatter_sites') {
      const count = Number(op.count) || 0;
      const spacing = Number(op.spacing) || 0;
      const b = op.bounds as { all?: boolean; rect?: { w: number; h: number } } | undefined;
      let area: number | null = null;
      if (!b || b.all) area = width * height;
      else if (b.rect) area = b.rect.w * b.rect.h;
      if (area != null && spacing > 0 && count * spacing * spacing > area) {
        warnings.push({ zone: zoneId, op_index: i, op_id: id, code: 'scatter_oversubscribed',
          message: `scatter_sites wants ${count} sites at spacing ${spacing} ` +
            `(needs ~${count * spacing * spacing} of ${area} cells) — likely under-places. ` +
            `Lower count/spacing or enlarge bounds.` });
      }
    }
  }
}
