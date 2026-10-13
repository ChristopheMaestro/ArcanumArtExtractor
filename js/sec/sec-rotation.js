// location_rot() (game/location.c): the rotation (0..7, also the ART direction) that faces a
// step of (dx, dy) tiles.
export function secRotationFromDelta(dx, dy) {
  const ddx = 2 * Math.abs(dx), ddy = 2 * Math.abs(dy);
  let sx = Math.sign(dx), sy = Math.sign(dy);
  if (ddx > ddy) { if (ddy - ddx / 2 < 0) sy = 0; } else if (ddx - ddy / 2 < 0) sx = 0;
  if (sy >= 0) {
    if (sx >= 0) return sy > 0 ? (sx > 0 ? 4 : 3) : 5;
    return sy > 0 ? 2 : 1;
  }
  return sx > -1 ? (sx > 0 ? 6 : 7) : 0;
}
