// Types shared between server and client. No runtime side effects.

export type Direction = 'north' | 'south' | 'east' | 'west';

export type ClassId = 'fighter' | 'rogue' | 'wizard';

export type EquipSlot =
  | 'mainhand'
  | 'helmet'
  | 'chest'
  | 'gloves'
  | 'leggings'
  | 'boots'
  | 'ring1'
  | 'ring2'
  | 'amulet';

export type StatId = 'strength' | 'dexterity' | 'intelligence' | 'constitution';

export type ScalingLetter = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | '-';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export type Range = [number, number];

export interface Position {
  zone: string;
  x: number;
  y: number;
}

export interface RolledStats {
  damage: Range | null;
  defense: Range | null;
  speed?: number;
  scaling: Partial<Record<StatId, ScalingLetter>> | null;
  [extra: string]: unknown;
}

export interface ItemEntity {
  id: string;
  type: 'item';
  components: {
    equipment: {
      base: string;
      affixes: string[];
      rolled: RolledStats;
      rarity?: Rarity;
    };
  };
}

export interface InventoryStack {
  base: string;
  item: ItemEntity | null;
  name: string;
  sprite: string;
  sell_value?: number;
  item_slot?: string;
}

export type Equipment = Record<EquipSlot, InventoryStack | null>;

export interface HealthComponent { current: number; max: number }
export interface InventoryComponent { slots: (InventoryStack | null)[] }
export interface WalletComponent { gold: number }
export interface StatsComponent {
  strength?: number;
  dexterity?: number;
  intelligence?: number;
  constitution?: number;
  speed?: number;
  damage?: Range | number;
  /** Flat armor override for mobs; if absent, defense is derived from constitution. */
  armor?: number;
}
export interface ProgressComponent { level: number; xp: number; unspent_points: number }
export interface QuestStateEntry {
  questId: string;
  stage: string;
  accepted_at: number;
  // Per-stage counters keyed by objective-defined keys (e.g. "killed",
  // "collected"). Reset to {} when a stage transitions.
  progress: Record<string, number>;
}
export interface QuestsComponent {
  active: QuestStateEntry[];
  completed: string[];
}
export interface AIComponent {
  behavior: string;
  aggro_range: number;
  template_id: string;
  /** Optional stable identifier for a specific spawn entry (set from ZoneSpawn.spawn_id).
   *  When present, quest givers can target this mob exclusively rather than any mob
   *  sharing the same template_id. */
  spawn_id?: string;
  target: string | null;
  spawn_region?: string;
  fixture?: boolean;
  /** Marks this mob as a readable sign. Its dialogue lines are shown in a read modal
   *  rather than broadcast to zone chat. */
  sign?: boolean;
  /** Stable identifier for a player-writable message board (e.g. "firdale_notice_board").
   *  Persists across server restarts; used as the DB key for board_messages. */
  board_id?: string;
  /** Set when a non-aggressive mob is hit by a player; causes it to fight back until
   *  the threat dies, flees, or moves beyond PROVOKED_LEASH tiles. */
  provoked?: boolean;
}

export interface PlayerEntity {
  id: string;
  type: 'player';
  name: string;
  klass: ClassId;
  color?: string;
  sprite?: string;
  position: Position;
  facing: Direction;
  nextActTick: number;
  nextRegenTick: number;
  components: {
    health: HealthComponent;
    inventory: InventoryComponent;
    equipment: Equipment;
    wallet: WalletComponent;
    stats: StatsComponent;
    progress: ProgressComponent;
    quests: QuestsComponent;
  };
}

export interface MobEntity {
  id: string;
  type: 'mob';
  name: string;
  sprite: string;
  level: number;
  position: Position;
  facing: Direction;
  nextActTick: number;
  nextRegenTick?: number;
  nextChatterTick?: number;
  xpReward: number;
  dialogue: string[];
  spawnRef?: { zoneId: string; spawnIndex: number };
  components: {
    health: HealthComponent;
    stats: StatsComponent;
    ai: AIComponent;
    inventory: InventoryComponent;
  };
}

export interface GroundItemEntity {
  id: string;
  type: 'ground_item';
  name: string;
  sprite: string;
  position: Position;
  passable: true;
  base: string;
  item: ItemEntity | null;
  gold: number;
}

export interface LootSlot {
  id: string;
  name: string;
  base: string;
  item: ItemEntity | null;
  gold: number;
}

export interface CorpseEntity {
  id: string;
  type: 'corpse';
  name: string;
  position: Position;
  passable: true;
  loot: LootSlot[];
  createdAtMs: number;
}

export type Entity = PlayerEntity | MobEntity | GroundItemEntity | CorpseEntity;

// Snapshot subset broadcast to clients — strips spawnRef and other server-only fields.
export interface EntitySnapshot {
  id: string;
  type: Entity['type'];
  name: string;
  sprite: string | null;
  position: Position;
  components: unknown;
  klass?: ClassId;
  base?: string;
  gold?: number;
  item?: ItemEntity | null;
  // For mobs: the template id (e.g. "barkeep", "merchant"). Lets the client
  // identify quest-giver eligibility against the byGiver index from /api/quests.
  templateId?: string;
  // For mobs: the spawn_id from the zone's spawn entry, when one was defined.
  // Overrides templateId for quest-giver matching — a quest whose giver is a
  // spawn_id will only show on the one specific mob that carries that spawn_id.
  spawnId?: string;
  // For players: custom hex color chosen at character creation.
  color?: string;
  // For merchant mobs: true when the mob's template has a shop array.
  hasShop?: boolean;
  // For fixture mobs: indestructible world objects that only talk when clicked.
  fixture?: boolean;
  // For sign fixtures: the readable text lines shown in the read modal.
  signText?: string[];
  // For board fixtures: stable board id used to load/post messages.
  boardId?: string;
  // For mobs: their level (1–50).
  level?: number;
  // For light-emitting mobs (torches, bonfires, etc.): radius in tiles.
  lightRadius?: number;
  // Fraction of a tile to render the entity square at.
  drawScale?: number;
  // For corpses:
  loot?: LootSlot[];
  createdAtMs?: number;
}

