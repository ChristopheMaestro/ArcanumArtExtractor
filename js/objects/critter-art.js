// Critter map art loading.

import { parseArtBuffer } from '../art/art-decoder.js';
import { frameCanvasForPalette } from '../art/art-export.js';
import { CRITTER_ART_ROOT, MONSTER_ART_ROOT } from '../core/config.js';
import { flipCanvasHorizontally, pickArtFrameForRotation } from './art-frames.js';
import { resolveMonsterArtUrl } from '../proto/critter-aid.js';

// One fetch per critter/monster/unique-NPC ART file, and one decode per
// (file, frame number) that decodes only that frame of each direction. Shared
// by the map sprites and the proto thumbnails/preview. Misses are cached too.
const critterBufferCache = new Map();
const critterFrameCache = new Map();
function loadCritterBuffer(url) {
  let p = critterBufferCache.get(url);
  if (!p) {
    p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    critterBufferCache.set(url, p);
  }
  return p;
}
export function loadCritterFrames(url, frameNo = 0) {
  const f = Number.isInteger(frameNo) && frameNo > 0 ? frameNo : 0;
  const key = `${url}|f${f}`;
  let p = critterFrameCache.get(key);
  if (!p) {
    p = loadCritterBuffer(url).then(async buf => {
      let frames = await parseArtBuffer(buf, Infinity, { firstPerDirection: true, frame: f });
      if (!frames.length && f > 0) frames = await parseArtBuffer(buf, Infinity, { firstPerDirection: true, frame: 0 });
      return frames;
    });
    critterFrameCache.set(key, p);
  }
  return p;
}

// The canvas of a decoded frame in the palette selected by the art id (bits 4-5).
// parseArtBuffer() composes frame.canvas with the file's first palette; any other
// palette is re-coloured from the frame's indices. Ids that name a palette the
// file does not have fall back to the last one it has, like scenery does.
export function critterFrameSource(frame, paletteIndex) {
  const palettes = frame?.palettes;
  if (!Number.isInteger(paletteIndex) || paletteIndex <= 0 || !palettes || palettes.length < 2 || !frame.indices) return frame?.canvas;
  const idx = Math.min(palettes.length - 1, paletteIndex);
  return frameCanvasForPalette(frame, palettes[idx], 0);
}

// Resolves which ART file actually exists for a critter/monster/unique-NPC id
// (cached per requested file set). The decoded weapon+animation file is tried
// first, then the same weapon's base animation, then the unarmed base file --
// many weapon/animation combinations do not exist for every body/armour.
const critterArtResolveCache = new Map();
export function resolveCritterArt(info) {
  if (!info || !info.filename) return Promise.resolve(null);
  const names = info.candidates || [info.filename];
  const key = info.monster
    ? `m|${info.artRoot || MONSTER_ART_ROOT}${info.monsterFolder}/${info.monsterCode}|${info.waKey}`
    : `c|${names.join('|')}`;
  let p = critterArtResolveCache.get(key);
  if (!p) {
    p = (async () => {
      if (info.monster) {
        const url = await resolveMonsterArtUrl(info);
        if (!url) return null;
        const file = decodeURIComponent(url.split('/').pop());
        const stem = file.toLowerCase().replace(/\.art$/, '');
        const fallback = !(info.waLetters && stem.endsWith(info.waLetters));
        return { url, file, wanted: info.waLetters || null, fallback };
      }
      for (let i = 0; i < names.length; i++) {
        const url = `${CRITTER_ART_ROOT}${names[i].split('\\').map(encodeURIComponent).join('/')}`;
        const ok = await loadCritterFrames(url, info.frameNo).then(() => true, () => false);
        if (ok) return { url, file: names[i].split('\\').pop(), wanted: names[0].split('\\').pop(), fallback: i > 0 };
      }
      return null;
    })();
    critterArtResolveCache.set(key, p);
  }
  return p;
}

