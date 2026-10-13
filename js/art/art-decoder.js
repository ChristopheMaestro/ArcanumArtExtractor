// .ART decoding.

// The game always treats palette index 0 as the transparent/color-key
// entry (see Arcanum_ART_Files_Explanation.txt, section 2) — it isn't
// necessarily pure blue, that's just the common modding convention. This
// fallback is only used if a file somehow has no palette at all.
const DEFAULT_TRANSPARENT_COLOR = [0, 0, 255];

export function paletteZeroColor(palette) {
  return (palette && palette[0]) ? palette[0] : DEFAULT_TRANSPARENT_COLOR;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// RGBA pixels of palette indices: the 256 colours are packed once into a lookup
// table and each pixel is then a single 32-bit store. Every palette entry equal
// to `transparentRGB` gets alpha 0.
export function composeFrameRgba(indices, palette, total, transparentRGB) {
  const [tr, tg, tb] = transparentRGB;
  const lut = new Uint32Array(256);
  for (let k = 0; k < 256; k++) {
    const [r, g, b] = palette[k] || [0, 0, 0];
    const a = (r === tr && g === tg && b === tb) ? 0 : 255;
    lut[k] = LITTLE_ENDIAN ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  }
  const rgba = new Uint8ClampedArray(total * 4);
  const out = new Uint32Array(rgba.buffer);
  for (let i = 0; i < total; i++) out[i] = lut[indices[i]];
  return rgba;
}

// The frame's pixels as ImageData, straight from its indices (no canvas readback).
export function frameImageData(frame) {
  const { width: w, height: h } = frame;
  return new ImageData(composeFrameRgba(frame.indices, frame.palette, w * h, paletteZeroColor(frame.palette)), w, h);
}

export function composeFrameCanvasInPlace(frame, transparentRGB) {
  const { width: w, height: h, indices, palette } = frame;
  const rgba = composeFrameRgba(indices, palette, w * h, transparentRGB);
  frame.canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
}

// frame.canvas is created on first use: a file's frames are decoded together, but
// most callers only ever draw a few of them (one direction, one pose, a thumbnail).
// Assigning frame.canvas replaces it like a plain property.
function defineLazyFrameCanvas(frame) {
  const settle = (obj, value) => Object.defineProperty(obj, 'canvas', { value, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(frame, 'canvas', {
    configurable: true,
    enumerable: true,
    get() {
      const canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = this.height;
      settle(this, canvas);
      composeFrameCanvasInPlace(this, paletteZeroColor(this.palette));
      return canvas;
    },
    set(value) { settle(this, value); },
  });
}

// Refuse frames whose pixel buffer would be absurd; a corrupt header could
// otherwise ask for gigabytes.
const MAX_FRAME_PIXELS = 1 << 26;

// ART header: how many 1 KB palettes follow the 0x84-byte header. One shared
// rule for the parser, the packer's template reader and the hex viewer.
// `flags` are the four uint32 palette ids at 0x0C..0x18: one palette is stored
// per NON-ZERO slot, so a sparse file such as (X, 0, X, X) holds three palettes,
// not four (verified on art/critter/hgm/hgmuwxna.ART). A file always stores at
// least one palette.
export function artPaletteCount(flags) {
  let n = 0;
  for (let i = 0; i < 4; i++) if (flags[i] !== 0) n++;
  return Math.max(1, n);
}

// Output is preallocated at width*height and never grows past it, so a
// crafted or corrupt stream can't balloon memory, and typed-array fill/set
// replace the per-pixel Array.push of the old version (~10x faster).
function decodeRLE(chunk, total) {
  const out = new Uint8Array(total);
  const len = chunk.length;
  let ptr = 0, o = 0;
  while (ptr < len && o < total) {
    const control = chunk[ptr++];
    const count = control & 0x7F;
    if ((control & 0x80) === 0) {
      if (ptr >= len) break;
      const end = Math.min(total, o + count);
      out.fill(chunk[ptr++], o, end);
      o = end;
    } else {
      const n = Math.min(count, total - o, len - ptr);
      if (n > 0) out.set(chunk.subarray(ptr, ptr + n), o);
      ptr += count;
      o += n;
    }
  }
  return out;
}

export async function parseArtFile(file) {
  const buf = await file.arrayBuffer();
  const frames = await parseArtBuffer(buf);
  return { frames, buf };
}

// opts.firstPerDirection: decode only the first non-empty image of each direction
// (what rotation-based callers use) and skip the pixel data of every other frame.
// Critter/monster ART holds dozens of animation frames per direction; decoding
// all of them for one thumbnail or one map sprite is what made loading slow.
export async function parseArtBuffer(buf, maxFrames = Infinity, opts = null) {
  if (buf.byteLength < 0x84) {
      throw new Error(`file too small to contain valid headers (${buf.byteLength} bytes)`);
  }
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const head = new Array(33);
  for (let i = 0; i < 33; i++) head[i] = view.getUint32(i * 4, true);

  const paletteCount = artPaletteCount([head[3], head[4], head[5], head[6]]);

  // Flags bit 0: set = one direction, clear = eight directions (see
  // Arcanum_ART_Files_Explanation.txt). This has to be a bitwise test —
  // the other flag bits are unrelated and unidentified, so an equality
  // check against specific values seen before would misread files with
  // different (still-valid) flag combinations.
  const directionCount = ((head[0] & 1) === 0) ? 8 : 1;
  const framesPerDirection = head[8];
  const totalImages = directionCount * framesPerDirection;
  if (!Number.isFinite(totalImages) || totalImages < 0 || totalImages > 20000) {
    throw new Error('unsupported or corrupt header (implausible frame count)');
  }

  let offset = 0x84;
  const paletteBytesNeeded = paletteCount * 1024;
  if (offset + paletteBytesNeeded > buf.byteLength) {
    throw new Error('file is truncated before its palette data');
  }

  const palettes = new Array(paletteCount);
  for (let p = 0; p < paletteCount; p++) {
    const palBytes = bytes.subarray(offset, offset + 1024);
    offset += 1024;
    const tuples = new Array(256);
    for (let i = 0; i < 256; i++) {
      const b = palBytes[i * 4];
      const g = palBytes[i * 4 + 1];
      const r = palBytes[i * 4 + 2];
      tuples[i] = [r, g, b];
    }
    palettes[p] = tuples;
  }
  const activePalette = palettes[0];

  const infoBytesNeeded = totalImages * 28;
  if (offset + infoBytesNeeded > buf.byteLength) {
    throw new Error('file is truncated before its frame headers');
  }

  const imageInfos = new Array(totalImages);
  for (let i = 0; i < totalImages; i++) {
    const frameInfoOffset = offset;
    const width = view.getUint32(offset, true);
    const height = view.getUint32(offset + 4, true);
    const size = view.getUint32(offset + 8, true);
    const hotspotX = view.getInt32(offset + 12, true);
    const hotspotY = view.getInt32(offset + 16, true);
    const movementOffsetX = view.getInt32(offset + 20, true);
    const movementOffsetY = view.getInt32(offset + 24, true);
    offset += 28;
    imageInfos[i] = {
      frameInfoOffset,
      width,
      height,
      size,
      hotspotX,
      hotspotY,
      movementOffsetX,
      movementOffsetY
    };
  }

  const frames = [];
  const firstOnly = !!(opts && opts.firstPerDirection);
  // opts.frame: which image within each direction to decode (clamped to the
  // direction's last frame); 0 = the first non-empty image of each direction.
  const wantFrame = firstOnly ? Math.max(0, Math.min(Math.max(0, framesPerDirection - 1), (opts.frame | 0))) : 0;
  const dirDone = new Set();
  for (let idx = 0; idx < imageInfos.length && frames.length < maxFrames; idx++) {
    const { width: w, height: h, size: compressedSize } = imageInfos[idx];
    if (w === 0 || h === 0) continue;

    if (offset + compressedSize > buf.byteLength) {
      throw new Error(`frame ${idx} pixel data runs past the end of the file`);
    }
    if (firstOnly) {
      const dir = Math.floor(idx / framesPerDirection);
      if (wantFrame > 0) {
        if (idx % framesPerDirection !== wantFrame) { offset += compressedSize; continue; }
      } else {
        if (dirDone.has(dir)) { offset += compressedSize; continue; }
        dirDone.add(dir);
      }
    }
    const dataOffset = offset;
    const chunk = bytes.subarray(offset, offset + compressedSize);
    offset += compressedSize;

    const total = w * h;
    if (total > MAX_FRAME_PIXELS) {
      throw new Error(`frame ${idx} is implausibly large (${w}×${h})`);
    }
    let indices = (total === chunk.length) ? chunk : decodeRLE(chunk, total);

    let finalIndices;
    if (indices.length < total) {
      finalIndices = new Uint8Array(total);
      finalIndices.set(indices);
    } else {
      finalIndices = indices.subarray(0, total);
    }

    const frame = {
      index: idx,
      direction: Math.floor(idx / framesPerDirection),
      width: w,
      height: h,
      totalImages,
      frameInfoOffset: imageInfos[idx].frameInfoOffset,
      hotspotX: imageInfos[idx].hotspotX,
      hotspotY: imageInfos[idx].hotspotY,
      movementOffsetX: imageInfos[idx].movementOffsetX,
      movementOffsetY: imageInfos[idx].movementOffsetY,
      embeddedLeft: imageInfos[idx].hotspotX,
      embeddedTop: imageInfos[idx].hotspotY,
      indices: finalIndices,
      palette: activePalette,
      palettes,
      dataOffset,
      dataLength: compressedSize,
    };
    defineLazyFrameCanvas(frame);
    frames.push(frame);
  }

  // Exposed alongside the frames so callers can offer a per-direction
  // choice instead of dumping every direction's frames into one list —
  // the frame table is laid out direction by direction (see
  // Arcanum_ART_Files_Explanation.txt), so direction d's frames are
  // exactly frames[d * framesPerDirection .. (d+1) * framesPerDirection).
  frames.directionCount = directionCount;
  frames.framesPerDirection = framesPerDirection;
  frames.frameRate = head[1];   // header "frame rate" (frames per second of the animation)

  return frames;
}
