// The map-level files of a map folder, written the way loadMapData() (sec/sec-map-data.js) reads them.
//   startloc.txt  two lines: x, y (the tile the player starts on)
//   map.jmp       int count, then 0x20-byte jump points { flags, pad, int64 loc, int dst_map, pad, int64 dst_loc }
//   map.sbf       int count, then int64 sector ids (x | y << 26): the blocked sectors

export function startLocBytes(start) {
  return new TextEncoder().encode(`${start.x}\r\n${start.y}\r\n`);
}

export function jumpFileBytes(jumps) {
  const out = new Uint8Array(4 + jumps.length * 0x20), dv = new DataView(out.buffer);
  dv.setInt32(0, jumps.length, true);
  jumps.forEach((j, i) => {
    const at = 4 + i * 0x20;
    dv.setUint32(at, j.flags >>> 0, true);
    dv.setUint32(at + 8, j.x >>> 0, true); dv.setUint32(at + 12, j.y >>> 0, true);
    dv.setInt32(at + 0x10, j.dstMap | 0, true);
    dv.setUint32(at + 0x18, j.dst.x >>> 0, true); dv.setUint32(at + 0x1C, j.dst.y >>> 0, true);
  });
  return out;
}

// `keys`: "sx,sy" strings (sector coordinates)
export function blockedSectorBytes(keys) {
  const list = [...keys].map(k => k.split(',').map(Number));
  const out = new Uint8Array(4 + list.length * 8), dv = new DataView(out.buffer);
  dv.setInt32(0, list.length, true);
  list.forEach(([x, y], i) => dv.setBigUint64(4 + i * 8, (BigInt(x) | (BigInt(y) << 26n)) & 0xFFFFFFFFFFFFFFFFn, true));
  return out;
}