// The walk animation of a critter, for NPCs that roam the map. `info` is a critter art
// info (protoCritterAidInfo) already switched to the walk animation (anim 1, file letter
// 'b'). Resolves to { dirs, fps } where dirs[rotation] lists that direction's frames
// ({ canvas, hotspotX, hotspotY }), or null when no walk ART exists: resolveCritterArt()
// falls back to the idle file in that case, which must not be played as a walk.
const critterWalkCache = new Map();
export async function loadCritterWalkArt(info) {
  const res = await resolveCritterArt(info);
  if (!res || !/b\.art$/i.test(res.file)) return null;
  const key = `${res.url}|p${info.palette || 0}`;
  let p = critterWalkCache.get(key);
  if (!p) {
    p = loadCritterBuffer(res.url).then(buf => parseArtBuffer(buf, Infinity)).then(frames => {
      if ((frames.directionCount || 1) < 8) return null;
      const byDir = Array.from({ length: 8 }, () => []);
      for (const f of frames) {
        if (!(f.width > 0 && f.height > 0) || f.direction > 7) continue;
        const canvas = critterFrameSource(f, info.palette);
        // moveX / moveY: how far the game shifts the critter on screen (px) when this frame is shown.
        if (canvas) byDir[f.direction].push({ canvas, hotspotX: Number(f.hotspotX) || 0, hotspotY: Number(f.hotspotY) || 0, moveX: Number(f.movementOffsetX) || 0, moveY: Number(f.movementOffsetY) || 0 });
      }
      // A direction with no image reuses the opposite-handed one, mirrored.
      const dirs = byDir.map((list, r) => {
        if (list.length) return list;
        return byDir[(8 - r) % 8].map(f => ({ canvas: flipCanvasHorizontally(f.canvas), hotspotX: f.canvas.width - f.hotspotX, hotspotY: f.hotspotY, moveX: -f.moveX, moveY: f.moveY }));
      });
      return dirs.every(l => l.length) ? { dirs, fps: frames.frameRate > 0 ? frames.frameRate : 10 } : null;
    }).catch(() => null);
    critterWalkCache.set(key, p);
  }
  return p;
}

// The standing animation of a critter (breathing, shifting weight): every frame of every
// direction of the idle file the critter's art id resolves to. Resolves to { dirs, fps }
// like loadCritterWalkArt, or null when the file has a single frame per direction.
const critterIdleCache = new Map();
export async function loadCritterIdleArt(info) {
  const res = await resolveCritterArt(info);
  if (!res) return null;
  const key = `${res.url}|p${info.palette || 0}`;
  let p = critterIdleCache.get(key);
  if (!p) {
    p = loadCritterBuffer(res.url).then(buf => parseArtBuffer(buf, Infinity)).then(frames => {
      if ((frames.directionCount || 1) < 8 || (frames.framesPerDirection || 1) < 2) return null;
      const byDir = Array.from({ length: 8 }, () => []);
      for (const f of frames) {
        if (!(f.width > 0 && f.height > 0) || f.direction > 7) continue;
        const canvas = critterFrameSource(f, info.palette);
        if (canvas) byDir[f.direction].push({ canvas, hotspotX: Number(f.hotspotX) || 0, hotspotY: Number(f.hotspotY) || 0 });
      }
      const dirs = byDir.map((list, r) => list.length ? list
        : byDir[(8 - r) % 8].map(f => ({ canvas: flipCanvasHorizontally(f.canvas), hotspotX: f.canvas.width - f.hotspotX, hotspotY: f.hotspotY })));
      return dirs.every(l => l.length > 1) ? { dirs, fps: frames.frameRate > 0 ? frames.frameRate : 5 } : null;
    }).catch(() => null);
    critterIdleCache.set(key, p);
  }
  return p;
}

// Map-tile art for placed NPCs/PCs: art/critter/<dir>/<file>.art, frame chosen
// by the object's own rotation (same selection as scenery/portals) and the
// frame number stored in its art id.
export async function loadCritterMapArt(info) {
  if (!info || !info.filename) return null;
  try {
    const res = await resolveCritterArt(info);
    if (!res) return null;
    const url = res.url;
    // Cache the finished sprite per file + rotation + frame so the horizontal
    // flip canvas is built once, not once per placed NPC/monster.
    if (!window.__arcanumCritterSprites) window.__arcanumCritterSprites = new Map();
    const spriteKey = `${url}|${info.rotation}|f${info.frameNo || 0}|p${info.palette || 0}|${res.fallback ? 1 : 0}`;
    const cachedSprite = window.__arcanumCritterSprites.get(spriteKey);
    if (cachedSprite) return cachedSprite;
    const frames = await loadCritterFrames(url, info.frameNo);
    if (!frames.length || !frames[0]?.canvas) return null;
    const { frame, mirrored } = pickArtFrameForRotation(frames, info.rotation);
    if (!frame?.canvas) return null;
    let source = critterFrameSource(frame, info.palette);
    let hotspotX = Number(frame.hotspotX) || 0;
    if (mirrored) { source = flipCanvasHorizontally(source); hotspotX = source.width - hotspotX; }
    const sprite = {
      canvas: source, hotspotX, hotspotY: Number(frame.hotspotY) || 0,
      artName: res.file, artFile: res.file,
      artNote: res.fallback ? `critter art fallback: wanted ${res.wanted || '?'}, using ${res.file}` : null
    };
    window.__arcanumCritterSprites.set(spriteKey, sprite);
    return sprite;
  } catch (_) {
    return null;
  }
}
