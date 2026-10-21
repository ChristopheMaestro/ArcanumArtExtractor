// Exporting .ART frames as PNG/BMP.

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Saves a canvas exactly as it is currently drawn (same pixels, same size).
export async function exportCanvasPng(canvas, baseName) {
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error('the browser could not encode the canvas as PNG');
  const safe = String(baseName || 'map').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'map';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// The 256 palette colours as RGBA pixels (alpha 0 on `transparentIndex`), packed once so each pixel is then a
// single 32-bit copy. Written through a byte array so the colours are clamped exactly as a per-pixel write would be.
const OPAQUE_BLACK = new Uint32Array(new Uint8ClampedArray([0, 0, 0, 255]).buffer)[0];
export function paletteRgbaLut(palette, transparentIndex = 0) {
  const bytes = new Uint8ClampedArray(1024);
  for (let k = 0; k < 256; k++) {
    const rgb = palette[k] || [0, 0, 0];
    const o = k * 4;
    bytes[o] = rgb[0]; bytes[o + 1] = rgb[1]; bytes[o + 2] = rgb[2];
    bytes[o + 3] = k === transparentIndex ? 0 : 255;
  }
  return new Uint32Array(bytes.buffer);
}

// RGBA pixels of `count` palette indices (an index outside the palette is opaque black, as before).
export function indicesToRgba(indices, count, lut, total) {
  const rgba = new Uint8ClampedArray(total * 4);
  const out = new Uint32Array(rgba.buffer);
  for (let i = 0; i < count; i++) out[i] = lut[indices[i]] ?? OPAQUE_BLACK;
  return rgba;
}

export function frameRgbaForPalette(frame, palette, transparentIndex = 0) {
  return indicesToRgba(frame.indices, frame.indices.length, paletteRgbaLut(palette, transparentIndex), frame.width * frame.height);
}

export function frameCanvasForPalette(frame, palette, transparentIndex = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const rgba = frameRgbaForPalette(frame, palette, transparentIndex);
  canvas.getContext('2d').putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
  return canvas;
}

export function frameBlobForPalette(group, frame) {
  const palette = group.selectedPalette || group.palettes[0];
  return canvasToBlob(frameCanvasForPalette(frame, palette, group.transparentIndex));
}

export function frameFilename(baseName, frame) {
  const suffix = frame.totalImages > 1 ? `_${frame.index}` : '';
  return `${baseName}${suffix}.png`;
}
