// .ART Packer dialog: pick what the file is for, add frames, place the hotspot on a preview, build.

import { errText } from '../core/text-io.js';
import { buildArtBuffer, buildBmpBuffer, parseBmp, readArtTemplate } from './packer-art-builder.js';
import { convertPngToFrame, remapToPalette } from './packer-png.js';
import { PACKER_EDGES, PACKER_KINDS, walkStride } from './packer-kinds.js';
import { createGuide } from './packer-guide.js';
import { indicesToRgba, paletteRgbaLut } from './art-export.js';
import { packerLaunchBtn } from '../core/dom.js';
import { saveFile } from '../core/util.js';
import { openToolPage, registerToolPage } from '../editor/tool-pages.js';

const $ = id => document.getElementById(id);
const packerOverlayEl = $('packerOverlay');
const packerKindsEl = $('packerKinds');
const packerKindBlurbEl = $('packerKindBlurb');
const packerActivityFieldEl = $('packerActivityField');
const packerActivityEl = $('packerActivity');
const packerEdgeFieldEl = $('packerEdgeField');
const packerEdgeEl = $('packerEdge');
const packerFpsFieldEl = $('packerFpsField');
const packerFpsEl = $('packerFps');
const packerActionFieldEl = $('packerActionField');
const packerActionEl = $('packerAction');
const packerFramesHintEl = $('packerFramesHint');
const packerSummaryEl = $('packerSummary');
const packerFrameListEl = $('packerFrameList');
const packerStageHintEl = $('packerStageHint');
const packerStageEl = $('packerStage');
const packerZoomEl = $('packerZoom');
const packerMoveTogetherEl = $('packerMoveTogether');
const packerHotResetBtn = $('packerHotReset');
const packerHotAllBtn = $('packerHotAll');
const packerStrideBtn = $('packerStride');
const packerTemplateInputEl = $('packerTemplateInput');
const packerTemplateStatusEl = $('packerTemplateStatus');
const packerExportBtn = $('packerExport');
const packerClearBtn = $('packerClearBtn');
const packerLogEl = $('packerLog');

// [{ id, name, width, height, indices, palette, outIndices, canvas, paletteMismatch, note, hotX, hotY, moveX, moveY }]
export let packerFrames = [];
let packerFramesSeq = 0;
let packerBlob = null;
let legacyHeader = null;        // header words the loader ignores, taken from a reference file
let selected = 0;
const settings = { kind: 'object', activity: 'still', rotation: 0 };

const kindDef = () => PACKER_KINDS[settings.kind];
const activityDef = () => kindDef().activities[settings.activity];
const directions = () => kindDef().directions;
// Images per direction, or 0 when the count doesn't divide evenly.
function framesPerDirection() {
  const n = packerFrames.length, d = directions();
  return n > 0 && n % d === 0 ? n / d : 0;
}

export function packerLog(message, kind) {
  const p = document.createElement('p');
  if (kind) p.className = kind;
  p.textContent = message;
  packerLogEl.appendChild(p);
  packerLogEl.classList.add('has-entries');
  packerLogEl.scrollTop = packerLogEl.scrollHeight;
}

function palettesEqual(a, b) {
  for (let i = 0; i < 256; i++) {
    const ca = a[i] || [0, 0, 0];
    const cb = b[i] || [0, 0, 0];
    if (ca[0] !== cb[0] || ca[1] !== cb[1] || ca[2] !== cb[2]) return false;
  }
  return true;
}

// Palette index 0 is the transparent colour in the game, so that is what a thumbnail shows as clear.
function buildFrameThumbCanvas(width, height, indices, palette) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const total = width * height;
  const rgba = indicesToRgba(indices, total, paletteRgbaLut(palette, 0), total);
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

// A BMP painted in an ordinary editor marks transparency with pure blue wherever it landed in the
// palette. The game wants it on index 0, so swap the two (pixels and palette).
function moveBlueToIndexZero(indices, palette) {
  const isBlue = c => c && c[0] === 0 && c[1] === 0 && c[2] === 255;
  if (isBlue(palette[0])) return { indices, palette, note: '' };
  const used = new Uint8Array(256);
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1;
  let k = -1;
  for (let i = 1; i < 256; i++) if (isBlue(palette[i]) && (used[i] || k < 0)) { k = i; if (used[i]) break; }
  if (k < 0) {
    const c = palette[0] || [0, 0, 0];
    return { indices, palette, note: `no pure blue (0,0,255) in this BMP, so the colour on index 0 (${c.join(',')}) will be transparent in the game` };
  }
  const pal = palette.map(c => c.slice());
  [pal[0], pal[k]] = [pal[k], pal[0]];
  const out = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = indices[i] === 0 ? k : indices[i] === k ? 0 : indices[i];
  return { indices: out, palette: pal, note: 'moved pure blue to palette index 0' };
}

