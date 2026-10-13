// .ART Packer: the hotspot preview. A frame is drawn the way the map viewer places it, on top of a
// greyscale floor tile and wall (the game's own art, schematic shapes if it can't be loaded), so the
// hotspot can be judged by eye and dragged.

import { ART_ROOT } from '../core/config.js';
import { fetchBuffer, memoAsync } from '../core/text-io.js';
import { parseArtBuffer } from './art-decoder.js';
import { SEC_ISO_HALF_H as HH, SEC_ISO_HALF_W as HW } from '../sec/sec-iso.js';
import { secWallAnchor } from '../sec/sec-walls.js';

const TILE_ART = `${ART_ROOT}tile/bg1bg21a.ART`;
const WALL_ART = `${ART_ROOT}wall/BB1bclU0.ART`;

function greyscale(canvas, brightness) {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) * brightness;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

async function loadGuideArt(url, brightness) {
  const frames = await parseArtBuffer(await fetchBuffer(url), 1);
  const f = frames[0];
  return { canvas: greyscale(f.canvas, brightness), hotX: f.hotspotX, hotY: f.hotspotY };
}

// null parts mean "draw a schematic instead".
const loadGuides = memoAsync(async () => {
  const [tile, wall] = await Promise.all([
    loadGuideArt(TILE_ART, 0.8).catch(() => null),
    loadGuideArt(WALL_ART, 0.75).catch(() => null),
  ]);
  return { tile, wall };
});

function diamond(ctx, cx, cy) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - HH); ctx.lineTo(cx + HW, cy); ctx.lineTo(cx, cy + HH); ctx.lineTo(cx - HW, cy);
  ctx.closePath();
}

function drawFloor(ctx, guides, reach) {
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      const cx = (j - i) * HW, cy = (i + j) * HH;
      if (guides.tile) {
        ctx.drawImage(guides.tile.canvas, cx - 39, cy - 20);
      } else {
        diamond(ctx, cx, cy);
        ctx.fillStyle = (i + j) & 1 ? '#3a3a3a' : '#444'; ctx.fill();
      }
    }
  }
}

// A wall sprite on the edge `rotation` of the tile at the origin, placed as the map viewer does:
// anchor - hotspot, mirrored (with its hotspot) for rotations 2, 3, 6, 7.
function drawWall(ctx, rotation, canvas, hotX, hotY) {
  const a = secWallAnchor(rotation);
  const mirrored = (rotation & 2) !== 0;
  const left = a.dx - (mirrored ? canvas.width - hotX : hotX);
  const top = a.dy - hotY;
  if (mirrored) {
    ctx.save(); ctx.translate(left + canvas.width, top); ctx.scale(-1, 1); ctx.drawImage(canvas, 0, 0); ctx.restore();
  } else {
    ctx.drawImage(canvas, left, top);
  }
}

// Schematic wall: a slab of the same footprint, for when the game's art isn't there.
function drawSchematicWall(ctx, rotation) {
  const e = (rotation >> 1) & 3;
  const [x1, y1, x2, y2] = [[0, -HH, HW, 0], [0, HH, HW, 0], [-HW, 0, 0, HH], [-HW, 0, 0, -HH]][e];
  const H = 110;
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - H); ctx.lineTo(x1, y1 - H);
  ctx.closePath();
  ctx.fillStyle = e & 1 ? '#6a6a6a' : '#555'; ctx.fill();
  ctx.strokeStyle = '#888'; ctx.stroke();
}

function guideWall(ctx, guides, rotation) {
  if (guides.wall) drawWall(ctx, rotation, guides.wall.canvas, guides.wall.hotX, guides.wall.hotY);
  else drawSchematicWall(ctx, rotation);
}

function cross(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 8, y + .5); ctx.lineTo(x + 9, y + .5);
  ctx.moveTo(x + .5, y - 8); ctx.lineTo(x + .5, y + 9);
  ctx.stroke();
  ctx.restore();
}

// getState() -> { guide: 'object' | 'wall' | 'tile' | 'none', rotation (wall), frame: { canvas, hotX, hotY } | null, zoom }
// onDrag(dHotX, dHotY) is told how a drag changed the hotspot. Returns { redraw, load }: load()
// fetches the game's tile and wall art (once) and redraws with them.
export function createGuide(canvas, getState, onDrag) {
  const ctx = canvas.getContext('2d');
  let guides = { tile: null, wall: null };
  const load = () => { loadGuides().then(g => { guides = g; redraw(); }).catch(() => {}); };

  function redraw() {
    const st = getState();
    const W = canvas.width, H = canvas.height, z = st.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#161513'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    if (st.guide === 'none') {
      ctx.setTransform(z, 0, 0, z, 16, 16);
      if (st.frame) ctx.drawImage(st.frame.canvas, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    ctx.setTransform(z, 0, 0, z, Math.round(W / 2), Math.round(H * 0.7));
    ctx.lineWidth = 1 / z;
    drawFloor(ctx, guides, 4);
    ctx.strokeStyle = '#b8b8b8';
    diamond(ctx, 0, 0); ctx.stroke();

    const f = st.frame;
    if (st.guide === 'tile') {
      if (f) ctx.drawImage(f.canvas, -39, -20);
      diamond(ctx, 0, 0); ctx.strokeStyle = '#e0c060'; ctx.stroke();
    } else if (st.guide === 'wall') {
      const rot = st.rotation;
      const edge = (rot >> 1) & 3;
      const partner = [3, 2, 1, 0][edge] * 2;
      const partnerBehind = (partner >> 1) === 0 || (partner >> 1) === 3;
      if (partnerBehind) guideWall(ctx, guides, partner);
      if (f) drawWall(ctx, rot, f.canvas, f.hotX, f.hotY);
      if (!partnerBehind) guideWall(ctx, guides, partner);
      // The edge the wall is meant to stand on.
      const [x1, y1, x2, y2] = [[0, -HH, HW, 0], [0, HH, HW, 0], [-HW, 0, 0, HH], [-HW, 0, 0, -HH]][edge];
      ctx.strokeStyle = '#e0c060'; ctx.lineWidth = 2 / z;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const a = secWallAnchor(rot);
      cross(ctx, a.dx, a.dy);
    } else {
      // Object: the walls behind it (NE and NW edges), then the sprite, then the cross.
      guideWall(ctx, guides, 0);
      guideWall(ctx, guides, 6);
      if (f) ctx.drawImage(f.canvas, -f.hotX, -f.hotY);
      cross(ctx, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Dragging the picture moves it under the cross, i.e. changes the hotspot the other way.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const st = getState();
    if (!st.frame || st.guide === 'none' || st.guide === 'tile') return;
    drag = { x: e.clientX, y: e.clientY, sx: 0, sy: 0 };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const st = getState();
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.width;            // css px per canvas px
    const dx = Math.round((e.clientX - drag.x) / (scale * st.zoom));
    const dy = Math.round((e.clientY - drag.y) / (scale * st.zoom));
    const mirrored = st.guide === 'wall' && (st.rotation & 2) !== 0;
    const mx = (mirrored ? dx : -dx), my = -dy;          // hotspot change
    if (mx !== drag.sx || my !== drag.sy) {
      onDrag(mx - drag.sx, my - drag.sy);
      drag.sx = mx; drag.sy = my;
    }
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  redraw();
  return { redraw, load };
}
