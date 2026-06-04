import { state } from './state.ts';
import { ARMOR_SLOTS, BLOCKING_TILES, SCALING_COEFFS } from '../../shared/constants.ts';
import { buildSpriteColorMap, buildTileColorMap } from '../../shared/tileset.ts';
import type {
  ClassId, Direction, EntitySnapshot, EquipSlot, InventoryStack, LootSlot, PlayerEntity,
  QuestDef, Range, RolledStats, StatId,
} from '../../shared/types.ts';

const TILE = 32;
const corpseEmptiedAt = new Map<string, number>();
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
// Offscreen canvas used to composite the night overlay with radial light cutouts.
const darknessCanvas = document.createElement('canvas');
const darknessCtx = darknessCanvas.getContext('2d')!;
const hud           = document.getElementById('hud')!;
const hotbar        = document.getElementById('hotbar')!;
const hbAttack      = document.getElementById('hb-attack')!;
const hbAttackCd    = document.getElementById('hb-attack-cd')!;
const hbPotion      = document.getElementById('hb-potion')!;
const hbPotionLabel = document.getElementById('hb-potion-label')!;
const hbPotionCd    = document.getElementById('hb-potion-cd')!;
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

const RARITY_COLORS: Record<string, string> = {
  common: '#cccccc',
  uncommon: '#5acc5a',
  rare: '#5a9aff',
  legendary: '#ff8c2a',
};

function rarityColor(rarity?: string): string {
  return RARITY_COLORS[rarity ?? 'common'] ?? RARITY_COLORS['common']!;
}

function stackTooltip(stack: InventoryStack): string {
  const eq = stack.item?.components?.equipment;
  const rolled = eq?.rolled as RolledStats | undefined;
  const rarity = eq?.rarity as string | undefined;
  const lines = [(rarity && rarity !== 'common' ? `[${rarity.charAt(0).toUpperCase() + rarity.slice(1)}] ` : '') + (stack.name || stack.base || 'Item')];
  if (stack.item_slot === 'consumable') {
    lines.push('Click to use');
    return lines.join('\n');
  }
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
  if (rolled) {
    const SKIP = new Set(['damage', 'defense', 'speed', 'scaling']);
    for (const [k, v] of Object.entries(rolled)) {
      if (SKIP.has(k) || v === null || v === undefined) continue;
      if (typeof v === 'number') {
        const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        lines.push(`${label}: +${v}`);
      }
    }
  }
  if (rolled?.speed != null) {
    lines.push(`Speed: ${rolled.speed.toFixed(2)}`);
  }
  return lines.join('\n');
}

const invBackdrop = document.getElementById('inv-backdrop')!;
const invSlots = document.getElementById('inv-slots')!;
const invEquip = document.getElementById('inv-equip')!;
const invGold = document.getElementById('inv-gold')!;
const invDetail = document.getElementById('inv-detail')!;

const lootBackdrop  = document.getElementById('loot-backdrop')!;
const lootTitle     = document.getElementById('loot-title')!;
const lootBody      = document.getElementById('loot-body')!;
const lootAllBtn    = document.getElementById('loot-all-btn') as HTMLButtonElement;
const lootCloseBtn  = document.getElementById('loot-close-btn')!;

const signBackdrop  = document.getElementById('sign-backdrop')!;
const signTitle     = document.getElementById('sign-title')!;
const signBody      = document.getElementById('sign-body')!;
const signCloseBtn  = document.getElementById('sign-close-btn')!;

const boardBackdrop   = document.getElementById('board-backdrop')!;
const boardTitle      = document.getElementById('board-title')!;
const boardTabRead    = document.getElementById('board-tab-read')!;
const boardTabPost    = document.getElementById('board-tab-post')!;
const boardReadView   = document.getElementById('board-read-view')!;
const boardPostView   = document.getElementById('board-post-view')!;
const boardMsgsEl     = document.getElementById('board-messages')!;
const boardTextarea   = document.getElementById('board-textarea') as HTMLTextAreaElement;
const boardCharCount  = document.getElementById('board-char-count')!;
const boardPostBtn    = document.getElementById('board-post-btn') as HTMLButtonElement;
const boardPostErr    = document.getElementById('board-post-err')!;
const boardCloseBtn   = document.getElementById('board-close-btn')!;

const tradeBackdrop  = document.getElementById('trade-backdrop')!;
const tradeTitle     = document.getElementById('trade-title')!;
const tradeTabBuy    = document.getElementById('trade-tab-buy')!;
const tradeTabSell   = document.getElementById('trade-tab-sell')!;
const tradeList      = document.getElementById('trade-list')!;
const tradeConfirm   = document.getElementById('trade-confirm')!;
const tradeGoldEl    = document.getElementById('trade-gold')!;
const tradeErr       = document.getElementById('trade-err')!;

const EQ_LAYOUT: (EquipSlot | null)[][] = [
  [null,       'helmet',    'amulet'  ],
  ['mainhand', 'chest',     'gloves'  ],
  ['ring1',    'leggings',  'ring2'   ],
  [null,       'boots',     null      ],
];

function invOpen(): boolean { return invBackdrop.classList.contains('open'); }

function renderCharSummary(): void {
  const s = state.self;
  if (!s) { invDetail.innerHTML = '<div class="idd-empty">—</div>'; return; }
  const prog = s.components?.progress || { level: 1, xp: 0, unspent_points: 0 };
  const stats = s.components?.stats || {};
  const hp = s.components?.health || { current: 0, max: 0 };
  const dmg = effectiveDamageRange(s);
  const def = totalDefense(s);
  const dex = stats.dexterity || 0;
  const dodgePct = Math.min(30, dex);
  const xpNext = xpForNext(prog.level);
  const xpPct = xpNext > 0 ? Math.round((prog.xp / xpNext) * 100) : 0;
  const hpPct = hp.max > 0 ? Math.round((hp.current / hp.max) * 100) : 0;

  const row = (lbl: string, val: string | number) =>
    `<div class="idd-row"><span class="lbl">${lbl}</span><span class="val">${val}</span></div>`;

  let html = `<div class="idd-name">${s.name || 'Player'}</div>`;
  html += `<div class="idd-slot">${classDisplay(s.klass)} · Lv ${prog.level}</div>`;
  html += '<hr class="idd-divider">';
  html += row('HP', `${hp.current} / ${hp.max} <span style="opacity:0.45;font-size:10px">(${hpPct}%)</span>`);
  html += row('XP', `${prog.xp} / ${xpNext} <span style="opacity:0.45;font-size:10px">(${xpPct}%)</span>`);
  html += '<hr class="idd-divider">';
  html += row('Strength', stats.strength ?? 0);
  html += row('Dexterity', stats.dexterity ?? 0);
  html += row('Intelligence', stats.intelligence ?? 0);
  html += row('Constitution', stats.constitution ?? 0);
  html += '<hr class="idd-divider">';
  html += row('Damage', `${dmg[0]}–${dmg[1]}`);
  html += row('Defense', def);
  html += row('Dodge', `${dodgePct}%`);
  if ((prog.unspent_points || 0) > 0) {
    html += `<div style="color:#ffd84a;font-size:11px;margin-top:8px">▲ ${prog.unspent_points} unspent point${prog.unspent_points !== 1 ? 's' : ''} — press C</div>`;
  }
  invDetail.innerHTML = html;
}

