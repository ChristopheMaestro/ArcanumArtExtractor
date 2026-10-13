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

export function frameCanvasForPalette(frame, palette, transparentIndex = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 0; i < frame.indices.length; i++) {
    const rgb = palette[frame.indices[i]] || [0, 0, 0];
    const o = i * 4;
    rgba[o] = rgb[0];
    rgba[o + 1] = rgb[1];
    rgba[o + 2] = rgb[2];
    rgba[o + 3] = frame.indices[i] === transparentIndex ? 0 : 255;
  }
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
