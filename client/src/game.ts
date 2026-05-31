import { state } from './state.ts';
import { ARMOR_SLOTS, BLOCKING_TILES, SCALING_COEFFS } from '../../shared/constants.ts';
import type {
  ClassId, Direction, EntitySnapshot, EquipSlot, InventoryStack, PlayerEntity,
  QuestDef, Range, RolledStats, StatId,
} from '../../shared/types.ts';

const TILE = 32;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatLog = document.getElementById('chat-log')!;
const sheetBackdrop = document.getElementById('charsheet-backdrop')!;
const csName = document.getElementById('cs-name')!;
const csClass = document.getElementById('cs-class')!;
const csLevel = document.getElementById('cs-level')!;
const csXp = document.getElementById('cs-xp')!;
const csHp = document.getElementById('cs-hp')!;
const csStr = document.getElementById('cs-str')!;
const csDex = document.getElementById('cs-dex')!;
const csInt = document.getElementById('cs-int')!;
const csCon = document.getElementById('cs-con')!;
const csDmg = document.getElementById('cs-dmg')!;
const csDef = document.getElementById('cs-def')!;
const csDodge = document.getElementById('cs-dodge')!;
const csPoints = document.getElementById('cs-points')!;
const csAlloc = document.getElementById('cs-alloc')!;
for (const stat of ['strength', 'dexterity', 'intelligence', 'constitution'] as StatId[]) {
  document.getElementById(`alloc-${stat}`)!.addEventListener('click', () => state.sendAllocate?.(stat));
}

function stackTooltip(stack: InventoryStack): string {
  const lines = [stack.name || stack.base || 'Item'];
  const rolled = stack.item?.components?.equipment?.rolled as RolledStats | undefined;
  if (Array.isArray(rolled?.damage)) {
    lines.push(`Damage: ${rolled.damage[0]}–${rolled.damage[1]}`);
  }
  if (rolled?.scaling) {
    const scl = Object.entries(rolled.scaling)
      .filter(([, v]) => v && v !== '-')
      .map(([k, v]) => `${k.slice(0, 3).toUpperCase()} ${v}`)
      .join('  ');
    if (scl) lines.push(`Scaling: ${scl}`);
  }
  if (Array.isArray(rolled?.defense)) {
    lines.push(`Defense: ${rolled.defense[0]}–${rolled.defense[1]}`);
  }
  return lines.join('\n');
}

const invBackdrop = document.getElementById('inv-backdrop')!;
const invSlots = document.getElementById('inv-slots')!;
const invEquip = document.getElementById('inv-equip')!;
const invGold = document.getElementById('inv-gold')!;

const EQ_LAYOUT: (EquipSlot | null)[][] = [
  [null,       'helmet',    'amulet'  ],
  ['mainhand', 'chest',     'gloves'  ],
  ['ring1',    'leggings',  'ring2'   ],
  [null,       'boots',     null      ],
];

function invOpen(): boolean { return invBackdrop.classList.contains('open'); }

function renderInventory(): void {
  const s = state.self;
  if (!s) return;
  const inv = s.components?.inventory?.slots || [];
  const equipment = s.components?.equipment;
  const gold = s.components?.wallet?.gold || 0;
  invGold.textContent = String(gold);
  invEquip.innerHTML = '';
  for (const row of EQ_LAYOUT) {
    for (const slot of row) {
      const cell = document.createElement('div');
      if (!slot) {
        cell.style.visibility = 'hidden';
        cell.className = 'eq-cell';
        invEquip.appendChild(cell);
        continue;
      }
      const eq = equipment?.[slot];
      cell.className = 'eq-cell' + (eq ? ' filled' : '');
      const label = document.createElement('div');
      label.textContent = eq ? (eq.name || eq.base || '?') : '—';
      const sub = document.createElement('div');
      sub.className = 'eq-slot-name';
      sub.textContent = slot;
      cell.appendChild(label);
      cell.appendChild(sub);
      if (eq) {
        cell.title = stackTooltip(eq);
        cell.addEventListener('click', () => state.sendUnequip?.(slot));
      }
      invEquip.appendChild(cell);
    }
  }
  invSlots.innerHTML = '';
  for (let i = 0; i < inv.length; i++) {
    const cell = document.createElement('div');
    const stack = inv[i];
    cell.className = 'slot' + (stack ? ' filled' : ' empty');
    cell.textContent = stack ? (stack.name || stack.base || '?') : '·';
    cell.dataset.slot = String(i);
    if (stack) {
      cell.title = stackTooltip(stack);
      cell.addEventListener('click', () => state.sendEquip?.(i));
    }
    invSlots.appendChild(cell);
  }
}

function openInventory(): void { invBackdrop.classList.add('open'); renderInventory(); }
function closeInventory(): void { invBackdrop.classList.remove('open'); }
window.addEventListener('mmo:self', () => { if (invOpen()) renderInventory(); });
window.addEventListener('mmo:zone', () => { if (invOpen()) renderInventory(); });

// ─── Hover tooltip + click-to-talk + quest modals ─────────────────────────
const tooltipEl = document.getElementById('world-tooltip')!;
const qgBackdrop = document.getElementById('questgiver-backdrop')!;
const qgTitle = document.getElementById('qg-title')!;
const qgBody = document.getElementById('qg-body')!;
const qlBackdrop = document.getElementById('questlog-backdrop')!;
const qlBody = document.getElementById('ql-body')!;