function renderItemDetail(stack: InventoryStack | null): void {
  if (!stack) { renderCharSummary(); return; }
  const eq = stack.item?.components?.equipment;
  const rolled = eq?.rolled as RolledStats | undefined;
  const rarity = (eq?.rarity as string | undefined) ?? 'common';
  const slot = stack.item_slot ?? '';
  const color = rarityColor(rarity);

  let html = `<div class="idd-name" style="color:${color}">${stack.name || stack.base || 'Item'}</div>`;
  if (rarity !== 'common') {
    html += `<div class="idd-rarity" style="color:${color}">${rarity}</div>`;
  }
  if (slot && slot !== 'quest' && slot !== 'currency' && slot !== 'consumable') {
    html += `<div class="idd-slot">${slot}</div>`;
  }

  const hasStats = rolled && (
    Array.isArray(rolled.damage) || Array.isArray(rolled.defense) ||
    rolled.speed != null || rolled.scaling
  );
  if (hasStats) {
    html += '<hr class="idd-divider">';
    if (Array.isArray(rolled!.damage)) {
      html += `<div class="idd-row"><span class="lbl">Damage</span><span class="val">${rolled!.damage[0]}–${rolled!.damage[1]}</span></div>`;
    }
    if (Array.isArray(rolled!.defense)) {
      html += `<div class="idd-row"><span class="lbl">Defense</span><span class="val">${rolled!.defense[0]}–${rolled!.defense[1]}</span></div>`;
    }
    if (rolled!.speed != null) {
      html += `<div class="idd-row"><span class="lbl">Speed</span><span class="val">${(rolled!.speed as number).toFixed(2)}</span></div>`;
    }
    if (rolled!.scaling) {
      const scalingEntries = Object.entries(rolled!.scaling as Record<string, string>)
        .filter(([, v]) => v && v !== '-')
        .map(([k, v]) => `${k.slice(0, 3).toUpperCase()} ${v}`)
        .join('  ');
      if (scalingEntries) {
        html += `<div class="idd-row"><span class="lbl">Scaling</span><span class="val">${scalingEntries}</span></div>`;
      }
    }
    const SKIP = new Set(['damage', 'defense', 'speed', 'scaling']);
    for (const [k, v] of Object.entries(rolled!)) {
      if (SKIP.has(k) || v === null || v === undefined) continue;
      if (typeof v === 'number') {
        const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        html += `<div class="idd-row"><span class="lbl">${label}</span><span class="val bonus">+${v}</span></div>`;
      }
    }
  }

  // Projected character stat impact if equipped
  const s = state.self;
  if (s) {
    const eqSlot = (slot) as import('../../shared/types.ts').EquipSlot;
    const curDmg = effectiveDamageRange(s);
    const curDef = totalDefense(s);
    let newDmg: Range | null = null;
    let newDef: number | null = null;

    if (slot === 'mainhand' && Array.isArray(rolled?.damage)) {
      const stats = s.components?.stats || {};
      const base = rolled!.damage as Range;
      let bonus = 0;
      if (rolled!.scaling) {
        for (const [stat, letter] of Object.entries(rolled!.scaling as Record<string, string>)) {
          const c = SCALING_COEFFS[letter];
          if (c) bonus += ((stats as Record<string, unknown>)[stat] as number || 0) * c;
        }
      }
      const b = Math.round(bonus);
      newDmg = [base[0] + b, base[1] + b];
    }

    if ((ARMOR_SLOTS as readonly string[]).includes(slot) && Array.isArray(rolled?.defense)) {
      const curSlotDef = s.components?.equipment?.[eqSlot]?.item?.components?.equipment?.rolled?.defense;
      const curAvg = Array.isArray(curSlotDef) ? Math.round((curSlotDef[0] + curSlotDef[1]) / 2) : 0;
      const newAvg = Math.round((rolled!.defense[0] + rolled!.defense[1]) / 2);
      newDef = curDef - curAvg + newAvg;
    }

    const dmgChanged = newDmg && (newDmg[0] !== curDmg[0] || newDmg[1] !== curDmg[1]);
    const defChanged = newDef !== null && newDef !== curDef;

    if (dmgChanged || defChanged) {
      html += '<hr class="idd-divider">';
      html += '<div class="idd-compare-lbl">If Equipped</div>';
      if (dmgChanged) {
        const diff = (newDmg![0] + newDmg![1]) - (curDmg[0] + curDmg[1]);
        const cls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
        const sign = diff > 0 ? '+' : '';
        html += `<div class="idd-row"><span class="lbl">Damage</span><span class="val ${cls}">${curDmg[0]}–${curDmg[1]} → ${newDmg![0]}–${newDmg![1]} <span style="opacity:0.6;font-size:10px">(${sign}${diff})</span></span></div>`;
      }
      if (defChanged) {
        const diff = newDef! - curDef;
        const cls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
        const sign = diff > 0 ? '+' : '';
        html += `<div class="idd-row"><span class="lbl">Defense</span><span class="val ${cls}">${curDef} → ${newDef} <span style="opacity:0.6;font-size:10px">(${sign}${diff})</span></span></div>`;
      }
    }
  }

  if (stack.sell_value != null || slot !== 'quest') {
    const price = Math.max(1, stack.sell_value ?? 0);
    if (slot !== 'quest' && slot !== 'currency') {
      html += `<div class="idd-sell">Sell value: ${price}g</div>`;
    }
  }

  invDetail.innerHTML = html;
}

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
      if (eq?.item?.components?.equipment?.rarity) {
        label.style.color = rarityColor(eq.item.components.equipment.rarity as string);
      }
      const sub = document.createElement('div');
      sub.className = 'eq-slot-name';
      sub.textContent = slot;
      cell.appendChild(label);
      cell.appendChild(sub);
      if (eq) {
        cell.title = stackTooltip(eq);
        cell.addEventListener('click', () => state.sendUnequip?.(slot));
        cell.addEventListener('mouseenter', () => renderItemDetail(eq));
        cell.addEventListener('mouseleave', () => renderItemDetail(null));
      }
      invEquip.appendChild(cell);
    }
  }
  invSlots.innerHTML = '';
  for (let i = 0; i < inv.length; i++) {
    const cell = document.createElement('div');
    const stack = inv[i];
    const rarity = stack?.item?.components?.equipment?.rarity as string | undefined;
    cell.className = 'slot' + (stack ? ' filled' : ' empty') + (rarity ? ` rarity-${rarity}` : '');
    cell.textContent = stack ? (stack.name || stack.base || '?') : '·';
    if (stack && rarity) cell.style.color = rarityColor(rarity);
    cell.dataset.slot = String(i);
    if (stack) {
      cell.title = stackTooltip(stack);
      cell.addEventListener('mouseenter', () => renderItemDetail(stack));
      cell.addEventListener('mouseleave', () => renderItemDetail(null));
      if (stack.item_slot === 'consumable') {
        cell.addEventListener('click', async () => {
          const r = await state.sendUseItem(i);
          if (r.ok && r.healed && r.healed > 0) {
            state.pickupFloats.push({ kind: 'item', name: `+${r.healed} HP`, t: performance.now() });
          }
        });
      } else {
        cell.addEventListener('click', () => state.sendEquip?.(i));
      }
    }
    invSlots.appendChild(cell);
  }
}

