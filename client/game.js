const TILE = 32;
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const chatInput = document.getElementById('chat-input');
const chatLog = document.getElementById('chat-log');
const sheetBackdrop = document.getElementById('charsheet-backdrop');
const csName = document.getElementById('cs-name');
const csLevel = document.getElementById('cs-level');
const csXp = document.getElementById('cs-xp');
const csHp = document.getElementById('cs-hp');
const csStr = document.getElementById('cs-str');
const csDex = document.getElementById('cs-dex');
const csInt = document.getElementById('cs-int');
const csCon = document.getElementById('cs-con');
const csDmg = document.getElementById('cs-dmg');
const csPoints = document.getElementById('cs-points');
const csAlloc = document.getElementById('cs-alloc');
for (const stat of ['strength', 'dexterity', 'intelligence', 'constitution']) {
  document.getElementById(`alloc-${stat}`).addEventListener('click', () => window.mmo?.sendAllocate?.(stat));
}

const invBackdrop = document.getElementById('inv-backdrop');
const invSlots = document.getElementById('inv-slots');
const invEquip = document.getElementById('inv-equip');
const invGold = document.getElementById('inv-gold');
// Paper-doll layout: 3 columns × 3 rows. Empty cells are visual padding.
const EQ_LAYOUT = [
  ['helmet',   'amulet',    null      ],
  ['chest',    'mainhand',  'gloves'  ],
  ['leggings', 'boots',     null      ],
  ['ring1',    null,        'ring2'   ],
];
function invOpen() { return invBackdrop.classList.contains('open'); }
function renderInventory() {
  const m = window.mmo;
  const s = m?.self;
  if (!s) return;
  const inv = s.components?.inventory?.slots || [];
  const equipment = s.components?.equipment || {};
  const gold = s.components?.wallet?.gold || 0;
  invGold.textContent = gold;
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
      const eq = equipment[slot];
      cell.className = 'eq-cell' + (eq ? ' filled' : '');
      const label = document.createElement('div');
      label.textContent = eq ? (eq.name || eq.base || '?') : '—';
      const sub = document.createElement('div');
      sub.className = 'eq-slot-name';
      sub.textContent = slot;
      cell.appendChild(label);
      cell.appendChild(sub);
      if (eq) cell.addEventListener('click', () => window.mmo?.sendUnequip?.(slot));
      invEquip.appendChild(cell);
    }
  }
  invSlots.innerHTML = '';
  for (let i = 0; i < inv.length; i++) {
    const cell = document.createElement('div');
    cell.className = 'slot' + (inv[i] ? ' filled' : ' empty');
    cell.textContent = inv[i] ? (inv[i].name || inv[i].base || '?') : '·';
    cell.dataset.slot = String(i);
    if (inv[i]) cell.addEventListener('click', () => window.mmo?.sendEquip?.(i));
    invSlots.appendChild(cell);
  }
}
function openInventory() { invBackdrop.classList.add('open'); renderInventory(); }
function closeInventory() { invBackdrop.classList.remove('open'); }
window.addEventListener('mmo:self', () => { if (invOpen()) renderInventory(); });
window.addEventListener('mmo:zone', () => { if (invOpen()) renderInventory(); });

ctx.imageSmoothingEnabled = false;

const KEY_TO_DIR = {
  ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east',
  w: 'north', s: 'south', a: 'west', d: 'east',
  W: 'north', S: 'south', A: 'west', D: 'east',
};

let lastSentDir = null;
let lastSentAt = 0;
const MOVE_COOLDOWN_MS = 100;
const FLOAT_TTL_MS = 900;
const DEATH_OVERLAY_MS = 1200;
const XP_FLOAT_TTL_MS = 1400;
const LEVEL_UP_TTL_MS = 1800;
const SPEECH_TTL_MS = 4500;
const CHAT_LOG_TTL_MS = 12000;
const ZONE_BANNER_TTL_MS = 2500;

const xpForNext = (level) => level * 100;

function chatFocused() { return document.activeElement === chatInput; }
function sheetOpen() { return sheetBackdrop.classList.contains('open'); }