export interface ZoneSnapshot {
  id: string;
  name: string;
  width: number;
  height: number;
  grid: string[][];
  entities: EntitySnapshot[];
  /** 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk */
  timeOfDay?: number;
}

// --- World definitions (YAML-loaded) ---

export interface UseEffect {
  heal?: Range | number;
}

export interface ItemBase {
  id: string;
  name: string;
  slot: EquipSlot | 'ring' | 'currency' | 'quest' | 'consumable';
  sprite?: string;
  tags: string[];
  base_damage?: Range;
  base_defense?: Range;
  base_speed?: number;
  value?: Range | number;
  sell_value?: number;
  use_effect?: UseEffect;
  scaling?: Partial<Record<StatId, ScalingLetter>>;
}

export interface Affix {
  id: string;
  name_prefix?: string;
  applies_to: string[];
  bonus?: Record<string, number | Range>;
}

export interface AffixPools { prefixes: Affix[]; suffixes: Affix[] }

export type MobRole = 'skirmisher' | 'brute' | 'tank' | 'pest' | 'soldier' | 'npc' | 'passive';

export interface MobTemplate {
  id: string;
  name: string;
  sprite: string;
  level: number;
  role: MobRole;
  speed: number;
  behavior: string;
  aggro_range: number;
  xp?: number;
  dialogue?: string[];
  loot_table?: { item: string; chance: number }[];
  shop?: { item: string; price: number }[];
  fixture?: boolean;
  /** When true, clicking this mob opens a read modal showing all dialogue lines. */
  sign?: boolean;
  /** Stable key for a player-writable message board (e.g. "firdale_notice_board"). */
  board_id?: string;
  /** Radius in tiles for a light source; creates a glow in the night overlay. */
  light_radius?: number;
  /** Fraction of a tile to render the entity square at (1 = full tile, 0.75 = default margin). */
  draw_scale?: number;
  respawn_seconds?: number;
  /** Override individual stats; unset fields fall back to role-derived values. */
  stats?: Partial<{ strength: number; dexterity: number; intelligence: number; constitution: number }>;
  /** Explicit flat armor value; if absent, defense is derived from constitution. */
  armor?: number;
}

export interface ZonePortal {
  at: { x: number; y: number };
  to: { zone: string; x: number; y: number };
  tile?: string | null;
  /** Client transition animation for non-cardinal portals (descend/ascend/teleport). */
  transition?: 'descend' | 'ascend' | 'teleport';
}

export interface ZoneSpawn {
  entity: string;
  /** Region to scatter the spawn(s) within. Either `region` or `at` is required.
   *  Ignored when `at` is set. */
  region?: string;
  /** Exact tile placement for a single entity (e.g. a torch or other fixture).
   *  Takes precedence over `region`; `count` is treated as 1. Placed precisely
   *  here with no scatter, so it can sit on a wall tile as a sconce. */
  at?: { x: number; y: number };
  count?: number;
  respawn_seconds?: number;
  /** Optional stable identifier for this specific spawn entry.
   *  Stored on the spawned mob as AIComponent.spawn_id and surfaced in EntitySnapshot.spawnId.
   *  Quest giver field can reference this instead of a template id to restrict the quest
   *  to one particular mob instance. */
  spawn_id?: string;
}

// --- Zone structure: archetypes, landmarks, focal points, constraints ---

/**
 * Structural archetype — the zone's internal spatial grammar. Not a tile
 * layout; a statement of how the zone organizes itself (entry/exit, focal
 * point, internal variety). Drives focal-point defaults and authoring
 * guidance. See server/game/mapgen/archetypes.ts for the library.
 */
export type ZoneArchetype =
  | 'approach'    // traversed: entry → choke points → far-end payoff
  | 'crucible'    // fought in: defensible perimeter, cover, sightlines
  | 'sanctuary'   // explored: dense branching interior, scattered interest
  | 'threshold'   // transitional: one face echoes from, one anticipates to
  | 'hearth';     // inhabited: a center of gravity with activity around it

export const ZONE_ARCHETYPES: readonly ZoneArchetype[] =
  ['approach', 'crucible', 'sanctuary', 'threshold', 'hearth'] as const;

/**
 * The zone's heart point — the ruin, the wellspring, the collapsed gate.
 * Used as the default focal-point anchor and drawn on the render overlay.
 *
 * Can be declared as explicit tile coordinates OR as a region reference —
 * the engine resolves the region to its center tile at generation time.
 * Prefer the region form for new zones: `landmark: { region: <id> }`.
 */
export type Landmark = { x: number; y: number } | { region: string };

/**
 * The structurally most significant tile of a zone — where spatially-anchored
 * narrative content (objectives, key NPCs, interactables) should cluster.
 * If omitted, it defaults to the landmark, else the zone center (see
 * resolveFocalPoint). `landmark_offset` places it relative to the landmark.
 */
export type FocalPoint =
  | { region: string }
  | { x: number; y: number }
  | { landmark_offset: { dx: number; dy: number } };

