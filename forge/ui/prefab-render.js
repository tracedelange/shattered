// Prefab grid renderer for the factory preview. Implements the renderer track of
// the staged pipeline: clean geometry lives in the grid (floor/wall/door/anchors),
// and "ruin" lives HERE as render-time atmosphere — wall autotiling, per-cell
// floor variants, and theme-driven decoration overlays (rubble/moss/water/cracks).
// This is why the legend stays lean and the builder no longer needs a contrast
// directive: structure reads from autotiling, not from tile choice.
(function () {
  function hexToRgb(h) {
    h = (h || '#888888').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  // amt in [-1,1]: negative → toward black, positive → toward white.
  function shade(hex, amt) {
    const c = hexToRgb(hex);
    const target = amt < 0 ? 0 : 255;
    const p = Math.min(1, Math.abs(amt));
    const m = (v) => Math.round(v + (target - v) * p);
    return `rgb(${m(c.r)},${m(c.g)},${m(c.b)})`;
  }
  // Stable per-cell pseudo-random in [0,1) — so overlays don't shimmer per render.
  function hash(x, y, seed) {
    let n = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
    n = (n ^ (n >>> 13)) >>> 0;
    return (n % 100000) / 100000;
  }

  function pickFloorColor(tileColors) {
    if (tileColors['stone_floor']) return tileColors['stone_floor'];
    const k = Object.keys(tileColors).find((t) => !/wall|void|water/.test(t));
    return (k && tileColors[k]) || '#8a8a86';
  }

  function speck(ctx, px, py, cell, r, color, scale) {
    const s = Math.max(1, cell * 0.08 * scale);
    const ox = px + (0.2 + 0.6 * r) * cell;
    const oy = py + (0.2 + 0.6 * ((r * 7.13) % 1)) * cell;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ox, oy, s, 0, Math.PI * 2);
    ctx.fill();
  }

  function crackLine(ctx, px, py, cell, r) {
    ctx.strokeStyle = 'rgba(18,16,14,0.55)';
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.beginPath();
    ctx.moveTo(px + r * cell, py);
    ctx.lineTo(px + ((r * 3.3) % 1) * cell, py + cell);
    ctx.stroke();
  }

  const ANCHOR_COLORS = {
    descend: '#9a5cff', ascend: '#9a5cff', loot: '#e8b53a',
    boss: '#e0503a', npc: '#3ac8c8', entrance: '#5ac86a',
  };

  function drawAnchor(ctx, px, py, cell, tag) {
    const cx = px + cell / 2;
    const cy = py + cell / 2;
    const R = cell * 0.3;
    const col = ANCHOR_COLORS[tag] || '#ffffff';
    if (tag === 'loot') {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R, cy); ctx.lineTo(cx, cy + R); ctx.lineTo(cx - R, cy);
      ctx.closePath(); ctx.fill();
    } else if (tag === 'descend' || tag === 'ascend') {
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, R * 1.5);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(154,92,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2); ctx.fill();
    } else if (tag === 'boss') {
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, cell * 0.12);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, R * 0.7, 0, Math.PI * 2); ctx.fill();
    }
  }

  function render(canvas, prefab, opts) {
    opts = opts || {};
    const tileColors = opts.tileColors || {};
    const blocking = opts.blocking || new Set();
    const theme = (opts.theme || '').toLowerCase();
    const seed = opts.seed || 1;

    const rows = (prefab.data || '').replace(/\r/g, '').replace(/\n+$/, '').split('\n');
    const h = rows.length;
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const legend = prefab.legend || {};
    const anchors = prefab.anchors || {};
    const cell = Math.max(8, Math.min(36, Math.floor(360 / Math.max(w, h, 1))));
    canvas.width = w * cell;
    canvas.height = h * cell;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const floorBase = pickFloorColor(tileColors);
    const wallBase = tileColors['wall'] || '#3a2a1a';
    const roleAt = (x, y) => {
      const ch = (rows[y] || '')[x] || ' ';
      if (ch === ' ') return { role: 'void' };
      const tile = legend[ch];
      if (!tile) return { role: 'void' };
      if (blocking.has(tile)) return { role: 'wall', tile };
      return { role: 'floor', tile };
    };
    const isWall = (x, y) => roleAt(x, y).role === 'wall';

    // PASS 1 — floor with per-cell variant (void stays transparent).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = roleAt(x, y);
        if (c.role !== 'floor') continue;
        const base = (c.tile && tileColors[c.tile]) || floorBase;
        ctx.fillStyle = shade(base, (hash(x, y, seed) - 0.5) * 0.16);
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    // PASS 2 — walls with autotiled edges: a lit cap where open above, shadow
    // seams where they meet floor → the wall mass reads as raised, not flat.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = roleAt(x, y);
        if (c.role !== 'wall') continue;
        const base = (c.tile && tileColors[c.tile]) || wallBase;
        ctx.fillStyle = base;
        ctx.fillRect(x * cell, y * cell, cell, cell);
        const cap = Math.max(2, cell * 0.18);
        const seam = Math.max(1, cell * 0.12);
        if (!isWall(x, y - 1)) { ctx.fillStyle = shade(base, 0.2); ctx.fillRect(x * cell, y * cell, cell, cap); }
        if (!isWall(x, y + 1)) { ctx.fillStyle = shade(base, -0.4); ctx.fillRect(x * cell, (y + 1) * cell - seam, cell, seam); }
        if (!isWall(x - 1, y)) { ctx.fillStyle = shade(base, -0.18); ctx.fillRect(x * cell, y * cell, seam, cell); }
        if (!isWall(x + 1, y)) { ctx.fillStyle = shade(base, -0.18); ctx.fillRect((x + 1) * cell - seam, y * cell, seam, cell); }
      }
    }

    // PASS 3 — theme overlays (cosmetic ruin), seeded so they're stable.
    const wants = {
      rubble: /ruin|rubble|crumbl|broken|collaps|derelict|abandon/.test(theme),
      moss: /moss|overgrow|verdant|jungle|forest|vine/.test(theme),
      water: /flood|water|sunken|swamp|drown|damp/.test(theme),
      crack: /crack|fractur|shatter|split/.test(theme),
      ash: /scorch|burn|ash|char|ember|smold/.test(theme),
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roleAt(x, y).role !== 'floor') continue;
        const px = x * cell;
        const py = y * cell;
        const nearWall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isWall(x + dx, y + dy));
        if (wants.water && hash(x, y, seed + 5) < 0.55) { ctx.fillStyle = 'rgba(58,108,168,0.30)'; ctx.fillRect(px, py, cell, cell); }
        if (wants.rubble && hash(x, y, seed + 1) < (nearWall ? 0.5 : 0.16)) speck(ctx, px, py, cell, hash(x, y, seed + 2), 'rgba(42,38,32,0.6)', 2);
        if (wants.moss && hash(x, y, seed + 3) < 0.22) speck(ctx, px, py, cell, hash(x, y, seed + 4), 'rgba(74,112,52,0.5)', 2);
        if (wants.crack && hash(x, y, seed + 6) < 0.12) crackLine(ctx, px, py, cell, hash(x, y, seed + 7));
        if (wants.ash && hash(x, y, seed + 8) < 0.2) speck(ctx, px, py, cell, hash(x, y, seed + 9), 'rgba(20,18,16,0.45)', 3);
      }
    }

    // PASS 4 — anchors on top.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = (rows[y] || '')[x];
        const tag = anchors[ch];
        if (tag) drawAnchor(ctx, x * cell, y * cell, cell, tag);
      }
    }
  }

  window.PrefabRender = { render };
})();
