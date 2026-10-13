// "Open world editor": asks for the size of the new world (in sectors) and the terrain it starts from,
// with a small isometric preview. Confirming fires a `worldeditorcreate` event on document with
// detail { width, height, terrain: { id, name } }.

import { loadTerrainTypes } from '../sec/sec-terrain.js';

const MAX_SECTORS = 64;   // every sector is held in memory until exported
const PREVIEW_W = 420, PREVIEW_H = 260;

const css = `
.we-dialog { width: min(720px, 100%); }
.we-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 16px; }
.we-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-muted); }
.we-sizes { display: flex; gap: 10px; }
.we-sizes .we-field { flex: 1; }
.we-sizes input { width: 100%; box-sizing: border-box; }
.we-types { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 5px; max-height: 250px; overflow-y: auto; margin-top: 6px; }
.we-type { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--surface-2); color: var(--ink); font: 600 10.5px/1.2 var(--font-mono); cursor: pointer; text-align: left; }
.we-type:hover, .we-type:focus-visible { border-color: var(--brass); }
.we-type.active { border-color: var(--teal); box-shadow: 0 0 0 1px var(--teal); background: rgba(32,178,170,.16); }
.we-type i { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,.5); }
.we-type small { color: var(--ink-muted); font-weight: 400; }
.we-preview { display: flex; flex-direction: column; gap: 6px; align-items: center; }
.we-preview canvas { width: 100%; max-width: ${PREVIEW_W}px; aspect-ratio: ${PREVIEW_W} / ${PREVIEW_H}; background: #14110d; border: 1px solid var(--border); border-radius: 4px; }
.we-footer { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 680px) { .we-layout { grid-template-columns: 1fr; } }
`;

let overlay = null, state = null;

function build() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="dat-packer we-dialog" role="dialog" aria-modal="true" aria-label="World editor">
      <div class="packer-header"><h2>World editor</h2><button class="packer-close" type="button" aria-label="Close">×</button></div>
      <div class="packer-body">
        <p class="packer-hint">How big is the new world, and which terrain should its sectors start with? Nothing is written to disk until you export from the editor.</p>
        <div class="we-layout">
          <div>
            <div class="we-sizes">
              <label class="we-field">Width (sectors)<input type="number" class="we-w" min="1" max="${MAX_SECTORS}" step="1" value="4"></label>
              <label class="we-field">Height (sectors)<input type="number" class="we-h" min="1" max="${MAX_SECTORS}" step="1" value="4"></label>
            </div>
            <div class="we-field" style="margin-top:12px">Type of sectors<div class="we-types" role="radiogroup" aria-label="Terrain"></div></div>
          </div>
          <div class="we-preview"><canvas class="we-canvas" width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas><span class="packer-hint we-summary"></span></div>
        </div>
        <div class="we-footer"><button type="button" class="btn-back we-cancel">Cancel</button><button type="button" class="btn-back we-ok tool-btn tool-art">Open world editor</button></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const q = sel => overlay.querySelector(sel);
  state = { w: q('.we-w'), h: q('.we-h'), types: q('.we-types'), canvas: q('.we-canvas'), summary: q('.we-summary'), terrain: null, list: [] };

  const close = () => overlay.classList.remove('open');
  q('.packer-close').addEventListener('click', close);
  q('.we-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
  state.w.addEventListener('input', draw);
  state.h.addEventListener('input', draw);
  q('.we-ok').addEventListener('click', () => {
    const { width, height } = size();
    close();
    document.dispatchEvent(new CustomEvent('worldeditorcreate', { detail: { width, height, terrain: { id: state.terrain.id, name: state.terrain.name } } }));
  });
}

const clampSize = v => Math.min(MAX_SECTORS, Math.max(1, Math.round(Number(v)) || 1));
const size = () => ({ width: clampSize(state.w.value), height: clampSize(state.h.value) });
const rgb = (c, k = 1) => `rgb(${c.map(v => Math.min(255, Math.round(v * k))).join(',')})`;

// Sectors as diamonds (x runs down-right, y down-left, like the map), tiled with the terrain colour.
function draw() {
  const { width, height } = size(), t = state.terrain, ctx = state.canvas.getContext('2d');
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  state.summary.textContent = `${width} × ${height} sectors · ${(width * height).toLocaleString()} in total · ${t ? t.name : ''}${t?.blocked ? ' (blocked terrain)' : ''}`;
  if (!t) return;
  // Too many sectors to draw one by one: show at most 32 per side, the shape (ratio) is kept.
  const m = Math.max(width, height), shown = Math.min(m, 32), f = shown / m;
  const cols = Math.max(1, Math.round(width * f)), rows = Math.max(1, Math.round(height * f));
  const pad = 10, n = cols + rows;
  const hw = Math.min((PREVIEW_W - 2 * pad) / n, 2 * (PREVIEW_H - 2 * pad) / n), hh = hw / 2;   // half diamond width / height
  const ox = PREVIEW_W / 2 + (rows - cols) * hw / 2, oy = (PREVIEW_H - n * hh) / 2;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const cx = ox + (x - y) * hw, cy = oy + (x + y) * hh + hh;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy); ctx.closePath();
    ctx.fillStyle = rgb(t.color, (x + y) % 2 ? 0.92 : 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.stroke();
  }
  if (f < 1) { ctx.fillStyle = 'rgba(241,228,195,.8)'; ctx.font = '11px monospace'; ctx.fillText('(preview scaled down)', 8, PREVIEW_H - 8); }
}

function select(t) {
  state.terrain = t;
  for (const b of state.types.children) {
    const on = Number(b.dataset.id) === t.id;
    b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on));
  }
  draw();
}

export async function openWorldEditorDialog() {
  if (!overlay) build();
  overlay.classList.add('open');
  if (!state.list.length) {
    try {
      state.list = (await loadTerrainTypes()).filter(t => !t.blocked && t.hasTemplates);   // nothing can be built on blocked terrain
      state.types.innerHTML = '';
      for (const t of state.list) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'we-type'; b.dataset.id = t.id; b.setAttribute('role', 'radio');
        b.innerHTML = '<i></i><span></span>';
        b.querySelector('i').style.background = rgb(t.color);
        b.querySelector('span').textContent = t.name;
        b.addEventListener('click', () => select(t));
        state.types.appendChild(b);
      }
      select(state.list.find(t => t.name === 'green grasslands') || state.list[0]);
    } catch (err) {
      state.types.textContent = `Could not read terrain.mes: ${err.message || err}`;
    }
  } else draw();
}