export type SpatialConstraintType = 'adjacency' | 'elevation' | 'visibility' | 'distance';

/**
 * A declared spatial relationship to another zone. The Gardener proposes
 * these; the Implementer satisfies the structurally-enforceable ones.
 * Only `adjacency` is enforceable in the current graph model (it implies a
 * matching connection) — `elevation`, `visibility`, and `distance` are
 * recorded authorial intent surfaced to the LLM and lints.
 */
export interface SpatialConstraint {
  type: SpatialConstraintType;
  /** Target zone id this relationship is declared against. */
  target: string;
  /** For adjacency: which side of THIS zone the target should sit on. */
  direction?: Direction;
  /** For elevation: whether this zone is above/below the target. */
  relation?: 'above' | 'below';
  /** For distance: minimum number of neutral zones that should separate them. */
  min_zones?: number;
  /** Free-text rationale carried through from the opportunity. */
  note?: string;
}

/**
 * Per-feature noise parameters for organic feature distribution. The active
 * mechanism is the `noise_patch` op; this optional list documents a zone's
 * feature-noise intent in one place and keeps seeds named and stable.
 */
export interface NoiseSeedSpec {
  feature: string;
  tile: string;
  seed: string | number;
  frequency?: number;
  threshold?: number;
}

// --- Mapgen ops (deterministic) ---

export type ShapeSpec =
  | { kind: 'rect'; w: number; h: number }
  | { kind: 'circle'; r: number }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'polygon'; points: [number, number][] };

export type PositionSpec =
  | { center: true }
  | { x: number; y: number }
  | { relative_to: string; side: Direction; gap?: number };

export type BoundsRef =
  | { region: string }
  | { rect: { x: number; y: number; w: number; h: number } }
  | { all: true }
  /** Zone-wide bounds shrunk by `inset` tiles on every side. */
  | { inset: number }
  /** A strip of `depth` tiles along the given edge, full zone width/height. */
  | { edge_strip: Direction; depth: number }
  /** A depth×depth square at the given corner. */
  | { corner_patch: 'NE' | 'NW' | 'SE' | 'SW'; depth: number };

export type PointAnchor = 'center' | 'north' | 'south' | 'east' | 'west';

export type PointRef =
  | { x: number; y: number }
  | { region: string; anchor?: PointAnchor }
  // Parametric point on a zone edge. `t` is 0..1 along the edge
  // (0 = west/north corner, 1 = east/south corner). Defaults to 0.5.
  // `inset` moves the point inward from the edge by this many tiles (default 0).
  | { edge: Direction; t?: number; inset?: number }
  // A named feature placed by an earlier pass (site/anchor/region). Resolves to
  // the feature's point (or region center). Lets later atoms wire to generated
  // features by name instead of hand-guessed coordinates.
  | { feature: string }
  // Zone center (floor(width/2), floor(height/2)).
  | { center: true };

/**
 * Coordinate-free placement descriptors for the Implementor's `post_ops` layer.
 * The model never emits X/Y; it picks a descriptor that matches the *intent* and
 * the engine resolves it against the live grid at generation time (see
 * resolveSemanticAt in mapgen/index.ts). Resolution returns null when nothing
 * matches, in which case the owning post-op is skipped (never crashes load).
 */
export type SemanticAt =
  // Free tile of `near_tile`, at least `margin` tiles from any blocking tile.
  // With `near_region`, additionally within ~3 tiles of a region whose id
  // starts with that prefix (e.g. "building" matches "building_0").
  | { near_tile: string; near_region?: string; margin?: number }
  // Any tile of exactly this type (e.g. place on an existing road/path).
  | { on_tile: string }
  // Any unclaimed passable tile. Last resort.
  | { random_free: true }
  // Free tile inside the named region's bounding box.
  | { in_region: string }
  // Free tile within `distance` tiles of the named region's centroid. Default 4.
  | { near_region: string; distance?: number }
  // The centroid tile of the named region (nearest free tile if blocked).
  | { center_of_region: string }
  // Free tile on the given perimeter edge, `inset` tiles inward. Default 1.
  | { free_edge: Direction; inset?: number }
  // The tile tagged with anchor key `anchor` from the most recently stamped
  // prefab named `anchor_of` earlier in this post_ops sequence.
  | { anchor_of: string; anchor: string };

/**
 * A prefab is an ASCII tile grid with a legend and optional anchor map. Used
 * inline in stamp/place ops, or as a named entry loaded from world/prefabs/.
 */
export interface PrefabData {
  data: string;
  legend: Record<string, string>;
  /** char -> anchor tag; those cells become anchor features, left walkable. */
  anchors?: Record<string, string>;
}

export interface Prefab extends PrefabData {
  id: string;
  description?: string;
}

/** A stamp/place prefab: an inline definition, or the id of a named prefab. */
export type PrefabRef = PrefabData | string;

/** Keepout claim categories, named for YAML. Mirrors CLAIM in blackboard.ts. */
export type ClaimCategory = 'reserved' | 'building' | 'road' | 'water' | 'site';

export interface WallsSpec {
  tile: string;
  door?: { side: Direction; tile?: string };
}

/** Controls how an op is spatially anchored relative to the zone's inset boundary.
 *  - `internal`  — placement is bounded to the interior (inside the inset wall).
 *  - `perimeter` — placement is on the inset line itself (walls, gates, towers).
 *  When `inset` is 0 on the zone, all placements behave as if no boundary exists. */
export type Placement = 'internal' | 'perimeter';

