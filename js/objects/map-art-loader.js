// Shared artwork loader for object sprites on maps.

import { parseArtBuffer } from '../art/art-decoder.js';
import { frameCanvasForPalette } from '../art/art-export.js';
import { ART_ROOT, PORTAL_ART_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { flipCanvasHorizontally, pickArtFrameForRotation, pickPortalFrameForRotation } from './art-frames.js';
import { loadPortalManifest } from './wall-art.js';
import {
  ensureProtoArtMesLoaded,
  PROTO_ART_TYPE_EYE_CANDY,
  protoArtMesMap,
  protoArtRoot,
} from '../proto/proto-mes.js';

export function loadMobMapArtShared(artId, objectType, paletteIndex = null, rotation = null, rawAid = null) {
  if (artId === null || artId === undefined) return Promise.resolve(null);
  const numericId = Number(artId);
  if (!Number.isFinite(numericId)) return Promise.resolve(null);
  // Cache the in-flight promise (not just the finished result) so objects that
  // share art and are loaded concurrently trigger a single load.
  const cacheKey = `sec-mob:${objectType}:${numericId}:${paletteIndex ?? 'default'}:r${Number.isInteger(rotation) ? rotation : 'x'}:f${objectType === 3 && Number.isFinite(Number(rawAid)) ? (Number(rawAid) >>> 14) & 0x1F : 0}`;
  if (!window.__arcanumMobArtCache) window.__arcanumMobArtCache = new Map();
  const cache = window.__arcanumMobArtCache;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const p = loadMobMapArtSharedUncached(artId, objectType, paletteIndex, rotation, rawAid).catch(() => null);
  cache.set(cacheKey, p);
  return p;
}

async function loadMobMapArtSharedUncached(artId, objectType, paletteIndex = null, rotation = null, rawAid = null) {
  if (artId === null || artId === undefined) return null;
  const numericId = Number(artId);
  if (!Number.isFinite(numericId)) return null;
  if (!window.__arcanumMobArtFrames) window.__arcanumMobArtFrames = new Map();

  let artName = null;
  try {
    await ensureProtoArtMesLoaded(objectType, 1);
    artName = protoArtMesMap(objectType, 1)?.get(numericId) || null;
  } catch (_) {}

  const candidates = [];
  if (artName) {
    let filename = String(artName).replace(/^.*[\\/]/, '');
    // portal.mes stores the ART filename followed by the numeric portal
    // display/name value, e.g. `BR2f5cu2.art 2036`. The numeric value is
    // a MES lookup value, not part of the filesystem filename.
    if (objectType === 1) {
      const portalFilename = filename.match(/^(.*?\.art)(?:\s+\d+)?$/i);
      if (portalFilename) filename = portalFilename[1];
    }
    // eye_candy.mes stores the base name only. The actual game filename
    // includes _f, _b or _u according to the packed eye-candy layer type.
    if (objectType === PROTO_ART_TYPE_EYE_CANDY) {
      const raw = Number(rawAid);
      const eyeCandyType = Number.isFinite(raw) ? ((raw >>> 6) & 0x7) : null;
      const suffix = eyeCandyType === 0 ? '_f' : eyeCandyType === 1 ? '_b' : eyeCandyType === 2 ? '_u' : null;
      if (suffix && !new RegExp(`${suffix}\\.art$`, 'i').test(filename)) filename = `${filename}${suffix}.art`;
    }
    if (objectType === 1) {
      // Spelling in portal.mes is not guaranteed to match the file on disk.
      let exact = null;
      try { exact = (await loadPortalManifest()).get(filename.toLowerCase()) || null; } catch (_) {}
      if (exact) candidates.push(`${PORTAL_ART_ROOT}${encPath(exact)}`);
      candidates.push(`${PORTAL_ART_ROOT}${encPath(filename)}`);
      candidates.push(`${PORTAL_ART_ROOT}${encPath(filename.toLowerCase())}`);
      candidates.push(`${PORTAL_ART_ROOT}${encPath(filename.replace(/\.art$/i, '.ART'))}`);
    } else {
      candidates.push(`${protoArtRoot(objectType)}${encPath(filename)}`);
    }
  }
  const idText = String(Math.trunc(numericId));
  const padded = idText.padStart(6, '0');
  // Keep the numeric fallback for ordinary item/scenery art, but prefer the
  // MES-resolved filename above (containers in particular require
  // art/container/container.mes + art/container/).
  candidates.push(
    `${ART_ROOT}${encPath(idText)}.art`,
    `${ART_ROOT}${encPath(padded)}.art`,
    `${ART_ROOT}${encPath(idText)}.ART`,
    `${ART_ROOT}${encPath(padded)}.ART`
  );

  for (const url of [...new Set(candidates)]) {
    try {
      // Fetch + parse each ART url once (hits and misses); every rotation and
      // palette of the same art reuses it.
      let framesPromise = window.__arcanumMobArtFrames.get(url);
      if (!framesPromise) {
        framesPromise = fetch(url).then(r => (r.ok ? r.arrayBuffer().then(b => parseArtBuffer(b)) : null)).catch(() => null);
        window.__arcanumMobArtFrames.set(url, framesPromise);
      }
      const frames = await framesPromise;
      if (!frames || !frames.length || !frames[0]?.canvas) continue;
      const portalPick = objectType === 1 ? pickPortalFrameForRotation(frames, rotation) : null;
      // Traps (eye-candy art, nibble E) are drawn on maps with their 10th
      // frame -- frame 0 is a mostly empty/idle frame. Use the last frame if
      // the ART has fewer than 10.
      const trapPick = objectType === PROTO_ART_TYPE_EYE_CANDY
        ? { frame: frames[Math.min(9, frames.length - 1)], mirrored: false }
        : null;
      let { frame, mirrored } = portalPick || trapPick || pickArtFrameForRotation(frames, rotation);
      if (!frame?.canvas) continue;
      // Scenery ART can hold several variants per direction (blood.ART: a splash growing into a
      // pool). The art id's frame number (bits 14-18, like critters') says which one is placed;
      // frame 0 of the direction would always show the smallest.
      if (objectType === 3 && Number.isFinite(Number(rawAid))) {
        const frameNo = (Number(rawAid) >>> 14) & 0x1F;
        if (frameNo > 0) {
          const seq = frames.filter(f => f.direction === frame.direction && f.canvas).sort((a, b) => a.index - b.index);
          if (seq.length > 1) frame = seq[Math.min(frameNo, seq.length - 1)];
        }
      }
      const palettes = frame.palettes || [];
      const selectedPaletteIndex = Number.isInteger(paletteIndex)
        ? Math.max(0, Math.min(palettes.length - 1, paletteIndex))
        : null;
      const selectedPalette = selectedPaletteIndex === null ? null : palettes[selectedPaletteIndex];
      let source = selectedPalette
        ? frameCanvasForPalette(frame, selectedPalette, 0)
        : frame.canvas;
      let frameHotspotX = Number(frame.hotspotX) || 0;
      if (mirrored) {
        source = flipCanvasHorizontally(source);
        frameHotspotX = source.width - frameHotspotX;
      }
      // Keep the MOB sprite at its actual ART dimensions. The map renderer
      // applies the current map zoom when drawing it, so the sprite can
      // naturally extend beyond the tile it is positioned on. Preserve the
      // ART hotspot as the anchor, matching the game's sprite placement.
      // Scenery ART with several frames in the chosen direction (camp fires, torches,
      // fountains...) is an animation the game plays at the ART's frame rate. Every
      // frame of that direction is kept so the map can animate it.
      let animFrames = null;
      if (objectType === 3) {
        const seq = frames.filter(f => f.direction === frame.direction && f.canvas).sort((a, b) => a.index - b.index);
        if (seq.length > 1) {
          animFrames = seq.map(f => {
            let c = selectedPalette ? frameCanvasForPalette(f, selectedPalette, 0) : f.canvas;
            let hx = Number(f.hotspotX) || 0;
            if (mirrored) { c = flipCanvasHorizontally(c); hx = c.width - hx; }
            return { canvas: c, hotspotX: hx, hotspotY: Number(f.hotspotY) || 0 };
          });
        }
      }
      // Doors, chests and traps are played on demand (a click in Animate mode): the whole
      // sequence of the drawn direction -- closed to open, or a trap going off.
      let actionFrames = null;
      if (objectType === 1 || objectType === 2 || objectType === PROTO_ART_TYPE_EYE_CANDY) {
        const seq = frames.filter(f => f.direction === frame.direction && f.canvas).sort((a, b) => a.index - b.index);
        if (seq.length > 1) {
          actionFrames = seq.map(f => {
            let c = selectedPalette ? frameCanvasForPalette(f, selectedPalette, 0) : f.canvas;
            let hx = Number(f.hotspotX) || 0;
            if (mirrored) { c = flipCanvasHorizontally(c); hx = c.width - hx; }
            return { canvas: c, hotspotX: hx, hotspotY: Number(f.hotspotY) || 0 };
          });
        }
      }
      const result = {
        actionFrames,
        actionFps: Number(frames.frameRate) > 0 ? Number(frames.frameRate) : 8,
        animFrames,
        animFps: Number(frames.frameRate) > 0 ? Number(frames.frameRate) : 8,
        canvas: source,
        hotspotX: frameHotspotX,
        hotspotY: Number(frame.hotspotY) || 0,
        direction: frame.direction,
        mirrored,
        artId: numericId,
        artName: artName || url.split('/').pop(),
        artFile: url.split('/').pop(),
        artNote: portalPick ? portalPick.note : null,
        paletteIndex: selectedPalette ? selectedPaletteIndex : 0
      };
      return result;
    } catch (_) {}
  }
  return null;
}