function openInventory(): void { invBackdrop.classList.add('open'); renderItemDetail(null); renderInventory(); }
function closeInventory(): void { invBackdrop.classList.remove('open'); }
window.addEventListener('mmo:self', () => { if (invOpen()) { renderInventory(); renderCharSummary(); } });
window.addEventListener('mmo:zone', () => { if (invOpen()) renderInventory(); });

// ─── Trade modal ────────────────────────────────────────────────────────────

const BACKEND_URL = import.meta.env.VITE_SERVER_URL ?? '';

interface ShopItem { item: string; price: number; name: string; sprite: string }
let activeTradeMob: EntitySnapshot | null = null;
let tradeTab: 'buy' | 'sell' = 'buy';
let shopItems: ShopItem[] = [];
let pendingSell: { slotIndex: number; stack: InventoryStack } | null = null;

const TRADE_ERR_MSG: Record<string, string> = {
  insufficient_gold: 'Not enough gold.',
  inventory_full: 'Inventory full.',
  out_of_range: 'Too far away.',
  cannot_sell: 'Cannot sell quest or currency items.',
};

// ─── Loot panel ──────────────────────────────────────────────────────────────

let openCorpseId: string | null = null;

function lootOpen(): boolean { return lootBackdrop.classList.contains('open'); }
function closeLoot(): void { lootBackdrop.classList.remove('open'); openCorpseId = null; }

function renderLootBody(loot: LootSlot[]): void {
  lootBody.innerHTML = '';
  if (loot.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.45;font-size:12px;padding:8px 0';
    empty.textContent = 'Nothing left.';
    lootBody.appendChild(empty);
    lootAllBtn.disabled = true;
    return;
  }
  lootAllBtn.disabled = false;
  for (const slot of loot) {
    const row = document.createElement('div');
    row.className = 'loot-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'loot-item-name';
    nameEl.textContent = slot.gold > 0 ? `${slot.gold} Gold` : slot.name;
    if (slot.gold > 0) nameEl.style.color = '#ffd84a';
    else if (slot.item?.components?.equipment?.rarity)
      nameEl.style.color = rarityColor(slot.item.components.equipment.rarity as string);
    const btn = document.createElement('button');
    btn.textContent = 'Take';
    btn.addEventListener('click', async () => {
      if (!openCorpseId) return;
      const r = await state.sendLootCorpse(openCorpseId, slot.id);
      if (r.ok && r.self) state.self = r.self;
    });
    row.appendChild(nameEl);
    row.appendChild(btn);
    lootBody.appendChild(row);
  }
}

function openLoot(snap: EntitySnapshot): void {
  openCorpseId = snap.id;
  lootTitle.textContent = snap.name;
  renderLootBody(snap.loot ?? []);
  lootBackdrop.classList.add('open');
}

lootAllBtn.addEventListener('click', async () => {
  if (!openCorpseId) return;
  const r = await state.sendLootCorpse(openCorpseId, 'all');
  if (r.ok && r.self) state.self = r.self;
});
lootCloseBtn.addEventListener('click', closeLoot);

function signOpen(): boolean { return signBackdrop.classList.contains('open'); }
function closeSign(): void { signBackdrop.classList.remove('open'); }
function openSign(snap: EntitySnapshot): void {
  signTitle.textContent = snap.name;
  signBody.textContent = (snap.signText ?? []).join('\n');
  signBackdrop.classList.add('open');
}
signCloseBtn.addEventListener('click', closeSign);

// ─── Message board modal ──────────────────────────────────────────────────────

import type { BoardMessage } from './state.ts';

let activeBoardId: string | null = null;
let boardTab: 'read' | 'post' = 'read';

const BOARD_POST_ERR: Record<string, string> = {
  out_of_range: 'Move closer to post.',
  rate_limited: 'Wait a moment before posting again.',
  too_long: 'Message too long (max 200 characters).',
  empty: 'Message cannot be empty.',
};

function boardOpen(): boolean { return boardBackdrop.classList.contains('open'); }
function closeBoard(): void {
  boardBackdrop.classList.remove('open');
  activeBoardId = null;
  boardPostErr.textContent = '';
  boardTextarea.value = '';
  boardCharCount.textContent = '0 / 200';
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderBoardMessages(messages: BoardMessage[]): void {
  boardMsgsEl.innerHTML = '';
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.45;font-size:12px;padding:8px 0';
    empty.textContent = 'No messages yet. Be the first to post!';
    boardMsgsEl.appendChild(empty);
    return;
  }
  for (const msg of messages) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 0;border-bottom:1px solid #333';
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;opacity:0.55;margin-bottom:3px';
    header.textContent = `${msg.authorName} · ${timeAgo(msg.postedAt)}`;
    const body = document.createElement('div');
    body.style.cssText = 'font-size:13px;color:#ddd;word-break:break-word';
    body.textContent = msg.text;
    row.appendChild(header);
    row.appendChild(body);
    boardMsgsEl.appendChild(row);
  }
}

function switchBoardTab(tab: 'read' | 'post'): void {
  boardTab = tab;
  boardTabRead.classList.toggle('active', tab === 'read');
  boardTabPost.classList.toggle('active', tab === 'post');
  boardReadView.style.display = tab === 'read' ? '' : 'none';
  boardPostView.style.display = tab === 'post' ? '' : 'none';
  boardPostErr.textContent = '';
}

async function openBoard(snap: EntitySnapshot): Promise<void> {
  if (!snap.boardId) return;
  activeBoardId = snap.boardId;
  boardTitle.textContent = snap.name;
  boardMsgsEl.innerHTML = '<div style="opacity:0.45;font-size:12px;padding:8px 0">Loading…</div>';
  switchBoardTab('read');
  boardBackdrop.classList.add('open');
  const r = await state.sendReadBoard(snap.boardId);
  if (r.ok && r.messages) renderBoardMessages(r.messages);
}

boardTabRead.addEventListener('click', () => switchBoardTab('read'));
boardTabPost.addEventListener('click', () => switchBoardTab('post'));

boardTextarea.addEventListener('input', () => {
  boardCharCount.textContent = `${boardTextarea.value.length} / 200`;
});

boardPostBtn.addEventListener('click', async () => {
  if (!activeBoardId) return;
  const text = boardTextarea.value.trim();
  if (!text) { boardPostErr.textContent = 'Message cannot be empty.'; return; }
  boardPostBtn.disabled = true;
  boardPostErr.textContent = '';
  const r = await state.sendPostToBoard(activeBoardId, text);
  boardPostBtn.disabled = false;
  if (!r.ok) {
    boardPostErr.textContent = BOARD_POST_ERR[r.reason ?? ''] || r.reason || 'Post failed.';
    return;
  }
  boardTextarea.value = '';
  boardCharCount.textContent = '0 / 200';
  switchBoardTab('read');
  // Refresh messages
  const r2 = await state.sendReadBoard(activeBoardId);
  if (r2.ok && r2.messages) renderBoardMessages(r2.messages);
});

boardCloseBtn.addEventListener('click', closeBoard);

