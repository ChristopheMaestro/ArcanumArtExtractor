// .ART Packer: BMP parsing and .ART file building.

import { artPaletteCount } from './art-decoder.js';

//
// Builds an .art file out of 8-bit indexed frames: the mirror image of parseArtBuffer.
// Layout (checked against the game's own files and the hex viewer):
//   0x00 flags (bit 0 set = one direction, clear = eight; bit 1 is set on moving critter art)
//   0x04 frames per second      0x08 bits per pixel (8)      0x0C four palette slots (non-zero = stored)
//   0x1C action frame           0x20 frames per direction
//   0x24 / 0x64 legacy tables the loader ignores            0x44 bytes of pixel data per direction
//   then 1 KB per palette, then one 28-byte record per image:
//   width, height, stored bytes, hotspot X/Y, movement X/Y; then the (RLE) pixels of every image.
// Images are stored direction by direction. Palette index 0 is the transparent colour.

export function parseBmp(buf) {
  if (buf.byteLength < 54) throw new Error('file is too small to be a valid BMP');
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4D) {
    throw new Error('not a BMP file (missing "BM" signature)');
  }

  const dataOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  if (headerSize < 40) throw new Error('unsupported BMP header — save as a standard Windows BMP');

  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bitCount = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (width <= 0) throw new Error('BMP has an invalid width');
  if (bitCount !== 8) throw new Error(`expected an 8-bit indexed BMP, got ${bitCount}-bit`);
  if (compression !== 0) throw new Error('compressed BMPs are not supported — save as an uncompressed 8-bit BMP');

  const height = Math.abs(rawHeight);
  if (height <= 0) throw new Error('BMP has an invalid height');
  const topDown = rawHeight < 0;

  let clrUsed = view.getUint32(46, true);
  if (clrUsed === 0 || clrUsed > 256) clrUsed = 256;

  const paletteOffset = 14 + headerSize;
  const palette = new Array(256).fill(null).map(() => [0, 0, 0]);
  for (let i = 0; i < clrUsed; i++) {
    const o = paletteOffset + i * 4;
    if (o + 3 > bytes.length) break;
    palette[i] = [bytes[o + 2], bytes[o + 1], bytes[o]];
  }

  const rowSize = Math.ceil(width / 4) * 4;
  const indices = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const srcRow = topDown ? row : (height - 1 - row);
    const rowStart = dataOffset + srcRow * rowSize;
    if (rowStart + width > bytes.length) throw new Error('BMP pixel data runs past the end of the file');
    indices.set(bytes.subarray(rowStart, rowStart + width), row * width);
  }

  return { width, height, indices, palette };
}

export function buildBmpBuffer(width, height, indices, palette) {
  const rowSize = Math.ceil(width / 4) * 4;
  const pixelDataSize = rowSize * height;
  const paletteSize = 256 * 4;
  const headerSize = 14 + 40;
  const dataOffset = headerSize + paletteSize;
  const fileSize = dataOffset + pixelDataSize;

  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // BITMAPFILEHEADER
  bytes[0] = 0x42; bytes[1] = 0x4D; // 'BM'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, dataOffset, true);

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive => bottom-up, matching parseBmp's default read path
  view.setUint16(26, 1, true);     // planes
  view.setUint16(28, 8, true);     // bit count (8-bit indexed)
  view.setUint32(30, 0, true);     // BI_RGB, uncompressed
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true);   // ~72 DPI
  view.setInt32(42, 2835, true);
  view.setUint32(46, 256, true);   // colors used
  view.setUint32(50, 0, true);     // important colors

  for (let i = 0; i < 256; i++) {
    const [r, g, b] = palette[i] || [0, 0, 0];
    const o = headerSize + i * 4;
    bytes[o] = b; bytes[o + 1] = g; bytes[o + 2] = r; bytes[o + 3] = 0;
  }

  for (let row = 0; row < height; row++) {
    const srcRow = height - 1 - row; // bottom-up
    const rowStart = dataOffset + row * rowSize;
    bytes.set(indices.subarray(srcRow * width, srcRow * width + width), rowStart);
  }

  return buf;
}

function encodeRLE(indices) {
  const out = [];
  const n = indices.length;
  let i = 0;
  while (i < n) {
    let runLen = 1;
    while (i + runLen < n && indices[i + runLen] === indices[i] && runLen < 127) runLen++;
    if (runLen >= 2) {
      out.push(runLen, indices[i]);
      i += runLen;
    } else {
      const litStart = i;
      let litLen = 0;
      while (i < n && litLen < 127) {
        let rl = 1;
        while (i + rl < n && indices[i + rl] === indices[i] && rl < 127) rl++;
        if (rl >= 2) break;
        litLen++;
        i++;
      }
      out.push(0x80 | litLen);
      for (let k = 0; k < litLen; k++) out.push(indices[litStart + k]);
    }
  }
  return Uint8Array.from(out);
}

