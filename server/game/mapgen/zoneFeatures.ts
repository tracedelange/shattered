// Unified zone-feature resolution.
//
// A zone's `features` array is the single interface for dropping content into
// a zone. Each entry names either:
//   - a feature operator (mapgen/features registry) — toggled/tuned via
//     mergeFeatures and placed by the phased feature pass, or
//   - a named prefab (world/prefabs/) — compiled here into the canonical
//     stamp(+portal) post_op chain so the region/anchor wiring is generated
//     deterministically instead of hand-authored by the Implementor.
//
// normalizeZoneFeatures splits a zone's declared features into those two
// buckets; compilePrefabFeatureOps emits the post_ops for the prefab bucket.

import { FEATURE_REGISTRY } from './features/index.ts';
import type { FeatureOverride } from './biomes/index.ts';
import type { GenOp, Prefab, ZoneFeatureEntry } from '../../../shared/types.ts';

/** A normalized prefab-feature entry (always object form, id resolved). */
export interface PrefabFeatureEntry {
  id: string;
  in_region?: string;
  portal_to?: string;
  transition?: 'descend' | 'ascend' | 'teleport';
}

export interface NormalizedZoneFeatures {
  /** Override map for the registry-operator path (input to mergeFeatures). */
  overrides: Record<string, FeatureOverride> | undefined;
  /** Entries naming a world/prefabs id, in declaration order. */
  prefabEntries: PrefabFeatureEntry[];
}

/**
 * Split a zone's `features` array into registry-operator overrides and prefab
 * entries. An id present in the prefab registry but not the feature registry
 * is a prefab feature; everything else flows to mergeFeatures (which warns on
 * unknown ids downstream). `{ enabled: false }` disables a biome-default
 * operator or drops a prefab entry.
 */
export function normalizeZoneFeatures(
  features: ZoneFeatureEntry[] | undefined,
  prefabs: Record<string, Prefab>,
): NormalizedZoneFeatures {
  const overrides: Record<string, FeatureOverride> = {};
  const prefabEntries: PrefabFeatureEntry[] = [];
  if (!features) return { overrides: undefined, prefabEntries };
  if (!Array.isArray(features)) {
    console.warn('[zoneFeatures] features must be an array of entries — ignored (the override-map form was removed).');
    return { overrides: undefined, prefabEntries };
  }

  for (const entry of features) {
    const e = typeof entry === 'string' ? { id: entry } : entry;
    const enabled = e.enabled !== false;
    if (!(e.id in FEATURE_REGISTRY) && e.id in prefabs) {
      if (!enabled) continue;
      prefabEntries.push({ id: e.id, in_region: e.in_region, portal_to: e.portal_to, transition: e.transition });
    } else {
      overrides[e.id] = !enabled ? false : e.params ? { enabled: true, params: e.params } : true;
    }
  }
  return {
    overrides: Object.keys(overrides).length ? overrides : undefined,
    prefabEntries,
  };
}

/**
 * Compile prefab-feature entries into post_ops. Each entry becomes a
 * footprint-checked stamp placed by the engine — random open ground with
 * breathing room by default, or center-out inside `in_region` (silently
 * skipped when that region is absent). When `portal_to` is set, a portal op
 * targets the prefab's anchor; the anchor tag is read from the prefab
 * definition, so the stamp→portal chain can never drift out of sync.
 */
export function compilePrefabFeatureOps(
  entries: PrefabFeatureEntry[],
  prefabs: Record<string, Prefab>,
  zoneId: string,
): GenOp[] {
  const ops: GenOp[] = [];
  for (const e of entries) {
    const prefab = prefabs[e.id];
    if (!prefab) {
      console.warn(`[zoneFeatures] zone '${zoneId}': prefab feature '${e.id}' not in world/prefabs/ — skipped.`);
      continue;
    }
    ops.push((
      e.in_region
        ? {
            // Region-pinned: center-out inside the region; the region is
            // biome-claimed so the stamp needs the 'biome' overwrite mode.
            type: 'stamp',
            at: { in_region: e.in_region },
            prefab: e.id,
            region: e.id,
            overwrite: 'biome',
            if_region: e.in_region,
          }
        : {
            type: 'stamp',
            at: { random_free: true },
            prefab: e.id,
            region: e.id,
            margin: 1,
            spacing: 8,
          }
    ) as GenOp);
    if (e.portal_to) {
      const anchor = Object.values(prefab.anchors ?? {})[0];
      if (!anchor) {
        console.warn(
          `[zoneFeatures] zone '${zoneId}': feature '${e.id}' has portal_to but the prefab declares no anchors — portal skipped.`,
        );
        continue;
      }
      ops.push({
        type: 'portal',
        at: { anchor_of: e.id, anchor },
        target_zone: e.portal_to,
        transition: e.transition ?? 'descend',
      } as GenOp);
    }
  }
  return ops;
}