export type GenOp =
  | { type: 'fill'; tile: string; bounds?: BoundsRef; only_over?: string | string[]; placement?: Placement }
  | {
      type: 'region';
      id: string;
      shape: ShapeSpec;
      at: PositionSpec;
      floor?: string;
      walls?: WallsSpec;
      /** Only paint floor where current tile is in this list. Useful for organic
       *  regions that should respect already-placed terrain (e.g. don't stomp trees). */
      only_over?: string | string[];
    }
  | { type: 'shape'; shape: ShapeSpec; at: PositionSpec; tile: string; only_over?: string | string[] }
  | { type: 'road'; from: PointRef; to: PointRef; tile: string; width?: number }
  // Multi-point polyline. With `jitter > 0`, deterministically meanders
  // perpendicular to the path (seeded). For rivers, winding trails, etc.
  | {
      type: 'path';
      points: PointRef[];
      tile: string;
      width?: number;
      jitter?: number;
      seed?: number | string;
      placement?: Placement;
    }
  // Quadratic curve from `from` to `to` with `bulge` cells of perpendicular
  // offset on the control point. Positive bulge curves right of travel.
  | {
      type: 'arc';
      from: PointRef;
      to: PointRef;
      bulge: number;
      tile: string;
      width?: number;
    }
  // Deterministic point scatter within `bounds`. Each placement consults
  // `over` (when set) to only overwrite specific tiles.
  | {
      type: 'scatter';
      bounds: BoundsRef;
      tile: string;
      count: number;
      seed: number | string;
      over?: string | string[];
    }
  | {
      type: 'noise_patch';
      bounds?: BoundsRef;
      tile: string;
      threshold: number;
      scale: number;
      seed: number | string;
      over?: string | string[];
      placement?: Placement;
    }
  // Literal ASCII grid painted onto the zone. Each character in `data` maps to
  // a tile via `legend`; unmapped characters are skipped (passthrough). `scale`
  // tiles-per-character lets a compact sketch drive a large zone.
  | {
      type: 'sketch';
      data: string;
      legend: Record<string, string>;
      at?: { x: number; y: number };
      scale?: number;
    }
  // Cellular-automata cavern. Fills `bounds` (default: whole zone) with an
  // organic, connected open space: random seed → smoothing passes → small-pocket
  // pruning → tunnel-carving so every open cell is reachable. Open cells get
  // `floor`; solid cells get `wall` (if set, else left as-is). The open area's
  // AABB is registered under `region` (if given) for spawns/spawn_point/roads,
  // and an always-open `anchor` cell is exposed via the zone's focal point.
  | {
      type: 'cave';
      bounds?: BoundsRef;
      floor: string;
      wall?: string;
      seed: number | string;
      /** Initial wall probability (higher = sparser). Default 0.45. */
      fill?: number;
      /** Smoothing iterations (higher = blobbier). Default 5. */
      iterations?: number;
      /** Open pockets smaller than this are filled solid. Default 12. */
      min_pocket?: number;
      /** Carve tunnels to join surviving pockets. Default true. */
      connect?: boolean;
      /** Width of carved connector tunnels. Default 2. */
      tunnel_width?: number;
      /** Register the open-area AABB as a named region. */
      region?: string;
    }
  // Binary space partition into rooms joined by corridors — built interiors
  // (keeps, barracks, dungeons), the complement to `cave`'s organic spaces.
  // Recursively splits `bounds`, carves a room in each leaf, and connects sibling
  // rooms with L-shaped (4-connected) corridors so the whole interior is one
  // reachable graph. Each room is registered as a region (`<prefix>_N`); the
  // largest is also `<prefix>_main` for spawn_point/focal use.
  | {
      type: 'bsp';
      bounds?: BoundsRef;
      floor: string;
      /** If set, fill bounds with this wall tile before carving (for non-wall zones). */
      wall?: string;
      seed: number | string;
      /** Minimum room side length. Default 4. */
      min_room?: number;
      /** Maximum room side length. Default 10. */
      max_room?: number;
      /** Gap between a room and its partition edge (wall thickness). Default 1. */
      margin?: number;
      /** Max partition recursion depth. Default 5. */
      max_depth?: number;
      /** Corridor width. Default 1. */
      corridor_width?: number;
      /** Region id prefix for rooms. Default 'room'. */
      region_prefix?: string;
      /** Tags applied to each room region. */
      tags?: string[];
    }
  // Blue-noise (Poisson-disk) site placement. Scatters `count` points within
  // `bounds`, each at least `spacing` apart and on a free (un-claimed) cell,
  // registering every one as a `site` feature and reserving a disc of keepout
  // around it. Later atoms (route, stamp) target these sites by id/tag. The
  // backbone of settlement/camp/ruin layouts.
  | {
      type: 'scatter_sites';
      bounds?: BoundsRef;
      count: number;
      spacing: number;
      seed: number | string;
      /** Feature id prefix: <prefix>_1, _2, … Default 'site'. */
      id_prefix?: string;
      /** Tags applied to each placed site (e.g. ['plot']) for tag-based routing. */
      tags?: string[];
      /** Only place on these tile(s) — e.g. ['grass'] to avoid water/rock. */
      over?: string | string[];
      /** Keepout radius reserved around each site. Default ceil(spacing/2). */
      claim_radius?: number;
      /** Which keepout category to stamp. Default 'site'. */
      claim?: ClaimCategory;
      /** Keep sites at least this far from the zone edge. Default 2. */
      margin?: number;
      /** Optionally clear a floor disc at each site (a plaza/plot). */
      clear?: { tile: string; radius?: number };
      /**
       * Weighted role distribution. Each placed site draws one role and gets it
       * added as an extra tag (e.g. 'tavern', 'blacksmith'). Later stamp ops can
       * read this tag via `role_prefabs` to choose a role-specific building footprint.
       */
      roles?: Array<{
        role: string;
        weight: number;
        /** Hard cap on how many sites receive this role. Unlimited when omitted. */
        max?: number;
        /**
         * Module id this role belongs to. When present and that module is
         * inactive, the role is stripped from the resolved op so no sites
         * receive it and the corresponding stamp role_prefab is also removed.
         */
        module?: string;
      }>;
      placement?: Placement;
    }
  // Place a hand-authored prefab (a "vault") at a site or point. The prefab is
  // an ASCII footprint; `legend` maps chars to tiles, `anchors` maps chars to
  // anchor tags (e.g. 'D' -> 'door'). Placement is CENTERED on each target.
  // Every non-anchor cell is claimed BUILDING (so routes go around it); anchor
  // cells stay un-claimed and are registered as anchor features (so routes can
  // connect to the door). `at_tag` stamps one prefab per matching feature —
  // turning scatter_sites plots into actual buildings. Optional seeded rotation
  // gives a row of identical houses real variety.
  | {
      type: 'stamp';
      /** Inline prefab, or the id of a named prefab loaded from world/prefabs/. */
      prefab: PrefabRef;
      /** Single placement point (mutually exclusive with at_tag). In post_ops
       *  this may also be a SemanticAt descriptor. */
      at?: PointRef | SemanticAt;
      /** Stamp once per feature carrying this tag (e.g. 'plot'). */
      at_tag?: string;
      seed?: number | string;
      /** Each char paints a scale×scale block. Default 1. */
      scale?: number;
      /** Keepout category for the footprint. Default 'building'. */
      claim?: ClaimCategory;
      /**
       * When true, skip cells already claimed as BUILDING — the stamp paints
       * only where no prior building footprint exists. Use for optional features
       * (markets, plazas) that should yield to buildings rather than overwrite them.
       */
      only_free?: boolean;
      /** Feature-id prefix for registered anchors when not stamping by tag. Default 'stamp'. */
      anchor_prefix?: string;
      /** Rotate the footprint: a fixed quarter-turn or 'random' (seeded per target). */
      rotate?: 'random' | 0 | 90 | 180 | 270;
      /** Register each footprint's AABB as a region (<feature-id>_interior, or this id). */
      region?: string;
      /**
       * Role-specific prefab overrides. When stamping an `at_tag` site whose
       * tags include a key from this map, that prefab is used instead of the
       * default `prefab`. Roles are assigned by `scatter_sites.roles`.
       */
      role_prefabs?: Record<string, PrefabRef>;
      placement?: Placement;
    }
  // Find a free location and stamp a prefab atomically. Unlike `stamp`, no
  // explicit position is needed — the engine samples candidates within the
  // placement region, checks the full prefab bounding box against keepout,
  // and stamps on first fit. Footprint-aware: won't clip buildings or walls.
  | {
      type: 'place';
      /** Inline prefab, or the id of a named prefab loaded from world/prefabs/. */
      prefab: PrefabRef;
      seed: string | number;
      /** Restrict candidate search to the inset interior or the perimeter line. */
      placement?: Placement;
      /** Min gap between the prefab edge and the search region boundary. Default 1. */
      margin?: number;
      /** Only place on top of these tile types. */
      over?: string | string[];
      /** Register the placed AABB as a named region. */
      region?: string;
      /** Prefix for registered anchor features. Default 'place'. */
      anchor_prefix?: string;
      /** Keepout category for the footprint. Default 'building'. */
      claim?: ClaimCategory;
      /** Rotate the footprint randomly (seeded). Default false. */
      rotate?: boolean;
    }
  // Cost-aware path between two endpoints (A* over the routing-cost layer). Bends
  // around expensive/impassable terrain and reuses existing roads. `from_tag`
  // routes every feature carrying that tag to `to` (a star network). Carves
  // `tile`, claims it as road, and never cuts through building-claimed cells.
  // Edge selection: choose which nodes (features) should connect, forming a
  // road graph. `mst` spans all nodes with minimum total length (a tree);
  // `extra_edges` adds back a fraction of the shortest non-tree links for loops;
  // `star` connects every node to `hub`. Emits `edge` features (ends = two node
  // ids) tagged `edge_tag`, which a following `route { edges: <tag> }` carves.
  | {
      type: 'network';
      /** Gather every feature with this tag as a node. */
      nodes_tag?: string;
      /** Additional explicit node feature ids (e.g. a well/plaza). */
      nodes?: string[];
      method?: 'mst' | 'star';
      /** For star: the hub feature id every node links to (defaults to first node). */
      hub?: string;
      /** Fraction (0..1) of shortest non-tree edges to add as loops. Default 0. */
      extra_edges?: number;
      /** Tag applied to emitted edge features (route consumes this). Default 'road'. */
      edge_tag?: string;
      /** Edge feature id prefix. Default 'edge'. */
      edge_prefix?: string;
    }
  | {
      type: 'route';
      from?: PointRef;
      from_tag?: string;
      /** Route every `edge` feature carrying this tag (from ends[0] to ends[1]). */
      edges?: string;
      /** Required for from/from_tag; ignored in edges mode. */
      to?: PointRef;
      tile: string;
      width?: number;
      /** Claim carved cells as CLAIM.ROAD so later passes see the network. Default true. */
      claim_road?: boolean;
      /** Clearable obstacle tiles the road may cut through at a penalty (e.g. tree).
       *  The carve clears them; without this, routes only detour around them. */
      through?: string | string[];
      /** Routing penalty for cutting through a `through` tile. Default 6 (so a road
       *  prefers open ground but will breach forest rather than detour far). */
      through_cost?: number;
    }
  // Reachability repair. Floods walkable tiles from the entry seed(s) and, for
  // anything that should be reachable but isn't, carves a corridor to it from
  // the nearest reachable cell (clearing `through` obstacles). `ensure_tags`
  // guarantees specific features (e.g. every door) are reachable; `ensure_all`
  // guarantees every walkable tile is one connected component. With no `carve`
  // tile it runs report-only, logging what is stranded. Runs last in a recipe.
  | {
      type: 'ensure_reach';
      /** Entry seed point(s) the player reaches the zone from. */
      from?: PointRef | PointRef[];
      /** Also seed from every feature carrying this tag. */
      from_tag?: string;
      /** Feature tags that must be reachable; a corridor is carved to each stranded one. */
      ensure_tags?: string[];
      /** Guarantee every walkable tile is connected to the seeds. */
      ensure_all?: boolean;
      /** Tile for carved repair corridors. Omit to run report-only (warn). */
      carve?: string;
      /** Clearable obstacles a repair corridor may cut through (e.g. wall, tree). */
      through?: string | string[];
      through_cost?: number;
      width?: number;
    }
  // Voronoi region decomposition: partition `bounds` (default: whole zone) by
  // assigning each tile to the nearest cell seed, then painting that cell's
  // floor. Produces naturally irregular borders without hand-authoring; adding
  // a cell reshapes its neighbours automatically. `weight` biases a cell's
  // territory (multiplicatively-weighted distance — higher = larger). Each
  // cell is registered as a named region (AABB of its assigned tiles) so
  // spawns, spawn_point, and roads can reference it like any region.
  | {
      type: 'voronoi';
      bounds?: BoundsRef;
      cells: Array<{ id: string; at: PointRef; floor: string; weight?: number }>;
      /** Paint a 1-tile seam where two cells meet (ridgelines, walls, water). */
      border?: { tile: string };
      /** Only repaint tiles currently matching one of these (e.g. ['grass']). */
      over?: string | string[];
    }
  // Place a traversable portal tile that moves the player to `target_zone` on
  // contact. Intended for the post_ops layer (zone_connect): `at` resolves the
  // source tile (typically an `anchor_of` a stamped entrance prefab), the engine
  // paints `tile` there, and World resolves the destination to the target zone's
  // spawn point after all zones load. The reverse portal is auto-synthesized
  // from the target zone's non-cardinal `connections` key.
  | {
      type: 'portal';
      at: PointRef | SemanticAt;
      target_zone: string;
      /** Client transition animation. Default 'teleport'. */
      transition?: 'descend' | 'ascend' | 'teleport';
      /** Tile painted at the portal cell. Default 'portal'. */
      tile?: string;
    };

