// The new-world page: the size of the world (in sectors), the brush and the terrains to paint with in the left bar, the
// world in the centre (all grassland at first; press and drag on it to paint sectors; the transition sectors the game
// needs between terrains are worked out from the painting and shown), and in the right bar the button that opens the
// editor on it - or a .zip that this page exported before, to go on working on that world. It takes the window like
// the other Workshop tools (tool-pages.js). Two events go out on document:
//   worldeditorcreate  detail { name, width, height, ids, structures }   (ids: one terrain.tdf id per sector, y * width + x; structures: NPCs of the town to build, 0 for none; trainStation: add a train station to the town; docks: { boats } or null, a pier with that many ships; temple: add a temple)
//   worldeditorload    detail { name, width, height, terrainId, sectors, worldFiles: [{ name, bytes }] }

import { loadWorldPlanner } from '../sec/sec-terrain.js';
import { readSecTileData } from '../sec/sec-parser.js';
import { loadJSZip } from '../core/util.js';
import { errText } from '../core/text-io.js';
import { generateTemplate, worldTemplates } from './world-templates.js';
import { MAX_BOATS } from './sec-docks.js';
import { closeToolPage, openToolPage, registerToolPage } from './tool-pages.js';

const MAX_SECTORS = 64;   // every sector is held in memory until exported
const MAX_BRUSH = 8;
const PREVIEW_W = 900, PREVIEW_H = 560;
const WORLD_FILES = ['map.prp', 'terrain.tdf', 'mapinfo.txt'];