interface CameraTransform { offsetX: number; offsetY: number }
let lastCamera: CameraTransform = { offsetX: 0, offsetY: 0 };
let hoveredEntity: EntitySnapshot | null = null;
let hoveredTile: { x: number; y: number } | null = null;
let mousePx = { x: 0, y: 0 };

function qgOpen(): boolean { return qgBackdrop.classList.contains('open'); }
function qlOpen(): boolean { return qlBackdrop.classList.contains('open'); }
function closeQuestgiver(): void { qgBackdrop.classList.remove('open'); }
function closeQuestlog(): void { qlBackdrop.classList.remove('open'); }

// Per-player, per-quest-state cache: which templates have a pending-quest
// `!` (offered but not yet accepted/completed) and which have an active
// talk-objective targeting them right now. Rebuilt on `mmo:quests` only —
// the canvas render and mousemove handlers hit these every frame/event.
let questgiverKeys = new Set<string>();
let talkTargetKeys = new Set<string>();

/** Returns the quest-giver key for a mob snapshot.
 *  Prefers spawnId when present (specific instance), falls back to templateId. */
function giverKey(snap: EntitySnapshot): string | null {
  if (snap.type !== 'mob') return null;
  return snap.spawnId ?? snap.templateId ?? null;
}

function rebuildQuestInteractionCaches(): void {
  const accepted = new Set(state.quests.active.map((q) => q.questId));
  const completed = new Set(state.quests.completed);
  questgiverKeys = new Set();
  for (const [key, ids] of Object.entries(state.questsByGiver)) {
    if (ids.some((id) => !accepted.has(id) && !completed.has(id))) {
      questgiverKeys.add(key);
    }
  }
  talkTargetKeys = new Set();
  for (const entry of state.quests.active) {
    const def = state.questDefs[entry.questId];
    if (!def) continue;
    const stage = def.stages?.find((s) => s.id === entry.stage);
    const obj = stage?.objective ?? (def.giver ? { kind: 'talk' as const, target_template: def.giver } : null);
    if (obj?.kind === 'talk') talkTargetKeys.add(obj.target_template);
  }
}

function isQuestgiver(snap: EntitySnapshot): boolean {
  const k = giverKey(snap);
  return k !== null && questgiverKeys.has(k);
}

// Resolve the active stage's objective for a quest, falling back to the
// "talk to giver" default the server also uses when YAML omits one.
function resolveActiveObjective(def: QuestDef): NonNullable<QuestDef['stages']>[number]['objective'] | null {
  const entry = state.quests.active.find((q) => q.questId === def.id);
  if (!entry) return null;
  const stage = def.stages?.find((s) => s.id === entry.stage);
  if (!stage) return null;
  if (stage.objective) return stage.objective;
  if (def.giver) return { kind: 'talk', target_template: def.giver };
  return null;
}

function progressText(def: QuestDef): string | null {
  const entry = state.quests.active.find((q) => q.questId === def.id);
  if (!entry) return null;
  const obj = resolveActiveObjective(def);
  if (!obj) return null;
  if (obj.kind === 'kill_count') {
    return `Killed: ${entry.progress?.killed ?? 0} / ${obj.target}`;
  }
  if (obj.kind === 'collect_count') {
    return `Collected: ${entry.progress?.collected ?? 0} / ${obj.target} ${obj.item_base}`;
  }
  if (obj.kind === 'kill_specific') {
    return entry.progress?.killed ? 'Target defeated' : 'Target still at large';
  }
  return null;
}

function questgiverBlock(
  def: QuestDef,
  state_: 'available' | 'active' | 'completed',
  clickedTemplate: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'quest-block';
  const name = document.createElement('div');
  name.className = 'quest-name';
  name.textContent = def.name || def.id;
  wrap.appendChild(name);
  if (def.description) {
    const desc = document.createElement('div');
    desc.className = 'quest-desc';
    desc.textContent = String(def.description).trim();
    wrap.appendChild(desc);
  }
  if (def.rewards && def.rewards.length > 0) {
    const r = document.createElement('div');
    r.className = 'quest-rewards';
    const parts: string[] = [];
    for (const reward of def.rewards) {
      if (reward.gold) parts.push(`${reward.gold} gold`);
      if (reward.item) parts.push(reward.item);
    }
    r.textContent = parts.length ? `Rewards: ${parts.join(', ')}` : '';
    wrap.appendChild(r);
  }
  const status = document.createElement('div');
  status.className = 'quest-status';
  if (state_ === 'active') {
    const entry = state.quests.active.find((q) => q.questId === def.id);
    const stage = def.stages?.find((s) => s.id === entry?.stage);
    const prog = progressText(def);
    const parts = [stage?.text || entry?.stage || '', prog].filter(Boolean);
    status.textContent = `In progress — ${parts.join(' · ')}`;
  } else if (state_ === 'completed') {
    status.textContent = 'Completed';
  }
  if (state_ !== 'available') wrap.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (state_ === 'available') {
    const accept = document.createElement('button');
    accept.className = 'primary';
    accept.textContent = 'Accept';
    accept.addEventListener('click', async () => {
      const r = await state.sendQuestAction(def.id, 'accept', clickedTemplate);
      if (!r.ok && r.reason === 'out_of_range') {
        showFloatingMessage('Move closer to talk.');
        return;
      }
      closeQuestgiver();
    });
    const decline = document.createElement('button');
    decline.textContent = 'Decline';
    decline.addEventListener('click', () => closeQuestgiver());
    actions.appendChild(decline);
    actions.appendChild(accept);
  } else if (state_ === 'active') {
    const obj = resolveActiveObjective(def);
    if (obj?.kind === 'talk' && obj.target_template === clickedTemplate) {
      const report = document.createElement('button');
      report.className = 'primary';
      report.textContent = 'Report';
      report.addEventListener('click', async () => {
        const r = await state.sendQuestAction(def.id, 'talk', clickedTemplate);
        if (!r.ok && r.reason === 'out_of_range') {
          showFloatingMessage('Move closer to talk.');
          return;
        }
        closeQuestgiver();
      });
      actions.appendChild(report);
    }
    const abandon = document.createElement('button');
    abandon.textContent = 'Abandon';
    abandon.addEventListener('click', async () => {
      await state.sendQuestAction(def.id, 'abandon');
      closeQuestgiver();
    });
    actions.appendChild(abandon);
  }
  wrap.appendChild(actions);
  return wrap;
}

