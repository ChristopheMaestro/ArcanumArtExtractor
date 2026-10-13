// GIF builder dialog.

import { errText } from '../core/text-io.js';
import { readCanvasPixels } from '../core/canvas-utils.js';
import { log } from '../core/log.js';
import { saveFile } from '../core/util.js';

let activeGroup = null;    // the { frames, currentIndex, ... } state for the open builder
let activeGroupRef = null; // the file-group it belongs to (for baseName / re-entry)
let gifWorkerUrl = null;

function computeBounds(frames) {
  const included = frames.filter(f => f.include);
  const list = included.length ? included : frames;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach(f => {
    minX = Math.min(minX, f.offsetX);
    minY = Math.min(minY, f.offsetY);
    maxX = Math.max(maxX, f.offsetX + f.ref.width);
    maxY = Math.max(maxY, f.offsetY + f.ref.height);
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function initZoom(gifState) {
  const bounds = computeBounds(gifState.frames);
  const maxDim = Math.max(bounds.width, bounds.height, 1);
  gifState.zoom = Math.max(0.25, Math.min(360 / maxDim, 8));
}

function redrawStage() {
  const gifState = activeGroup;
  if (!gifState) return;
  const bounds = computeBounds(gifState.frames);
  const zoom = gifState.zoom;
  const canvas = document.getElementById('gbStageCanvas');
  canvas.width = Math.max(1, Math.round(bounds.width * zoom));
  canvas.height = Math.max(1, Math.round(bounds.height * zoom));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const current = gifState.frames[gifState.currentIndex];

  function drawFrame(f, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      f.ref.canvas,
      (f.offsetX - bounds.minX) * zoom,
      (f.offsetY - bounds.minY) * zoom,
      f.ref.width * zoom,
      f.ref.height * zoom
    );
  }

  if (gifState.onionMode !== 'none') {
    if (gifState.onionMode === 'all') {
      gifState.frames.forEach((f, i) => {
        if (i === gifState.currentIndex || !f.include) return;
        drawFrame(f, gifState.onionOpacity);
      });
    } else {
      const prev = gifState.frames[gifState.currentIndex - 1];
      const next = gifState.frames[gifState.currentIndex + 1];
      if (prev) drawFrame(prev, gifState.onionOpacity);
      if (next) drawFrame(next, gifState.onionOpacity);
    }
  }

  ctx.globalAlpha = 1;
  drawFrame(current, 1);

  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--brass-strong').trim() || '#c9974f';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    (current.offsetX - bounds.minX) * zoom + 0.5,
    (current.offsetY - bounds.minY) * zoom + 0.5,
    Math.max(0, current.ref.width * zoom - 1),
    Math.max(0, current.ref.height * zoom - 1)
  );
  ctx.setLineDash([]);

  document.getElementById('gbOffsetX').value = current.offsetX;
  document.getElementById('gbOffsetY').value = current.offsetY;
  document.getElementById('gbFrameDuration').value = current.duration;
  document.getElementById('gbIncludeFrame').checked = current.include;
  document.getElementById('gbFrameLabel').textContent = `${gifState.currentIndex + 1} / ${gifState.frames.length}`;
  document.getElementById('gbEmbeddedHint').textContent =
    `Embedded header offset for this frame: ${current.ref.embeddedLeft}, ${current.ref.embeddedTop}`;

  renderThumbstrip();
}

function renderThumbstrip() {
  const gifState = activeGroup;
  const strip = document.getElementById('gbThumbstrip');
  strip.innerHTML = '';
  gifState.frames.forEach((f, i) => {
    const cell = document.createElement('div');
    cell.className = 'gb-thumb' + (i === gifState.currentIndex ? ' current' : '') + (!f.include ? ' excluded' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.include;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { f.include = cb.checked; redrawStage(); });
    cell.appendChild(cb);

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = f.ref.width;
    thumbCanvas.height = f.ref.height;
    thumbCanvas.getContext('2d').drawImage(f.ref.canvas, 0, 0);
    cell.appendChild(thumbCanvas);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `#${f.ref.index}`;
    cell.appendChild(idx);

    cell.addEventListener('click', () => { gifState.currentIndex = i; redrawStage(); });
    strip.appendChild(cell);
  });
}

function setupStageDrag() {
  const canvas = document.getElementById('gbStageCanvas');
  let dragging = false;
  let startClientX = 0, startClientY = 0, startOffsetX = 0, startOffsetY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    const gifState = activeGroup;
    if (!gifState) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    startClientX = e.clientX;
    startClientY = e.clientY;
    const current = gifState.frames[gifState.currentIndex];
    startOffsetX = current.offsetX;
    startOffsetY = current.offsetY;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const gifState = activeGroup;
    if (!gifState) return;
    const current = gifState.frames[gifState.currentIndex];
    const dx = (e.clientX - startClientX) / gifState.zoom;
    const dy = (e.clientY - startClientY) / gifState.zoom;
    current.offsetX = Math.round(startOffsetX + dx);
    current.offsetY = Math.round(startOffsetY + dy);
    redrawStage();
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
}

function buildGifStateForDirection(group, direction) {
  const frames = group.sourceFrames.filter(f => f.direction === direction);
  const state = {
    direction,
    // Default each frame's position from its hotspot, the same way the
    // game itself lines frames up: draw position = anchor - hotspot
    // (see Arcanum_ART_Files_Explanation.txt, section 2). With the
    // anchor fixed at (0,0) for every frame of this file, that puts all
    // their hotspots on top of one another, which is what a correctly
    // aligned animation looks like.
    frames: frames.map(f => ({
      ref: f,
      offsetX: -(f.hotspotX || 0),
      offsetY: -(f.hotspotY || 0),
      duration: 100,
      include: true,
    })),
    currentIndex: 0,
    onionMode: 'adjacent',
    onionOpacity: 0.35,
    loop: true,
    zoom: 1,
  };
  initZoom(state);
  return state;
}

function selectGifDirection(group, direction) {
  if (!group.gifByDirection[direction]) {
    group.gifByDirection[direction] = buildGifStateForDirection(group, direction);
  }
  activeGroup = group.gifByDirection[direction];
  activeGroupRef = group;

  const picker = document.getElementById('gbDirectionSelect');
  if (picker.value !== String(direction)) picker.value = String(direction);

  document.getElementById('gbOnionMode').value = activeGroup.onionMode;
  document.getElementById('gbOnionOpacity').value = activeGroup.onionOpacity;
  document.getElementById('gbLoop').checked = activeGroup.loop;
  document.getElementById('gbResult').classList.remove('show');
  document.getElementById('gbProgress').classList.remove('active');
  redrawStage();
}

export function openGifBuilder(group) {
  document.getElementById('gbTitle').textContent = `Build GIF — ${group.baseName}.art`;

  const directionRow = document.getElementById('gbDirectionPicker');
  const picker = document.getElementById('gbDirectionSelect');
  if (group.directionCount > 1) {
    // The frame table is stored direction by direction, framesPerDirection
    // frames at a time (see Arcanum_ART_Files_Explanation.txt) — that's
    // exactly what splits the file into these choices.
    picker.innerHTML = '';
    for (let d = 0; d < group.directionCount; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = `Direction ${d + 1} (${group.framesPerDirection} frame${group.framesPerDirection === 1 ? '' : 's'})`;
      picker.appendChild(opt);
    }
    directionRow.hidden = false;
  } else {
    directionRow.hidden = true;
  }

  document.getElementById('gbOverlay').classList.add('open');
  selectGifDirection(group, group.lastDirection || 0);
}

export function closeGifBuilder() {
  if (activeGroupRef && activeGroup) activeGroupRef.lastDirection = activeGroup.direction;
  document.getElementById('gbOverlay').classList.remove('open');
  activeGroup = null;
  activeGroupRef = null;
}

async function getGifWorkerUrl() {
  if (gifWorkerUrl) return gifWorkerUrl;
  const resp = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
  if (!resp.ok) throw new Error(`couldn't load the GIF worker script (HTTP ${resp.status})`);
  const text = await resp.text();
  gifWorkerUrl = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
  return gifWorkerUrl;
}

// GIF has one transparent colour. Pick a key that no included frame uses
// (and that is far from the colours they do use, since the encoder matches
// by nearest palette entry) instead of always sacrificing pure magenta.
function pickGifTransparentKey(frames) {
  const used = new Set();
  for (const f of frames) {
    const c = f.ref.canvas;
    if (!c.width || !c.height) continue;
    const px = readCanvasPixels(c); if (!px) continue;
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) used.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      if (used.size > 20000) break;
    }
  }
  const usedList = Array.from(used);
  const candidates = [0xFF00FF, 0x00FFFF, 0xFFFF00, 0x00FF00, 0xFF0000, 0x0000FF, 0x7F007F, 0x007F7F, 0x7F7F00];
  let best = candidates[0], bestDist = -1;
  for (const cand of candidates) {
    const cr = cand >> 16, cg = (cand >> 8) & 255, cb = cand & 255;
    let min = Infinity;
    for (const u of usedList) {
      const dr = (u >> 16) - cr, dg = ((u >> 8) & 255) - cg, db = (u & 255) - cb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < min) min = dist;
      if (min <= bestDist) break;
    }
    if (min > bestDist) { bestDist = min; best = cand; }
  }
  return best;
}

