// Frame selection by rotation for object art.

export function aidRotation(rawValue) {
  const raw = Number(rawValue);
  return Number.isFinite(raw) ? ((raw >>> 11) & 0x7) : null;
}

// Picks the frame for `rotation`. parseArtBuffer() drops empty images, so
// frames[] is not indexable by direction -- go through frame.direction.
// When the wanted direction has no image, the opposite-handed direction
// (8 - r) is used mirrored; failing that, the nearest populated direction.
export function pickArtFrameForRotation(frames, rotation) {
  const fpd = frames.framesPerDirection || 1;
  if (!Number.isInteger(rotation) || (frames.directionCount || 1) < 8) {
    return { frame: frames[0], mirrored: false };
  }
  const firstOfDir = new Map();
  for (const f of frames) {
    if (!(f.width > 0 && f.height > 0)) continue;
    const have = firstOfDir.get(f.direction);
    if (!have || (f.index % fpd === 0 && have.index % fpd !== 0)) firstOfDir.set(f.direction, f);
  }
  const want = ((rotation % 8) + 8) % 8;
  if (firstOfDir.has(want)) return { frame: firstOfDir.get(want), mirrored: false };
  const opposite = (8 - want) % 8;
  if (firstOfDir.has(opposite)) return { frame: firstOfDir.get(opposite), mirrored: true };
  let best = null, bestDist = 9;
  for (const [d, f] of firstOfDir) {
    const dist = Math.min((d - want + 8) % 8, (want - d + 8) % 8);
    if (dist < bestDist) { bestDist = dist; best = f; }
  }
  return { frame: best || frames[0], mirrored: false };
}

// Portals stand on a tile edge exactly like walls, so their ART uses the same
// TIG direction order as wall ART (see loadWallArtFromRaw): the order is not
// assumed, it is derived from which directions of THIS file hold an image.
// Interior side serves rotations 0,1,6,7 (odd ones 1,7); exterior 2..5 (3,5).
const PORTAL_FULL_DIR_OFFSET = 6;
export function pickPortalFrameForRotation(frames, rotation) {
  if (!Number.isInteger(rotation)) return null;
  const fpd = frames.framesPerDirection || 1;
  if ((frames.directionCount || 1) !== 8) {
    // Door ART such as IN4E4aU0.ART is ONE direction holding the opening
    // animation (7 frames: closed, swinging, open). Like single-direction wall
    // ART, it is drawn mirrored horizontally for rotations 2/3/6/7 (rot & 2).
    // Frame 0 is the closed door; the AID's low bits (0x11 on every rot-7
    // portal AND on the rot-7 wall beside it) belong to that mirroring, not to
    // an animation frame.
    const first = frames.find(f => f.width > 0 && f.height > 0);
    if (!first) return null;
    const m = (rotation & 2) !== 0;
    return { frame: first, mirrored: m,
      note: `single-direction ART (${fpd} frames), rot ${rotation & 7} -> frame 1${m ? ' mirrored' : ''}` };
  }
  const firstOfDir = new Map();
  for (const f of frames) {
    if (!(f.width > 0 && f.height > 0)) continue;
    const have = firstOfDir.get(f.direction);
    if (!have || (f.index % fpd === 0 && have.index % fpd !== 0)) firstOfDir.set(f.direction, f);
  }
  const r = rotation & 7;
  const interior = ((r / 2) | 0) === 0 || ((r / 2) | 0) === 3;
  const needed = interior ? [1, 7] : [3, 5];
  let best = -1, offset = 0;
  // All eight directions present: the file cannot reveal the order, so use the
  // calibrated offset (rot 7 -> direction 5, the 6th image) instead of 0.
  const order = firstOfDir.size === 8 ? [PORTAL_FULL_DIR_OFFSET] : [0, 5, 1, 2, 3, 4, 6, 7];
  for (const off of order) {
    const score = needed.filter(n => firstOfDir.has((n + off) % 8)).length
      + (firstOfDir.has((r + off) % 8) ? 0.5 : 0);
    if (score > best) { best = score; offset = off; }
  }
  const dir = (r + offset) % 8;
  let frame = firstOfDir.get(dir), exact = !!frame;
  if (!frame) {
    let bestDist = 9;
    for (const [k, f] of firstOfDir) {
      const dist = Math.min((k - dir + 8) % 8, (dir - k + 8) % 8);
      if (dist < bestDist) { bestDist = dist; frame = f; }
    }
  }
  if (!frame) return null;
  return { frame, mirrored: false,
    note: `${firstOfDir.size === 8 ? 'full-8 calibrated; ' : ''}rot ${r} -> dir ${frame.direction}${exact ? '' : ' (nearest, wanted ' + dir + ')'}, offset ${offset}, image #${frames.indexOf(frame) + 1} of ${frames.length} (${frames.directionCount} dirs x ${fpd} frames), populated [${[...firstOfDir.keys()].sort().join(',')}]` };
}

export function flipCanvasHorizontally(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const c = out.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.translate(canvas.width, 0);
  c.scale(-1, 1);
  c.drawImage(canvas, 0, 0);
  return out;
}