function showFloatingMessage(text: string): void {
  let banner = document.getElementById('qg-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'qg-banner';
    banner.className = 'quest-status';
    banner.style.color = '#ffd84a';
    banner.style.marginTop = '6px';
    qgBody.appendChild(banner);
  }
  banner.textContent = text;
}

function openQuestgiver(snap: EntitySnapshot): void {
  const key = giverKey(snap);
  if (!key) return;
  qgTitle.textContent = snap.name;
  qgBody.innerHTML = '';

  const offered = state.questsByGiver[key] || [];
  if (offered.length === 0) {
    // No quests at all — just show dialogue chatter as flavor.
    const speech = state.speech.get(snap.id);
    const hint = document.createElement('div');
    hint.className = 'quest-desc';
    hint.textContent = speech?.text || `${snap.name} has nothing for you right now.`;
    qgBody.appendChild(hint);
    qgBackdrop.classList.add('open');
    return;
  }

  const active = new Set(state.quests.active.map((q) => q.questId));
  const completed = new Set(state.quests.completed);
  // Also include active quests whose current talk objective targets this
  // NPC, even if they weren't authored by this giver — handles inter-NPC
  // hand-offs and the same-giver report case.
  const queue = new Set(offered);
  for (const entry of state.quests.active) {
    const def = state.questDefs[entry.questId];
    if (!def) continue;
    const stage = def.stages?.find((s) => s.id === entry.stage);
    const obj = stage?.objective ?? (def.giver ? { kind: 'talk' as const, target_template: def.giver } : null);
    if (obj?.kind === 'talk' && obj.target_template === key) queue.add(entry.questId);
  }

  for (const qid of queue) {
    const def = state.questDefs[qid];
    if (!def) continue;
    const st = active.has(qid) ? 'active' : completed.has(qid) ? 'completed' : 'available';
    qgBody.appendChild(questgiverBlock(def, st, key));
  }
  qgBackdrop.classList.add('open');
}

function renderQuestlog(): void {
  qlBody.innerHTML = '';
  const active = state.quests.active;
  const completed = state.quests.completed;

  const activeHeader = document.createElement('div');
  activeHeader.className = 'ql-section';
  activeHeader.textContent = `Active (${active.length})`;
  qlBody.appendChild(activeHeader);
  if (active.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ql-empty';
    empty.textContent = 'No active quests.';
    qlBody.appendChild(empty);
  } else {
    for (const entry of active) {
      const def = state.questDefs[entry.questId];
      const row = document.createElement('div');
      row.className = 'quest-row';
      const name = document.createElement('div');
      name.className = 'ql-name';
      name.textContent = def?.name || entry.questId;
      const stage = def?.stages?.find((s) => s.id === entry.stage);
      const stageText = document.createElement('div');
      stageText.className = 'ql-stage';
      stageText.textContent = stage?.text?.trim() || `Current stage: ${entry.stage}`;
      row.appendChild(name);
      row.appendChild(stageText);
      if (def) {
        const prog = progressText(def);
        if (prog) {
          const progEl = document.createElement('div');
          progEl.className = 'ql-stage';
          progEl.style.color = '#7acdf5';
          progEl.textContent = prog;
          row.appendChild(progEl);
        }
      }
      qlBody.appendChild(row);
    }
  }

  if (completed.length > 0) {
    const cHeader = document.createElement('div');
    cHeader.className = 'ql-section';
    cHeader.textContent = `Completed (${completed.length})`;
    qlBody.appendChild(cHeader);
    for (const qid of completed) {
      const def = state.questDefs[qid];
      const row = document.createElement('div');
      row.className = 'quest-row';
      const name = document.createElement('div');
      name.className = 'ql-name';
      name.textContent = def?.name || qid;
      row.appendChild(name);
      qlBody.appendChild(row);
    }
  }
}

function openQuestlog(): void { qlBackdrop.classList.add('open'); renderQuestlog(); }
window.addEventListener('mmo:quests', () => {
  rebuildQuestInteractionCaches();
  if (qlOpen()) renderQuestlog();
});
window.addEventListener('mmo:ready', rebuildQuestInteractionCaches);

interface Pick {
  tile: { x: number; y: number } | null;
  entity: EntitySnapshot | null;
}

