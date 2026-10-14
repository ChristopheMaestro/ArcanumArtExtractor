// The game's bitmap fonts (art/interface/*Font.ART).
//
// A font is a one-direction ART file with one frame per character: frame (char code - 31).
// Pixels are a grey ramp in the file's palette (index 0 is transparent, index 1 is an edge
// marker); the game tints the ramp with the font's colour (tig_font_create), which is what
// drawText() does.

import { DATA_ROOT } from '../core/config.js';
import { memoAsync } from '../core/text-io.js';
import { parseArtBuffer } from '../art/art-decoder.js';

const FONT_ROOT = `${DATA_ROOT}art/interface/`;
const FIRST_CHAR = 31;       // frame 0 is char code 31

const fonts = new Map();     // file name -> memoized loader

export function loadGameFont(file) {
  if (!fonts.has(file)) {
    fonts.set(file, memoAsync(async () => {
      const resp = await fetch(`${FONT_ROOT}${file}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${file}`);
      const frames = await parseArtBuffer(await resp.arrayBuffer());
      const glyphs = new Map();
      let peak = 1;
      for (const f of frames) {
        glyphs.set(f.index, f);
        for (const v of f.indices) if (v > 1) peak = Math.max(peak, f.palette[v][0]);
      }
      return { glyphs, peak, cache: new Map() };
    }));
  }
  return fonts.get(file)();
}

function glyphCanvas(font, frame, color) {
  const key = `${frame.index}:${color}`;
  let c = font.cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = frame.width; c.height = frame.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(frame.width, frame.height);
  const [r, g, b] = color;
  for (let i = 0; i < frame.indices.length; i++) {
    const v = frame.indices[i];
    if (v < 2) continue;
    const k = Math.min(1, frame.palette[v][0] / font.peak);
    img.data.set([r * k, g * k, b * k, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  font.cache.set(key, c);
  return c;
}

// tig_font.c: a glyph advances the pen by its hotspot X (hot_x); the last character of a string counts
// its own width instead, so the string ends at the ink.
const advance = (g, last) => (g ? (last ? g.width : g.hotspotX) : 4);

export function textWidth(font, text) {
  const chars = [...text];
  return chars.reduce((w, ch, i) => w + advance(font.glyphs.get(ch.charCodeAt(0) - FIRST_CHAR), i === chars.length - 1), 0);
}

// Draws `text` inside the rect {x, y, width}: left aligned, or right aligned to the rect's edge.
export function drawText(ctx, font, text, rect, color, align = 'left') {
  let x = align === 'right' ? rect.x + rect.width - textWidth(font, text) : rect.x;
  for (const ch of text) {
    const g = font.glyphs.get(ch.charCodeAt(0) - FIRST_CHAR);
    if (g) ctx.drawImage(glyphCanvas(font, g, color), x, rect.y);
    x += advance(g, false);
  }
}