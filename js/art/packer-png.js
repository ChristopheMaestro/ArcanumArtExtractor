// .ART Packer: PNG to indexed-colour conversion.

import { packerFrames } from './packer-ui.js';

//
// Lets a .png be dropped straight into the packer. It's decoded via
// canvas, then either quantized down to a fresh <=256-colour palette
// (if this is the first frame) or nearest-colour-mapped onto the
// palette already established by frame 0 (if there's a shared palette
// to match, which is the common case here).

const PNG_ALPHA_THRESHOLD = 128;
const PNG_TRANSPARENT_KEY = [0, 0, 255]; // matches the format's transparency convention

async function decodePngFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('could not decode this PNG'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: imgData.data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function nearestPaletteIndex(palette, r, g, b, limit, startIndex) {
  const start = startIndex || 0;
  let best = start;
  let bestDist = Infinity;
  const n = limit || palette.length;
  for (let i = start; i < n; i++) {
    const c = palette[i] || [0, 0, 0];
    const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

// Re-express a frame drawn with its own palette in the shared one: index 0 stays transparent,
// every other pixel takes the nearest colour among indices 1 and up.
export function remapToPalette(indices, from, to) {
  const out = new Uint8Array(indices.length);
  const cache = new Map();
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (v === 0) continue;
    let m = cache.get(v);
    if (m === undefined) {
      const c = from[v] || [0, 0, 0];
      m = nearestPaletteIndex(to, c[0], c[1], c[2], 256, 1);
      cache.set(v, m);
    }
    out[i] = m;
  }
  return out;
}

function medianCutQuantize(pixels, maxColors) {
  if (pixels.length === 0) return [[0, 0, 0]];
  let buckets = [pixels];
  while (buckets.length < maxColors) {
    let idx = -1, maxRange = -1, channel = 0;
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (bucket.length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255, max = 0;
        for (const p of bucket) { if (p[c] < min) min = p[c]; if (p[c] > max) max = p[c]; }
        const range = max - min;
        if (range > maxRange) { maxRange = range; idx = i; channel = c; }
      }
    }
    if (idx === -1) break;
    const bucket = buckets[idx];
    bucket.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(bucket.length / 2);
    buckets.splice(idx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }
  return buckets.filter(b => b.length > 0).map(bucket => {
    let sr = 0, sg = 0, sb = 0;
    for (const p of bucket) { sr += p[0]; sg += p[1]; sb += p[2]; }
    const n = bucket.length;
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  });
}

export async function convertPngToFrame(file) {
  const { width, height, data } = await decodePngFile(file);
  const total = width * height;

  const opaqueColors = [];
  let hasTransparent = false;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (data[o + 3] < PNG_ALPHA_THRESHOLD) { hasTransparent = true; continue; }
    opaqueColors.push([data[o], data[o + 1], data[o + 2]]);
  }

  // Arcanum always reads palette index 0 as the transparent/color-key
  // entry — it's a fixed slot, not "whichever index happens to hold pure
  // blue" (see Arcanum_ART_Files_Explanation.txt, section 2). Whether or not
  // this frame has transparent pixels, a later one may, and any opaque colour
  // sitting on index 0 would turn into a hole in the game. So index 0 is
  // always reserved for the chroma key and the real colours start at 1.
  let palette;
  let usingSharedPalette = false;
  const reservesIndexZero = true;
  if (packerFrames.length > 0) {
    palette = packerFrames[0].palette;
    usingSharedPalette = true;
  } else {
    const maxOpaqueColors = 255;
    const uniqueMap = new Map();
    for (const c of opaqueColors) {
      const key = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!uniqueMap.has(key)) uniqueMap.set(key, c);
    }
    const uniqueColors = Array.from(uniqueMap.values());

    let reduced;
    if (uniqueColors.length <= maxOpaqueColors) {
      reduced = uniqueColors;
    } else {
      const SAMPLE_CAP = 40000;
      let sample = opaqueColors;
      if (sample.length > SAMPLE_CAP) {
        const stride = Math.ceil(sample.length / SAMPLE_CAP);
        sample = sample.filter((_, i) => i % stride === 0);
      }
      reduced = medianCutQuantize(sample, maxOpaqueColors);
    }

    palette = new Array(256).fill(null).map(() => [0, 0, 0]);
    palette[0] = PNG_TRANSPARENT_KEY.slice();
    reduced.forEach((c, i) => { palette[i + 1] = c; });
  }

  const indices = new Uint8Array(total);
  // The palette is fixed here, so each distinct colour only needs one search.
  const nearestCache = new Map();
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (data[o + 3] < PNG_ALPHA_THRESHOLD) {
      indices[i] = 0;
    } else {
      const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      let idx = nearestCache.get(key);
      if (idx === undefined) {
        // Never let an opaque pixel land on the reserved transparent slot.
        idx = nearestPaletteIndex(palette, data[o], data[o + 1], data[o + 2], 256, reservesIndexZero ? 1 : 0);
        nearestCache.set(key, idx);
      }
      indices[i] = idx;
    }
  }

  return { width, height, indices, palette, usingSharedPalette, hasTransparent };
}