const css = `
.we-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-muted); }
.we-sizes { display: flex; gap: 10px; }
.we-sizes .we-field { flex: 1; }
.we-sizes input, .we-name { width: 100%; box-sizing: border-box; }
.we-types { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 5px; margin-top: 6px; }
.we-type { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--surface-2); color: var(--ink); font: 600 10.5px/1.2 var(--font-mono); cursor: pointer; text-align: left; }
.we-type:hover, .we-type:focus-visible { border-color: var(--brass); }
.we-type.active { border-color: var(--teal); box-shadow: 0 0 0 1px var(--teal); background: rgba(32,178,170,.16); }
.we-type i { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,.5); }
.we-preview { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; }
.we-preview canvas { width: 100%; max-width: ${PREVIEW_W}px; aspect-ratio: ${PREVIEW_W} / ${PREVIEW_H}; background: #14110d; border: 1px solid var(--border); border-radius: 4px; cursor: crosshair; touch-action: none; }
.we-brush { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.we-brush input[type=range] { flex: 1; min-width: 0; }
.we-brush output { min-width: 2ch; text-align: right; color: var(--ink); font: 600 11px var(--font-mono); }
.we-shapes { display: flex; gap: 4px; flex: none; }
.we-fill { margin-top: 8px; width: 100%; }
.we-templates { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.we-templates .btn-back { margin: 0; text-align: center; }
.we-load-status:empty { display: none; }
.we-check { display: flex; align-items: center; gap: 6px; }
.we-check input { width: 5em; }
.we-check input[type=checkbox] { width: auto; }
.we-check.off { opacity: .45; }
.we-summary { text-align: center; }
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
    mk(`<div class="we-sizes">
      <label class="we-field">Width (sectors)<input type="number" class="we-w" min="1" max="${MAX_SECTORS}" step="1" value="4"></label>
      <label class="we-field">Height (sectors)<input type="number" class="we-h" min="1" max="${MAX_SECTORS}" step="1" value="4"></label></div>`),
    mk(`<div class="we-field">Brush<div class="we-brush">
      <div class="we-shapes" role="radiogroup" aria-label="Brush shape">
        <button type="button" class="we-type active" role="radio" aria-checked="true" data-shape="square">Square</button>
        <button type="button" class="we-type" role="radio" aria-checked="false" data-shape="round">Round</button></div>
      <input type="range" class="we-bsize" min="1" max="${MAX_BRUSH}" step="1" value="1" aria-label="Brush size"><output class="we-bsize-out">1</output></div></div>`),
    mk(`<div class="we-field">Sectors<div class="we-types" role="radiogroup" aria-label="Terrain"></div>
      <button type="button" class="btn-back we-fill tool-btn">Fill the whole map with it</button></div>`),
  ];
  const main = [mk(`<div class="we-preview"><canvas class="we-canvas" width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas><span class="packer-hint we-summary"></span></div>`)];
  const right = [
    mk(`<div class="we-actions">
      <button type="button" class="btn-back we-ok tool-btn tool-art">Open world editor</button>
      <button type="button" class="btn-back we-load tool-btn">Load a map (.zip)…</button>
      <input type="file" class="we-file" accept=".zip,application/zip" hidden>
      <p class="we-load-status" aria-live="polite"></p>
      <div class="we-sep">or</div></div>`),
    mk(`<label class="we-field">Map name
      <input type="text" class="we-name" maxlength="40" placeholder="New world" spellcheck="false" title="Names the map: its folder in an exported module, and the module itself"></label>`),
    mk(`<div class="we-field">Map templates
      <p class="packer-hint">Paints the map with a kind of land. Each click makes a new one; you can paint over it.</p>
      <div class="we-templates"></div></div>`),
    mk(`<div class="we-field">Structures
      <label class="we-check" title="Builds a town of houses joined by paths. One guard for every 5 NPCs patrols the paths, armed like the guards of Shrouded Hills, Black Root or Ashbury.">Town <input type="number" class="we-town" min="0" max="200" step="1" placeholder="0" aria-label="NPCs of the town"> NPC</label>
      <label class="we-check we-check-box" title="Adds a train station like the one of Ashbury: the train, the platform, a ticket booth, two conductors and a ticket agent. They stand there but have no scripts, so no tickets are sold."><input type="checkbox" class="we-station"> Train station</label>
      <label class="we-check we-check-box we-docks-row off" title="Needs water: paint some water first"><input type="checkbox" class="we-docks" disabled> Docks <input type="number" class="we-boats" min="0" max="${MAX_BOATS}" step="1" value="1" disabled aria-label="Boats in the docks"> boats</label>
      <label class="we-check we-check-box" title="Adds a temple, the one of Caladon or the vine-covered one of Shrouded Hills, on open ground near the town, with a path to the town."><input type="checkbox" class="we-temple"> Temple</label></div>`),
  ];
  registerToolPage('world', { title: 'New world', leftWidth: 340, rightWidth: 320, rightTitle: 'Start', left, main, right });
  const q = sel => document.querySelector(`.tool-pane[data-page="world"] ${sel}`);
  state = { docks: q('.we-docks'), boats: q('.we-boats'), docksRow: q('.we-docks-row'), w: q('.we-w'), h: q('.we-h'), types: q('.we-types'), canvas: q('.we-canvas'), summary: q('.we-summary'), status: q('.we-load-status'),
    terrain: null, list: [], planner: null, painted: new Uint8Array(0), pw: 0, ph: 0, plan: null, layout: null, hover: null, brushSize: 1, brushShape: 'square',
    base: document.createElement('canvas'), dirty: false, last: null, painting: false };
  state.base.width = PREVIEW_W; state.base.height = PREVIEW_H;

  state.w.addEventListener('input', () => redraw(true));
  state.h.addEventListener('input', () => redraw(true));
  const bsize = q('.we-bsize');
  bsize.addEventListener('input', () => { state.brushSize = Number(bsize.value); q('.we-bsize-out').textContent = bsize.value; drawOverlay(); });
  for (const b of q('.we-shapes').children) b.addEventListener('click', () => {
    state.brushShape = b.dataset.shape;
    for (const o of b.parentNode.children) { const on = o === b; o.classList.toggle('active', on); o.setAttribute('aria-checked', String(on)); }
    drawOverlay();
  });
  q('.we-fill').addEventListener('click', () => { if (state.terrain) { state.painted.fill(state.terrain.id); redraw(true); } });
  const cv = state.canvas;
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !state.terrain) return;
    cv.setPointerCapture(e.pointerId);
    state.painting = true; state.last = null;
    strokeTo(cellAt(e));
  });
  cv.addEventListener('pointermove', e => {
    state.hover = cellAt(e);
    if (state.painting) strokeTo(state.hover); else drawOverlay();
  });
  const endStroke = () => { state.painting = false; state.last = null; };
  cv.addEventListener('pointerup', endStroke);
  cv.addEventListener('pointercancel', endStroke);
  cv.addEventListener('pointerleave', () => { state.hover = null; if (!state.painting) drawOverlay(); });
  q('.we-ok').addEventListener('click', () => {
    if (!state.plan || !state.planner) return;
    const { width, height } = size();
    closeToolPage();
    document.dispatchEvent(new CustomEvent('worldeditorcreate', { detail: { name: mapName(q('.we-name').value), width, height, ids: state.plan.ids, structures: Math.max(0, Math.round(Number(q('.we-town').value)) || 0),
      trainStation: q('.we-station').checked, temple: q('.we-temple').checked,
      docks: q('.we-docks').checked ? { boats: Math.min(MAX_BOATS, Math.max(0, Math.round(Number(q('.we-boats').value)) || 0)) } : null,
      terrainAt: (sx, sy) => state.planner.types.find(t => t.id === state.plan.ids[sy * width + sx])?.name } }));
  });
  for (const t of worldTemplates) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-back tool-btn'; b.textContent = t.name; b.title = t.hint;
    b.addEventListener('click', () => {
      if (!state.planner) return;
      const { width, height } = size();
      state.painted = generateTemplate(t.name, width, height, state.planner); state.pw = width; state.ph = height;
      redraw(true);
    });
    q('.we-templates').appendChild(b);
  }
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
  let width = sectors.reduce((m, s) => Math.max(m, s.position.x), -Infinity) + 1, height = sectors.reduce((m, s) => Math.max(m, s.position.y), -Infinity) + 1, terrainId = null;
  if (prp && prp.length >= 0x18) {
    const v = new DataView(prp.buffer, prp.byteOffset, prp.byteLength);
    terrainId = v.getInt32(0, true);
    width = Math.max(width, Math.ceil(Number(v.getBigInt64(8, true)) / 64));
    height = Math.max(height, Math.ceil(Number(v.getBigInt64(16, true)) / 64));
  }
  return { name: file.name, width, height, terrainId, sectors, worldFiles };
}

// A name that is safe as a folder name and in MapList.mes ({name, x, y, ...}): no path or list characters, "New world" when empty
const mapName = v => String(v || '').replace(/[\\/:*?"<>|,{}\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'New world';
const clampSize = v => Math.min(MAX_SECTORS, Math.max(1, Math.round(Number(v)) || 1));
const size = () => ({ width: clampSize(state.w.value), height: clampSize(state.h.value) });
const rgb = (c, k = 1) => `rgb(${c.map(v => Math.min(255, Math.round(v * k))).join(',')})`;

// Every sector is drawn as a diamond (x runs down-left, y down-right, like the map). `layout` places them, so a
// pointer position can be turned back into a sector.
function layoutFor(width, height) {
  const pad = 10, n = width + height;
  const hw = Math.min((PREVIEW_W - 2 * pad) / n, 2 * (PREVIEW_H - 2 * pad) / n), hh = hw / 2;   // half diamond width / height
  return { width, height, hw, hh, ox: PREVIEW_W / 2 + (width - height) * hw / 2, oy: (PREVIEW_H - n * hh) / 2 };
}
const centre = (L, x, y) => [L.ox + (y - x) * L.hw, L.oy + (x + y) * L.hh + L.hh];
// The painting is done on the corner points of the sectors, (width + 1) x (height + 1) of them: point (x, y) is the top
// corner of sector (x, y). That keeps a painted area the size it was painted (see loadWorldPlanner).
const pointPos = (L, x, y) => [L.ox + (y - x) * L.hw, L.oy + (x + y) * L.hh];

// The corner point under a pointer event (it may lie outside the map: the brush is then clipped).
function cellAt(e) {
  const L = state.layout, r = state.canvas.getBoundingClientRect();
  if (!L || !r.width) return null;
  const u = ((e.clientX - r.left) * PREVIEW_W / r.width - L.ox) / L.hw, v = ((e.clientY - r.top) * PREVIEW_H / r.height - L.oy) / L.hh;
  return { x: Math.round((v - u) / 2), y: Math.round((u + v) / 2) };
}

// The sectors the brush covers when it is centred on (cx, cy).
function brushCells(cx, cy) {
  const n = state.brushSize, c = (n - 1) / 2, out = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const dx = i - c, dy = j - c;
    const inside = state.brushShape === 'square' || dx * dx + dy * dy <= Math.max(0.25, (n / 2) ** 2 - 0.3);
    if (inside) out.push({ x: cx + i - (n >> 1), y: cy + j - (n >> 1) });
  }
  return out;
}

function paintAt(cell) {
  const { width, height } = state.layout, vw = width + 1;
  let changed = false;
  for (const c of brushCells(cell.x, cell.y)) {
    if (c.x < 0 || c.y < 0 || c.x > width || c.y > height || state.painted[c.y * vw + c.x] === state.terrain.id) continue;
    state.painted[c.y * vw + c.x] = state.terrain.id; changed = true;
  }
  return changed;
}

// Paints at `cell`, and along the line from where the stroke was before (a quick drag skips sectors otherwise).
function strokeTo(cell) {
  if (!cell || !state.layout) return;
  const from = state.last || cell, steps = Math.max(Math.abs(cell.x - from.x), Math.abs(cell.y - from.y));
  let changed = false;
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    changed = paintAt({ x: Math.round(from.x + (cell.x - from.x) * t), y: Math.round(from.y + (cell.y - from.y) * t) }) || changed;
  }
  state.last = cell;
  if (changed) redraw(true); else drawOverlay();
}

// The brush outline on top of the map.
function drawOverlay() {
  const ctx = state.canvas.getContext('2d'), L = state.layout;
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  ctx.drawImage(state.base, 0, 0);
  if (!L || !state.hover || !state.terrain) return;
  ctx.beginPath();
  for (const c of brushCells(state.hover.x, state.hover.y)) {
    if (c.x < 0 || c.y < 0 || c.x > L.width || c.y > L.height) continue;
    const [cx, cy] = pointPos(L, c.x, c.y);
    ctx.moveTo(cx, cy - L.hh); ctx.lineTo(cx + L.hw, cy); ctx.lineTo(cx, cy + L.hh); ctx.lineTo(cx - L.hw, cy); ctx.closePath();
  }
  ctx.fillStyle = rgb(state.terrain.color); ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 0.75; ctx.stroke();
}

// The painted map and its transitions, redone. `replan`: the painting or the size changed.
function redraw(replan) {
  if (replan) { state.dirty = true; }
  if (state.queued) return;
  state.queued = true;
  requestAnimationFrame(() => { state.queued = false; if (state.dirty) { state.dirty = false; draw(); syncDocks(); } drawOverlay(); });
}

// Docks need a sea: the option stays greyed out (and off) while no corner of the map is painted with water.
function syncDocks() {
  const water = state.list.find(t => t.name === 'water');
  const has = !!water && state.painted.includes(water.id);
  state.docks.disabled = state.boats.disabled = !has;
  if (!has) state.docks.checked = false;
  state.docksRow.classList.toggle('off', !has);
  state.docksRow.title = has ? 'Adds docks like the ones of Ashbury and Dernholm: wooden piers into the sea (two boats to a pier) with a ship moored for each boat and a path to the village, on a beach with open sea beside it' : 'Needs water: paint some water first';
}

function draw() {
  const { width, height } = size();
  if (width !== state.pw || height !== state.ph) {   // a new size keeps the painting that still fits (corner points: one more than sectors)
    const next = new Uint8Array((width + 1) * (height + 1));
    for (let y = 0; y <= Math.min(height, state.ph); y++) for (let x = 0; x <= Math.min(width, state.pw); x++) next[y * (width + 1) + x] = state.painted[y * (state.pw + 1) + x];
    state.painted = next; state.pw = width; state.ph = height;
  }
  const L = state.layout = layoutFor(width, height), ctx = state.base.getContext('2d'), types = state.list;
  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  if (!state.planner || !types.length) { state.summary.textContent = `${width} × ${height} sectors`; return; }
  const plan = state.plan = state.planner.plan(width, height, state.painted);
  // A big world has thousands of sectors, and every path call costs: so the grid is drawn in grid space (a sector is a unit
  // square there, and the map is an affine picture of it), one rect per plain sector, one path per colour, and the
  // outlines are the grid lines. A sector's own parts never overlap another's, so the quarters can follow the plain parts.
  const { hw, hh } = L, shadeOf = (x, y) => ((x + y) % 2 ? 1 : 0);
  const mains = new Map(), quarters = new Map();
  const bucket = (set, id, odd) => { const key = id * 2 + odd; let a = set.get(key); if (!a) set.set(key, a = []); return a; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // The planner lists the corners as the points (x, y), (x, y + 1), (x + 1, y + 1), (x + 1, y); on screen x runs down-left, so
    // the screen order is top, left = (x + 1, y), bottom, right = (x, y + 1). A sector is filled with the terrain of
    // most of its corners (the first of them on a tie); each corner of another terrain is a quarter of the diamond.
    const o = (y * width + x) * 4, odd = shadeOf(x, y);
    const c = [plan.corners[o], plan.corners[o + 3], plan.corners[o + 2], plan.corners[o + 1]];
    let main = c[0], best = 0;
    for (let k = 0; k < 4; k++) {
      let n = 0;
      for (let j = 0; j < 4; j++) if (c[j] === c[k]) n++;
      if (n > best) { best = n; main = c[k]; }
    }
    bucket(mains, main, odd).push(x, y);
    if (best === 4) continue;
    for (let k = 0; k < 4; k++) if (c[k] !== main) bucket(quarters, c[k], odd).push(x, y, k);
  }
  // grid space -> picture: x runs down-left, y down-right (pointPos)
  const corner = [[0, 0], [1, 0], [1, 1], [0, 1]];   // top, left, bottom, right of a sector, in its own unit square
  ctx.save();
  ctx.setTransform(-hw, hh, hw, hh, L.ox, L.oy);
  for (const [key, list] of mains) {
    ctx.fillStyle = rgb(types[key >> 1]?.color || [128, 128, 128], key & 1 ? 0.92 : 1);
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 2) ctx.rect(list[i], list[i + 1], 1, 1);
    ctx.fill();
  }
  for (const [key, list] of quarters) {
    ctx.fillStyle = rgb(types[key >> 1]?.color || [128, 128, 128], key & 1 ? 0.92 : 1);
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 3) {
      const x = list[i], y = list[i + 1], p = corner[list[i + 2]], a = corner[(list[i + 2] + 3) % 4], b = corner[(list[i + 2] + 1) % 4];
      ctx.moveTo(x + p[0], y + p[1]); ctx.lineTo(x + (p[0] + b[0]) / 2, y + (p[1] + b[1]) / 2); ctx.lineTo(x + .5, y + .5); ctx.lineTo(x + (p[0] + a[0]) / 2, y + (p[1] + a[1]) / 2); ctx.closePath();
    }
    ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath();
  for (let x = 0; x <= width; x++) { const [x0, y0] = pointPos(L, x, 0), [x1, y1] = pointPos(L, x, height); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  for (let y = 0; y <= height; y++) { const [x0, y0] = pointPos(L, 0, y), [x1, y1] = pointPos(L, width, y); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.stroke();
  const hard = plan.hard ? ` · ${plan.hard} with a hard edge (no transition between ${plan.hardPairs.join(', ')})` : '';
  state.summary.textContent = `${width} × ${height} sectors · ${(width * height).toLocaleString()} in total · ${plan.transitions} transition sectors${hard}`;
}

function select(t) {
  state.terrain = t;
  for (const b of state.types.children) {
    const on = Number(b.dataset.id) === t.id;
    b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on));
  }
  drawOverlay();
}

export async function openWorldEditorDialog() {
  if (!state) build();
  openToolPage('world');
  if (!state.planner) {
    try {
      state.planner = await loadWorldPlanner();
      state.list = state.planner.types;   // by terrain id; the ones without sectors of their own in the game (void plains / mountains, scorched earth) are not offered
      state.types.innerHTML = '';
      for (const t of state.list.filter(t => t.hasTemplates)) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'we-type'; b.dataset.id = t.id; b.setAttribute('role', 'radio');
        if (t.blocked) b.title = 'Blocked terrain: nothing can walk here';
        b.innerHTML = '<i></i><span></span>';
        b.querySelector('i').style.background = rgb(t.color);
        b.querySelector('span').textContent = t.name;
        b.addEventListener('click', () => select(t));
        state.types.appendChild(b);
      }
      state.terrain = null;
      select(state.list.find(t => t.name === 'green grasslands') || state.list.find(t => t.hasTemplates));
    } catch (err) {
      state.types.textContent = `Could not read terrain.mes: ${err.message || err}`;
      return;
    }
  }
  redraw(true);
}