function pickAt(clientX: number, clientY: number): Pick {
  if (!state.zone) return { tile: null, entity: null };
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const cx = (clientX - rect.left) * sx;
  const cy = (clientY - rect.top) * sy;
  const tx = Math.floor((cx - lastCamera.offsetX) / TILE);
  const ty = Math.floor((cy - lastCamera.offsetY) / TILE);
  const z = state.zone;
  if (tx < 0 || ty < 0 || tx >= z.width || ty >= z.height) {
    return { tile: null, entity: null };
  }
  const tile = { x: tx, y: ty };
  let entity: EntitySnapshot | null = null;
  const rank = (e: EntitySnapshot) => e.type === 'ground_item' ? 0 : e.type === 'player' ? 2 : 1;
  for (const e of z.entities) {
    if (e.position.x !== tx || e.position.y !== ty) continue;
    if (!entity || rank(e) >= rank(entity)) entity = e;
  }
  return { tile, entity };
}

function updateTooltip(): void {
  if (!hoveredEntity) { tooltipEl.classList.remove('open'); return; }
  const snap = hoveredEntity;
  tooltipEl.innerHTML = '';
  const name = document.createElement('div');
  name.className = 'tt-name';
  name.textContent = snap.name || snap.type;
  tooltipEl.appendChild(name);
  const hp = (snap.components as { health?: { current: number; max: number } } | undefined)?.health;
  if (hp && typeof hp.current === 'number' && typeof hp.max === 'number') {
    const track = document.createElement('div');
    track.className = 'tt-hp-track';
    const fill = document.createElement('div');
    fill.className = 'tt-hp-fill';
    const pct = Math.max(0, Math.min(1, hp.current / Math.max(1, hp.max)));
    fill.style.width = `${pct * 100}%`;
    fill.style.background = pct > 0.5 ? '#5acc5a' : pct > 0.25 ? '#cc8a3a' : '#cc3a3a';
    track.appendChild(fill);
    tooltipEl.appendChild(track);
    const txt = document.createElement('div');
    txt.className = 'tt-hp-text';
    txt.textContent = `HP ${hp.current} / ${hp.max}`;
    tooltipEl.appendChild(txt);
  }
  if (isQuestgiver(snap)) {
    const q = document.createElement('div');
    q.className = 'tt-quest';
    q.textContent = '! Has a quest';
    tooltipEl.appendChild(q);
  }
  if (hasQuestInteraction(snap)) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = 'Click to talk';
    tooltipEl.appendChild(hint);
  }
  tooltipEl.classList.add('open');
  repositionTooltip();
}