function defaultHotspot(frame) {
  const [x, y] = kindDef().hotspot(frame.width, frame.height);
  frame.hotX = x; frame.hotY = y;
}

function invalidatePackerBuild() {
  packerBlob = null;
}

// Everything that depends on the set of frames: shared palette, recoloured copies, thumbnails.
function syncPackerFrames() {
  invalidatePackerBuild();
  if (packerFrames.length === 0) return;
  const base = packerFrames[0].palette;
  packerFrames.forEach((f, i) => {
    f.paletteMismatch = i > 0 && !palettesEqual(base, f.palette);
    f.outIndices = f.paletteMismatch ? remapToPalette(f.indices, f.palette, base) : f.indices;
    f.canvas = buildFrameThumbCanvas(f.width, f.height, f.outIndices, base);
  });
  selected = Math.min(selected, packerFrames.length - 1);
}

// ---- purpose / options ---------------------------------------------------------------------

function renderKinds() {
  packerKindsEl.innerHTML = '';
  for (const [key, def] of Object.entries(PACKER_KINDS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'packer-kind' + (key === settings.kind ? ' active' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(key === settings.kind));
    const strong = document.createElement('strong'); strong.textContent = def.label;
    const small = document.createElement('small'); small.textContent = def.folders;
    b.append(strong, small);
    b.addEventListener('click', () => setKind(key));
    packerKindsEl.appendChild(b);
  }
}

function setKind(key) {
  if (!PACKER_KINDS[key]) return;
  settings.kind = key;
  settings.activity = Object.keys(kindDef().activities)[0];
  packerFps(activityDef().fps);
  packerActionEl.value = '';
  packerFrames.forEach(defaultHotspot);
  packerFrames.forEach(f => { f.moveX = 0; f.moveY = 0; });
  refreshAll();
}

const packerFps = v => { packerFpsEl.value = String(v); };

function syncOptions() {
  const def = kindDef();
  renderKinds();
  packerKindBlurbEl.textContent = def.blurb;
  const acts = Object.entries(def.activities);
  packerActivityFieldEl.hidden = acts.length < 2;
  packerActivityEl.innerHTML = '';
  for (const [k, a] of acts) {
    const o = document.createElement('option'); o.value = k; o.textContent = a.label; packerActivityEl.appendChild(o);
  }
  packerActivityEl.value = settings.activity;
  packerEdgeFieldEl.hidden = def.guide !== 'wall';
  packerFpsFieldEl.hidden = packerActionFieldEl.hidden = !def.multiFrame;
  packerStrideBtn.hidden = !activityDef().movement;
  packerStageHintEl.textContent = def.hotspotHelp + (def.guide === 'none' ? '' : ' Drag the picture, or click the preview and use the arrow keys (Shift = 10 px).');
  const per = def.directions === 8 ? 'Give them direction by direction: all the frames of direction 0, then of direction 1… up to 7. ' : '';
  packerFramesHintEl.textContent = per + (def.multiFrame ? 'One image per frame, in play order.' : 'A single image.') + (def.size ? ` Expected size ${def.size[0]} × ${def.size[1]}.` : '');
}

function initEdgeSelect() {
  for (const e of PACKER_EDGES) {
    const o = document.createElement('option'); o.value = String(e.rotation); o.textContent = e.label; packerEdgeEl.appendChild(o);
  }
}

// ---- frame list ----------------------------------------------------------------------------

function numberInput(title, value, onChange) {
  const input = document.createElement('input');
  input.type = 'number'; input.step = '1'; input.title = title; input.value = value;
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('input', () => { onChange(parseInt(input.value, 10) || 0); invalidatePackerBuild(); stage.redraw(); });
  return input;
}

function frameLabel(idx) {
  const per = framesPerDirection();
  if (directions() === 8 && per) return `dir ${Math.floor(idx / per)} · frame ${idx % per}`;
  return String(idx);
}

function renderPackerFrameList() {
  packerFrameListEl.innerHTML = '';
  const walk = !!activityDef().movement;
  packerFrames.forEach((frame, idx) => {
    const li = document.createElement('li');
    li.className = 'packer-frame-item' + (idx === selected ? ' selected' : '');
    li.addEventListener('click', () => { selected = idx; renderPackerFrameList(); stage.redraw(); });

    const thumb = document.createElement('span');
    thumb.className = 'packer-frame-thumb';
    thumb.appendChild(frame.canvas);
    li.appendChild(thumb);

    const info = document.createElement('span');
    info.className = 'packer-frame-info';
    const name = document.createElement('span');
    name.className = 'packer-frame-name';
    name.textContent = `${frameLabel(idx)}: ${frame.name}`;
    info.appendChild(name);
    const dims = document.createElement('span');
    dims.className = 'packer-frame-dims';
    dims.textContent = `${frame.width}×${frame.height}`;
    info.appendChild(dims);
    if (frame.paletteMismatch) {
      const warn = document.createElement('span');
      warn.className = 'packer-frame-warning';
      warn.textContent = 'palette differs from frame 0: recoloured to match';
      info.appendChild(warn);
    }
    li.appendChild(info);

    const hot = document.createElement('span');
    hot.className = 'packer-frame-offsets';
    hot.title = 'Hotspot: the point of the picture that sits on the anchor';
    hot.append(numberInput('Hotspot X', frame.hotX, v => { frame.hotX = v; }), numberInput('Hotspot Y', frame.hotY, v => { frame.hotY = v; }));
    li.appendChild(hot);
    if (walk) {
      const mv = document.createElement('span');
      mv.className = 'packer-frame-offsets packer-frame-move';
      mv.title = 'Movement: how far this frame carries the critter on screen (px)';
      mv.append(numberInput('Movement X', frame.moveX, v => { frame.moveX = v; }), numberInput('Movement Y', frame.moveY, v => { frame.moveY = v; }));
      li.appendChild(mv);
    }

    const actions = document.createElement('span');
    actions.className = 'packer-frame-actions';
    const mk = (text, title, fn, cls) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text; b.title = title; if (cls) b.className = cls;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      actions.appendChild(b); return b;
    };
    mk('⬇', 'Download as .bmp', () => downloadPackerFrameBmp(frame));
    mk('↑', 'Move up', () => movePackerFrame(frame.id, -1)).disabled = idx === 0;
    mk('↓', 'Move down', () => movePackerFrame(frame.id, 1)).disabled = idx === packerFrames.length - 1;
    mk('✕', 'Remove', () => removePackerFrame(frame.id), 'packer-remove');
    li.appendChild(actions);

    packerFrameListEl.appendChild(li);
  });
}