async function compileGif() {
  const gifState = activeGroup;
  const group = activeGroupRef;
  if (!gifState || !group) return;

  const included = gifState.frames.filter(f => f.include);
  if (included.length === 0) {
    log('select at least one frame to include in the GIF', 'err');
    return;
  }

  const bounds = computeBounds(gifState.frames);
  const compileBtn = document.getElementById('gbCompile');
  const progress = document.getElementById('gbProgress');
  const progressBar = document.getElementById('gbProgressBar');
  compileBtn.disabled = true;
  progress.classList.add('active');
  progressBar.style.width = '0%';
  document.getElementById('gbResult').classList.remove('show');

  try {
    const workerScript = await getGifWorkerUrl();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const keyColor = pickGifTransparentKey(included);
    const keyCss = '#' + keyColor.toString(16).padStart(6, '0');
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width,
      height,
      transparent: keyColor,
      workerScript,
      repeat: gifState.loop ? 0 : -1,
    });

    for (const f of included) {
      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = width;
      frameCanvas.height = height;
      const ctx = frameCanvas.getContext('2d');
      ctx.fillStyle = keyCss;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(f.ref.canvas, Math.round(f.offsetX - bounds.minX), Math.round(f.offsetY - bounds.minY));
      gif.addFrame(frameCanvas, { delay: f.duration, copy: true });
    }

    const blob = await new Promise((resolve, reject) => {
      gif.on('progress', (p) => { progressBar.style.width = `${Math.round(p * 100)}%`; });
      gif.on('finished', (b) => resolve(b));
      gif.on('abort', () => reject(new Error('GIF encoding was aborted')));
      gif.render();
    });

    const resultImg = document.getElementById('gbResultImg');
    if (resultImg.src && resultImg.src.startsWith('blob:')) URL.revokeObjectURL(resultImg.src);
    const url = URL.createObjectURL(blob);
    resultImg.src = url;
    document.getElementById('gbResult').classList.add('show');
    const suffix = group.directionCount > 1 ? `_dir${gifState.direction + 1}` : '';
    const outName = `${group.baseName}${suffix}.gif`;
    document.getElementById('gbDownload').onclick = () => saveFile(outName, blob);
    log(`${group.baseName}: compiled a ${included.length}-frame GIF${suffix ? ` for direction ${gifState.direction + 1}` : ''}`, 'ok');
  } catch (err) {
    log(`GIF compile failed: ${errText(err)}`, 'err');
  } finally {
    compileBtn.disabled = false;
    progress.classList.remove('active');
  }
}

