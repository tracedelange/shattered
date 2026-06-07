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
 * (Also reserved as a Voronoi seed for a future world-coordinate model; the
 * current engine has no inter-zone map, so it is intra-zone metadata today.)
 */
export interface Landmark { x: number; y: number }

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
  | { all: true };

export type PointAnchor = 'center' | 'north' | 'south' | 'east' | 'west';

export type PointRef =
  | { x: number; y: number }
  | { region: string; anchor?: PointAnchor }
  // Parametric point on a zone edge. `t` is 0..1 along the edge
  // (0 = west/north corner, 1 = east/south corner). Defaults to 0.5.
  | { edge: Direction; t?: number }
  // A named feature placed by an earlier pass (site/anchor/region). Resolves to
  // the feature's point (or region center). Lets later atoms wire to generated
  // features by name instead of hand-guessed coordinates.
  | { feature: string };

/** Keepout claim categories, named for YAML. Mirrors CLAIM in blackboard.ts. */
export type ClaimCategory = 'reserved' | 'building' | 'road' | 'water' | 'site';

export interface WallsSpec {
  tile: string;
  door?: { side: Direction; tile?: string };
}

export type GenOp =
  | { type: 'fill'; tile: string; bounds?: BoundsRef }
  | {
      type: 'region';
      id: string;
      shape: ShapeSpec;
      at: PositionSpec;
      floor?: string;
      walls?: WallsSpec;
    }
  | { type: 'shape'; shape: ShapeSpec; at: PositionSpec; tile: string }
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
      bounds: BoundsRef;
      tile: string;
      threshold: number;
      scale: number;
      seed: number | string;
      over?: string | string[];
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
    }
  // Cost-aware path between two endpoints (A* over the routing-cost layer). Bends
  // around expensive/impassable terrain and reuses existing roads. `from_tag`
  // routes every feature carrying that tag to `to` (a star network). Carves
  // `tile`, claims it as road, and never cuts through building-claimed cells.
  | {
      type: 'route';
      from?: PointRef;
      from_tag?: string;
      to: PointRef;
      tile: string;
      width?: number;
      /** Claim carved cells as CLAIM.ROAD so later passes see the network. Default true. */
      claim_road?: boolean;
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
    };

export type SpawnPoint =
  | { region: string }
  | { x: number; y: number }
  // Spawn the player at the zone's resolved focal point.
  | { focal: true };

export interface ZoneDef {
  id: string;
  name?: string;
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
  spawn_point?: SpawnPoint;
  spawns?: ZoneSpawn[];
  portals?: ZonePortal[];
  connections?: Partial<Record<Direction, string>>;
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
