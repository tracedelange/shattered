import { state } from './state.ts';
import { ARMOR_SLOTS, SCALING_COEFFS } from '../../shared/constants.ts';
import type {
  ClassId, EquipSlot, InventoryStack, PlayerEntity, Range, RolledStats, StatId,
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
  if (e.key === ' ' || e.code === 'Space') {
    state.sendAttack?.();
    e.preventDefault();
    return;
  }
  const dir = KEY_TO_DIR[e.key];
  if (!dir) return;
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
    ? `${nameText}zone: ${state.zone!.id}  pos: (${self.position.x},${self.position.y})  ${hpText}  ${lvlText}${goldText}${ptsText}  [WASD · Space · C sheet · I inv · Enter chat]`
    : 'connected, waiting for state…';

  requestAnimationFrame(render);
}

render();