window.addEventListener('mmo:zone', () => {
  if (!lootOpen() || !openCorpseId) return;
  const corpse = state.zone?.entities.find((e) => e.id === openCorpseId);
  if (!corpse || corpse.type !== 'corpse') { closeLoot(); return; }
  renderLootBody(corpse.loot ?? []);
  if ((corpse.loot?.length ?? 0) === 0) closeLoot();
});

function tradeOpen(): boolean { return tradeBackdrop.classList.contains('open'); }

function closeTrade(): void {
  tradeBackdrop.classList.remove('open');
  activeTradeMob = null;
  pendingSell = null;
  tradeConfirm.innerHTML = '';
  tradeErr.textContent = '';
}

function appendTradeRow(
  label: string,
  priceText: string,
  priceClass: string,
  btnLabel: string,
  btnClass: string,
  disabled: boolean,
  onClick: () => void,
): void {
  const row = document.createElement('div');
  row.className = 'trade-row';
  const name = document.createElement('span');
  name.className = 'trade-row-name';
  name.textContent = label;
  const price = document.createElement('span');
  price.className = priceClass;
  price.textContent = priceText;
  const btn = document.createElement('button');
  btn.className = btnClass;
  btn.textContent = btnLabel;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  row.appendChild(name);
  row.appendChild(price);
  row.appendChild(btn);
  tradeList.appendChild(row);
}