export type SpawnPoint =
  | { region: string }
  | { x: number; y: number }
  // Spawn the player at the zone's resolved focal point.
  | { focal: true };

// ─── World Generation ────────────────────────────────────────────────────────

export type WorldBiome =
  | 'ocean'
  | 'tundra'
  | 'plains'
  | 'grassland'
  | 'forest'
  | 'swamp'
  | 'desert'
  | 'mountain';

export type WorldCellTag = 'beach';

export type BoundaryStyle = 'mountain' | 'ocean';

export type SettlementModifier = 'cursed' | 'blessed' | 'deserted' | 'ruined' | 'contested' | 'hidden';

export interface LevelBand {
  tier: 1 | 2 | 3 | 4 | 5;
  minLevel: number;
  maxLevel: number;
}

export interface WorldCell {
  gridX: number;
  gridY: number;
  worldBiome: WorldBiome;
  /** Derived from world seed + grid position. Passed to zone generator. */
  seed: string;
  width: number;
  height: number;
  /** Noise values retained for debugging / editor overlays. */
  temperature: number;
  moisture: number;
  elevation: number;
  danger: number;
  levelBand: LevelBand;
  tags: WorldCellTag[];
}

export type SettlementType = 'city' | 'village';

export interface WorldSettlement {
  type: SettlementType;
  gridX: number;
  gridY: number;
  worldBiome: WorldBiome;
  modifier?: SettlementModifier;
}

