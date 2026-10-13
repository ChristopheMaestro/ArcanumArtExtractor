// Canvas helpers.

// Reads a canvas's pixels without triggering Chrome's "Multiple readback
// operations using getImageData" warning. That warning fires when a canvas
// that was created WITHOUT willReadFrequently is read back repeatedly (once
// per wall sprite, hundreds of times). The sprite canvases are drawn to the
// map every frame, so they stay GPU-friendly; instead the pixels are copied
// once into a shared scratch canvas created with willReadFrequently:true and
// read from there. The full ImageData is cached per source canvas.
const canvasPixelCache = new WeakMap();
let pixelScratch = null;
export function readCanvasPixels(canvas) {
  let img = canvasPixelCache.get(canvas);
  if (img !== undefined) return img;
  img = null;
  try {
    if (canvas.width > 0 && canvas.height > 0) {
      if (!pixelScratch) {
        const c = document.createElement('canvas');
        pixelScratch = { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
      }
      const { canvas: sc, ctx: sx } = pixelScratch;
      sc.width = canvas.width; sc.height = canvas.height; // also clears it
      sx.drawImage(canvas, 0, 0);
      img = sx.getImageData(0, 0, canvas.width, canvas.height);
    }
  } catch (_) { img = null; }
  canvasPixelCache.set(canvas, img);
  return img;
}