function renderCharSheet() {
  const m = window.mmo;
  const s = m?.self;
  if (!s) return;
  const prog = s.components?.progress || { level: 1, xp: 0, unspent_points: 0 };
  const stats = s.components?.stats || {};
  const hp = s.components?.health || { current: 0, max: 0 };
  // Effective damage: weapon range overrides bare-fist range; strength is flat.
  const mh = s.components?.equipment?.mainhand;
  const weaponDmg = mh?.item?.components?.equipment?.rolled?.damage;
  const baseDmg = Array.isArray(weaponDmg) ? weaponDmg
    : (Array.isArray(stats.damage) ? stats.damage : [0, 0]);
  const dmg = [baseDmg[0] + (stats.strength || 0), baseDmg[1] + (stats.strength || 0)];
  csName.textContent = s.name || 'Player';
  csLevel.textContent = prog.level;
  csXp.textContent = `${prog.xp} / ${xpForNext(prog.level)}`;
  csHp.textContent = `${hp.current} / ${hp.max}`;
  csStr.textContent = stats.strength ?? 0;
  csDex.textContent = stats.dexterity ?? 0;
  csInt.textContent = stats.intelligence ?? 0;
  csCon.textContent = stats.constitution ?? 0;
  csDmg.textContent = `${dmg[0]}–${dmg[1]}`;
  csPoints.textContent = prog.unspent_points || 0;
  csAlloc.classList.toggle('hidden', (prog.unspent_points || 0) <= 0);
}

function openSheet() { sheetBackdrop.classList.add('open'); renderCharSheet(); }
function closeSheet() { sheetBackdrop.classList.remove('open'); }

window.addEventListener('mmo:self', renderCharSheet);
window.addEventListener('mmo:zone', () => { if (sheetOpen()) renderCharSheet(); });