export interface WorldDef {
  seed: string;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  boundaryStyle: BoundaryStyle;
  /** Row-major: cells[row][col] */
  cells: WorldCell[][];
  /** Villages and dungeons. */
  settlements: WorldSettlement[];
  /** Cities — placed separately after villages, stored for easy lookup. */
  cities: WorldSettlement[];
}

// ─── Zone Definitions ────────────────────────────────────────────────────────

/** Per-zone toggle/param override for a biome feature operator. `false` disables
 *  a biome-default feature; an object enables/tunes it; `true` enables with biome
 *  defaults. Mirrors FeatureOverride in mapgen/biomes. */
export type ZoneFeatureOverride =
  | boolean
  | { enabled?: boolean; params?: Record<string, number> };

export interface ZoneDef {
  id: string;
  name?: string;
  /** Player-facing zone title (Implementor-owned). Falls back to a capitalized
   *  biome name in the client banner when unset. */
  display_name?: string;
  /** Level/difficulty band for this zone instance (Implementor-owned). */
  level_band?: LevelBand;
  /** Zone-instance spawn weight overrides (Implementor-owned, mob_populate). */
  spawn_weights?: Record<string, number>;
  tileset?: string;
  width?: number;
  height?: number;
  default_tile?: string;
  /** Structural archetype — drives focal-point default and authoring guidance. */
  archetype?: ZoneArchetype;
  /** The zone's heart point; default focal anchor and render overlay. */
  landmark?: Landmark;
  /** The narrative anchor tile; defaults to landmark, else zone center. */
  focal_point?: FocalPoint;
  /** Declared spatial relationships to other zones (from the Gardener). */
  spatial_constraints?: SpatialConstraint[];
  /** Optional directional bias for the zone's territory (forward-compat:
   *  consumed by a future inter-zone Voronoi model, not the current engine). */
  boundary_weights?: Partial<Record<Direction, number>>;
  /** Documented per-feature noise intent; the active mechanism is noise_patch. */
  noise_seeds?: NoiseSeedSpec[];
  ops?: GenOp[];
  /**
   * Implementor-appended ops that execute after the biome pipeline (and any
   * feature ops) resolve, operating on the already-generated grid. May use the
   * coordinate-free SemanticAt descriptors and the `portal` op. Skipped (with a
   * warning) when a descriptor can't be resolved — post_ops never crash load.
   */
  post_ops?: GenOp[];
  /** Zone-wide inset boundary in tiles. Ops with `placement: 'internal'` are
   *  bounded to this interior; `placement: 'perimeter'` places on this line. */
  inset?: number;
  /**
   * Biome-driven generation. When present, `ops` is derived at load time from
   * the named biome rather than read from the file. `ops` (if also present) is
   * ignored when `biome` is set.
   */
  biome?: string;
  /** Seed for biome pipeline variance. String or hex string. */
  seed?: string;
  /** Zone-level param overrides passed to the biome pipeline (e.g. { inset: 5 }). */
  zoneParams?: Record<string, number>;
  /** Op-level param overrides keyed by basePipeline entry id (e.g. { village_plots: { count: 8 } }). */
  opParams?: Record<string, Record<string, number>>;
  /**
   * Per-zone feature operators. Two forms:
   *   - an array of ids to enable with biome defaults: ['fountain', 'guard_tower']
   *   - an override map: { fountain: false, guard_tower: { params: { ... } } }
   * The map can disable a biome-default feature (`false`), tune its params, or
   * add a feature not in the biome's defaults. See mergeFeatures.
   */
  features?: string[] | Record<string, ZoneFeatureOverride>;
  /** Free-form tags set by worldgen (e.g. ['beach_N', 'beach_NE']). */
  tags?: string[];
  spawn_point?: SpawnPoint;
  spawns?: ZoneSpawn[];
  portals?: ZonePortal[];
  /**
   * Zone links. Cardinal keys (north/south/east/west) are edge transitions
   * resolved to perimeter portal tiles. Non-cardinal keys (e.g. `surface`,
   * `cellar`) name an interior connection back to a parent zone; the engine
   * auto-synthesizes a return portal for these at load time.
   */
  connections?: Record<string, string>;
}

