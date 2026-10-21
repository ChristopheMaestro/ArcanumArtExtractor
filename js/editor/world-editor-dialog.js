// The new-world page: the size of the world (in sectors) and the terrain it starts from in the left bar, a
// preview in the centre, and in the right bar the button that opens the editor on it - or a .zip that this
// page exported before, to go on working on that world. It takes the window like the other Workshop tools
// (tool-pages.js). Two events go out on document:
//   worldeditorcreate  detail { width, height, terrain: { id, name } }
//   worldeditorload    detail { name, width, height, terrainId, sectors, worldFiles: [{ name, bytes }] }

import { loadTerrainTypes } from '../sec/sec-terrain.js';
import { readSecTileData } from '../sec/sec-parser.js';
import { loadJSZip } from '../core/util.js';
import { errText } from '../core/text-io.js';
import { closeToolPage, openToolPage, registerToolPage } from './tool-pages.js';

const MAX_SECTORS = 64;   // every sector is held in memory until exported
const PREVIEW_W = 900, PREVIEW_H = 560;
const WORLD_FILES = ['map.prp', 'terrain.tdf', 'mapinfo.txt'];

const css = `
.we-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-muted); }
.we-sizes { display: flex; gap: 10px; }
.we-sizes .we-field { flex: 1; }
.we-sizes input { width: 100%; box-sizing: border-box; }
.we-types { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 5px; margin-top: 6px; }
.we-type { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--surface-2); color: var(--ink); font: 600 10.5px/1.2 var(--font-mono); cursor: pointer; text-align: left; }
.we-type:hover, .we-type:focus-visible { border-color: var(--brass); }
.we-type.active { border-color: var(--teal); box-shadow: 0 0 0 1px var(--teal); background: rgba(32,178,170,.16); }
.we-type i { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,.5); }
.we-preview { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; }
.we-preview canvas { width: 100%; max-width: ${PREVIEW_W}px; aspect-ratio: ${PREVIEW_W} / ${PREVIEW_H}; background: #14110d; border: 1px solid var(--border); border-radius: 4px; }
.we-actions { display: flex; flex-direction: column; gap: 8px; }
.we-actions .btn-back { margin: 0; text-align: center; }
.we-sep { display: flex; align-items: center; gap: 8px; color: var(--ink-muted); font-size: 11px; }
.we-sep::before, .we-sep::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
.we-load-status { font-size: 11.5px; color: var(--teal); min-height: 1.2em; margin: 0; }
.we-load-status.err { color: var(--rust); }
`;

let state = null;

function build() {
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
  const mk = html => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  const left = [
    mk(`<p class="packer-hint">How big is the new world, and which terrain should its sectors start with? Nothing is written to disk until you export from the editor.</p>`),
    mk(`<div class="we-sizes">
      <label class="we-field">Width (sectors)<input type="number" class="we-w" min="1" max="${MAX_SECTORS}" step="1" value="4"></label>
      <label class="we-field">Height (sectors)<input type="number" class="we-h" min="1" max="${MAX_SECTORS}" step="1" value="4"></label></div>`),
    mk(`<div class="we-field">Type of sectors<div class="we-types" role="radiogroup" aria-label="Terrain"></div></div>`),
  ];
  const main = [mk(`<div class="we-preview"><canvas class="we-canvas" width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas><span class="packer-hint we-summary"></span></div>`)];
  const right = [
    mk(`<div class="we-actions">
      <button type="button" class="btn-back we-ok tool-btn tool-art">Open world editor</button>
      <div class="we-sep">or</div>
      <p class="packer-hint">Go on with a world this page made before: pick the .zip it exported (the sectors and map files inside).</p>
      <button type="button" class="btn-back we-load tool-btn">Load a map (.zip)…</button>
      <input type="file" class="we-file" accept=".zip,application/zip" hidden>
      <p class="we-load-status" aria-live="polite"></p></div>`),
  ];
  registerToolPage('world', { title: 'New world', leftWidth: 340, rightWidth: 320, rightTitle: 'Start', left, main, right });
  const q = sel => document.querySelector(`.tool-pane[data-page="world"] ${sel}`);
  state = { w: q('.we-w'), h: q('.we-h'), types: q('.we-types'), canvas: q('.we-canvas'), summary: q('.we-summary'), status: q('.we-load-status'), terrain: null, list: [] };

  state.w.addEventListener('input', draw);
  state.h.addEventListener('input', draw);
  q('.we-ok').addEventListener('click', () => {
    const { width, height } = size();
    if (!state.terrain) return;
    closeToolPage();
    document.dispatchEvent(new CustomEvent('worldeditorcreate', { detail: { width, height, terrain: { id: state.terrain.id, name: state.terrain.name } } }));
  });
  const file = q('.we-file');
  q('.we-load').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    state.status.className = 'we-load-status';
    state.status.textContent = `Reading ${f.name}…`;
    try {
      const world = await readWorldZip(f);
      state.status.textContent = '';
      closeToolPage();
      document.dispatchEvent(new CustomEvent('worldeditorload', { detail: world }));
    } catch (err) {
      state.status.className = 'we-load-status err';
      state.status.textContent = `${f.name}: ${errText(err)}`;
    }
  });
}

// A .zip exported by the new-world editor: <sector id>.sec files, map.prp, terrain.tdf, mapinfo.txt (any folder).
// Other files in it (.mob, dialogs...) are not read.
async function readWorldZip(file) {
  await loadJSZip();
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const base = path => path.split('/').pop();
  const entries = Object.values(zip.files).filter(e => !e.dir);
  const secs = entries.filter(e => /^\d+\.sec$/i.test(base(e.name)));
  if (!secs.length) throw new Error('no sector files (<number>.sec) in this .zip');
  const sectors = [];
  const mask = (1n << 26n) - 1n;
  for (const e of secs) {
    const filename = base(e.name), id = BigInt(filename.replace(/\.sec$/i, ''));
    const position = { id, x: Number(id & mask), y: Number((id >> 26n) & mask) };
    sectors.push({ filename, dir: '', index: sectors.length, position, decoded: readSecTileData(await e.async('arraybuffer'), filename), error: null });
  }
  const worldFiles = [];
  for (const n of WORLD_FILES) {
    const e = entries.find(x => base(x.name).toLowerCase() === n);
    if (e) worldFiles.push({ name: n, bytes: await e.async('uint8array') });
  }
  const prp = worldFiles.find(f => f.name === 'map.prp')?.bytes;
  let width = Math.max(...sectors.map(s => s.position.x)) + 1, height = Math.max(...sectors.map(s => s.position.y)) + 1, terrainId = null;
  if (prp && prp.length >= 0x18) {
    const v = new DataView(prp.buffer, prp.byteOffset, prp.byteLength);
    terrainId = v.getInt32(0, true);
    width = Math.max(width, Math.ceil(Number(v.getBigInt64(8, true)) / 64));
    height = Math.max(height, Math.ceil(Number(v.getBigInt64(16, true)) / 64));
  }
  return { name: file.name, width, height, terrainId, sectors, worldFiles };
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
  if (f < 1) { ctx.fillStyle = 'rgba(241,228,195,.8)'; ctx.font = '12px monospace'; ctx.fillText('(preview scaled down)', 8, PREVIEW_H - 8); }
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
  if (!state) build();
  openToolPage('world');
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
