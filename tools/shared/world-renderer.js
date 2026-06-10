// Shared world-map grid renderer used by both the world-gen and world-map tools,
// and mirrored in the in-game client.

export const BIOME_COLORS = {
  ocean:     '#1a4a7a',
  tundra:    '#b0c4d8',
  plains:    '#c8b560',
  grassland: '#4a8c3f',
  forest:    '#1f5c2e',
  swamp:     '#4a6741',
  desert:    '#c9a84c',
  mountain:  '#7a7a8c',
};

export const TIER_COLORS = ['', '#2ecc71', '#f1c40f', '#e67e22', '#e74c3c', '#8e44ad'];
export const TIER_LABELS = ['', 'lv 1–5', 'lv 5–10', 'lv 10–20', 'lv 20–35', 'lv 35–50'];

export const SETTLEMENT_STYLE = {
  city:    { fill: '#f5c842', stroke: '#8a6f00' },
  village: { fill: '#ffffff', stroke: '#555555' },
};

/**
 * Render the world grid onto a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} world  — { cols, rows, cells[][], settlements[], cities? }
 * @param {number} cellPx — pixels per grid cell
 * @param {{ viewMode?: 'biome'|'level', players?: {gridX:number,gridY:number,name:string}[] }} [opts]
 */
export function renderWorldGrid(canvas, ctx, world, cellPx, opts) {
  const viewMode = opts?.viewMode ?? 'biome';
  canvas.width  = world.cols * cellPx;
  canvas.height = world.rows * cellPx;

  const drawGrid = cellPx >= 6;

  for (let row = 0; row < world.rows; row++) {
    for (let col = 0; col < world.cols; col++) {
      const cell = world.cells[row]?.[col];

      if (!cell) {
        ctx.fillStyle = BIOME_COLORS.ocean;
        ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
      } else if (viewMode === 'level') {
        const tier = cell.levelBand?.tier;
        ctx.fillStyle = cell.worldBiome === 'ocean' ? '#1a2a3a' : (TIER_COLORS[tier] ?? '#333');
        ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);

        if (cellPx >= 20 && tier && cell.worldBiome !== 'ocean') {
          const label = TIER_LABELS[tier];
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.font = `bold ${Math.min(cellPx * 0.28, 11)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, col * cellPx + cellPx / 2, row * cellPx + cellPx / 2);
        }
      } else {
        ctx.fillStyle = BIOME_COLORS[cell.worldBiome] ?? '#333';
        ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);

        if (cell.tags?.includes('beach')) {
          ctx.fillStyle = 'rgba(226, 201, 126, 0.45)';
          ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
        }
      }

      if (drawGrid) {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(col * cellPx + 0.25, row * cellPx + 0.25, cellPx - 0.5, cellPx - 0.5);
      }
    }
  }

  // Settlement overlays
  const allSettlements = [...(world.settlements ?? []), ...(world.cities ?? [])];
  for (const s of allSettlements) {
    const style = SETTLEMENT_STYLE[s.type] ?? SETTLEMENT_STYLE.village;
    const x = s.gridX * cellPx;
    const y = s.gridY * cellPx;

    ctx.fillStyle = style.fill + '99';
    ctx.fillRect(x, y, cellPx, cellPx);

    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = Math.max(1, cellPx * 0.1);
    ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, cellPx - ctx.lineWidth, cellPx - ctx.lineWidth);

    ctx.fillStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(x + cellPx / 2, y + cellPx / 2, Math.max(1, cellPx * 0.18), 0, Math.PI * 2);
    ctx.fill();
  }

  // Player position markers
  const players = opts?.players ?? [];
  for (const p of players) {
    const x = p.gridX * cellPx;
    const y = p.gridY * cellPx;
    const r = Math.max(3, cellPx * 0.22);

    // Glow ring
    ctx.beginPath();
    ctx.arc(x + cellPx / 2, y + cellPx / 2, r + Math.max(1, cellPx * 0.08), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(x + cellPx / 2, y + cellPx / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}
