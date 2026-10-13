// Wall and mob overlays.

import { mobMapTypeColor } from '../mob/mob-map.js';
import { SEC_BLIT_ADD } from '../objects/object-fields.js';
import { secIsoProject } from './sec-iso.js';
import { aidRotation } from '../objects/art-frames.js';
import { secCritterIdle, secNpcPose, secNpcStandArt, secNpcWalk } from './sec-npc-motion.js';

// Set by the map viewer: when enabled, scenery whose ART has several frames plays them and
// roaming NPCs walk their routes. `time` is performance.now() of the current tick, `start`
// that of the moment Animate was switched on, `hour` the hour of day (waypoints and
// standpoints differ between day and night).
export const secObjectAnim = { enabled: false, time: 0, start: 0, hour: 12, nav: null };

// Where a roaming NPC is at this animation tick (see secNpcPose), worked out once per tick
// however often it is asked: the draw order and the drawing both need it. Null for the rest.
export function secPoseOf(mob) {
  const a = secObjectAnim;
  if (!a.enabled || !mob.motion) return null;
  if (mob._poseT !== a.time || mob._poseH !== a.hour || mob._poseN !== a.nav) {
    mob._pose = secNpcPose(mob, a.hour, (a.time - a.start) / 1000, a.nav);
    mob._poseT = a.time; mob._poseH = a.hour; mob._poseN = a.nav;
  }
  return mob._pose;
}

// Doors, chests and traps: a click in Animate mode plays the ART's sequence. A door or chest
// opens (forward) and the next click closes it (backwards); a trap goes off and then settles
// back to its resting picture. `mob._act` = { t0, dir, once } until a trap's run is over.
export function secToggleAction(mob) {
  if (!secObjectAnim.enabled || !mob.actionFrames) return false;
  const a = mob._act;
  const n = mob.actionFrames.length;
  const now = secObjectAnim.time || performance.now();
  if (mob.type === 17) { mob._act = { t0: now, dir: 1, once: true }; return true; }
  if (a && !a.once) {
    // Reverse from wherever it is now: shift the start so the frame stays put.
    const at = Math.min(n - 1, Math.max(0, Math.floor((now - a.t0) * (mob.actionFps || 8) / 1000)));
    const cur = a.dir > 0 ? at : n - 1 - at;
    const dir = -a.dir;
    mob._act = { t0: now - (dir > 0 ? cur : n - 1 - cur) * 1000 / (mob.actionFps || 8), dir };
  } else mob._act = { t0: now, dir: 1 };
  return true;
}

// The frame of a clicked door / chest / trap, or null when it shows its normal picture.
function secActionFrame(mob) {
  const a = mob._act;
  if (!a || !mob.actionFrames || !secObjectAnim.enabled) return null;
  const n = mob.actionFrames.length;
  const step = Math.floor((secObjectAnim.time - a.t0) * (mob.actionFps || 8) / 1000);
  if (a.once && step >= n) { mob._act = null; return null; }
  const i = Math.min(n - 1, Math.max(0, step));
  if (!a.once && a.dir < 0 && step >= n - 1 && i === n - 1) { mob._act = null; return null; }
  return mob.actionFrames[a.dir > 0 ? i : n - 1 - i];
}

