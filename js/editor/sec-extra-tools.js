// The editor's tools for what a sector and a map hold besides tiles and objects (what the game's editor works on):
//   roof      the roof grid (4 x 4 tiles a cell): any roof style, brush or rectangle, pieces fitted to the neighbours
//   light     the sector's own lights (lamps, fires, daylight, shadows...) placed free on a tile
//   block     the sector's block list: tiles the player and NPCs cannot enter, whatever stands there
//   sector    a sector's script, town map, light scheme, sounds and aptitude adjustment; tile scripts
//   mapdata   the map's start location (startloc.txt), jump points (map.jmp) and blocked sectors (map.sbf)
// The viewer (sec-folder-viewer.js) owns the map, the history and the export; this builds the panels and the work of each
// tool from what it hands over (`env`). Changes are recorded as { kind: 'fn', sec, apply(forward) } history entries.

import { ART_TYPE } from '../core/art-id.js';
import { escapeHtml } from '../core/util.js';
import { SEC_ISO_HALF_W } from '../sec/sec-iso.js';
import { loadLightSchemeNames, loadMapList, loadTownMapNames } from '../sec/sec-map-data.js';
import { loadSecRoofNames, secRoofNum } from '../sec/sec-roofs.js';
import { roofPieceAround } from './sec-house-plan.js';
import { blockedSectorBytes, jumpFileBytes, startLocBytes } from './sec-map-files.js';
import { secEnsureExtras, secExtrasDiffer, secSetTileBlocked, secSetTileScript, secTileBlocked, secTileScriptAt } from './sec-sector-extras.js';
import { SEC_NO_ROOF, secIsRoofId } from './sec-writer.js';

export const EXTRA_TOOLS = ['stamp', 'roof', 'light', 'block', 'sector', 'mapdata'];

const esc = escapeHtml;
const q = (root, sel) => root.querySelector(sel);
// A row of buttons of which one is on (the look of the Wall tool's brushes). `onPick(id)` runs on a click.
function pickRow(root, onPick) {
  const btns = [...root.querySelectorAll('button[data-id]')];
  const set = id => { for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.id === id)); };
  for (const b of btns) b.addEventListener('click', () => { set(b.dataset.id); onPick(b.dataset.id); });
  return { set };
}
const modeRow = (label, items, cls = 'sec-wall-brushes sec-opt-wide') =>
  `<div class="${cls}" role="group" aria-label="${esc(label)}"><span>${esc(label)}</span>${items.map(([id, text, title], i) => `<button type="button" class="sec-wall-brush" data-id="${id}" aria-pressed="${i === 0}" title="${esc(title || '')}">${esc(text)}</button>`).join('')}</div>`;

// ---- roofs ----------------------------------------------------------------------------------------------------------
const roofRaw = (num, piece, mirrored) => (((ART_TYPE.ROOF << 28) | (num << 19) | (piece << 14) | (mirrored ? 0x11 : 0)) >>> 0);

// ---- lights ---------------------------------------------------------------------------------------------------------
// art/light/light.mes: the sprite a light is drawn with; LF_* are game/light.h's flags.
const LF_DARK = 0x2, LF_ANIMATING = 0x4, LF_INDOOR = 0x8, LF_OUTDOOR = 0x10;
const LIGHT_ART = num => ((9 << 28) | (num << 19)) >>> 0;
// [art number, name, width of the sprite in tiles (its picture's width / the 80 px of a tile)]
const LIGHT_SIZES = [[0, 'Disk 1x1', 1.2], [1, 'Disk 2x2', 1.95], [2, 'Disk 3x3', 2.9], [3, 'Disk 4x4', 3.7], [5, 'Disk 5x5', 5.6], [11, 'Large', 5.6], [9, 'Flicker', 3.1], [10, 'Fireplace', 6.3]];
const LIGHT_PRESETS = [
  { id: 'lamp', name: 'Lamp', note: 'warm glow at any hour', art: 11, rgb: [255, 208, 162], flags: 0 },
  { id: 'candle', name: 'Candle', note: 'small, warm', art: 2, rgb: [255, 197, 138], flags: 0 },
  { id: 'torch', name: 'Torch', note: 'flickers', art: 9, rgb: [255, 170, 90], flags: LF_ANIMATING },
  { id: 'fire', name: 'Fireplace', note: 'flickers, red-orange', art: 10, rgb: [255, 140, 60], flags: LF_ANIMATING },
  { id: 'magic', name: 'Magic blue', note: 'cold glow', art: 5, rgb: [84, 175, 186], flags: 0 },
  { id: 'moon', name: 'Moonlight', note: 'wide, pale', art: 11, rgb: [162, 255, 255], flags: 0 },
  { id: 'fill', name: 'Room fill', note: 'takes the indoor ambient', art: 3, rgb: [74, 80, 98], flags: LF_INDOOR },
  { id: 'day', name: 'Daylight', note: 'takes the outdoor ambient', art: 3, rgb: [255, 255, 255], flags: LF_OUTDOOR },
  { id: 'dark', name: 'Shadow', note: 'darkens what is under it', art: 5, rgb: [120, 120, 120], flags: LF_DARK }
];
const toHex = ([r, g, b]) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
const fromHex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