export interface TileEntry {
  color: string;
  /** If true, this tile blocks movement. Extends the base BLOCKING_TILES set
   *  at world-load time so new solid tiles don't require a code change. */
  blocking?: boolean;
}

export interface Tileset {
  name: string;
  tile_size: number;
  tiles: Record<string, TileEntry>;
  sprites: Record<string, { color: string }>;
}

// Objective shapes are a discriminated union. Each kind is checked by the
// corresponding notify* hook in server/game/systems/quests.ts; new kinds
// require a new hook AND a new branch in tryAdvanceStage.
export type QuestObjective =
  | {
      kind: 'kill_count';
      target: number;
      template_id?: string;   // optional filter
      zone?: string;          // optional filter
    }
  | { kind: 'kill_specific'; target_id: string }
  | { kind: 'collect_count'; item_base: string; target: number }
  | { kind: 'talk'; target_template: string }
  | {
      kind: 'reach';
      radius: number;          // Chebyshev distance (tile-square)
      zone?: string;           // optional zone filter
      template_id?: string;    // satisfied when within radius of any mob with this template id
      x?: number;              // OR a fixed point in `zone` (zone required)
      y?: number;
    };

export interface QuestStageDef {
  id: string;
  text: string;
  on_complete?: string;
  // If omitted, server treats the stage as a talk-the-giver objective —
  // satisfied by clicking the giver in the quest modal.
  objective?: QuestObjective;
}
export interface QuestReward {
  gold?: number;
  item?: string;
  xp?: number;
}
export interface QuestDef {
  id: string;
  name?: string;
  /** Mob template id (e.g. "merchant") or a spawn_id from a zone spawn entry
   *  (e.g. "market_merchant"). When a spawn_id is used, only that specific mob
   *  instance can give and receive this quest. */
  giver?: string;
  zone?: string;
  description?: string;
  stages?: QuestStageDef[];
  rewards?: QuestReward[];
  /** Quest id(s) that must be completed before this quest becomes available. */
  unlock_after?: string | string[];
  /** If true, the quest can be accepted and completed any number of times. */
  repeatable?: boolean;
  [extra: string]: unknown;
}

export interface WorldDefs {
  zones: Record<string, ZoneDef>;
  mobs: Record<string, MobTemplate>;
  itemBases: Record<string, ItemBase>;
  affixes: AffixPools;
  quests: Record<string, QuestDef>;
  tilesets: Record<string, Tileset>;
  /** Named prefabs loaded from world/prefabs/, available by id to stamp/place ops. */
  prefabs: Record<string, Prefab>;
  /** Union of the base BLOCKING_TILES constant and any tileset tile entries
   *  with \`blocking: true\`. Computed by the world loader at load time. */
  blockingTiles: ReadonlySet<string>;
}