setupStageDrag();

document.getElementById('gbClose').addEventListener('click', closeGifBuilder);
document.getElementById('gbDirectionSelect').addEventListener('change', (e) => {
  if (!activeGroupRef) return;
  selectGifDirection(activeGroupRef, parseInt(e.target.value, 10) || 0);
});
document.getElementById('gbOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'gbOverlay') closeGifBuilder();
});
document.getElementById('gbPrev').addEventListener('click', () => {
  if (!activeGroup) return;
  activeGroup.currentIndex = (activeGroup.currentIndex - 1 + activeGroup.frames.length) % activeGroup.frames.length;
  redrawStage();
});
document.getElementById('gbNext').addEventListener('click', () => {
  if (!activeGroup) return;
  activeGroup.currentIndex = (activeGroup.currentIndex + 1) % activeGroup.frames.length;
  redrawStage();
});
document.getElementById('gbOffsetX').addEventListener('input', (e) => {
  if (!activeGroup) return;
  activeGroup.frames[activeGroup.currentIndex].offsetX = parseInt(e.target.value, 10) || 0;
  redrawStage();
});
document.getElementById('gbOffsetY').addEventListener('input', (e) => {
  if (!activeGroup) return;
  activeGroup.frames[activeGroup.currentIndex].offsetY = parseInt(e.target.value, 10) || 0;
  redrawStage();
});
document.getElementById('gbIncludeFrame').addEventListener('change', (e) => {
  if (!activeGroup) return;
  activeGroup.frames[activeGroup.currentIndex].include = e.target.checked;
  redrawStage();
});
document.getElementById('gbFrameDuration').addEventListener('input', (e) => {
  if (!activeGroup) return;
  const v = parseInt(e.target.value, 10);
  activeGroup.frames[activeGroup.currentIndex].duration = (Number.isFinite(v) && v > 0) ? v : 100;
});
document.getElementById('gbOnionMode').addEventListener('change', (e) => {
  if (!activeGroup) return;
  activeGroup.onionMode = e.target.value;
  redrawStage();
});
document.getElementById('gbOnionOpacity').addEventListener('input', (e) => {
  if (!activeGroup) return;
  activeGroup.onionOpacity = parseFloat(e.target.value) || 0.35;
  redrawStage();
});
document.getElementById('gbAlignTopLeft').addEventListener('click', () => {
  if (!activeGroup) return;
  const current = activeGroup.frames[activeGroup.currentIndex];
  current.offsetX = 0;
  current.offsetY = 0;
  redrawStage();
});
document.getElementById('gbAlignCenter').addEventListener('click', () => {
  if (!activeGroup) return;
  const bounds = computeBounds(activeGroup.frames);
  const current = activeGroup.frames[activeGroup.currentIndex];
  current.offsetX = Math.round(bounds.minX + (bounds.width - current.ref.width) / 2);
  current.offsetY = Math.round(bounds.minY + (bounds.height - current.ref.height) / 2);
  redrawStage();
});
document.getElementById('gbAlignEmbedded').addEventListener('click', () => {
  if (!activeGroup) return;
  const current = activeGroup.frames[activeGroup.currentIndex];
  current.offsetX = -(current.ref.embeddedLeft || 0);
  current.offsetY = -(current.ref.embeddedTop || 0);
  redrawStage();
});
document.getElementById('gbAlignAllCenter').addEventListener('click', () => {
  if (!activeGroup) return;
  const included = activeGroup.frames.filter(f => f.include);
  const list = included.length ? included : activeGroup.frames;
  const maxW = Math.max(...list.map(f => f.ref.width));
  const maxH = Math.max(...list.map(f => f.ref.height));
  activeGroup.frames.forEach(f => {
    f.offsetX = Math.round((maxW - f.ref.width) / 2);
    f.offsetY = Math.round((maxH - f.ref.height) / 2);
  });
  redrawStage();
});
document.getElementById('gbApplyDuration').addEventListener('click', () => {
  if (!activeGroup) return;
  const v = parseInt(document.getElementById('gbGlobalDuration').value, 10);
  const dur = (Number.isFinite(v) && v > 0) ? v : 100;
  activeGroup.frames.forEach(f => { f.duration = dur; });
  redrawStage();
});
document.getElementById('gbLoop').addEventListener('change', (e) => {
  if (!activeGroup) return;
  activeGroup.loop = e.target.checked;
});
document.getElementById('gbCompile').addEventListener('click', compileGif);

document.addEventListener('keydown', (e) => {
  if (!document.getElementById('gbOverlay').classList.contains('open')) return;
  if (e.key === 'Escape') { closeGifBuilder(); return; }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!activeGroup) return;
  const current = activeGroup.frames[activeGroup.currentIndex];
  const step = e.shiftKey ? 10 : 1;
  let handled = true;
  if (e.key === 'ArrowLeft') current.offsetX -= step;
  else if (e.key === 'ArrowRight') current.offsetX += step;
  else if (e.key === 'ArrowUp') current.offsetY -= step;
  else if (e.key === 'ArrowDown') current.offsetY += step;
  else handled = false;
  if (handled) { e.preventDefault(); redrawStage(); }
});