export function createExtraTools(env) {
  const { edit, status, panes } = env;
  const owns = tool => EXTRA_TOOLS.includes(tool);
  const autoLayers = new Set();
  const useLayer = key => { if (!env.getLayer(key)) { env.setLayer(key, true); autoLayers.add(key); } };
  const absX = wx => env.minX * 64 + wx, absY = wy => env.minY * 64 + wy;

  // =============================================================== copy and paste
  const stamp = { mode: 'select', sel: null, clip: null, tiles: true, objects: true, lights: true, roofs: true, replace: true };
  panes.stamp.innerHTML = `
    <p class="sec-eye-head">Drag a rectangle on the map to copy what is in it, then click to paste the copy where you want it. The paste shows before you click. Shift snaps the paste to whole roof cells, so the roofs come along too.</p>
    <div class="sec-edit-controls">
      ${modeRow('Do', [['select', 'Copy', 'Drag a rectangle: what is in it is copied'], ['paste', 'Paste', 'Click where the copy goes (its north corner lands on the tile)']])}
      <label><input type="checkbox" class="sec-stamp-tiles" checked> Tiles</label>
      <label title="Scenery, walls, doors and windows (the sector's own objects; NPCs, items and containers are filed as .mob files and stay)"><input type="checkbox" class="sec-stamp-objects" checked> Objects</label>
      <label><input type="checkbox" class="sec-stamp-lights" checked> Lights</label>
      <label title="Roof cells that lie wholly inside the rectangle (4 x 4 tiles each)"><input type="checkbox" class="sec-stamp-roofs" checked> Roofs</label>
      <label class="sec-opt-wide" title="Take away the objects and roofs of the target area first, so the paste is not mixed with what stood there"><input type="checkbox" class="sec-stamp-replace" checked> Replace what is there</label>
    </div>
    <p class="sec-edit-note sec-stamp-info"></p>`;
  const stampUi = { tiles: q(panes.stamp, '.sec-stamp-tiles'), objects: q(panes.stamp, '.sec-stamp-objects'), lights: q(panes.stamp, '.sec-stamp-lights'), roofs: q(panes.stamp, '.sec-stamp-roofs'), replace: q(panes.stamp, '.sec-stamp-replace'), info: q(panes.stamp, '.sec-stamp-info') };
  const stampMode = pickRow(q(panes.stamp, '[aria-label="Do"]'), id => { stamp.mode = id; env.scheduleCursor(); });
  for (const k of ['tiles', 'objects', 'lights', 'roofs', 'replace']) stampUi[k].addEventListener('change', () => { stamp[k] = stampUi[k].checked; env.scheduleCursor(); });
  const rectOf = s => ({ x0: Math.min(s.x0, s.x1), y0: Math.min(s.y0, s.y1), x1: Math.max(s.x0, s.x1), y1: Math.max(s.y0, s.y1) });
  const capture = s => {
    const r = rectOf(s), tiles = [], objs = [], lights = [], roofs = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      const raw = env.tileRawAt(x, y);
      if (raw != null) tiles.push({ dx: x - r.x0, dy: y - r.y0, raw });
      for (const pt of env.objectsAt(x, y)) if (pt.staticSecObject && pt.__obj) objs.push({ dx: x - r.x0, dy: y - r.y0, pt });
    }
    for (const sec of env.valid) for (const l of sec.decoded?.lights || []) {
      const x = l.x - env.minX * 64, y = l.y - env.minY * 64;
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) lights.push({ dx: x - r.x0, dy: y - r.y0, l });
    }
    const cx0 = Math.ceil(r.x0 / 4), cy0 = Math.ceil(r.y0 / 4), cx1 = Math.floor((r.x1 + 1) / 4) - 1, cy1 = Math.floor((r.y1 + 1) / 4) - 1;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) roofs.push({ cx: cx - cx0, cy: cy - cy0, raw: roofAt(cx, cy) });   // (null: no roof there)
    return { ...r, w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1, tiles, objs, lights, roofs, rcx0: cx0, rcy0: cy0 };
  };
  const stampInfo = () => {
    const c = stamp.clip;
    stampUi.info.textContent = c ? `Copied ${c.w} x ${c.h} tiles · ${c.objs.length} object${c.objs.length === 1 ? '' : 's'} · ${c.lights.length} light${c.lights.length === 1 ? '' : 's'} · ${c.roofs.filter(r => r.raw != null).length} roof cell${c.roofs.filter(r => r.raw != null).length === 1 ? '' : 's'}` : 'Nothing copied yet.';
  };
  stampInfo();
  // where the north corner of the copy lands for a pointer on `f` (Shift: a whole number of roof cells away from where it was)
  const stampAnchor = (f, shift) => {
    const c = stamp.clip;
    return shift ? { x: c.x0 + 4 * Math.round((f.wx - c.x0) / 4), y: c.y0 + 4 * Math.round((f.wy - c.y0) / 4) } : { x: f.wx, y: f.wy };
  };
  let lastShift = false;
  const paste = (f, shift) => {
    const c = stamp.clip; if (!c) { edit.problem = 'Copy something first'; return; }
    const a = stampAnchor(f, shift);
    let n = { tiles: 0, objs: 0, lights: 0, roofs: 0 };
    const inMap = (x, y) => x >= 0 && y >= 0 && x < env.mapW && y < env.mapH;
    if (stamp.replace && stamp.objects) {
      for (let dy = 0; dy < c.h; dy++) for (let dx = 0; dx < c.w; dx++) for (const pt of env.objectsAt(a.x + dx, a.y + dy).slice()) if (pt.staticSecObject && pt.__obj) env.removeObject(pt);
    }
    if (stamp.tiles) for (const t of c.tiles) if (inMap(a.x + t.dx, a.y + t.dy) && env.setTile(a.x + t.dx, a.y + t.dy, t.raw)) n.tiles++;
    if (stamp.objects) for (const o of c.objs) if (inMap(a.x + o.dx, a.y + o.dy) && env.cloneObject(o.pt, a.x + o.dx, a.y + o.dy)) n.objs++;
    if (stamp.lights) for (const { dx, dy, l } of c.lights) {
      const x = a.x + dx, y = a.y + dy; if (!inMap(x, y)) continue;
      if (env.addLight({ wx: x, wy: y, offsetX: l.offsetX, offsetY: l.offsetY, flags: l.flags, artId: l.artId, r: l.r, g: l.g, b: l.b })) n.lights++;
    }
    let skippedRoofs = false;
    if (stamp.roofs && c.roofs.length) {
      const sx = a.x - c.x0, sy = a.y - c.y0;
      if (sx % 4 === 0 && sy % 4 === 0) {
        const ox = c.rcx0 + sx / 4, oy = c.rcy0 + sy / 4;
        for (const r of c.roofs) {
          if (r.raw == null && !stamp.replace) continue;
          const cx = ox + r.cx, cy = oy + r.cy;
          if (cx < 0 || cy < 0 || cx * 4 >= env.mapW || cy * 4 >= env.mapH) continue;
          if (env.setRoofCell(cx, cy, r.raw == null ? SEC_NO_ROOF : r.raw)) n.roofs++;
        }
        if (n.roofs) env.ensureRoofArt();
      } else skippedRoofs = c.roofs.some(r => r.raw != null);
    }
    edit.houseNote = `Pasted ${n.tiles} tiles, ${n.objs} objects, ${n.lights} lights, ${n.roofs} roof cells${skippedRoofs ? ' (hold Shift to paste roofs: they go in whole cells)' : ''}`;
  };

  // =============================================================== roofs
  const roof = { mode: 'paint', shape: 'brush', size: 1, num: 2, piece: 'auto', mirrored: false, names: {}, drag: null, touched: new Set() };
  panes.roof.innerHTML = `
    <p class="sec-eye-head">Roofs cover 4 x 4 tiles a cell and show in the Roofs layer (isometric view). Paint a roof over a building, or erase it. Alt+click a roof to take its style.</p>
    <div class="sec-edit-controls">
      ${modeRow('Do', [['paint', 'Paint', 'Put the roof style below on the cells you press'], ['erase', 'Erase', 'Take the roof off the cells you press']])}
      ${modeRow('Shape', [['brush', 'Brush', 'Cell by cell: press and drag'], ['rect', 'Rectangle', 'Press on one corner, release on the opposite one']])}
      <label>Size <input type="number" class="sec-roof-size" min="1" max="8" value="1" title="Cells a side (a cell is 4 x 4 tiles)"></label>
      <label class="sec-opt-wide">Roof <select class="sec-roof-num" aria-label="Roof style"></select></label>
      <label class="sec-opt-wide" title="Auto fits each cell to the roofs around it, as the game's houses do: corners, edges and the middle"><span>Piece</span>
        <select class="sec-roof-piece"><option value="auto">Auto (fits its neighbours)</option>${Array.from({ length: 9 }, (_, i) => `<option value="${i}">Piece ${i}</option>`).join('')}</select></label>
      <label title="A piece drawn the other way round (only with a chosen piece)"><input type="checkbox" class="sec-roof-mirror"> Mirrored</label>
    </div>`;
  const roofUi = { size: q(panes.roof, '.sec-roof-size'), num: q(panes.roof, '.sec-roof-num'), piece: q(panes.roof, '.sec-roof-piece'), mirror: q(panes.roof, '.sec-roof-mirror') };
  const roofDo = pickRow(q(panes.roof, '[aria-label="Do"]'), id => { roof.mode = id; });
  const roofShape = pickRow(q(panes.roof, '[aria-label="Shape"]'), id => { roof.shape = id; roofUi.size.disabled = id === 'rect'; });
  void roofDo; void roofShape;
  roofUi.size.addEventListener('input', () => { roof.size = Math.max(1, Math.min(8, Math.round(Number(roofUi.size.value)) || 1)); env.scheduleCursor(); });
  roofUi.num.addEventListener('change', () => { roof.num = Number(roofUi.num.value); });
  roofUi.piece.addEventListener('change', () => { roof.piece = roofUi.piece.value; roofUi.mirror.disabled = roof.piece === 'auto'; });
  roofUi.mirror.addEventListener('change', () => { roof.mirrored = roofUi.mirror.checked; });
  roofUi.mirror.disabled = true;
  loadSecRoofNames().then(names => {
    roof.names = names;
    roof.num = env.usualRoofNum();
    roofUi.num.innerHTML = Object.entries(names).filter(([, n]) => n).map(([i, n]) => `<option value="${i}">${i} · ${esc(n)}</option>`).join('');
    roofUi.num.value = String(roof.num);
  }).catch(() => {});

  // The roof art id on cell (cx, cy) (world tiles / 4), or null when there is none.
  const roofAt = (cx, cy) => {
    const at = env.sectorAtWorld(cx * 4, cy * 4); if (!at) return null;
    const ids = at.sec.decoded.roofArtIds; if (!ids) return null;
    const v = ids[(((cy * 4) & 63) >> 2) * 16 + (((cx * 4) & 63) >> 2)] >>> 0;
    return secIsRoofId(v) ? v : null;
  };
  // A cell takes the piece its neighbours of the same style ask for.
  const fitCell = (cx, cy) => {
    const v = roofAt(cx, cy); if (v == null) return;
    const num = secRoofNum(v), [piece, mirrored] = roofPieceAround((dx, dy) => { const w = roofAt(cx + dx, cy + dy); return w != null && secRoofNum(w) === num; });
    const raw = roofRaw(num, piece, mirrored);
    if (raw !== v) env.setRoofCell(cx, cy, raw);
  };
  const fitAround = cells => {
    const todo = new Map();
    for (const [cx, cy] of cells) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) todo.set(`${cx + dx},${cy + dy}`, [cx + dx, cy + dy]);
    for (const [x, y] of todo.values()) fitCell(x, y);
  };
  const roofCells = (cx, cy) => {      // the cells of the brush around the cell the pointer is on
    const n = roof.size, o = Math.floor((n - 1) / 2), out = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) out.push([cx + dx - o, cy + dy - o]);
    return out;
  };
  const rectCells = d => {
    const out = [];
    for (let y = Math.min(d.cy0, d.cy1); y <= Math.max(d.cy0, d.cy1); y++) for (let x = Math.min(d.cx0, d.cx1); x <= Math.max(d.cx0, d.cx1); x++) out.push([x, y]);
    return out;
  };
  const applyRoof = cells => {
    let changed = false;
    for (const [cx, cy] of cells) {
      if (cx < 0 || cy < 0 || cx * 4 >= env.mapW || cy * 4 >= env.mapH) continue;
      const raw = roof.mode === 'erase' ? SEC_NO_ROOF : roofRaw(roof.num, roof.piece === 'auto' ? 8 : Number(roof.piece), roof.piece !== 'auto' && roof.mirrored);
      if (env.setRoofCell(cx, cy, raw)) changed = true;
    }
    if (changed) {
      if (roof.mode === 'paint' && roof.piece === 'auto') fitAround(cells); else if (roof.mode === 'erase') fitAround(cells);
      env.ensureRoofArt();
    }
  };

  // =============================================================== lights
  const light = { mode: 'place', preset: LIGHT_PRESETS[0], art: 11, rgb: [255, 208, 162], flags: 0, drop: true };
  panes.light.innerHTML = `
    <p class="sec-eye-head">Lights the sector keeps, free on a tile (house lights come with the placeholder houses). They show with the Lighting button on; here each one is marked by a ring in its colour.</p>
    <div class="sec-edit-controls">
      ${modeRow('Do', [['place', 'Place', 'Put the light on the tile you press'], ['remove', 'Remove', 'Take the lights off the tile you press']])}
      <label class="sec-opt-wide" title="The light sits where you press inside the tile (its pixel offset). Unticked, on the tile's centre"><input type="checkbox" class="sec-light-drop" checked> Place where clicked</label>
      <label>Size <select class="sec-light-size">${LIGHT_SIZES.map(([n, t]) => `<option value="${n}">${t}</option>`).join('')}</select></label>
      <label>Colour <input type="color" class="sec-light-colour" value="#ffd0a2"></label>
      <label title="Cycles through the frames of its art (torches, fires)"><input type="checkbox" class="sec-light-anim"> Flickers</label>
      <label title="Subtracts light: a shadow"><input type="checkbox" class="sec-light-dark"> Dark</label>
      <label class="sec-opt-wide" title="Indoor / outdoor lights take the ambient colour of the hour instead of their own"><span>Takes</span>
        <select class="sec-light-tint"><option value="own">its own colour</option><option value="indoor">the indoor ambient (room fill)</option><option value="outdoor">the outdoor ambient (daylight)</option></select></label>
    </div>
    <div class="sec-gen-list sec-light-presets" role="listbox" aria-label="Kinds of light">${LIGHT_PRESETS.map(p => `<button type="button" class="sec-gen-kind" data-id="${p.id}" aria-pressed="${p === LIGHT_PRESETS[0]}"><span>${p.name}</span><small>${p.note}</small></button>`).join('')}</div>`;
  const lightUi = { drop: q(panes.light, '.sec-light-drop'), size: q(panes.light, '.sec-light-size'), colour: q(panes.light, '.sec-light-colour'), anim: q(panes.light, '.sec-light-anim'), dark: q(panes.light, '.sec-light-dark'), tint: q(panes.light, '.sec-light-tint') };
  pickRow(q(panes.light, '[aria-label="Do"]'), id => { light.mode = id; env.scheduleCursor(); });
  const lightFlags = () => (lightUi.anim.checked ? LF_ANIMATING : 0) | (lightUi.dark.checked ? LF_DARK : 0) | (lightUi.tint.value === 'indoor' ? LF_INDOOR : lightUi.tint.value === 'outdoor' ? LF_OUTDOOR : 0);
  const syncLightUi = () => {
    lightUi.size.value = String(light.art); lightUi.colour.value = toHex(light.rgb);
    lightUi.anim.checked = !!(light.flags & LF_ANIMATING); lightUi.dark.checked = !!(light.flags & LF_DARK);
    lightUi.tint.value = light.flags & LF_INDOOR ? 'indoor' : light.flags & LF_OUTDOOR ? 'outdoor' : 'own';
  };
  const presets = pickRow(q(panes.light, '.sec-light-presets'), id => {
    const p = LIGHT_PRESETS.find(x => x.id === id); Object.assign(light, { preset: p, art: p.art, rgb: p.rgb.slice(), flags: p.flags }); syncLightUi(); env.scheduleCursor();
  });
  void presets;
  const readLightUi = () => { light.art = Number(lightUi.size.value); light.rgb = fromHex(lightUi.colour.value); light.flags = lightFlags(); light.drop = lightUi.drop.checked; env.scheduleCursor(); };
  for (const k of ['size', 'colour', 'anim', 'dark', 'tint', 'drop']) lightUi[k].addEventListener('input', readLightUi);
  syncLightUi();
  const lightRadius = art => (LIGHT_SIZES.find(s => s[0] === art) || [0, '', 5.6])[2];

  // =============================================================== blocked tiles
  const block = { mode: 'block', stroke: null };
  panes.block.insertAdjacentHTML('beforeend', `
    <p class="sec-eye-head">Blocked tiles are in the sector's block list: nobody can step on them, whatever the tile or the objects there. They show in red with the Blocked layer (bright red = this list; dark red = what the tile art and the objects block already).</p>
    <div class="sec-edit-controls">
      ${modeRow('Do', [['block', 'Block', 'Mark the tiles you paint as blocked'], ['open', 'Open', 'Take the tiles you paint out of the block list']])}
      <div class="sec-house-actions sec-opt-wide"><button type="button" class="sec-block-ring" title="Block the tiles of the edge of the sector you press... (use the brush for the rest)">Block a sector's edge</button><button type="button" class="sec-block-clear" title="Take every tile of the sector you press out of the block list">Open a whole sector</button></div>
    </div>`);
  pickRow(q(panes.block, '[aria-label="Do"]'), id => { block.mode = id; env.scheduleCursor(); });
  const blockSectorMode = { ring: false, clear: false };
  const blockBtns = { ring: q(panes.block, '.sec-block-ring'), clear: q(panes.block, '.sec-block-clear') };
  for (const k of ['ring', 'clear']) blockBtns[k].addEventListener('click', () => {
    const on = !blockSectorMode[k]; blockSectorMode.ring = blockSectorMode.clear = false; blockSectorMode[k] = on;
    for (const [n, b] of Object.entries(blockBtns)) b.style.outline = blockSectorMode[n] ? '1px solid var(--teal)' : '';
    status.textContent = on ? 'Press the sector' : '';
  });
  const blockTile = (wx, wy, on) => {
    const at = env.sectorAtWorld(wx, wy); if (!at) return false;
    if (!secSetTileBlocked(at.sec.decoded, at.idx, on)) return false;
    const key = env.secKey(at.sec);
    const s = block.stroke.get(key) || { sec: at.sec, on, idxs: [] };
    s.idxs.push(at.idx); block.stroke.set(key, s);
    env.markExtra(at.sec);
    return true;
  };
  const blockFootprint = (wx, wy, on) => {
    const n = edit.size, o = Math.floor((n - 1) / 2);
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) blockTile(wx + dx - o, wy + dy - o, on);
  };

  // =============================================================== sector properties and tile scripts
  const sect = { mode: 'props', sec: null, townNames: null, schemeNames: null, scriptNum: 0 };
  panes.sector.innerHTML = `
    <p class="sec-eye-head">Press a tile to choose its sector. Tile scripts are scripts the game runs on a tile (a trap, a trigger, a door's logic); show them with the Scripts layer.</p>
    <div class="sec-edit-controls">
      ${modeRow('Press', [['props', 'Choose sector', 'Press a tile: its sector is edited below'], ['script', 'Tile script', 'Give the pressed tile the script number below'], ['clear', 'Remove script', 'Take the tile script off the pressed tile']])}
      <label class="sec-opt-wide" title="Number of the .scr file (0 = none)">Tile script # <input type="number" class="sec-sect-tscript" min="1" max="65535" value="1"> <span class="sec-sect-tname"></span></label>
    </div>
    <h4 class="sec-eye-head sec-sect-title">No sector chosen</h4>
    <div class="sec-edit-controls sec-sect-form" hidden>
      <label class="sec-opt-wide" title="Script of the whole sector (0 = none)">Sector script # <input type="number" class="sec-sect-script" min="0" max="65535" value="0"></label>
      <label class="sec-opt-wide" title="The town the game names when you enter it (Rules/TownMap.mes)">Town map <select class="sec-sect-town"></select></label>
      <label class="sec-opt-wide" title="Ambient lighting of the sector, over the map's own (Rules/Lighting Schemes.mes); none: the map's">Light scheme <select class="sec-sect-scheme"></select></label>
      <label title="Music scheme number (0 = the map's)">Music <input type="number" class="sec-sect-music" min="0" max="999" value="0"></label>
      <label title="Ambient sound scheme number (0 = the map's)">Ambient <input type="number" class="sec-sect-ambient" min="0" max="999" value="0"></label>
      <label title="Adjusts the aptitude of the characters in the sector (-100..100)">Aptitude adj. <input type="number" class="sec-sect-apt" min="-100" max="100" value="0"></label>
      <label class="sec-opt-wide" title="Put these properties on every sector of the map"><input type="checkbox" class="sec-sect-all"> Apply to every sector of the map</label>
    </div>`;
  const sUi = { tscript: q(panes.sector, '.sec-sect-tscript'), tname: q(panes.sector, '.sec-sect-tname'), title: q(panes.sector, '.sec-sect-title'), form: q(panes.sector, '.sec-sect-form'),
    script: q(panes.sector, '.sec-sect-script'), town: q(panes.sector, '.sec-sect-town'), scheme: q(panes.sector, '.sec-sect-scheme'), music: q(panes.sector, '.sec-sect-music'), ambient: q(panes.sector, '.sec-sect-ambient'), apt: q(panes.sector, '.sec-sect-apt'), all: q(panes.sector, '.sec-sect-all') };
  pickRow(q(panes.sector, '[aria-label="Press"]'), id => {
    sect.mode = id;
    if (id !== 'props') useLayer('scripts');
    status.textContent = id === 'script' ? 'Press the tiles that get the script' : id === 'clear' ? 'Press the tiles whose script goes' : '';
  });
  const scriptName = async (num, span) => {
    span.textContent = '';
    if (!(num > 0)) return;
    try {
      const m = await import('../scr/scr-explorer.js'), f = await m.scrFileForNumber(num);
      if (Number(sUi.tscript.value) === num) span.textContent = f ? f.replace(/^\d+_?|\.scr$/gi, '') : 'no such script';
    } catch (_) { /* name stays empty */ }
  };
  sUi.tscript.addEventListener('input', () => { sect.scriptNum = Math.round(Number(sUi.tscript.value)) || 0; scriptName(sect.scriptNum, sUi.tname); });
  sect.scriptNum = 1;
  const fillSelect = (select, names, none) => {
    const rows = [...(names || new Map()).entries()].filter(([n]) => n > 0).sort((a, b) => a[0] - b[0]);
    select.innerHTML = `<option value="0">${none}</option>` + rows.map(([n, t]) => `<option value="${n}">${n} · ${esc(String(t).replace(/\s*\[.*?\]\s*/g, ''))}</option>`).join('');
  };
  Promise.all([loadTownMapNames().catch(() => null), loadLightSchemeNames().catch(() => null)]).then(([t, l]) => {
    sect.townNames = t; sect.schemeNames = l;
    fillSelect(sUi.town, t, '(none)'); fillSelect(sUi.scheme, l, "(the map's)");
    if (sect.sec) showSector(sect.sec);
  });
  const showSector = sec => {
    sect.sec = sec;
    const d = secEnsureExtras(sec.decoded), i = d.sectorInfo;
    sUi.title.textContent = `Sector ${sec.position.x}, ${sec.position.y} · ${sec.filename}`;
    sUi.form.hidden = false;
    sUi.script.value = String(i.script.num); sUi.music.value = String(i.music); sUi.ambient.value = String(i.ambient); sUi.apt.value = String(i.aptitudeAdj);
    const ensureOpt = (sel, v) => { if (![...sel.options].some(o => o.value === String(v))) sel.insertAdjacentHTML('beforeend', `<option value="${v}">${v}</option>`); sel.value = String(v); };
    ensureOpt(sUi.town, i.townmap); ensureOpt(sUi.scheme, i.lightScheme);
  };
  // one change of the chosen sector's properties (or of every sector's), as one history step
  const applyInfo = (key, value) => {
    if (!sect.sec) return;
    const secs = sUi.all.checked ? env.valid.filter(s => s.decoded && !s.terrain) : [sect.sec], entries = [];
    for (const sec of secs) {
      const d = secEnsureExtras(sec.decoded), before = JSON.stringify(d.sectorInfo), info = JSON.parse(before);
      if (key === 'script') info.script.num = value; else info[key] = value;
      const after = JSON.stringify(info);
      if (after === before) continue;
      d.sectorInfo = info;
      entries.push({ kind: 'fn', sec, apply: fwd => { d.sectorInfo = JSON.parse(fwd ? after : before); } });
      env.markExtra(sec);
    }
    if (entries.length) env.commit(entries);
  };
  const num = (el, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(el.value)) || 0));
  sUi.script.addEventListener('change', () => applyInfo('script', num(sUi.script, 0, 65535)));
  sUi.town.addEventListener('change', () => applyInfo('townmap', Number(sUi.town.value)));
  sUi.scheme.addEventListener('change', () => applyInfo('lightScheme', Number(sUi.scheme.value)));
  sUi.music.addEventListener('change', () => applyInfo('music', num(sUi.music, 0, 999)));
  sUi.ambient.addEventListener('change', () => applyInfo('ambient', num(sUi.ambient, 0, 999)));
  sUi.apt.addEventListener('change', () => applyInfo('aptitudeAdj', num(sUi.apt, -100, 100)));
  scriptName(1, sUi.tname);

  // =============================================================== map data: start, jump points, blocked sectors
  const mp = { mode: 'start', jumpDst: null, orig: null, maps: new Map() };
  const mapSnapshot = () => { const m = env.getMapData(); return JSON.stringify({ s: m.start, j: m.jumps.map(j => [j.flags, j.x, j.y, j.dstMap, j.dst.x, j.dst.y]), b: [...m.blockedSectors].sort() }); };
  const mapParts = () => {
    const m = env.getMapData(), o = JSON.parse(mp.orig), now = JSON.parse(mapSnapshot()), out = [];
    if (JSON.stringify(o.s) !== JSON.stringify(now.s) && m.start) out.push({ name: 'startloc.txt', bytes: startLocBytes(m.start) });
    if (JSON.stringify(o.j) !== JSON.stringify(now.j)) out.push({ name: 'map.jmp', bytes: jumpFileBytes(m.jumps) });
    if (JSON.stringify(o.b) !== JSON.stringify(now.b)) out.push({ name: 'map.sbf', bytes: blockedSectorBytes(m.blockedSectors) });
    return out;
  };
  panes.mapdata.innerHTML = `
    <p class="sec-eye-head">What the game keeps for the whole map: where the player starts, the jump points that take you to another map (a door into a house interior, a cave mouth) and the sectors nobody can enter. Saved as startloc.txt, map.jmp and map.sbf. A town or secret area inside a world map uses its world map's.</p>
    <div class="sec-edit-controls">
      ${modeRow('Press', [['start', 'Start', 'Press the tile where the player starts'], ['jump', 'Add jump', 'Press the tile that takes the player to the destination below'], ['unjump', 'Remove jump', 'Press a jump point to take it away'], ['sector', 'Blocked sector', 'Press a sector to block or unblock all of it']])}
      <div class="sec-opt-wide sec-map-jumpform">
        <label class="sec-opt-wide">Goes to map <select class="sec-map-dst"><option value="0">(loading maps…)</option></select></label>
        <label>x <input type="number" class="sec-map-dx" min="0" value="100"></label>
        <label>y <input type="number" class="sec-map-dy" min="0" value="100"></label>
      </div>
    </div>
    <p class="sec-edit-note sec-map-start"></p>
    <div class="sec-map-list" role="list"></div>`;
  const mUi = { dst: q(panes.mapdata, '.sec-map-dst'), dx: q(panes.mapdata, '.sec-map-dx'), dy: q(panes.mapdata, '.sec-map-dy'), start: q(panes.mapdata, '.sec-map-start'), list: q(panes.mapdata, '.sec-map-list'), form: q(panes.mapdata, '.sec-map-jumpform') };
  pickRow(q(panes.mapdata, '[aria-label="Press"]'), id => {
    mp.mode = id; mUi.form.hidden = id !== 'jump';
    if (id === 'start') useLayer('start');
    if (id === 'jump' || id === 'unjump') useLayer('jumps');
    if (id === 'sector') useLayer('blocked');
    status.textContent = '';
  });
  mUi.form.hidden = true;
  loadMapList().then(m => {
    mp.maps = m;
    mUi.dst.innerHTML = [...m.entries()].map(([n, name]) => `<option value="${n}">${n} · ${esc(name)}</option>`).join('');
    renderMapList();
  }).catch(() => { mUi.dst.innerHTML = '<option value="1">1</option>'; });
  const mapLabel = n => mp.maps.get(n) || `map ${n}`;
  const mapOp = (apply) => { env.commit([{ kind: 'fn', sec: null, apply }]); };
  function renderMapList() {
    const m = env.getMapData();
    mUi.start.textContent = m.start ? `Start: ${m.start.x}, ${m.start.y} (tile ${m.start.x & 63}, ${m.start.y & 63} of sector ${m.start.x >> 6}, ${m.start.y >> 6})` : 'No start location.';
    const rows = m.jumps.map((j, i) => `<div class="sec-info-row" role="listitem"><span title="This tile">${j.x}, ${j.y}</span><span>→ ${esc(mapLabel(j.dstMap))} · ${j.dst.x}, ${j.dst.y} <a href="#" class="sec-mapdata-link" data-i="${i}" title="Take this jump point away">remove</a></span></div>`);
    mUi.list.innerHTML = rows.length ? rows.join('') : '<p class="sec-edit-note">No jump points.</p>';
  }
  mUi.list.addEventListener('click', e => {
    const a = e.target.closest('a[data-i]'); if (!a) return;
    e.preventDefault();
    const m = env.getMapData(), j = m.jumps[Number(a.dataset.i)]; if (!j) return;
    const at = m.jumps.indexOf(j);
    m.jumps.splice(at, 1); mapOp(fwd => { if (fwd) m.jumps.splice(m.jumps.indexOf(j), 1); else m.jumps.splice(Math.min(at, m.jumps.length), 0, j); });
    afterMapChange();
  });
  function afterMapChange() { renderMapList(); env.mapChanged(); }
  const mapPress = f => {
    const m = env.getMapData(), X = absX(f.wx), Y = absY(f.wy);
    if (mp.mode === 'start') {
      const before = m.start ? { ...m.start } : null, after = { x: X, y: Y };
      m.start = { ...after };
      mapOp(fwd => { m.start = fwd ? { ...after } : before && { ...before }; });
    } else if (mp.mode === 'jump') {
      const dstMap = Number(mUi.dst.value) || 0;
      if (!dstMap) { edit.problem = 'Pick the map the jump point leads to'; return; }
      const j = { flags: 0, x: X, y: Y, dstMap, dst: { x: Math.max(0, Math.round(Number(mUi.dx.value)) || 0), y: Math.max(0, Math.round(Number(mUi.dy.value)) || 0) } };
      m.jumps.push(j);
      mapOp(fwd => { if (fwd) m.jumps.push(j); else { const k = m.jumps.indexOf(j); if (k >= 0) m.jumps.splice(k, 1); } });
    } else if (mp.mode === 'unjump') {
      const hits = m.jumps.filter(j => j.x === X && j.y === Y); if (!hits.length) return;
      const kept = m.jumps.slice();
      m.jumps = m.jumps.filter(j => !hits.includes(j)); const after = m.jumps;
      mapOp(fwd => { m.jumps = fwd ? after : kept; });
    } else if (mp.mode === 'sector') {
      const key = `${env.minX + (f.wx >> 6)},${env.minY + (f.wy >> 6)}`, was = m.blockedSectors.has(key);
      if (was) m.blockedSectors.delete(key); else m.blockedSectors.add(key);
      mapOp(fwd => { const on = fwd ? !was : was; if (on) m.blockedSectors.add(key); else m.blockedSectors.delete(key); });
    }
    afterMapChange();
  };

  // =============================================================== what the viewer calls
  const strokeOps = [];      // history entries made by the stroke being drawn
  // (Shift snaps a paste to whole roof cells; the ghost follows the key)
  const onShift = e => { if (!panes.stamp.isConnected) { document.removeEventListener('keydown', onShift); document.removeEventListener('keyup', onShift); return; } if (e.key === 'Shift' && lastShift !== (e.type === 'keydown')) { lastShift = e.type === 'keydown'; if (edit.on && edit.tool === 'stamp') env.scheduleCursor(); } };
  document.addEventListener('keydown', onShift); document.addEventListener('keyup', onShift);
  const act = {
    // a tool was picked
    onTool(id) {
      // the map-data layers a tool switched on for itself go off again when another tool is picked
      const keep = { block: ['blocked'], sector: ['scripts'], mapdata: ['start', 'jumps', 'blocked'] }[id] || [];
      for (const k of [...autoLayers]) if (!keep.includes(k)) { env.setLayer(k, false); autoLayers.delete(k); }
      if (!owns(id)) return;
      if (id === 'roof') { env.showLayer('roofs'); env.ensureRoofArt(); if (roofUi.num.options.length) roofUi.num.value = String(roof.num); }
      if (id === 'block') useLayer('blocked');
      if (id === 'sector') { useLayer('scripts'); if (sect.mode === 'props' && !sect.sec) { /* waits for a press */ } }
      if (id === 'mapdata') {
        mp.orig ??= mapSnapshot();
        renderMapList();
        useLayer('start'); useLayer('jumps');
      }
    },
    press(tool, f, event) {
      strokeOps.length = 0;
      if (tool === 'stamp') {
        if (stamp.mode === 'select' || !stamp.clip) { stamp.mode = 'select'; stampMode.set('select'); stamp.sel = { x0: f.wx, y0: f.wy, x1: f.wx, y1: f.wy, dragging: true }; env.scheduleCursor(); }
        else paste(f, !!event?.shiftKey);
      } else if (tool === 'roof') {
        const cx = f.wx >> 2, cy = f.wy >> 2;
        if (event?.altKey) {
          const v = roofAt(cx, cy);
          if (v != null) { roof.num = secRoofNum(v); roofUi.num.value = String(roof.num); status.textContent = `Roof ${roof.num} · ${roof.names[roof.num] || ''}`; }
          return;
        }
        if (roof.shape === 'rect') { roof.drag = { cx0: cx, cy0: cy, cx1: cx, cy1: cy }; env.scheduleCursor(); }
        else applyRoof(roofCells(cx, cy));
      } else if (tool === 'light') {
        if (light.mode === 'remove') {
          const at = env.sectorAtWorld(f.wx, f.wy); if (!at) return;
          const X = absX(f.wx), Y = absY(f.wy);
          for (const l of (at.sec.decoded.lights || []).filter(l => l.x === X && l.y === Y)) env.removeLight(at.sec, l);
        } else {
          const off = light.drop ? env.pixelOffsetFor(f) : [0, 0];
          const rgb = light.flags & (LF_INDOOR | LF_OUTDOOR) ? [74, 80, 98] : light.rgb;
          env.addLight({ wx: f.wx, wy: f.wy, offsetX: off[0], offsetY: off[1], flags: light.flags, artId: LIGHT_ART(light.art), r: rgb[0], g: rgb[1], b: rgb[2] });
        }
      } else if (tool === 'block') {
        if (blockSectorMode.ring || blockSectorMode.clear) {
          const at = env.sectorAtWorld(f.wx, f.wy); if (!at) return;
          block.stroke = new Map();
          const bx = (f.wx >> 6) << 6, by = (f.wy >> 6) << 6;
          for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) {
            const edge = i === 0 || j === 0 || i === 63 || j === 63;
            if (blockSectorMode.clear) blockTile(bx + i, by + j, false); else if (edge) blockTile(bx + i, by + j, true);
          }
          this.commitStroke();
          return;
        }
        block.stroke = new Map(); blockFootprint(f.wx, f.wy, block.mode === 'block');
      } else if (tool === 'sector') {
        const at = env.sectorAtWorld(f.wx, f.wy); if (!at) return;
        if (sect.mode === 'props') { showSector(at.sec); return; }
        const d = secEnsureExtras(at.sec.decoded), before = secTileScriptAt(d, at.idx) || null;
        if (sect.mode === 'script' && !(sect.scriptNum > 0)) { edit.problem = 'Enter the number of the script first'; return; }
        const { changed } = secSetTileScript(d, at.idx, sect.mode === 'script' ? sect.scriptNum : 0);
        if (!changed) return;
        const after = secTileScriptAt(d, at.idx) || null, idx = at.idx;
        const put = node => { const k = d.tileScripts.findIndex(t => t.tile === idx); if (k >= 0) d.tileScripts.splice(k, 1); if (node) d.tileScripts.push(node); };
        strokeOps.push({ kind: 'fn', sec: at.sec, apply: fwd => put(fwd ? after : before) });
        env.markExtra(at.sec); useLayer('scripts');
      } else if (tool === 'mapdata') mapPress(f);
      env.redraw();
    },
    drag(tool, from, f) {
      if (tool === 'stamp') { if (stamp.sel?.dragging) { stamp.sel.x1 = f.wx; stamp.sel.y1 = f.wy; env.scheduleCursor(); } }
      else if (tool === 'roof') {
        if (roof.drag) { const cx = f.wx >> 2, cy = f.wy >> 2; if (cx !== roof.drag.cx1 || cy !== roof.drag.cy1) { roof.drag.cx1 = cx; roof.drag.cy1 = cy; env.scheduleCursor(); } return; }
        if (roof.shape === 'brush') applyRoof(roofCells(f.wx >> 2, f.wy >> 2));
      } else if (tool === 'block' && block.stroke && !(blockSectorMode.ring || blockSectorMode.clear)) {
        // every tile along the way, so a quick drag leaves no gaps
        let x0 = from.wx, y0 = from.wy; const x1 = f.wx, y1 = f.wy, dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          blockFootprint(x0, y0, block.mode === 'block');
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      } else if (tool === 'sector' && sect.mode !== 'props') this.press(tool, f);
      env.redraw();
    },
    // the pointer was released: the stroke becomes history entries (the viewer adds env.edit.objOps to its step)
    commitStroke() {
      if (stamp.sel?.dragging) {
        stamp.sel.dragging = false;
        stamp.clip = capture(stamp.sel); stamp.mode = 'paste'; stampMode.set('paste'); stampInfo();
        env.scheduleCursor();
      }
      if (roof.drag) { applyRoof(rectCells(roof.drag)); roof.drag = null; env.scheduleCursor(); }
      if (block.stroke) {
        for (const s of block.stroke.values()) {
          const { sec, idxs, on } = s, d = sec.decoded;
          strokeOps.push({ kind: 'fn', sec, apply: fwd => { for (const i of idxs) secSetTileBlocked(d, i, fwd ? on : !on); } });
        }
        block.stroke = null; env.redraw();
      }
      for (const o of strokeOps.splice(0)) edit.objOps.push(o);
    },
    // after an undo / redo
    afterReplay() { if (env.getMapData && mp.orig) { renderMapList(); env.mapChanged(); } if (sect.sec) showSector(sect.sec); },
    // the files of the map-level data that changed
    mapFiles() { return mp.orig ? mapParts() : []; },
    cancel() { roof.drag = null; block.stroke = null; strokeOps.length = 0; },

    // what the cursor shows: `h.footprint(cells, fill, stroke)`
    cursor(c, f, tool, h) {
      if (tool === 'stamp') {
        const border = (x0, y0, w, hh) => { const out = []; for (let i = 0; i < w; i++) for (let j = 0; j < hh; j++) if (i === 0 || j === 0 || i === w - 1 || j === hh - 1) out.push([x0 + i, y0 + j]); return out; };
        if (stamp.sel?.dragging) { const r = rectOf(stamp.sel); h.footprint(border(r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1), 'rgba(32,178,170,.2)', '#20b2aa'); }
        else if (stamp.mode === 'paste' && stamp.clip) {
          const cl = stamp.clip, a = stampAnchor(f, lastShift);
          for (const t of cl.tiles) if (stamp.tiles) env.drawTilePreview(c, t.raw, a.x + t.dx, a.y + t.dy);
          if (stamp.objects) for (const o of cl.objs.slice(0, 800)) env.drawObjectPreview(c, o.pt, a.x + o.dx, a.y + o.dy);
          h.footprint(border(a.x, a.y, cl.w, cl.h), null, lastShift ? '#7CFC9A' : '#ffe066');
        } else h.footprint([[f.wx, f.wy]], null, '#ffe066');
      } else if (tool === 'roof') {
        const cells = [];
        const addCell = (cx, cy) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells.push([cx * 4 + x, cy * 4 + y]); };
        if (roof.drag) rectCells(roof.drag).forEach(([x, y]) => addCell(x, y)); else roofCells(f.wx >> 2, f.wy >> 2).forEach(([x, y]) => addCell(x, y));
        h.footprint(cells, roof.mode === 'erase' ? 'rgba(255,143,132,.25)' : 'rgba(255,224,102,.14)', roof.mode === 'erase' ? '#ff8f84' : '#ffe066');
      } else if (tool === 'light') {
        const p = env.tileCentre(f.wx, f.wy), r = lightRadius(light.art) * (env.getMode() === 'art' ? SEC_ISO_HALF_W : 0.5) * env.zoom();
        c.save(); c.beginPath(); c.ellipse(p.x, p.y, r, env.getMode() === 'art' ? r / 2 : r, 0, 0, Math.PI * 2);
        c.strokeStyle = light.mode === 'remove' ? '#ff8f84' : `rgb(${light.rgb.join(',')})`; c.lineWidth = 2; c.setLineDash([5, 4]); c.stroke(); c.restore();
        h.footprint([[f.wx, f.wy]], null, '#ffe066');
      } else if (tool === 'block') {
        const n = edit.size, o = Math.floor((n - 1) / 2), cells = [];
        for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cells.push([f.wx + dx - o, f.wy + dy - o]);
        if (blockSectorMode.ring || blockSectorMode.clear) {
          const bx = (f.wx >> 6) << 6, by = (f.wy >> 6) << 6, ring = [];
          for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) if (blockSectorMode.clear || i === 0 || j === 0 || i === 63 || j === 63) ring.push([bx + i, by + j]);
          h.footprint(ring, blockSectorMode.clear ? 'rgba(32,178,170,.12)' : 'rgba(255,60,50,.2)', blockSectorMode.clear ? '#20b2aa' : '#ff5a4a');
        } else h.footprint(cells, block.mode === 'block' ? 'rgba(255,60,50,.3)' : 'rgba(32,178,170,.2)', block.mode === 'block' ? '#ff5a4a' : '#20b2aa');
      } else if (tool === 'sector') {
        if (sect.sec) {
          const bx = (sect.sec.position.x - env.minX) * 64, by = (sect.sec.position.y - env.minY) * 64, edge = [];
          for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) if (i === 0 || j === 0 || i === 63 || j === 63) edge.push([bx + i, by + j]);
          h.footprint(edge, 'rgba(32,178,170,.12)', '#20b2aa');
        }
        h.footprint([[f.wx, f.wy]], null, '#ffe066');
      } else if (tool === 'mapdata') {
        if (mp.mode === 'sector') {
          const bx = (f.wx >> 6) << 6, by = (f.wy >> 6) << 6, all = [];
          for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) if (i === 0 || j === 0 || i === 63 || j === 63) all.push([bx + i, by + j]);
          h.footprint(all, 'rgba(255,60,50,.12)', '#ff5a4a');
        } else h.footprint([[f.wx, f.wy]], mp.mode === 'unjump' ? 'rgba(255,143,132,.25)' : 'rgba(124,252,154,.18)', mp.mode === 'unjump' ? '#ff8f84' : '#7CFC9A');
      }
    },
    // markers drawn whenever their tool is on, hover or not
    markers(c, tool) {
      if (tool !== 'light') return;
      const z = env.zoom(), iso = env.getMode() === 'art';
      c.save(); c.lineWidth = 1.5;
      const cw = c.canvas.clientWidth, ch = c.canvas.clientHeight;   // read once, not per light
      for (const sec of env.valid) for (const l of sec.decoded?.lights || []) {
        const p = env.tileCentre(l.x - env.minX * 64, l.y - env.minY * 64);
        if (p.x < -80 || p.y < -80 || p.x > cw + 80 || p.y > ch + 80) continue;
        const ox = (l.offsetX || 0) * z * (iso ? 1 : 0), oy = (l.offsetY || 0) * z * (iso ? 1 : 0);
        const rgb = l.flags & LF_INDOOR ? [120, 160, 255] : l.flags & LF_OUTDOOR ? [255, 255, 255] : [l.r, l.g, l.b];
        const r = lightRadius((l.artId >>> 19) & 0x1FF) * (iso ? SEC_ISO_HALF_W : 0.5) * z;
        c.beginPath(); c.ellipse(p.x + ox, p.y + oy, Math.max(3, r), Math.max(2, iso ? r / 2 : r), 0, 0, Math.PI * 2);
        c.strokeStyle = `rgba(${rgb.join(',')},.85)`; c.setLineDash(l.flags & LF_DARK ? [2, 3] : []); c.stroke();
        c.beginPath(); c.arc(p.x + ox, p.y + oy, 3, 0, Math.PI * 2); c.fillStyle = `rgb(${rgb.join(',')})`; c.fill();
      }
      c.restore();
    },
    owns
  };
  return act;
}

// the tile-script / block-list state a sector shows to the viewer's "Blocked" and "Scripts" layers is read straight
// from `decoded`, so nothing else has to be handed over; re-exported for the viewer's tests
export { secExtrasDiffer, secTileBlocked };