export function drawSecMobOverlay(ctx, mobPoints, bounds, mode, zoom, ox, oy, iso, showBounds = false, lighting = null) {
  if (!mobPoints?.length) return;
  for (const mob of mobPoints) {
    if (mob.type === 0) continue;
    const pose = secPoseOf(mob);
    const worldLocalX = pose ? pose.x - bounds.minX * 64 : (mob.sectorX - bounds.minX) * 64 + mob.tileX;
    const worldLocalY = pose ? pose.y - bounds.minY * 64 : (mob.sectorY - bounds.minY) * 64 + mob.tileY;
    const mapWidthTiles = (bounds.maxX - bounds.minX + 1) * 64;
    // Color mode uses a top-down canvas whose X axis is mirrored manually.
    // Isometric mode follows the game's renderer directly: X=0 is already
    // the top-right and increasing X moves left/down.
    const localX = mode === 'art' ? worldLocalX : (mapWidthTiles - 1 - worldLocalX);
    const localY = worldLocalY;
    if (localX < 0 || localY < 0 || localX >= (bounds.maxX - bounds.minX + 1) * 64 || localY >= (bounds.maxY - bounds.minY + 1) * 64) continue;
    let px, py;
    if (mode === 'art') {
      const p = secIsoProject(localX, localY, iso);
      px = (p.x + (Number(mob.offsetX) || 0)) * zoom + ox;
      py = (p.y + (Number(mob.offsetY) || 0)) * zoom + oy;
    } else {
      px = localX * zoom + ox + zoom / 2; py = localY * zoom + oy + zoom / 2;
    }
    let art = mob.artCanvas, artHotX = Number(mob.hotspotX) || 0, artHotY = Number(mob.hotspotY) || 0;
    if (secObjectAnim.enabled && mob.animFrames) {
      // Each object starts at its own phase so neighbouring fires do not flicker in lockstep.
      const n = mob.animFrames.length;
      const f = mob.animFrames[(Math.floor(secObjectAnim.time * (mob.animFps || 8) / 1000) + ((mob.tileX * 7 + mob.tileY * 13) % n)) % n];
      art = f.canvas; artHotX = f.hotspotX; artHotY = f.hotspotY;
    }
    // A door, chest or trap that was clicked plays its sequence (see secToggleAction).
    const actFrame = secActionFrame(mob);
    if (actFrame) { art = actFrame.canvas; artHotX = actFrame.hotspotX; artHotY = actFrame.hotspotY; }
    // Critters standing still breathe: the idle ART plays, at each critter's own phase.
    let idled = false;
    if (secObjectAnim.enabled && (mob.type === 15 || mob.type === 16) && !(pose && pose.moving)) {
      const idle = secCritterIdle(mob);
      const rot = pose ? pose.rot : aidRotation(mob.critterAidRaw);
      const frames = idle && Number.isInteger(rot) ? idle.dirs[rot & 7] : null;
      if (frames) {
        const f = frames[(Math.floor(secObjectAnim.time * idle.fps / 1000) + ((mob.tileX * 7 + mob.tileY * 13) % frames.length)) % frames.length];
        art = f.canvas; artHotX = f.hotspotX; artHotY = f.hotspotY; idled = true;
      }
    }
    if (pose && !idled) {
      // Walking: the walk animation facing the way it goes (each NPC at its own phase);
      // standing: the idle sprite facing the way it last went. Either is fetched on first
      // use, and the original sprite stays until it arrives.
      let sprite = null;
      if (pose.moving && pose.rot !== null) {
        const walk = secNpcWalk(mob);
        const frames = walk?.art?.dirs[pose.rot];
        if (frames) sprite = frames[(Math.floor((secObjectAnim.time - secObjectAnim.start) / walk.frameMs) + (mob.tileX * 7 + mob.tileY * 13)) % frames.length];
      }
      if (!sprite) sprite = secNpcStandArt(mob, pose.rot);
      if (sprite?.canvas) { art = sprite.canvas; artHotX = sprite.hotspotX; artHotY = sprite.hotspotY; }
    }
    const typeColor = mobMapTypeColor(mob.type);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (art) {
      let dw, dh, left, top;
      if (mode === 'color') {
        // The color map is a one-tile-per-64x64-pixels representation.
        // Keep the entire rendered MOB strictly inside its own logical tile.
        // The clip is important because ART canvases can contain transparent
        // margins/offsets, and the outline must not spill into neighbours.
        const tileLeft = localX * zoom + ox;
        const tileTop = localY * zoom + oy;
        const tileSize = zoom;
        const maxW = Math.max(1, tileSize - 1);
        const maxH = Math.max(1, tileSize - 1);
        const fit = Math.min(maxW / Math.max(1, art.width), maxH / Math.max(1, art.height));
        dw = Math.max(1, art.width * fit);
        dh = Math.max(1, art.height * fit);
        left = tileLeft + (tileSize - dw) / 2;
        top = tileTop + (tileSize - dh) / 2;
        ctx.beginPath();
        ctx.rect(tileLeft, tileTop, tileSize, tileSize);
        ctx.clip();
      } else {
        // F_BLIT_SCALE: scale the sprite about its hotspot (the point on the tile).
        const bs = Number(mob.blitScale) > 0 ? Number(mob.blitScale) : 1;
        dw = Math.max(1, art.width * zoom * bs);
        dh = Math.max(1, art.height * zoom * bs);
        const hotspotX = artHotX;
        const hotspotY = artHotY;
        left = px - hotspotX * zoom * bs;
        top = py - hotspotY * zoom * bs;
      }
      let artSrc = art;
      // Additive-blend objects (flames, glows) emit light: they are added to the
      // scene, not tinted by the ambient colour and not drawn with their black.
      const additive = mode === 'art' && ((Number(mob.blitFlags) | 0) & SEC_BLIT_ADD) !== 0;
      if (lighting && mode === 'art' && !additive) {
        const rgb = lighting.mobColor(mob, (px - ox) / zoom, (py - oy) / zoom);
        if (rgb) artSrc = lighting.sprite(artSrc, rgb);
      }
      if (additive) ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(artSrc, left, top, dw, dh);
      if (showBounds) {
        ctx.strokeStyle = typeColor;
        ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * .18));
        ctx.strokeRect(left + .5, top + .5, Math.max(1, dw - 1), Math.max(1, dh - 1));
      }
    } else {
      const size = Math.max(7, Math.min(40, zoom));
      const left = px - size / 2, top = py - size / 2;
      ctx.fillStyle = typeColor;
      ctx.fillRect(left, top, size, size);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(9, size * .72)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', px, py + .5);
      if (showBounds) {
        ctx.strokeStyle = typeColor;
        ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * .18));
        ctx.strokeRect(left, top, size, size);
      }
    }
    ctx.restore();
  }
}