function renderTrade(): void {
  const s = state.self;
  if (!s || !activeTradeMob) return;
  const gold = s.components?.wallet?.gold || 0;
  tradeGoldEl.textContent = String(gold);
  tradeList.innerHTML = '';
  tradeErr.textContent = '';

  if (tradeTab === 'buy') {
    if (shopItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'trade-empty';
      empty.textContent = 'Nothing for sale.';
      tradeList.appendChild(empty);
      return;
    }
    for (const si of shopItems) {
      appendTradeRow(si.name, `${si.price}g`, 'trade-row-price', 'Buy', 'trade-btn buy', gold < si.price, async () => {
        if (!activeTradeMob) return;
        const r = await state.sendTrade({ mobId: activeTradeMob.id, action: 'buy', itemBase: si.item });
        if (r.ok && r.self) { state.self = r.self; renderTrade(); }
        else tradeErr.textContent = TRADE_ERR_MSG[r.reason ?? ''] || r.reason || 'Trade failed.';
      });
    }
  } else {
    const inv = s.components?.inventory?.slots || [];
    const grid = document.createElement('div');
    grid.className = 'slot-grid';
    let hasItems = false;
    for (let i = 0; i < inv.length; i++) {
      const stack = inv[i];
      const rarity = stack?.item?.components?.equipment?.rarity as string | undefined;
      const unsellable = stack?.item_slot === 'quest' || stack?.item_slot === 'currency';
      const cell = document.createElement('div');
      cell.className = 'slot' + (stack ? (unsellable ? ' unsellable' : ' filled') : ' empty');
      if (rarity && !unsellable) cell.style.color = rarityColor(rarity);
      if (pendingSell?.slotIndex === i) cell.classList.add('selected');
      cell.textContent = stack ? (stack.name || stack.base || '?') : '·';
      if (stack && !unsellable) {
        hasItems = true;
        cell.addEventListener('click', () => {
          pendingSell = { slotIndex: i, stack };
          tradeErr.textContent = '';
          renderTrade();
        });
      }
      grid.appendChild(cell);
    }
    tradeList.appendChild(grid);
    if (!hasItems) {
      const empty = document.createElement('div');
      empty.className = 'trade-empty';
      empty.textContent = 'Nothing to sell.';
      tradeList.appendChild(empty);
    }

    tradeConfirm.innerHTML = '';
    if (pendingSell) {
      const { slotIndex, stack } = pendingSell;
      const price = Math.max(1, stack.sell_value ?? 0);
      const nameEl = document.createElement('div');
      nameEl.className = 'conf-item';
      nameEl.innerHTML = `Sell <b>${stack.name || stack.base || 'item'}</b> for <span class="conf-price">${price}g</span>?`;
      const actions = document.createElement('div');
      actions.className = 'conf-actions';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'trade-btn';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.addEventListener('click', async () => {
        if (!activeTradeMob || !pendingSell) return;
        const r = await state.sendTrade({ mobId: activeTradeMob.id, action: 'sell', slotIndex });
        if (r.ok && r.self) { state.self = r.self; pendingSell = null; tradeErr.textContent = ''; }
        else tradeErr.textContent = TRADE_ERR_MSG[r.reason ?? ''] || r.reason || 'Trade failed.';
        renderTrade();
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'trade-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => { pendingSell = null; tradeConfirm.innerHTML = ''; renderTrade(); });
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      tradeConfirm.appendChild(nameEl);
      tradeConfirm.appendChild(actions);
    }
  }
}

async function openTrade(snap: EntitySnapshot): Promise<void> {
  if (!snap.templateId) return;
  activeTradeMob = snap;
  tradeTab = 'buy';
  tradeTitle.textContent = snap.name;
  tradeErr.textContent = '';
  tradeList.innerHTML = '';
  tradeTabBuy.classList.add('active');
  tradeTabSell.classList.remove('active');
  tradeBackdrop.classList.add('open');
  try {
    const r = await fetch(`${BACKEND_URL}/api/shop/${snap.templateId}`);
    shopItems = r.ok ? ((await r.json()) as { items: ShopItem[] }).items : [];
  } catch { shopItems = []; }
  renderTrade();
}

tradeTabBuy.addEventListener('click', () => {
  tradeTab = 'buy';
  tradeTabBuy.classList.add('active');
  tradeTabSell.classList.remove('active');
  pendingSell = null;
  tradeConfirm.innerHTML = '';
  tradeErr.textContent = '';
  renderTrade();
});
tradeTabSell.addEventListener('click', () => {
  tradeTab = 'sell';
  tradeTabSell.classList.add('active');
  tradeTabBuy.classList.remove('active');
  pendingSell = null;
  tradeConfirm.innerHTML = '';
  tradeErr.textContent = '';
  renderTrade();
});

window.addEventListener('mmo:self', () => { if (tradeOpen()) renderTrade(); });

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
let repeatableGiverKeys = new Set<string>();
let talkTargetKeys = new Set<string>();

/** Returns the quest-giver key for a mob snapshot.
 *  Prefers spawnId when present (specific instance), falls back to templateId. */
function giverKey(snap: EntitySnapshot): string | null {
  if (snap.type !== 'mob') return null;
  return snap.spawnId ?? snap.templateId ?? null;
}

function isQuestLocked(questId: string, completed: Set<string>): boolean {
  const def = state.questDefs[questId];
  if (!def?.unlock_after) return false;
  const prereqs = Array.isArray(def.unlock_after) ? def.unlock_after : [def.unlock_after];
  return !prereqs.every((id) => completed.has(id));
}

function rebuildQuestInteractionCaches(): void {
  const accepted = new Set(state.quests.active.map((q) => q.questId));
  const completed = new Set(state.quests.completed);
  questgiverKeys = new Set();
  repeatableGiverKeys = new Set();
  for (const [key, ids] of Object.entries(state.questsByGiver)) {
    const hasNonRepeatable = ids.some((id) => {
      const def = state.questDefs[id];
      return !def?.repeatable && !accepted.has(id) && !completed.has(id) && !isQuestLocked(id, completed);
    });
    const hasRepeatable = ids.some((id) => {
      const def = state.questDefs[id];
      return !!def?.repeatable && !accepted.has(id) && !isQuestLocked(id, completed);
    });
    if (hasNonRepeatable) {
      questgiverKeys.add(key);
    } else if (hasRepeatable) {
      repeatableGiverKeys.add(key);
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
  if (k && questgiverKeys.has(k)) return true;
  return snap.templateId != null && questgiverKeys.has(snap.templateId);
}

function isRepeatableQuestgiver(snap: EntitySnapshot): boolean {
  const k = giverKey(snap);
  if (k && repeatableGiverKeys.has(k)) return true;
  return snap.templateId != null && repeatableGiverKeys.has(snap.templateId);
}

function isTalkTarget(snap: EntitySnapshot): boolean {
  if (snap.type !== 'mob') return false;
  return (snap.templateId != null && talkTargetKeys.has(snap.templateId))
      || (snap.spawnId   != null && talkTargetKeys.has(snap.spawnId));
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
  clickedSpawnId?: string,
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
    const talkTarget = obj?.kind === 'talk'
      ? (obj.target_template === clickedSpawnId ? clickedSpawnId : clickedTemplate)
      : undefined;
    if (obj?.kind === 'talk' && (obj.target_template === clickedTemplate || obj.target_template === clickedSpawnId)) {
      const report = document.createElement('button');
      report.className = 'primary';
      report.textContent = 'Report';
      report.addEventListener('click', async () => {
        const r = await state.sendQuestAction(def.id, 'talk', talkTarget);
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

  // questsByGiver is keyed by templateId; giverKey() may return spawnId, so check both.
  const offered = state.questsByGiver[key] ?? state.questsByGiver[snap.templateId ?? ''] ?? [];

  const active = new Set(state.quests.active.map((q) => q.questId));
  const completed = new Set(state.quests.completed);

  // Build the full queue: quests offered by this NPC plus active quests
  // with a talk objective targeting this NPC (inter-NPC handoffs).
  const queue = new Set(offered);
  for (const entry of state.quests.active) {
    const def = state.questDefs[entry.questId];
    if (!def) continue;
    const stage = def.stages?.find((s) => s.id === entry.stage);
    const obj = stage?.objective ?? (def.giver ? { kind: 'talk' as const, target_template: def.giver } : null);
    if (obj?.kind === 'talk' && (obj.target_template === key || obj.target_template === snap.templateId)) {
      queue.add(entry.questId);
    }
  }

  if (queue.size === 0) {
    const speech = state.speech.get(snap.id);
    const hint = document.createElement('div');
    hint.className = 'quest-desc';
    hint.textContent = speech?.text || `${snap.name} has nothing for you right now.`;
    qgBody.appendChild(hint);
    qgBackdrop.classList.add('open');
    return;
  }

  for (const qid of queue) {
    const def = state.questDefs[qid];
    if (!def) continue;
    if (!active.has(qid) && !completed.has(qid) && isQuestLocked(qid, completed)) continue;
    const st = active.has(qid) ? 'active' : completed.has(qid) ? 'completed' : 'available';
    qgBody.appendChild(questgiverBlock(def, st, snap.templateId ?? key, snap.spawnId));
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

const questTrackerEl = document.getElementById('quest-tracker')!;

function renderQuestTracker(): void {
  questTrackerEl.innerHTML = '';
  const active = state.quests?.active ?? [];
  if (active.length === 0) return;
  const header = document.createElement('div');
  header.className = 'qt-header';
  header.textContent = 'Active Quests';
  questTrackerEl.appendChild(header);
  const shown = active.slice(0, 3);
  for (const entry of shown) {
    const def = state.questDefs[entry.questId];
    const wrap = document.createElement('div');
    wrap.className = 'qt-entry';
    const name = document.createElement('div');
    name.className = 'qt-name';
    name.textContent = def?.name || entry.questId;
    wrap.appendChild(name);
    const stageDef = def?.stages?.find((s) => s.id === entry.stage);
    const isReturnStage = stageDef && !stageDef.objective;
    const isTalkStage = stageDef?.objective?.kind === 'talk';
    if (stageDef?.text) {
      const stageEl = document.createElement('div');
      stageEl.className = 'qt-stage';
      const txt = stageDef.text.trim();
      stageEl.textContent = txt.length > 70 ? txt.slice(0, 67) + '…' : txt;
      wrap.appendChild(stageEl);
    }
    if (def) {
      const prog = progressText(def);
      if (prog) {
        const progEl = document.createElement('div');
        progEl.className = 'qt-progress';
        progEl.textContent = prog;
        wrap.appendChild(progEl);
      }
    }
    if (isReturnStage || isTalkStage) {
      const returnEl = document.createElement('div');
      returnEl.className = 'qt-return';
      returnEl.textContent = '↩ Return to NPC';
      wrap.appendChild(returnEl);
    }
    questTrackerEl.appendChild(wrap);
  }
  if (active.length > 3) {
    const more = document.createElement('div');
    more.className = 'qt-more';
    more.textContent = `+${active.length - 3} more — press Q`;
    questTrackerEl.appendChild(more);
  }
}

window.addEventListener('mmo:quests', () => {
  rebuildQuestInteractionCaches();
  renderQuestTracker();
  if (qlOpen()) renderQuestlog();
});
window.addEventListener('mmo:ready', () => {
  rebuildQuestInteractionCaches();
  renderQuestTracker();
});

// ---------------------------------------------------------------------------
// Hotbar
// ---------------------------------------------------------------------------

function findFirstConsumable(): { slot: number; stack: InventoryStack } | null {
  const slots = state.self?.components?.inventory?.slots;
  if (!slots) return null;
  for (let i = 0; i < slots.length; i++) {
    const stack = slots[i];
    if (stack && stack.item_slot === 'consumable') return { slot: i, stack };
  }
  return null;
}

function updateHotbar(): void {
  if (!state.self) { hotbar.classList.remove('visible'); return; }
  hotbar.classList.add('visible');
  const now = performance.now();

  // Attack cooldown overlay shrinks from top as cooldown expires
  const atkElapsed = now - lastAttackAt;
  const atkCd = attackCooldownMs();
  const atkFraction = atkElapsed < atkCd ? (atkCd - atkElapsed) / atkCd : 0;
  hbAttackCd.style.transform = `scaleY(${atkFraction.toFixed(3)})`;

  // Potion slot: reflect first consumable in inventory
  const consumable = findFirstConsumable();
  if (consumable) {
    hbPotion.classList.remove('empty');
    hbPotionLabel.textContent = consumable.stack.name || 'Potion';
  } else {
    hbPotion.classList.add('empty');
    hbPotionLabel.textContent = '—';
  }

  // Potion cooldown overlay
  const potionFraction = now < potionCooldownUntil
    ? (potionCooldownUntil - now) / POTION_COOLDOWN_MS : 0;
  hbPotionCd.style.transform = `scaleY(${potionFraction.toFixed(3)})`;
}

hbAttack.addEventListener('click', () => {
  if (!state.self) return;
  const now = performance.now();
  if (now - lastAttackAt < attackCooldownMs()) return;
  lastAttackAt = now;
  cancelAutopath();
  state.sendAttack?.();
});

hbPotion.addEventListener('click', () => {
  const consumable = findFirstConsumable();
  if (!consumable) return;
  const now = performance.now();
  if (now < potionCooldownUntil) return;
  potionCooldownUntil = now + POTION_COOLDOWN_MS;
  void state.sendUseItem?.(consumable.slot);
});

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
  const rank = (e: EntitySnapshot) =>
    (e.type === 'ground_item' || e.type === 'corpse') ? 0 : e.type === 'player' ? 2 : 1;
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
  if (snap.type === 'ground_item' && snap.item?.components?.equipment?.rarity) {
    name.style.color = rarityColor(snap.item.components.equipment.rarity as string);
  }
  tooltipEl.appendChild(name);
  if (snap.type === 'mob' && snap.level != null && !snap.fixture) {
    const lvl = document.createElement('div');
    lvl.className = 'tt-level';
    lvl.textContent = `Level ${snap.level}`;
    tooltipEl.appendChild(lvl);
  }
  const hp = (snap.components as { health?: { current: number; max: number } } | undefined)?.health;
  if (hp && typeof hp.current === 'number' && typeof hp.max === 'number' && !snap.fixture) {
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
  if (isTalkTarget(snap)) {
    const q = document.createElement('div');
    q.className = 'tt-quest';
    q.style.color = '#7acdf5';
    q.textContent = '? Quest return';
    tooltipEl.appendChild(q);
  } else if (isQuestgiver(snap)) {
    const q = document.createElement('div');
    q.className = 'tt-quest';
    q.textContent = '! Has a quest';
    tooltipEl.appendChild(q);
  }
  if (snap.hasShop) {
    const shopEl = document.createElement('div');
    shopEl.className = 'tt-quest';
    shopEl.style.color = '#ffd84a';
    shopEl.textContent = '$ Shop';
    tooltipEl.appendChild(shopEl);
  }
  if (snap.type === 'corpse') {
    const hasLoot = (snap.loot?.length ?? 0) > 0;
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = hasLoot ? 'Click to loot' : 'Empty';
    tooltipEl.appendChild(hint);
  } else if (snap.signText?.length) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = 'Click to read';
    tooltipEl.appendChild(hint);
  } else if (snap.boardId) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = 'Click to read & post';
    tooltipEl.appendChild(hint);
  } else if (snap.hasShop || hasQuestInteraction(snap)) {
    const hint = document.createElement('div');
    hint.className = 'tt-hint';
    hint.textContent = snap.hasShop && !hasQuestInteraction(snap) ? 'Click to trade' : 'Click to talk';
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
  return isQuestgiver(snap) || isRepeatableQuestgiver(snap) || isTalkTarget(snap);
}

// ─── Click-to-walk ────────────────────────────────────────────────────────

interface PathStep { x: number; y: number }
let autopathDest: PathStep | null = null;

function cancelAutopath(): void { autopathDest = null; }

function isWalkable(tx: number, ty: number): boolean {
  const z = state.zone;
  if (!z) return false;
  if (tx < 0 || ty < 0 || tx >= z.width || ty >= z.height) return false;
  return !BLOCKING_TILES.has(z.grid[ty]![tx]!);
}

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

const MOB_POKE_COOLDOWN_MS = 5000;
const mobPokeLastAt = new Map<string, number>();

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
  if (entity && entity.hasShop
      && chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
    void openTrade(entity);
    return;
  }
  if (entity && entity.type === 'corpse') {
    if ((entity.loot?.length ?? 0) === 0) return;
    if (chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
      openLoot(entity);
      return;
    }
    // Autopath toward corpse, open loot when close enough
    const dest = nearestWalkable(tile.x, tile.y);
    if (dest && (dest.x !== self.position.x || dest.y !== self.position.y)) {
      autopathDest = dest;
      state.sendAutopath(dest.x, dest.y);
    }
    return;
  }
  if (entity && entity.signText?.length) {
    openSign(entity);
    return;
  }
  if (entity && entity.boardId) {
    void openBoard(entity);
    return;
  }
  if (entity && entity.type === 'mob'
      && chebyshev(self.position.x, self.position.y, entity.position.x, entity.position.y) <= TALK_RANGE) {
    const now = Date.now();
    const last = mobPokeLastAt.get(entity.id) ?? 0;
    if (now - last >= MOB_POKE_COOLDOWN_MS) {
      mobPokeLastAt.set(entity.id, now);
      state.sendPokeMob(entity.id);
    }
    return;
  }
  const targetsMob = entity?.type === 'mob' && !entity.fixture;
  const dest = targetsMob
    ? nearestWalkable(tile.x, tile.y, { excludeSelf: true })
    : nearestWalkable(tile.x, tile.y);
  if (!dest) return;
  if (dest.x === self.position.x && dest.y === self.position.y) return;
  autopathDest = dest;
  state.sendAutopath(dest.x, dest.y);
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
// Matches server PLAYER_BASE_ACT_TICKS = 10 ticks xc3x97 100ms xe2x80x94 same rate as a speed-1 mob.
const ATTACK_COOLDOWN_MS = 1000;
function attackCooldownMs(): number { return ATTACK_COOLDOWN_MS; }
let lastAttackAt = 0;
const POTION_COOLDOWN_MS = 3000;
let potionCooldownUntil = 0;
const FLOAT_TTL_MS = 900;
const RESPAWN_DELAY_MS = 10_000;
const XP_FLOAT_TTL_MS = 1400;
const LEVEL_UP_TTL_MS = 1800;
const SPEECH_TTL_MS = 4500;
const CHAT_LOG_TTL_MS = 12000;
const ZONE_BANNER_TTL_MS = 2500;

const xpForNext = (level: number) => level * 100;

function chatFocused(): boolean { return document.activeElement === chatInput; }
function anyInputFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
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

const gameMenuBackdrop2 = document.getElementById('gamemenu-backdrop')!;
function menuOpen(): boolean { return gameMenuBackdrop2.classList.contains('open'); }
function openMenu(): void { gameMenuBackdrop2.classList.add('open'); }
function closeMenu(): void { gameMenuBackdrop2.classList.remove('open'); }

window.addEventListener('mmo:self', renderCharSheet);
window.addEventListener('mmo:zone', () => { if (sheetOpen()) renderCharSheet(); });

// Dismiss any modal by clicking the backdrop outside the modal box.
(function wireBackdropDismiss() {
  function onOutside(backdrop: HTMLElement, close: () => void) {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  }
  onOutside(sheetBackdrop,                                     closeSheet);
  onOutside(invBackdrop,                                       closeInventory);
  onOutside(lootBackdrop,                                      closeLoot);
  onOutside(signBackdrop,                                      closeSign);
  onOutside(boardBackdrop,                                     closeBoard);
  onOutside(tradeBackdrop,                                     closeTrade);
  onOutside(document.getElementById('questgiver-backdrop')!,  closeQuestgiver);
  onOutside(document.getElementById('questlog-backdrop')!,    closeQuestlog);
  onOutside(gameMenuBackdrop2,                                 closeMenu);
  // Login modal — just hide, no extra state to clear.
  const loginBd = document.getElementById('login-backdrop')!;
  loginBd.addEventListener('click', (e) => { if (e.target === loginBd) loginBd.classList.remove('open'); });
})();

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
    if (menuOpen()) { closeMenu(); e.preventDefault(); return; }
    if (qgOpen()) { closeQuestgiver(); e.preventDefault(); return; }
    if (qlOpen()) { closeQuestlog(); e.preventDefault(); return; }
    if (sheetOpen()) { closeSheet(); e.preventDefault(); return; }
    if (invOpen()) { closeInventory(); e.preventDefault(); return; }
    if (tradeOpen()) { closeTrade(); e.preventDefault(); return; }
    if (lootOpen()) { closeLoot(); e.preventDefault(); return; }
    if (signOpen()) { closeSign(); e.preventDefault(); return; }
    if (boardOpen()) { closeBoard(); e.preventDefault(); return; }
  }
  if (chatFocused()) return;
  if (anyInputFocused()) return;
  if (state.died) return;

  if (e.key === 'm' || e.key === 'M') {
    if (menuOpen()) closeMenu(); else openMenu();
    e.preventDefault();
    return;
  }
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
  if (e.key === 'f' || e.key === 'F') {
    if (anyInputFocused()) return;
    const consumable = findFirstConsumable();
    if (!consumable) { e.preventDefault(); return; }
    const now = performance.now();
    if (now < potionCooldownUntil) { e.preventDefault(); return; }
    potionCooldownUntil = now + POTION_COOLDOWN_MS;
    void state.sendUseItem?.(consumable.slot);
    e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    const now = performance.now();
    if (now - lastAttackAt < attackCooldownMs()) { e.preventDefault(); return; }
    lastAttackAt = now;
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

const CHAT_CHANNEL_PREFIX: Record<string, { label: string; color: string }> = {
  global:  { label: '[G] ', color: '#ffd84a' },
  whisper: { label: '[PM] ', color: '#cc88ff' },
  system:  { label: '[!] ', color: '#ff4444' },
};

function renderChatLog(): void {
  const now = performance.now();
  const visible = state.chatLog.filter(c => now - c.recvAt < CHAT_LOG_TTL_MS);
  chatLog.innerHTML = '';
  for (const c of visible.slice(-8)) {
    const line = document.createElement('div');
    line.className = 'chat-line';

    const isSystem = c.channel === 'system';
    const channel = c.channel && CHAT_CHANNEL_PREFIX[c.channel];
    if (channel) {
      const prefix = document.createElement('span');
      prefix.style.color = channel.color;
      prefix.textContent = channel.label;
      line.appendChild(prefix);
    }

    if (!isSystem) {
      const name = document.createElement('span');
      name.className = 'chat-name' + (c.from.id === state.entityId ? ' self' : '');
      if (channel) name.style.color = channel.color;
      name.textContent = c.from.name + ': ';
      line.appendChild(name);
    }

    const txt = document.createElement('span');
    if (channel) txt.style.color = channel.color;
    txt.textContent = c.text;
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

function drawEntity(px: number, py: number, color: string, scale?: number): void {
  const size = scale != null ? Math.round(TILE * scale) : TILE - 8;
  const margin = Math.floor((TILE - size) / 2);
  ctx.fillStyle = color;
  ctx.fillRect(px + margin, py + margin, size, size);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + margin + 0.5, py + margin + 0.5, size - 1, size - 1);
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

function drawCorpse(px: number, py: number, alpha: number): void {
  const cx = px + TILE / 2;
  const cy = py + TILE / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#8a7a6a';
  ctx.fillRect(cx - 7, cy - 2, 14, 4);
  ctx.fillRect(cx - 2, cy - 7, 4, 14);
  ctx.strokeStyle = '#2a1a0a';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(cx - 7, cy - 2, 14, 4);
  ctx.strokeRect(cx - 2, cy - 7, 4, 14);
  ctx.restore();
}

// Floating "!" above quest-giver heads. Pulses very gently so it reads as
// interactive without being a distraction.
function drawQuestMarker(cx: number, cy: number, color = '#ffd84a'): void {
  const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 220);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = color;
  ctx.strokeText('!', 0, 0);
  ctx.fillText('!', 0, 0);
  ctx.restore();
}

// Floating "?" above mobs that have an active talk-return objective.
function drawTalkMarker(cx: number, cy: number): void {
  const pulse = 0.88 + 0.12 * Math.sin(performance.now() / 280);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#7acdf5';
  ctx.strokeText('?', 0, 0);
  ctx.fillText('?', 0, 0);
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

const DAY_KEYFRAMES: [number, number, number, number, number][] = [
  // [timeOfDay, r, g, b, alpha]
  [0.00,  5, 15, 55, 0.40],  // midnight
  [0.20,  5, 15, 55, 0.30],  // pre-dawn
  [0.25, 80, 38, 10, 0.10],  // dawn
  [0.38, 80, 38, 10, 0.00],  // morning
  [0.62, 80, 38, 10, 0.00],  // afternoon
  [0.75, 80, 38, 10, 0.10],  // dusk
  [0.80,  5, 15, 55, 0.30],  // post-dusk
  [1.00,  5, 15, 55, 0.40],  // midnight again
];

function nightOverlayStyle(t: number): string | null {
  for (let i = 0; i < DAY_KEYFRAMES.length - 1; i++) {
    const [t0, r0, g0, b0, a0] = DAY_KEYFRAMES[i]!;
    const [t1, r1, g1, b1, a1] = DAY_KEYFRAMES[i + 1]!;
    if (t >= t0 && t <= t1) {
      const p = (t - t0) / (t1 - t0);
      const lerp = (a: number, b: number) => a + (b - a) * p;
      const a = lerp(a0, a1);
      if (a < 0.005) return null;
      return `rgba(${Math.round(lerp(r0, r1))},${Math.round(lerp(g0, g1))},${Math.round(lerp(b0, b1))},${a.toFixed(3)})`;
    }
  }
  return null;
}

// Erases a radial area from the darkness canvas so underlying tiles show through.
// Soft falloff starts at 50% of radius.
function punchLight(dCtx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  const grad = dCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0,   'rgba(0,0,0,1)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.9)');
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  dCtx.fillStyle = grad;
  dCtx.beginPath();
  dCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  dCtx.fill();
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
    state._tileColors = buildTileColorMap(ts);
    state._spriteColors = buildSpriteColorMap(ts);
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

  const rankOf = (e: typeof entities[number]) =>
    (e.type === 'ground_item' || e.type === 'corpse') ? 0 : e.type === 'player' ? 2 : 1;
  const ordered = [...entities].sort((a, b) => rankOf(a) - rankOf(b));
  for (const e of ordered) {
    const sprite = e.sprite || (e.type === 'player' ? 'player' : null);
    const color = e.color || (sprite && spriteColors[sprite]) || '#ffffff';
    const px = e.position.x * TILE + offsetX;
    const py = e.position.y * TILE + offsetY;
    if (e.type === 'ground_item') {
      drawGroundItem(px, py, color);
    } else if (e.type === 'corpse') {
      const hasLoot = (e.loot?.length ?? 0) > 0;
      if (!hasLoot) {
        if (!corpseEmptiedAt.has(e.id)) corpseEmptiedAt.set(e.id, Date.now());
        const elapsed = Date.now() - corpseEmptiedAt.get(e.id)!;
        drawCorpse(px, py, Math.max(0.15, 1 - elapsed / 10_000));
      } else {
        corpseEmptiedAt.delete(e.id);
        drawCorpse(px, py, 1.0);
      }
    } else {
      drawEntity(px, py, color, (e as { drawScale?: number }).drawScale);
      const hp = (e.components as { health?: { current: number; max: number } })?.health;
      if (hp && !e.fixture) drawHpBar(px, py, hp.current, hp.max);
    }
    if (e.type === 'mob') {
      if (isTalkTarget(e)) drawTalkMarker(px + TILE / 2, py - 10);
      else if (isQuestgiver(e)) drawQuestMarker(px + TILE / 2, py - 10);
      else if (isRepeatableQuestgiver(e)) drawQuestMarker(px + TILE / 2, py - 10, '#7acdf5');
    }
  }

  // Day / night overlay with radial light cutouts.
  const nightStyle = nightOverlayStyle(state.zone.timeOfDay ?? 0.5);
  if (nightStyle) {
    if (darknessCanvas.width !== canvas.width || darknessCanvas.height !== canvas.height) {
      darknessCanvas.width = canvas.width;
      darknessCanvas.height = canvas.height;
    }
    darknessCtx.clearRect(0, 0, darknessCanvas.width, darknessCanvas.height);
    darknessCtx.fillStyle = nightStyle;
    darknessCtx.fillRect(0, 0, darknessCanvas.width, darknessCanvas.height);

    darknessCtx.globalCompositeOperation = 'destination-out';
    // Player always carries a small personal light so they stay visible.
    if (self) {
      punchLight(
        darknessCtx,
        self.position.x * TILE + offsetX + TILE / 2,
        self.position.y * TILE + offsetY + TILE / 2,
        3 * TILE,
      );
    }
    // World light sources (torches, bonfires, etc. with lightRadius set).
    for (const e of entities) {
      const lr = (e as { lightRadius?: number }).lightRadius;
      if (!lr) continue;
      punchLight(
        darknessCtx,
        e.position.x * TILE + offsetX + TILE / 2,
        e.position.y * TILE + offsetY + TILE / 2,
        lr * TILE,
      );
    }
    darknessCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(darknessCanvas, 0, 0);

    // Warm glow halos on top of the darkness — visible even at the edge of light pools.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of entities) {
      const lr = (e as { lightRadius?: number }).lightRadius;
      if (!lr) continue;
      const gcx = e.position.x * TILE + offsetX + TILE / 2;
      const gcy = e.position.y * TILE + offsetY + TILE / 2;
      const gr = lr * TILE * 1.4;
      const gg = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, gr);
      gg.addColorStop(0,    'rgba(255, 150, 30, 0.14)');
      gg.addColorStop(0.35, 'rgba(255, 120, 10, 0.07)');
      gg.addColorStop(1,    'rgba(255,  80,  0, 0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(gcx, gcy, gr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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

  if (autopathDest) {
    const self = state.self;
    if (self && self.position.x === autopathDest.x && self.position.y === autopathDest.y) {
      autopathDest = null;
    } else {
      const cx = autopathDest.x * TILE + offsetX + TILE / 2;
      const cy = autopathDest.y * TILE + offsetY + TILE / 2;
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 180);
      ctx.save();
      ctx.strokeStyle = `rgba(255, 216, 74, ${pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
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
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    const padX = 6, padY = 4, lineH = 14, maxTextW = 130;
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxTextW && cur) { lines.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + padX * 2;
    const h = lines.length * lineH + padY * 2;
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
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, cx, by + padY + (i + 1) * lineH - 2);
    }
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

  const QUEST_COMPLETE_TTL_MS = 3200;
  state.questCompletions = state.questCompletions.filter((q) => now - q.t < QUEST_COMPLETE_TTL_MS);
  if (state.questCompletions.length > 0) {
    const q = state.questCompletions[0]!;
    const age = now - q.t;
    const t = age / QUEST_COMPLETE_TTL_MS;
    const alpha = t < 0.1 ? t / 0.1 : t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
    const y = canvas.height * 0.26;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.font = 'bold 22px monospace';
    ctx.fillStyle = '#ffd84a';
    ctx.strokeText('Quest Complete!', canvas.width / 2, y);
    ctx.fillText('Quest Complete!', canvas.width / 2, y);
    ctx.font = '14px monospace';
    ctx.fillStyle = '#ddd';
    ctx.strokeText(q.name, canvas.width / 2, y + 26);
    ctx.fillText(q.name, canvas.width / 2, y + 26);
    ctx.globalAlpha = 1;
  }

  const QUEST_STAGE_TTL_MS = 6000;
  state.questStageAdvances = state.questStageAdvances.filter((s) => now - s.t < QUEST_STAGE_TTL_MS);
  if (state.questStageAdvances.length > 0 && state.questCompletions.length === 0) {
    const s = state.questStageAdvances[0]!;
    const age = now - s.t;
    const t = age / QUEST_STAGE_TTL_MS;
    const alpha = t < 0.1 ? t / 0.1 : t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    const def = state.questDefs[s.questId];
    const stageDef = def?.stages?.find((st) => st.id === s.stage);
    const y = canvas.height * 0.26;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = '#7acdf5';
    ctx.strokeText('Objective complete!', canvas.width / 2, y);
    ctx.fillText('Objective complete!', canvas.width / 2, y);
    if (stageDef?.text) {
      ctx.font = '13px monospace';
      ctx.fillStyle = '#bbb';
      const txt = stageDef.text.trim().replace(/\s+/g, ' ');
      const line = txt.length > 60 ? txt.slice(0, 57) + '…' : txt;
      ctx.strokeText(line, canvas.width / 2, y + 24);
      ctx.fillText(line, canvas.width / 2, y + 24);
    }
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

  if (state.died && state.diedAt) {
    const elapsed = now - state.diedAt;
    if (elapsed > RESPAWN_DELAY_MS + 5000) {
      state.died = false;
    } else {
      const remaining = Math.max(0, RESPAWN_DELAY_MS - elapsed);
      const secs = Math.ceil(remaining / 1000);
      ctx.fillStyle = 'rgba(80, 0, 0, 0.7)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 48px monospace';
      ctx.fillStyle = '#ffdddd';
      ctx.textAlign = 'center';
      ctx.fillText('You died', canvas.width / 2, canvas.height / 2 - 30);
      ctx.font = 'bold 24px monospace';
      ctx.fillText(`Respawning in ${secs}...`, canvas.width / 2, canvas.height / 2 + 20);
    }
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
    ? `${nameText}zone: ${state.zone!.id}  pos: (${self.position.x},${self.position.y})  ${hpText}  ${lvlText}${goldText}${ptsText}  [WASD · Space·F · C · I · Q · Enter chat  /g global  /w name pm]`
    : 'connected, waiting for state…';

  updateHotbar();
  requestAnimationFrame(render);
}

render();