// What the frames add up to for the chosen purpose: the count the file will have, or what is wrong.
function summaryProblem() {
  const n = packerFrames.length, def = kindDef();
  if (n === 0) return null;
  if (def.directions === 8 && n % 8) return `8 directions need the same number of frames each: ${n} image${n === 1 ? '' : 's'} added, the next multiple of 8 is ${Math.ceil(n / 8) * 8}.`;
  if (!def.multiFrame && n > 1) return `${def.label} holds a single picture, but ${n} are added.`;
  return null;
}

function renderSummary() {
  const n = packerFrames.length;
  packerSummaryEl.classList.remove('err');
  if (n === 0) { packerSummaryEl.textContent = ''; return; }
  const problem = summaryProblem();
  if (problem) { packerSummaryEl.textContent = problem; packerSummaryEl.classList.add('err'); return; }
  const per = framesPerDirection();
  const def = kindDef();
  const odd = def.size && packerFrames.some(f => f.width !== def.size[0] || f.height !== def.size[1]);
  packerSummaryEl.textContent = def.directions === 8
    ? `${n} images = 8 directions × ${per} frame${per === 1 ? '' : 's'}.`
    : `${n} frame${n === 1 ? '' : 's'}.`;
  if (odd) {
    packerSummaryEl.textContent += ` Floor tiles are ${def.size[0]} × ${def.size[1]}: some of these are not.`;
    packerSummaryEl.classList.add('err');
  }
}

function refreshAll() {
  invalidatePackerBuild();
  syncOptions();
  renderSummary();
  renderPackerFrameList();
  stage.redraw();
}

function movePackerFrame(id, dir) {
  const idx = packerFrames.findIndex(f => f.id === id);
  const swapWith = idx + dir;
  if (idx === -1 || swapWith < 0 || swapWith >= packerFrames.length) return;
  [packerFrames[idx], packerFrames[swapWith]] = [packerFrames[swapWith], packerFrames[idx]];
  selected = swapWith;
  syncPackerFrames();
  refreshAll();
}

function removePackerFrame(id) {
  packerFrames = packerFrames.filter(f => f.id !== id);
  syncPackerFrames();
  refreshAll();
}