function repositionTooltip(): void {
  if (!tooltipEl.classList.contains('open')) return;
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  let x = mousePx.x + pad;
  let y = mousePx.y + pad;
  if (x + rect.width > window.innerWidth)  x = mousePx.x - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = mousePx.y - rect.height - pad;
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y}px`;
}

canvas.addEventListener('mousemove', (e) => {
  mousePx = { x: e.clientX, y: e.clientY };
  const p = pickAt(e.clientX, e.clientY);
  hoveredTile = p.tile;
  const changed = p.entity?.id !== hoveredEntity?.id;
  hoveredEntity = p.entity;
  if (changed) updateTooltip();
  else if (p.entity) repositionTooltip();
});
canvas.addEventListener('mouseleave', () => {
  hoveredEntity = null;
  hoveredTile = null;
  tooltipEl.classList.remove('open');
});
function hasQuestInteraction(snap: EntitySnapshot): boolean {
  if (snap.type !== 'mob') return false;
  const k = giverKey(snap);
  if (!k) return false;
  if ((state.questsByGiver[k]?.length ?? 0) > 0) return true;
  return talkTargetKeys.has(k);
}

// ─── Click-to-walk ────────────────────────────────────────────────────────

interface PathStep { x: number; y: number }
let autopath: PathStep[] = [];
let autopathTargetZone: string | null = null;
let autopathLastSentAt = 0;
const AUTOPATH_TICK_MS = 120;
const AUTOPATH_MAX_NODES = 4000;

function cancelAutopath(): void { autopath = []; autopathTargetZone = null; }

function isWalkable(tx: number, ty: number): boolean {
  const z = state.zone;
  if (!z) return false;
  if (tx < 0 || ty < 0 || tx >= z.width || ty >= z.height) return false;
  return !BLOCKING_TILES.has(z.grid[ty]![tx]!);
}

// 4-direction A* over the current zone grid. Path excludes the start tile.
function findPath(sx: number, sy: number, gx: number, gy: number): PathStep[] | null {
  if (sx === gx && sy === gy) return [];
  if (!isWalkable(gx, gy)) return null;
  const z = state.zone!;
  const w = z.width;
  const h = (x: number, y: number) => Math.abs(x - gx) + Math.abs(y - gy);
  const key = (x: number, y: number) => y * w + x;
  type Node = { x: number; y: number; g: number; f: number; from: number | null };
  const nodes = new Map<number, Node>();
  const open = new Map<number, Node>();
  const closed = new Set<number>();
  const start: Node = { x: sx, y: sy, g: 0, f: h(sx, sy), from: null };
  open.set(key(sx, sy), start);
  nodes.set(key(sx, sy), start);
  let visited = 0;

  while (open.size > 0) {
    let bestK = -1;
    let bestF = Infinity;
    for (const [k, n] of open) if (n.f < bestF) { bestF = n.f; bestK = k; }
    const cur = open.get(bestK)!;
    open.delete(bestK);
    closed.add(bestK);
    if (cur.x === gx && cur.y === gy) {
      const path: PathStep[] = [];
      let nodeK: number | null = bestK;
      while (nodeK !== null) {
        const n: Node = nodes.get(nodeK)!;
        if (n.from !== null) path.push({ x: n.x, y: n.y });
        nodeK = n.from;
      }
      return path.reverse();
    }
    if (++visited > AUTOPATH_MAX_NODES) return null;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      if (!isWalkable(nx, ny)) continue;
      const g = cur.g + 1;
      const existing = open.get(nk);
      if (existing && existing.g <= g) continue;
      const node: Node = { x: nx, y: ny, g, f: g + h(nx, ny), from: bestK };
      open.set(nk, node);
      nodes.set(nk, node);
    }
  }
  return null;
}

function dirFromDelta(dx: number, dy: number): Direction | null {
  if (dx === 1 && dy === 0) return 'east';
  if (dx === -1 && dy === 0) return 'west';
  if (dx === 0 && dy === 1) return 'south';
  if (dx === 0 && dy === -1) return 'north';
  return null;
}

function autopathTick(): void {
  if (autopath.length === 0) return;
  const self = state.self;
  if (!self) { cancelAutopath(); return; }
  if (autopathTargetZone && self.position.zone !== autopathTargetZone) {
    cancelAutopath();
    return;
  }
  const now = performance.now();
  if (now - autopathLastSentAt < AUTOPATH_TICK_MS) return;

  while (autopath.length > 0
         && autopath[0]!.x === self.position.x
         && autopath[0]!.y === self.position.y) {
    autopath.shift();
  }
  if (autopath.length === 0) { cancelAutopath(); return; }

  const next = autopath[0]!;
  const dir = dirFromDelta(next.x - self.position.x, next.y - self.position.y);
  if (!dir) { cancelAutopath(); return; }
  state.sendMove?.(dir);
  autopathLastSentAt = now;
}
setInterval(autopathTick, AUTOPATH_TICK_MS);

function nearestWalkable(tx: number, ty: number, opts: { excludeSelf?: boolean } = {}): PathStep | null {
  if (!opts.excludeSelf && isWalkable(tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = tx + dx, ny = ty + dy;
        if (isWalkable(nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}

canvas.addEventListener('click', (e) => {
  const { tile, entity } = pickAt(e.clientX, e.clientY);
  if (!tile) return;
  const self = state.self;
  if (!self) return;
  if (entity && entity.id === state.entityId) return;
  if (entity && hasQuestInteraction(entity)
      && chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
    openQuestgiver(entity);
    return;
  }
  const targetsMob = entity?.type === 'mob';
  const dest = targetsMob
    ? nearestWalkable(tile.x, tile.y, { excludeSelf: true })
    : nearestWalkable(tile.x, tile.y);
  if (!dest) return;
  const path = findPath(self.position.x, self.position.y, dest.x, dest.y);
  if (!path || path.length === 0) return;
  autopath = path;
  autopathTargetZone = self.position.zone;
  autopathLastSentAt = 0;
});

const TALK_RANGE = 2;
function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

ctx.imageSmoothingEnabled = false;

const KEY_TO_DIR: Record<string, 'north' | 'south' | 'east' | 'west'> = {
  ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east',
  w: 'north', s: 'south', a: 'west', d: 'east',
  W: 'north', S: 'south', A: 'west', D: 'east',
};

let lastSentDir: string | null = null;
let lastSentAt = 0;
const MOVE_COOLDOWN_MS = 100;
const FLOAT_TTL_MS = 900;
const DEATH_OVERLAY_MS = 1200;
const XP_FLOAT_TTL_MS = 1400;
const LEVEL_UP_TTL_MS = 1800;
const SPEECH_TTL_MS = 4500;
const CHAT_LOG_TTL_MS = 12000;
const ZONE_BANNER_TTL_MS = 2500;

const xpForNext = (level: number) => level * 100;

function chatFocused(): boolean { return document.activeElement === chatInput; }
function sheetOpen(): boolean { return sheetBackdrop.classList.contains('open'); }

function effectiveDamageRange(self: PlayerEntity): Range {
  const stats = self.components?.stats || {};
  const rolled = self.components?.equipment?.mainhand?.item?.components?.equipment?.rolled as RolledStats | undefined;
  const base: Range = Array.isArray(rolled?.damage)
    ? rolled.damage
    : (Array.isArray(stats.damage) ? stats.damage : [0, 0]);
  let bonus = 0;
  if (rolled?.scaling) {
    for (const [stat, letter] of Object.entries(rolled.scaling)) {
      const c = SCALING_COEFFS[letter as string];
      if (c) bonus += ((stats as Record<string, unknown>)[stat] as number || 0) * c;
    }
  }
  const b = Math.round(bonus);
  return [base[0] + b, base[1] + b];
}

function totalDefense(self: PlayerEntity): number {
  const eq = self.components?.equipment;
  if (!eq) return 0;
  let total = 0;
  for (const slot of ARMOR_SLOTS) {
    const def = eq[slot]?.item?.components?.equipment?.rolled?.defense;
    if (Array.isArray(def)) total += Math.round((def[0] + def[1]) / 2);
    else if (typeof def === 'number') total += def;
  }
  return total;
}

function classDisplay(klass: ClassId | undefined): string {
  if (!klass) return '—';
  return ({ fighter: 'Fighter', rogue: 'Rogue', wizard: 'Wizard' } as const)[klass] || '—';
}

function renderCharSheet(): void {
  const s = state.self;
  if (!s) return;
  const prog = s.components?.progress || { level: 1, xp: 0, unspent_points: 0 };
  const stats = s.components?.stats || {};
  const hp = s.components?.health || { current: 0, max: 0 };
  const dmg = effectiveDamageRange(s);
  const dex = stats.dexterity || 0;
  const dodgePct = Math.min(30, dex);
  csName.textContent = s.name || 'Player';
  csClass.textContent = classDisplay(s.klass);
  csLevel.textContent = String(prog.level);
  csXp.textContent = `${prog.xp} / ${xpForNext(prog.level)}`;
  csHp.textContent = `${hp.current} / ${hp.max}`;
  csStr.textContent = String(stats.strength ?? 0);
  csDex.textContent = String(stats.dexterity ?? 0);
  csInt.textContent = String(stats.intelligence ?? 0);
  csCon.textContent = String(stats.constitution ?? 0);
  csDmg.textContent = `${dmg[0]}–${dmg[1]}`;
  csDef.textContent = String(totalDefense(s));
  csDodge.textContent = `${dodgePct}%`;
  csPoints.textContent = String(prog.unspent_points || 0);
  csAlloc.classList.toggle('hidden', (prog.unspent_points || 0) <= 0);
}

function openSheet(): void { sheetBackdrop.classList.add('open'); renderCharSheet(); }
function closeSheet(): void { sheetBackdrop.classList.remove('open'); }

window.addEventListener('mmo:self', renderCharSheet);
window.addEventListener('mmo:zone', () => { if (sheetOpen()) renderCharSheet(); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (chatFocused()) {
      const text = chatInput.value;
      if (text.trim()) state.sendChat?.(text);
      chatInput.value = '';
      chatInput.blur();
    } else {
      chatInput.focus();
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (chatFocused()) { chatInput.value = ''; chatInput.blur(); e.preventDefault(); return; }
    if (qgOpen()) { closeQuestgiver(); e.preventDefault(); return; }
    if (qlOpen()) { closeQuestlog(); e.preventDefault(); return; }
    if (sheetOpen()) { closeSheet(); e.preventDefault(); return; }
    if (invOpen()) { closeInventory(); e.preventDefault(); return; }
  }
  if (chatFocused()) return;

  if (e.key === 'c' || e.key === 'C') {
    if (sheetOpen()) closeSheet(); else openSheet();
    e.preventDefault();
    return;
  }
  if (e.key === 'i' || e.key === 'I') {
    if (invOpen()) closeInventory(); else openInventory();
    e.preventDefault();
    return;
  }
  if (e.key === 'q' || e.key === 'Q') {
    if (qlOpen()) closeQuestlog(); else openQuestlog();
    e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    cancelAutopath();
    state.sendAttack?.();
    e.preventDefault();
    return;
  }
  const dir = KEY_TO_DIR[e.key];
  if (!dir) return;
  cancelAutopath();
  const now = performance.now();
  if (dir === lastSentDir && now - lastSentAt < MOVE_COOLDOWN_MS) return;
  lastSentDir = dir;
  lastSentAt = now;
  state.sendMove?.(dir);
  e.preventDefault();
});
window.addEventListener('keyup', () => { lastSentDir = null; });

chatInput.addEventListener('focus', () => chatInput.classList.remove('dim'));
chatInput.addEventListener('blur',  () => chatInput.classList.add('dim'));

function renderChatLog(): void {
  const now = performance.now();
  const visible = state.chatLog.filter(c => now - c.recvAt < CHAT_LOG_TTL_MS);
  chatLog.innerHTML = '';
  for (const c of visible.slice(-8)) {
    const line = document.createElement('div');
    line.className = 'chat-line';
    const name = document.createElement('span');
    name.className = 'chat-name' + (c.from.id === state.entityId ? ' self' : '');
    name.textContent = c.from.name + ': ';
    const txt = document.createElement('span');
    txt.textContent = c.text;
    line.appendChild(name);
    line.appendChild(txt);
    chatLog.appendChild(line);
  }
}
setInterval(renderChatLog, 250);
window.addEventListener('mmo:chat', renderChatLog);

interface FloatArgs {
  text: string; x: number; y: number; t: number; ttl: number; rise: number;
  color: string; font: string;
}
function drawFloatText({ text, x, y, t, ttl, rise, color, font }: FloatArgs): void {
  const age = performance.now() - t;
  if (age >= ttl) return;
  const dy = (age / ttl) * rise;
  const alpha = 1 - age / ttl;
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y - dy);
  ctx.fillText(text, x, y - dy);
  ctx.globalAlpha = 1;
}

function drawTile(px: number, py: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(px, py, TILE, TILE);
}

function drawEntity(px: number, py: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 4 + 0.5, py + 4 + 0.5, TILE - 9, TILE - 9);
}

function drawGroundItem(px: number, py: number, color: string): void {
  const cx = px + TILE / 2;
  const cy = py + TILE / 2 + 4;
  const r = 7;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Floating "!" above quest-giver heads. Pulses very gently so it reads as
// interactive without being a distraction.
function drawQuestMarker(cx: number, cy: number): void {
  const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 220);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#ffd84a';
  ctx.strokeText('!', 0, 0);
  ctx.fillText('!', 0, 0);
  ctx.restore();
}

function drawHpBar(px: number, py: number, current: number, max: number): void {
  if (current >= max) return;
  const w = TILE - 8;
  const pct = Math.max(0, current / max);
  ctx.fillStyle = '#000';
  ctx.fillRect(px + 4, py + 1, w, 3);
  ctx.fillStyle = pct > 0.5 ? '#5acc5a' : pct > 0.25 ? '#cc8a3a' : '#cc3a3a';
  ctx.fillRect(px + 4, py + 1, Math.round(w * pct), 3);
}

function render(): void {
  if (!state.zone || !state.tileset) {
    requestAnimationFrame(render);
    return;
  }

  const { grid, width, height, entities } = state.zone;
  const ts = state.tileset;
  if (state._tsRef !== ts) {
    state._tsRef = ts;
    state._tileColors = Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color]));
    state._spriteColors = Object.fromEntries(Object.entries(ts.sprites).map(([k, v]) => [k, v.color]));
  }
  const tileColors = state._tileColors!;
  const spriteColors = state._spriteColors!;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const self = state.self;
  const camCx = self ? self.position.x : Math.floor(width / 2);
  const camCy = self ? self.position.y : Math.floor(height / 2);
  const viewCols = Math.ceil(canvas.width / TILE);
  const viewRows = Math.ceil(canvas.height / TILE);
  const offsetX = Math.floor(canvas.width / 2) - camCx * TILE - TILE / 2;
  const offsetY = Math.floor(canvas.height / 2) - camCy * TILE - TILE / 2;
  lastCamera = { offsetX, offsetY };

  // Recompute hovered tile/entity every frame so the highlight stays under the
  // cursor as the camera scrolls (player movement) and across zone transitions.
  {
    const p = pickAt(mousePx.x, mousePx.y);
    hoveredTile = p.tile;
    if (p.entity?.id !== hoveredEntity?.id) {
      hoveredEntity = p.entity;
      updateTooltip();
    } else {
      hoveredEntity = p.entity;
    }
  }

  const x0 = Math.max(0, camCx - Math.ceil(viewCols / 2) - 1);
  const x1 = Math.min(width, camCx + Math.ceil(viewCols / 2) + 1);
  const y0 = Math.max(0, camCy - Math.ceil(viewRows / 2) - 1);
  const y1 = Math.min(height, camCy + Math.ceil(viewRows / 2) + 1);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const tile = grid[y]![x]!;
      const color = tileColors[tile] || '#ff00ff';
      drawTile(x * TILE + offsetX, y * TILE + offsetY, color);
    }
  }

  const rankOf = (e: typeof entities[number]) => e.type === 'ground_item' ? 0 : e.type === 'player' ? 2 : 1;
  const ordered = [...entities].sort((a, b) => rankOf(a) - rankOf(b));
  for (const e of ordered) {
    const sprite = e.sprite || (e.type === 'player' ? 'player' : null);
    const color = (sprite && spriteColors[sprite]) || '#ffffff';
    const px = e.position.x * TILE + offsetX;
    const py = e.position.y * TILE + offsetY;
    if (e.type === 'ground_item') {
      drawGroundItem(px, py, color);
    } else {
      drawEntity(px, py, color);
      const hp = (e.components as { health?: { current: number; max: number } })?.health;
      if (hp) drawHpBar(px, py, hp.current, hp.max);
    }
    if (e.type === 'mob' && isQuestgiver(e)) {
      drawQuestMarker(px + TILE / 2, py - 10);
    }
  }

  if (hoveredTile) {
    const px = hoveredTile.x * TILE + offsetX;
    const py = hoveredTile.y * TILE + offsetY;
    let color = '#7acdf5';
    if (hoveredEntity && hasQuestInteraction(hoveredEntity)) {
      const self = state.self;
      const inRange = self
        ? Math.max(
            Math.abs(self.position.x - hoveredEntity.position.x),
            Math.abs(self.position.y - hoveredEntity.position.y),
          ) <= TALK_RANGE
        : false;
      color = inRange ? '#ffd84a' : '#888';
    } else if (!isWalkable(hoveredTile.x, hoveredTile.y)) {
      color = '#cc5a5a';
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2);
    ctx.restore();
  }

  if (autopath.length > 0) {
    const dest = autopath[autopath.length - 1]!;
    const cx = dest.x * TILE + offsetX + TILE / 2;
    const cy = dest.y * TILE + offsetY + TILE / 2;
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 180);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 216, 74, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const now = performance.now();
  state.combatEvents = state.combatEvents.filter(ev => now - ev.t < FLOAT_TTL_MS);
  for (const ev of state.combatEvents) {
    if (!ev.at) continue;
    let text: string, color: string;
    if (ev.dodged) {
      text = 'dodge';
      color = '#9adfff';
    } else {
      text = ev.fatal ? `${ev.damage}!` : `${ev.damage}`;
      color = ev.fatal ? '#ffcc4a' : (ev.targetId === state.entityId ? '#ff6a6a' : '#ffffff');
    }
    drawFloatText({
      text,
      x: ev.at.x * TILE + offsetX + TILE / 2,
      y: ev.at.y * TILE + offsetY,
      t: ev.t, ttl: FLOAT_TTL_MS, rise: 18,
      color,
      font: 'bold 14px monospace',
    });
  }

  for (const [eid, sp] of state.speech) {
    if (now - sp.t > SPEECH_TTL_MS) { state.speech.delete(eid); continue; }
    const ent = entities.find(e => e.id === eid);
    if (!ent) continue;
    const age = now - sp.t;
    const alpha = age < SPEECH_TTL_MS - 500 ? 1 : 1 - (age - (SPEECH_TTL_MS - 500)) / 500;
    const text = sp.text;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    const padX = 6, padY = 4;
    const metrics = ctx.measureText(text);
    const w = Math.min(220, metrics.width + padX * 2);
    const h = 18;
    const cx = ent.position.x * TILE + offsetX + TILE / 2;
    const cy = ent.position.y * TILE + offsetY - 14;
    ctx.globalAlpha = 0.85 * alpha;
    ctx.fillStyle = '#1a1a1a';
    ctx.strokeStyle = '#7acdf5';
    ctx.lineWidth = 1;
    const bx = Math.round(cx - w / 2);
    const by = Math.round(cy - h);
    ctx.fillRect(bx, by, w, h);
    ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(cx - 4, by + h);
    ctx.lineTo(cx, by + h + 4);
    ctx.lineTo(cx + 4, by + h);
    ctx.closePath();
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();
    ctx.strokeStyle = '#7acdf5';
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#eee';
    ctx.fillText(text, cx, by + h - padY - 1);
    ctx.globalAlpha = 1;
  }

  const PICKUP_FLOAT_TTL_MS = 1400;
  state.pickupFloats = state.pickupFloats.filter(f => now - f.t < PICKUP_FLOAT_TTL_MS);
  if (self) {
    for (const f of state.pickupFloats) {
      drawFloatText({
        text: f.kind === 'gold' ? `+${f.amount} gold` : `+ ${f.name}`,
        x: self.position.x * TILE + offsetX + TILE / 2,
        y: self.position.y * TILE + offsetY - 26,
        t: f.t, ttl: PICKUP_FLOAT_TTL_MS, rise: 28,
        color: f.kind === 'gold' ? '#ffd84a' : '#bcd0e0',
        font: 'bold 12px monospace',
      });
    }
  }

  state.xpFloats = state.xpFloats.filter(f => now - f.t < XP_FLOAT_TTL_MS);
  if (self) {
    for (const f of state.xpFloats) {
      drawFloatText({
        text: `+${f.amount} XP`,
        x: self.position.x * TILE + offsetX + TILE / 2,
        y: self.position.y * TILE + offsetY - 12,
        t: f.t, ttl: XP_FLOAT_TTL_MS, rise: 36,
        color: '#7acdf5',
        font: 'bold 13px monospace',
      });
    }
  }

  if (state.zoneBanner && now - state.zoneBanner.t < ZONE_BANNER_TTL_MS) {
    const age = now - state.zoneBanner.t;
    const t = age / ZONE_BANNER_TTL_MS;
    const alpha = t < 0.15 ? t / 0.15 : t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    const y = canvas.height * 0.18;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = 'bold 42px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.strokeText(state.zoneBanner.name, canvas.width / 2, y);
    ctx.fillText(state.zoneBanner.name, canvas.width / 2, y);
    ctx.globalAlpha = 1;
  }

  if (state.levelUp && now - state.levelUp.t < LEVEL_UP_TTL_MS) {
    const age = now - state.levelUp.t;
    const t = age / LEVEL_UP_TTL_MS;
    const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 56px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd84a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    const text = `LEVEL ${state.levelUp.level}!`;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 3);
    ctx.fillText(text, canvas.width / 2, canvas.height / 3);
    ctx.globalAlpha = 1;
  }

  if (self?.components?.progress) {
    const prog = self.components.progress;
    const needed = xpForNext(prog.level);
    const pct = Math.min(1, prog.xp / needed);
    const bw = canvas.width - 40;
    const bx = 20;
    const by = canvas.height - 22;
    ctx.fillStyle = '#222';
    ctx.fillRect(bx, by, bw, 10);
    ctx.fillStyle = '#7acdf5';
    ctx.fillRect(bx, by, Math.round(bw * pct), 10);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 9);
    ctx.fillStyle = '#ddd';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Lv ${prog.level}  ${prog.xp} / ${needed} XP`, bx, by - 4);
  }

  if (state.died && state.diedAt && now - state.diedAt < DEATH_OVERLAY_MS) {
    const a = 1 - (now - state.diedAt) / DEATH_OVERLAY_MS;
    ctx.fillStyle = `rgba(80, 0, 0, ${0.5 * a})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = a;
    ctx.font = 'bold 48px monospace';
    ctx.fillStyle = '#ffdddd';
    ctx.textAlign = 'center';
    ctx.fillText('You died', canvas.width / 2, canvas.height / 2);
    ctx.globalAlpha = 1;
  } else if (state.died) {
    state.died = false;
  }

  const hpText = self?.components?.health
    ? `HP ${self.components.health.current}/${self.components.health.max}`
    : '';
  const lvlText = self?.components?.progress
    ? `Lv ${self.components.progress.level}`
    : '';
  const nameText = self?.name ? `${self.name}  ` : '';
  const ptsText = (self?.components?.progress?.unspent_points || 0) > 0
    ? `  [${self!.components.progress.unspent_points} unspent — press C]` : '';
  const gold = self?.components?.wallet?.gold || 0;
  const goldText = `  ⛁ ${gold}`;
  hud.textContent = self
    ? `${nameText}zone: ${state.zone!.id}  pos: (${self.position.x},${self.position.y})  ${hpText}  ${lvlText}${goldText}${ptsText}  [WASD · Space · C sheet · I inv · Q quests · Enter chat]`
    : 'connected, waiting for state…';

  requestAnimationFrame(render);
}

render();