// --- Socket events ---

export interface ChatFrom { id: string; name: string; type: Entity['type'] }

export interface CharacterSummary {
  id: string;
  slot: number;
  name: string;
  klass: ClassId;
  color: string;
  level: number;
  zone: string;
}

export interface ListCharactersResponse {
  characters: CharacterSummary[];
  error?: string;
}

export interface JoinRequest {
  /** Firebase ID token obtained from the client SDK after sign-in. */
  firebase_token: string;
  /** Select a specific character by id (must belong to this account). */
  character_id?: string;
  /** Only required when creating a new character (server returns needsCharacter: true). */
  name?: string;
  klass?: ClassId;
  color?: string;
}

export interface JoinResponse {
  /** Set if the token was invalid or an unexpected server error occurred. */
  error?: string;
  /**
   * True when the authenticated account has no character yet.  The client
   * should prompt for a name/class and re-emit join with those fields.
   */
  needsCharacter?: boolean;
  entityId: string;
  /** Undefined when needsCharacter is true or error is set. */
  zone?: ZoneSnapshot;
  /** Undefined when needsCharacter is true or error is set. */
  self?: PlayerEntity;
}

export interface CombatEvent {
  attackerId: string;
  targetId: string;
  damage: number;
  fatal: boolean;
  dodged: boolean;
  at: { x: number; y: number } | null;
}

export interface PickupEvent {
  kind: 'gold' | 'item';
  name: string;
  amount?: number;
  slot?: number;
}

export interface XpEvent {
  gained: number;
  xp: number;
  level: number;
  xp_to_next: number;
  source: { name: string; id: string };
}

export interface LevelUpEvent {
  level: number;
  from_level: number;
  unspent_points: number;
}

export type ChatChannel = 'zone' | 'global' | 'whisper' | 'system';
export interface ChatMessage { from: ChatFrom; text: string; at: number; channel?: ChatChannel }

export interface RespawnEvent { zone: ZoneSnapshot; self: PlayerEntity }
export interface DiedEvent {}

export interface SelfEvent { self: PlayerEntity }

export interface QuestsEvent { quests: QuestsComponent }

export type QuestActionKind = 'accept' | 'decline' | 'abandon' | 'talk';
export interface QuestActionMessage {
  questId: string;
  action: QuestActionKind;
  // For action: 'talk' — template id of the NPC the player clicked. Server
  // verifies it matches the talk objective's target_template.
  talkingTo?: string;
}
export interface QuestActionResponse {
  ok: boolean;
  reason?: string;
  quests?: QuestsComponent;
}

export type ActionMessage =
  | { action: 'move'; dir: Direction }
  | { action: 'attack' }
  | { action: 'autopath'; tx: number; ty: number };

export interface ServerToClientEvents {
  zone: (snap: ZoneSnapshot) => void;
  combat: (ev: CombatEvent) => void;
  pickup: (ev: PickupEvent) => void;
  xp: (ev: XpEvent) => void;
  levelup: (ev: LevelUpEvent) => void;
  chat: (msg: ChatMessage) => void;
  respawn: (ev: RespawnEvent) => void;
  died: (ev: DiedEvent) => void;
  self: (ev: SelfEvent) => void;
  quests: (ev: QuestsEvent) => void;
  open_map: () => void;
}

export type Ack<T> = (resp: T) => void;
export type ResultAck = Ack<{ ok: boolean; reason?: string; self?: PlayerEntity }>;

export interface TradeMessage {
  mobId: string;
  action: 'buy' | 'sell';
  itemBase?: string;  // for buy: the item base id to purchase
  slotIndex?: number; // for sell: the inventory slot index to sell
}
export interface TradeResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
}

export interface BoardMessage {
  id: string;
  authorName: string;
  text: string;
  postedAt: number;
}

export interface ReadBoardResponse {
  ok: boolean;
  messages?: BoardMessage[];
  reason?: string;
}

export interface PostBoardResponse {
  ok: boolean;
  reason?: string;
}

export interface ClientToServerEvents {
  list_characters: (req: { firebase_token: string }, ack: Ack<ListCharactersResponse>) => void;
  join: (req: JoinRequest, ack: Ack<JoinResponse>) => void;
  action: (msg: ActionMessage) => void;
  allocate: (msg: { stat: StatId }, ack: ResultAck) => void;
  equip: (msg: { slot: number }, ack: ResultAck) => void;
  unequip: (msg: { slot: EquipSlot }, ack: ResultAck) => void;
  chat: (msg: { text: string }) => void;
  quest_action: (msg: QuestActionMessage, ack: Ack<QuestActionResponse>) => void;
  poke_mob: (msg: { mobId: string }) => void;
  trade: (msg: TradeMessage, ack: Ack<TradeResponse>) => void;
  use_item: (msg: { slot: number }, ack: Ack<UseItemResponse>) => void;
  loot_corpse: (msg: { corpseId: string; slotId: string }, ack: Ack<LootCorpseResponse>) => void;
  read_board: (msg: { boardId: string }, ack: Ack<ReadBoardResponse>) => void;
  post_to_board: (msg: { boardId: string; text: string }, ack: Ack<PostBoardResponse>) => void;
}

export interface UseItemResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
  healed?: number;
}

export interface LootCorpseResponse {
  ok: boolean;
  reason?: string;
  self?: PlayerEntity;
}

// HTTP /api/quests payload — quest defs + an index of giver template id to
// quest ids that giver offers. Fetched once by the client on join.
export interface QuestsApiPayload {
  defs: Record<string, QuestDef>;
  byGiver: Record<string, string[]>;
}