function encodeRLESafe(indices) {
  const out = encodeRLE(indices);
  if (out.length !== indices.length || indices.length === 0) return out;
  // A compressed length that coincidentally equals the raw pixel count would
  // make the decoder treat this chunk as "stored uncompressed". Break the tie
  // by splitting the first repeat token [n, v] into [1, v][n-1, v]: identical
  // pixels, two bytes longer, so the length can no longer match.
  for (let p = 0; p < out.length;) {
    const control = out[p];
    const n = control & 0x7F;
    if ((control & 0x80) === 0) {
      if (n >= 2) {
        const r = new Uint8Array(out.length + 2);
        r.set(out.subarray(0, p), 0);
        r[p] = 1; r[p + 1] = out[p + 1];
        r[p + 2] = n - 1; r[p + 3] = out[p + 1];
        r.set(out.subarray(p + 2), p + 4);
        return r;
      }
      p += 2;
    } else {
      p += 1 + n;
    }
  }
  // Only literals, no repeats: a raw-length tie is impossible here (literal
  // tokens always add one control byte per <=127 pixels), so this is unreachable.
  return out;
}

// What a real .art file says about itself, to start a new one from: the settings the packer
// exposes, plus the legacy header tables (dwords 9-16) the loader ignores but real files fill.
export function readArtTemplate(buf) {
  if (buf.byteLength < 0x84) throw new Error('reference file is too small to be a valid .art file');
  const view = new DataView(buf);
  const head = [];
  for (let i = 0; i < 33; i++) head.push(view.getUint32(i * 4, true));
  artPaletteCount([head[3], head[4], head[5], head[6]]); // same rule as the parser
  const directions = (head[0] & 1) === 0 ? 8 : 1;
  const framesPerDirection = head[8];
  if (!Number.isFinite(framesPerDirection) || framesPerDirection < 1 || framesPerDirection > 2500) {
    throw new Error('reference file header looks invalid');
  }
  return {
    flags: head[0], fps: head[1], actionFrame: head[7], directions, framesPerDirection,
    legacy: head.slice(9, 17),
  };
}

// frames: [{ width, height, indices, hotX, hotY, moveX, moveY }], in file order (direction by
// direction). spec: { directions: 1|8, framesPerDirection, fps, actionFrame, flags, legacy? }.
export function buildArtBuffer(frames, palette, spec) {
  const { directions, framesPerDirection } = spec;
  if (frames.length !== directions * framesPerDirection) {
    throw new Error(`${directions} direction${directions === 1 ? '' : 's'} × ${framesPerDirection} frame${framesPerDirection === 1 ? '' : 's'} needs ${directions * framesPerDirection} images, but there are ${frames.length}`);
  }
  const headerBytes = new Uint8Array(0x84);
  const hv = new DataView(headerBytes.buffer);
  const compressedChunks = frames.map(f => encodeRLESafe(f.indices));

  // Bit 0 is not a free choice: it says how many directions follow.
  const flags = directions === 1 ? (spec.flags | 1) : (spec.flags & ~1);
  hv.setUint32(0x00, flags >>> 0, true);
  hv.setUint32(0x04, spec.fps >>> 0, true);
  hv.setUint32(0x08, 8, true);
  hv.setUint32(0x0C, 1, true);                        // one palette, in slot 0; the other slots stay empty
  hv.setUint32(0x1C, spec.actionFrame >>> 0, true);
  hv.setUint32(0x20, framesPerDirection, true);
  (spec.legacy || []).forEach((v, i) => hv.setUint32(0x24 + i * 4, v >>> 0, true));
  // Pixel bytes per direction (a one-direction file repeats its total in all eight slots, as the game's do).
  const dirSizes = [];
  for (let d = 0; d < directions; d++) {
    let sum = 0;
    for (let k = 0; k < framesPerDirection; k++) sum += compressedChunks[d * framesPerDirection + k].length;
    dirSizes.push(sum);
  }
  for (let d = 0; d < 8; d++) hv.setUint32(0x44 + d * 4, directions === 1 ? dirSizes[0] : dirSizes[d], true);

  const paletteBytes = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = palette[i] || [0, 0, 0];
    paletteBytes[i * 4] = b;
    paletteBytes[i * 4 + 1] = g;
    paletteBytes[i * 4 + 2] = r;
    paletteBytes[i * 4 + 3] = 0;
  }

  const descriptorBytes = new Uint8Array(frames.length * 28);
  const dv = new DataView(descriptorBytes.buffer);
  frames.forEach((f, i) => {
    const o = i * 28;
    dv.setUint32(o, f.width, true);
    dv.setUint32(o + 4, f.height, true);
    dv.setUint32(o + 8, compressedChunks[i].length, true);
    dv.setInt32(o + 12, f.hotX | 0, true);
    dv.setInt32(o + 16, f.hotY | 0, true);
    dv.setInt32(o + 20, f.moveX | 0, true);
    dv.setInt32(o + 24, f.moveY | 0, true);
  });

  const pixelTotal = compressedChunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(headerBytes.length + paletteBytes.length + descriptorBytes.length + pixelTotal);
  let pos = 0;
  out.set(headerBytes, pos); pos += headerBytes.length;
  out.set(paletteBytes, pos); pos += paletteBytes.length;
  out.set(descriptorBytes, pos); pos += descriptorBytes.length;
  for (const chunk of compressedChunks) { out.set(chunk, pos); pos += chunk.length; }

  return out.buffer;
}