function clearPackerFrames() {
  packerFrames = [];
  selected = 0;
  refreshAll();
}

export async function handlePackerFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.(bmp|png)$/i.test(f.name));
  if (files.length === 0) {
    packerLog('no .BMP or .PNG files in that selection', 'err');
    return;
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of files) {
    try {
      let width, height, indices, palette, note = '';
      if (/\.png$/i.test(file.name)) {
        const converted = await convertPngToFrame(file);
        width = converted.width;
        height = converted.height;
        indices = converted.indices;
        palette = converted.palette;
        note = converted.usingSharedPalette
          ? ' — mapped onto frame 0\'s palette'
          : ' — built a new palette from its colors';
      } else {
        const buf = await file.arrayBuffer();
        const bmp = parseBmp(buf);
        width = bmp.width; height = bmp.height;
        const fixed = moveBlueToIndexZero(bmp.indices, bmp.palette);
        indices = fixed.indices; palette = fixed.palette;
        if (fixed.note) note = ` — ${fixed.note}`;
      }
      packerFramesSeq += 1;
      const frame = {
        id: packerFramesSeq,
        name: file.name,
        width, height, indices, palette,
        outIndices: indices, paletteMismatch: false,
        hotX: 0, hotY: 0, moveX: 0, moveY: 0,
        canvas: buildFrameThumbCanvas(width, height, indices, palette),
      };
      defaultHotspot(frame);
      packerFrames.push(frame);
      packerLog(`${file.name}: added (${width}×${height})${note}`, 'ok');
    } catch (err) {
      packerLog(`${file.name}: ${errText(err)}`, 'err');
    }
  }
  syncPackerFrames();
  refreshAll();
}

async function downloadPackerFrameBmp(frame) {
  const buf = buildBmpBuffer(frame.width, frame.height, frame.outIndices, packerFrames[0].palette);
  const blob = new Blob([buf], { type: 'image/bmp' });
  await saveFile(`${frame.name.replace(/\.(bmp|png)$/i, '')}.bmp`, blob);
}

// ---- hotspot stage -------------------------------------------------------------------------

const stage = createGuide(packerStageEl, () => {
  const def = kindDef();
  const f = packerFrames[selected];
  return {
    guide: def.guide,
    rotation: settings.rotation,
    zoom: Number(packerZoomEl.value) || 2,
    frame: f ? { canvas: f.canvas, hotX: f.hotX, hotY: f.hotY } : null,
  };
}, (dx, dy) => shiftHotspot(dx, dy));

// Change the hotspot of the selected frame (or of all of them) by a delta in picture pixels.
function shiftHotspot(dx, dy) {
  const targets = packerMoveTogetherEl.checked ? packerFrames : [packerFrames[selected]].filter(Boolean);
  for (const f of targets) { f.hotX += dx; f.hotY += dy; }
  invalidatePackerBuild();
  packerFrameListEl.querySelectorAll('.packer-frame-item').forEach((li, i) => {
    const f = packerFrames[i];
    const inputs = li.querySelectorAll('.packer-frame-offsets:not(.packer-frame-move) input');
    if (f && inputs.length === 2) { inputs[0].value = f.hotX; inputs[1].value = f.hotY; }
  });
  stage.redraw();
}

packerStageEl.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1;
  const mirrored = kindDef().guide === 'wall' && (settings.rotation & 2) !== 0;
  // An arrow moves the picture that way; the hotspot moves the other way.
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!moves || !packerFrames[selected] || kindDef().guide === 'none' || kindDef().guide === 'tile') return;
  e.preventDefault();
  shiftHotspot((mirrored ? 1 : -1) * moves[0] * step, -moves[1] * step);
});
packerZoomEl.addEventListener('change', () => stage.redraw());
packerHotResetBtn.addEventListener('click', () => { packerFrames.forEach(defaultHotspot); refreshAll(); });
packerHotAllBtn.addEventListener('click', () => {
  const f = packerFrames[selected];
  if (!f) return;
  packerFrames.forEach(o => { o.hotX = f.hotX; o.hotY = f.hotY; });
  refreshAll();
});
packerStrideBtn.addEventListener('click', () => {
  const per = framesPerDirection();
  if (!per) { packerLog('add a multiple of 8 images first', 'err'); return; }
  packerFrames.forEach((f, i) => {
    const s = walkStride(Math.floor(i / per), per)[i % per];
    f.moveX = s.x; f.moveY = s.y;
  });
  packerLog(`walking movement filled in: one tile step per direction over ${per} frames`, 'ok');
  refreshAll();
});