window.addEventListener('keydown', (e) => {
  // Chat focus handling — Enter to focus/send, Esc to bail.
  if (e.key === 'Enter') {
    if (chatFocused()) {
      const text = chatInput.value;
      if (text.trim()) window.mmo?.sendChat?.(text);
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
  if (chatFocused()) return; // typing — let the input own all other keys

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
    window.mmo?.sendAttack?.();
    e.preventDefault();
    return;
  }
  const dir = KEY_TO_DIR[e.key];
  if (!dir) return;
  const now = performance.now();
  if (dir === lastSentDir && now - lastSentAt < MOVE_COOLDOWN_MS) return;
  lastSentDir = dir;
  lastSentAt = now;
  window.mmo?.sendMove?.(dir);
  e.preventDefault();
});
window.addEventListener('keyup', () => { lastSentDir = null; });

chatInput.addEventListener('focus', () => chatInput.classList.remove('dim'));
chatInput.addEventListener('blur',  () => chatInput.classList.add('dim'));

function renderChatLog() {
  const m = window.mmo;
  if (!m) return;
  const now = performance.now();
  const visible = m.chatLog.filter(c => now - c.recvAt < CHAT_LOG_TTL_MS);
  chatLog.innerHTML = '';
  for (const c of visible.slice(-8)) {
    const line = document.createElement('div');
    line.className = 'chat-line';
    const name = document.createElement('span');
    name.className = 'chat-name' + (c.from.id === m.entityId ? ' self' : '');
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

// Rises and fades over `ttl` ms. Caller filters expired entries first.
function drawFloatText({ text, x, y, t, ttl, rise, color, font }) {
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

function drawTile(px, py, color) {
  ctx.fillStyle = color;
  ctx.fillRect(px, py, TILE, TILE);
}

function drawEntity(px, py, color) {
  ctx.fillStyle = color;
  ctx.fillRect(px + 4, py + 4, TILE - 8, TILE - 8);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 4 + 0.5, py + 4 + 0.5, TILE - 9, TILE - 9);
}

function drawGroundItem(px, py, color) {
  // Small diamond-ish blob centered in the tile so it reads as "on the ground".
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

function drawHpBar(px, py, current, max) {
  if (current >= max) return;
  const w = TILE - 8;
  const pct = Math.max(0, current / max);
  ctx.fillStyle = '#000';
  ctx.fillRect(px + 4, py + 1, w, 3);
  ctx.fillStyle = pct > 0.5 ? '#5acc5a' : pct > 0.25 ? '#cc8a3a' : '#cc3a3a';
  ctx.fillRect(px + 4, py + 1, Math.round(w * pct), 3);
}

function render() {
  const m = window.mmo;
  if (!m?.zone || !m?.tileset) {
    requestAnimationFrame(render);
    return;
  }

  const { grid, width, height, entities } = m.zone;
  const ts = m.tileset;
  if (m._tsRef !== ts) {
    m._tsRef = ts;
    m._tileColors = Object.fromEntries(Object.entries(ts.tiles).map(([k, v]) => [k, v.color]));
    m._spriteColors = Object.fromEntries(Object.entries(ts.sprites).map(([k, v]) => [k, v.color]));
  }
  const tileColors = m._tileColors;
  const spriteColors = m._spriteColors;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const self = m.self;
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
      const tile = grid[y][x];
      const color = tileColors[tile] || '#ff00ff';
      drawTile(x * TILE + offsetX, y * TILE + offsetY, color);
    }
  }

  const rankOf = (e) => e.type === 'ground_item' ? 0 : e.type === 'player' ? 2 : 1;
  const ordered = [...entities].sort((a, b) => rankOf(a) - rankOf(b));
  for (const e of ordered) {
    const sprite = e.sprite || (e.type === 'player' ? 'player' : null);
    const color = spriteColors[sprite] || '#ffffff';
    const px = e.position.x * TILE + offsetX;
    const py = e.position.y * TILE + offsetY;
    if (e.type === 'ground_item') {
      drawGroundItem(px, py, color);
    } else {
      drawEntity(px, py, color);
      const hp = e.components?.health;
      if (hp) drawHpBar(px, py, hp.current, hp.max);
    }
  }

  const now = performance.now();
  m.combatEvents = m.combatEvents.filter(ev => now - ev.t < FLOAT_TTL_MS);
  for (const ev of m.combatEvents) {
    if (!ev.at) continue;
    drawFloatText({
      text: ev.fatal ? `${ev.damage}!` : `${ev.damage}`,
      x: ev.at.x * TILE + offsetX + TILE / 2,
      y: ev.at.y * TILE + offsetY,
      t: ev.t, ttl: FLOAT_TTL_MS, rise: 18,
      color: ev.fatal ? '#ffcc4a' : (ev.targetId === m.entityId ? '#ff6a6a' : '#ffffff'),
      font: 'bold 14px monospace',
    });
  }

  // Speech bubbles above speakers.
  for (const [eid, sp] of m.speech) {
    if (now - sp.t > SPEECH_TTL_MS) { m.speech.delete(eid); continue; }
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
    // little tail
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
  m.pickupFloats = m.pickupFloats.filter(f => now - f.t < PICKUP_FLOAT_TTL_MS);
  if (self) {
    for (const f of m.pickupFloats) {
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

  m.xpFloats = m.xpFloats.filter(f => now - f.t < XP_FLOAT_TTL_MS);
  if (self) {
    for (const f of m.xpFloats) {
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

  // Zone-name banner (on entry / transition).
  if (m.zoneBanner && now - m.zoneBanner.t < ZONE_BANNER_TTL_MS) {
    const age = now - m.zoneBanner.t;
    const t = age / ZONE_BANNER_TTL_MS;
    // Fade in for 0.2, hold, fade out for 0.4
    const alpha = t < 0.15 ? t / 0.15 : t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    const y = canvas.height * 0.18;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = 'bold 42px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.strokeText(m.zoneBanner.name, canvas.width / 2, y);
    ctx.fillText(m.zoneBanner.name, canvas.width / 2, y);
    ctx.globalAlpha = 1;
  }

  // Level up banner.
  if (m.levelUp && now - m.levelUp.t < LEVEL_UP_TTL_MS) {
    const age = now - m.levelUp.t;
    const t = age / LEVEL_UP_TTL_MS;
    const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 56px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd84a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    const text = `LEVEL ${m.levelUp.level}!`;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 3);
    ctx.fillText(text, canvas.width / 2, canvas.height / 3);
    ctx.globalAlpha = 1;
  }

  // XP bar at bottom of canvas.
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

  // Death overlay.
  if (m.died && m.diedAt && now - m.diedAt < DEATH_OVERLAY_MS) {
    const a = 1 - (now - m.diedAt) / DEATH_OVERLAY_MS;
    ctx.fillStyle = `rgba(80, 0, 0, ${0.5 * a})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = a;
    ctx.font = 'bold 48px monospace';
    ctx.fillStyle = '#ffdddd';
    ctx.textAlign = 'center';
    ctx.fillText('You died', canvas.width / 2, canvas.height / 2);
    ctx.globalAlpha = 1;
  } else if (m.died) {
    m.died = false;
  }

  const hpText = self?.components?.health
    ? `HP ${self.components.health.current}/${self.components.health.max}`
    : '';
  const lvlText = self?.components?.progress
    ? `Lv ${self.components.progress.level}`
    : '';
  const nameText = self?.name ? `${self.name}  ` : '';
  const ptsText = (self?.components?.progress?.unspent_points || 0) > 0
    ? `  [${self.components.progress.unspent_points} unspent — press C]` : '';
  const gold = self?.components?.wallet?.gold || 0;
  const goldText = `  ⛁ ${gold}`;
  hud.textContent = self
    ? `${nameText}zone: ${m.zone.id}  pos: (${self.position.x},${self.position.y})  ${hpText}  ${lvlText}${goldText}${ptsText}  [WASD · Space · C sheet · I inv · Enter chat]`
    : 'connected, waiting for state…';

  requestAnimationFrame(render);
}

render();