// ---- build ---------------------------------------------------------------------------------

function buildPacker() {
  if (packerFrames.length === 0) {
    packerLog('add at least one .BMP or .PNG frame first', 'err');
    return;
  }
  const problem = summaryProblem();
  if (problem) { packerLog(problem, 'err'); return; }
  try {
    const per = framesPerDirection();
    const walk = !!activityDef().movement;
    const actionText = packerActionEl.value.trim();
    const spec = {
      directions: directions(),
      framesPerDirection: per,
      fps: Math.max(1, parseInt(packerFpsEl.value, 10) || activityDef().fps),
      actionFrame: actionText === '' ? Math.max(0, per - 1) : Math.max(0, parseInt(actionText, 10) || 0),
      flags: activityDef().flags,
      legacy: legacyHeader,
    };
    const frames = packerFrames.map(f => ({
      width: f.width, height: f.height, indices: f.outIndices,
      hotX: f.hotX, hotY: f.hotY, moveX: walk ? f.moveX : 0, moveY: walk ? f.moveY : 0,
    }));
    const buf = buildArtBuffer(frames, packerFrames[0].palette, spec);
    packerBlob = new Blob([buf], { type: 'application/octet-stream' });
    packerLog(`built ${kindDef().label.toLowerCase()}: ${directions() === 8 ? `8 directions × ${per} frames` : `${per} frame${per === 1 ? '' : 's'}`} — ${buf.byteLength.toLocaleString()} bytes`, 'ok');
  } catch (err) {
    packerLog(`build failed: ${errText(err)}`, 'err');
  }
}

// Export: builds the .art and saves it, named after the first frame that was added.
async function exportPacker() {
  buildPacker();
  if (!packerBlob) return;
  const name = (packerFrames[0].name.replace(/\.(bmp|png)$/i, '').trim()) || 'output';
  await saveFile(`${name}.art`, packerBlob);
}

// The packer is a page of the window, not a pop-up: purpose and frames in the left bar, the hotspot preview in the
// centre, the build in the right bar (see tool-pages.js).
{
  const steps = [...packerOverlayEl.querySelectorAll('.packer-step')];
  registerToolPage('packer', { title: '.ART Packer', leftWidth: 300, rightWidth: 400, rightTitle: 'Settings and frames',
    rightAction: packerExportBtn, left: [steps[0]], main: [steps[3]], right: [steps[1], steps[2], steps[4]] });
  packerOverlayEl.remove();
}

function openPacker() {
  openToolPage('packer');
  stage.load();
  stage.redraw();
}

packerLaunchBtn.addEventListener('click', openPacker);
document.addEventListener('toolpageopen', (e) => { if (e.detail === 'packer') { stage.load(); stage.redraw(); } });
packerExportBtn.addEventListener('click', exportPacker);
packerClearBtn.addEventListener('click', clearPackerFrames);
packerActivityEl.addEventListener('change', () => {
  settings.activity = packerActivityEl.value;
  packerFps(activityDef().fps);
  refreshAll();
});
packerEdgeEl.addEventListener('change', () => { settings.rotation = Number(packerEdgeEl.value) || 0; stage.redraw(); });
for (const el of [packerFpsEl, packerActionEl]) el.addEventListener('input', invalidatePackerBuild);

// A reference file only lends its settings: speed, action frame, walking or not, and the header words
// the loader ignores. Its pictures and hotspots are not copied.
packerTemplateInputEl.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const t = readArtTemplate(await file.arrayBuffer());
    if (t.directions === 8 && kindDef().directions !== 8) setKind('creature');
    else if (t.directions === 1 && kindDef().directions !== 1) setKind('object');
    const acts = kindDef().activities;
    settings.activity = (t.flags & 2) && acts.walk ? 'walk' : (Object.keys(acts).find(k => !acts[k].movement) || Object.keys(acts)[0]);
    packerFps(t.fps || activityDef().fps);
    packerActionEl.value = String(t.actionFrame);
    legacyHeader = t.legacy;
    packerTemplateStatusEl.textContent = `${file.name}: ${t.directions} direction${t.directions === 1 ? '' : 's'} × ${t.framesPerDirection}, ${t.fps} fps, action frame ${t.actionFrame}`;
    packerTemplateStatusEl.classList.remove('err');
    refreshAll();
  } catch (err) {
    legacyHeader = null;
    packerTemplateStatusEl.textContent = `${file.name}: ${errText(err)}`;
    packerTemplateStatusEl.classList.add('err');
  }
});

initEdgeSelect();
packerFps(activityDef().fps);
refreshAll();
