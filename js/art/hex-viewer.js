// Hex viewer panel and .ART header analysis.

import { artPaletteCount } from './art-decoder.js';
import { log } from '../core/log.js';
import { rgbToHex } from '../core/util.js';

//
// Shows the raw bytes of the currently open .art file. Uses a virtual
// scroll (only the visible rows are ever in the DOM) so it stays fast
// even for large files. Hovering a decoded frame highlights the byte
// range its compressed pixel data occupies in the file.

const HEX_ROW_HEIGHT = 18;
const HEX_BYTES_PER_ROW = 16;

const hexOverlayEl = document.getElementById('hexOverlay');
const hexTitleEl = document.getElementById('hexTitle');
const hexMetaEl = document.getElementById('hexMeta');
const hexAnalysisEl = document.getElementById('hexAnalysis');
const hexFrameStripEl = document.getElementById('hexFrameStrip');
const hexScrollEl = document.getElementById('hexScroll');
const hexSpacerEl = document.getElementById('hexSpacer');
const hexRowsEl = document.getElementById('hexRows');
const hexCloseBtn = document.getElementById('hexClose');

let hexBytes = null;       // Uint8Array of the file currently shown
export let hexActiveGroup = null; // the file-group the hex view belongs to
let hexTotalRows = 0;
let hexHighlight = null;   // transient frame hover highlight, or null
let hexHeaderHighlights = []; // persistent header field selections
export let hexPinnedFrame = null;       // frame object currently pinned, or null
let hexPinnedPreviewEl = null;
let hexSelectedFrame = null;   // its .frame-preview element
let hexSelectedPalette = null; // currently selected palette descriptor
let hexPaletteHighlights = []; // persistent palette entry selections
const HEADER_HIGHLIGHT_COLORS = [
  '#ffd166', '#8ecae6', '#90be6d', '#f4a261', '#e9c46a',
  '#cdb4db', '#a8dadc', '#ffafcc', '#bde0fe', '#b7e4c7'
];

function escapeHtmlChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}

function buildHexRowHtml(rowIndex) {
  const rowStart = rowIndex * HEX_BYTES_PER_ROW;
  const rowLen = Math.min(HEX_BYTES_PER_ROW, hexBytes.length - rowStart);
  const offsetLabel = rowStart.toString(16).padStart(8, '0').toUpperCase();

  let hexHtml = '';
  let asciiHtml = '';
  for (let i = 0; i < HEX_BYTES_PER_ROW; i++) {
    if (i >= rowLen) {
      hexHtml += '<span class="hex-byte pad">--</span>';
      continue;
    }
    const byteIndex = rowStart + i;
    const b = hexBytes[byteIndex];
    const hexStr = b.toString(16).padStart(2, '0').toUpperCase();
    const ch = escapeHtmlChar((b >= 32 && b <= 126) ? String.fromCharCode(b) : '.');
    const frameHl = hexHighlight && byteIndex >= hexHighlight.start && byteIndex < hexHighlight.end;
    const paletteHl =
      hexPaletteHighlights.find(h => h.type !== 'whole-palette' && byteIndex >= h.start && byteIndex < h.end) ||
      hexPaletteHighlights.find(h => h.type === 'whole-palette' && byteIndex >= h.start && byteIndex < h.end);
    const headerHl =
      hexHeaderHighlights.find(h => h.type !== 'whole-header' && byteIndex >= h.start && byteIndex < h.end) ||
      hexHeaderHighlights.find(h => h.type === 'whole-header' && byteIndex >= h.start && byteIndex < h.end);
    const persistentHl = paletteHl || headerHl;
    const hlClass = persistentHl ? ` header-hl header-hl-${persistentHl.colorIndex}` : (frameHl ? ' hl' : '');
    hexHtml += `<span class="hex-byte${hlClass}">${hexStr}</span>`;
    asciiHtml += `<span class="hex-ascii-ch${hlClass}">${ch}</span>`;
  }

  return `<div class="hex-row" style="top:${rowIndex * HEX_ROW_HEIGHT}px">` +
    `<span class="hex-offset">${offsetLabel}</span>` +
    `<span class="hex-bytes">${hexHtml}</span>` +
    `<span class="hex-ascii">${asciiHtml}</span></div>`;
}

function renderHexViewport() {
  if (!hexBytes) return;
  const scrollTop = hexScrollEl.scrollTop;
  const viewportH = hexScrollEl.clientHeight || 400;
  const overscan = 6;
  const startRow = Math.max(0, Math.floor(scrollTop / HEX_ROW_HEIGHT) - overscan);
  const endRow = Math.min(hexTotalRows, Math.ceil((scrollTop + viewportH) / HEX_ROW_HEIGHT) + overscan);

  let html = '';
  for (let r = startRow; r < endRow; r++) html += buildHexRowHtml(r);
  hexRowsEl.innerHTML = html;
}

function readHeaderAnalysis(bytes) {
  const HEADER_SIZE = 0x84;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset) => view.getUint32(offset, true);

  if (bytes.length < HEADER_SIZE) {
    return {
      valid: false,
      message: `File is only ${bytes.length} bytes; a complete ART header requires 132 bytes (0x84).`
    };
  }

  const flags = u32(0);
  const fps = u32(4);
  const bpp = u32(8);
  const paletteFlags = [u32(0x0C), u32(0x10), u32(0x14), u32(0x18)];
  const actionFrame = u32(0x1C);
  const framesPerDirection = u32(0x20);
  const legacyFrameTable = Array.from({ length: 8 }, (_, i) => u32(0x24 + i * 4));
  const directionDataSizes = Array.from({ length: 8 }, (_, i) => u32(0x44 + i * 4));
  const legacyPixelTable = Array.from({ length: 8 }, (_, i) => u32(0x64 + i * 4));

  const oneDirection = (flags & 1) !== 0;
  const directions = oneDirection ? 1 : 8;
  const paletteCount = artPaletteCount(paletteFlags);
  const totalFrames = directions * framesPerDirection;
  const paletteBytes = paletteCount * 0x400;
  const frameInfoOffset = HEADER_SIZE + paletteBytes;
  const frameInfoBytes = totalFrames * 0x1C;
  const pixelDataOffset = frameInfoOffset + frameInfoBytes;

  const rows = [
    ['0x00', '4', 'Flags', `0x${flags.toString(16).padStart(8, '0').toUpperCase()}`, `bit 0: ${oneDirection ? 'set → 1 direction' : 'clear → 8 directions'}`],
    ['0x04', '4', 'Frames per second', String(fps), ''],
    ['0x08', '4', 'Bits per pixel', String(bpp), bpp === 8 ? 'expected value' : 'WARNING: Arcanum expects 8'],
    ['0x0C', '16', 'Palette presence', paletteFlags.map((v, i) => `P${i}=${v !== 0 ? 'present' : 'absent'}`).join(', '), `${paletteCount} palette${paletteCount === 1 ? '' : 's'} → ${paletteBytes.toLocaleString()} bytes`],
    ['0x1C', '4', 'Action frame', String(actionFrame), 'stored as a one-based animation event value'],
    ['0x20', '4', 'Frames per direction', String(framesPerDirection), `${directions} direction${directions === 1 ? '' : 's'} → ${totalFrames.toLocaleString()} frame records`],
    ['0x24', '32', 'Old frame-table values', '8 × uint32', 'legacy fields; loader ignores them'],
    ['0x44', '32', 'Direction data sizes', directionDataSizes.map(v => v.toLocaleString()).join(', '), 'read by loader, not authoritative for frame decoding'],
    ['0x64', '32', 'Old pixel-table values', '8 × uint32', 'legacy fields; loader ignores them']
  ];

  const warnings = [];
  if (bpp !== 8) warnings.push('Bits per pixel is not 8.');
  if (paletteFlags.every(v => v === 0)) {
    warnings.push('No palette ids are set; the loader still stores one palette.');
  }
  if (frameInfoOffset > bytes.length) warnings.push('Calculated frame-info offset is beyond the end of the file.');
  if (frameInfoOffset <= bytes.length && frameInfoBytes > bytes.length - frameInfoOffset) {
    warnings.push(`Header implies ${frameInfoBytes.toLocaleString()} bytes of frame records, but the file ends earlier.`);
  }

  return {
    valid: true, flags, fps, bpp, paletteFlags, paletteCount, actionFrame,
    framesPerDirection, directions, totalFrames, legacyFrameTable,
    directionDataSizes, legacyPixelTable, frameInfoOffset, frameInfoBytes,
    pixelDataOffset, rows, warnings
  };
}

function getPaletteDescriptors(bytes) {
  const info = readHeaderAnalysis(bytes);
  if (!info.valid) return [];
  const descriptors = [];
  let offset = 0x84;
  for (let paletteIndex = 0; paletteIndex < info.paletteCount; paletteIndex++) {
    if (offset + 0x400 > bytes.length) break;
    const colors = new Array(256);
    for (let i = 0; i < 256; i++) {
      const o = offset + i * 4;
      colors[i] = [bytes[o + 2], bytes[o + 1], bytes[o]];
    }
    descriptors.push({
      index: paletteIndex,
      start: offset,
      end: offset + 0x400,
      size: 0x400,
      colors
    });
    offset += 0x400;
  }
  return descriptors;
}

function renderPaletteAnalysis(palette) {
  if (!hexAnalysisEl || !palette) return;
  const fmt = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
  const selectedEntries = hexPaletteHighlights.filter(h => h.type === 'palette-entry' && h.paletteIndex === palette.index);
  const selectedMap = new Map(selectedEntries.map(h => [h.entryIndex, h]));
  const swatches = palette.colors.map((rgb, i) => {
    const color = rgbToHex(rgb);
    const selected = selectedMap.get(i);
    return `<button type="button" class="hex-palette-swatch${selected ? ` is-selected header-hl-${selected.colorIndex}` : ''}" data-palette-entry="${i}" title="Entry ${i} · ${fmt(palette.start + i * 4)} · ${color}" style="--palette-color:${color}; --header-highlight:${selected ? HEADER_HIGHLIGHT_COLORS[selected.colorIndex] : 'transparent'}"><span>${i.toString(16).padStart(2, '0').toUpperCase()}</span></button>`;
  }).join('');

  hexAnalysisEl.innerHTML = `
      <div class="hex-analysis-title">ART palette ${palette.index} analysis <span class="hex-analysis-clickhint">Click colors to pin/unpin their 4-byte palette entries</span></div>
      <div class="hex-analysis-summary">
        <span><strong>Palette:</strong> ${palette.index}</span>
        <span><strong>Range:</strong> ${fmt(palette.start)}–${fmt(palette.end - 1)}</span>
        <span><strong>Size:</strong> 0x400 (1,024 bytes)</span>
        <span><strong>Entries:</strong> 256</span>
        <span><strong>Format:</strong> B, G, R, reserved</span>
      </div>
      <div class="hex-palette-grid" aria-label="Palette ${palette.index} colors">${swatches}</div>
      <div class="hex-analysis-note">Each color is stored as 4 bytes in file order: blue, green, red, then a reserved byte. Palette entries are zero-based.</div>`;

  hexAnalysisEl.querySelectorAll('[data-palette-entry]').forEach(el => {
    el.addEventListener('click', () => togglePaletteEntryHighlight(palette, Number(el.dataset.paletteEntry)));
  });
  hexAnalysisEl.hidden = false;
}

function togglePaletteEntryHighlight(palette, entryIndex) {
  if (!hexBytes || !palette) return;
  const existing = hexPaletteHighlights.findIndex(h => h.type === 'palette-entry' && h.paletteIndex === palette.index && h.entryIndex === entryIndex);
  if (existing !== -1) {
    hexPaletteHighlights.splice(existing, 1);
    renderPaletteAnalysis(palette);
    renderHexViewport();
    return;
  }
  const used = new Set([
    ...hexHeaderHighlights.map(h => h.colorIndex),
    ...hexPaletteHighlights.map(h => h.colorIndex)
  ]);
  let colorIndex = 0;
  while (used.has(colorIndex) && colorIndex < HEADER_HIGHLIGHT_COLORS.length) colorIndex++;
  if (colorIndex >= HEADER_HIGHLIGHT_COLORS.length) colorIndex = hexPaletteHighlights.length % HEADER_HIGHLIGHT_COLORS.length;
  const start = palette.start + entryIndex * 4;
  hexPaletteHighlights.push({
    type: 'palette-entry',
    paletteIndex: palette.index,
    entryIndex,
    start,
    end: start + 4,
    colorIndex
  });
  renderPaletteAnalysis(palette);
  const rowTop = Math.floor(start / HEX_BYTES_PER_ROW) * HEX_ROW_HEIGHT;
  hexScrollEl.scrollTop = Math.max(0, rowTop - hexScrollEl.clientHeight / 2 + HEX_ROW_HEIGHT);
  renderHexViewport();
}

function togglePaletteHighlight(palette) {
  if (!hexBytes || !palette) return;
  const existing = hexPaletteHighlights.findIndex(h => h.type === 'whole-palette' && h.paletteIndex === palette.index);
  if (existing !== -1) {
    hexPaletteHighlights.splice(existing, 1);
    renderPaletteAnalysis(palette);
    renderHexViewport();
    return;
  }
  hexPaletteHighlights = hexPaletteHighlights.filter(h => h.type !== 'whole-palette');
  const used = new Set([
    ...hexHeaderHighlights.map(h => h.colorIndex),
    ...hexPaletteHighlights.map(h => h.colorIndex)
  ]);
  let colorIndex = 0;
  while (used.has(colorIndex) && colorIndex < HEADER_HIGHLIGHT_COLORS.length) colorIndex++;
  if (colorIndex >= HEADER_HIGHLIGHT_COLORS.length) colorIndex = palette.index % HEADER_HIGHLIGHT_COLORS.length;
  hexPaletteHighlights.push({
    type: 'whole-palette',
    paletteIndex: palette.index,
    start: palette.start,
    end: palette.end,
    colorIndex
  });
  renderPaletteAnalysis(palette);
  const rowTop = Math.floor(palette.start / HEX_BYTES_PER_ROW) * HEX_ROW_HEIGHT;
  hexScrollEl.scrollTop = Math.max(0, rowTop - hexScrollEl.clientHeight / 2 + HEX_ROW_HEIGHT);
  renderHexViewport();
}

function toggleHeaderHighlight(rowIndex) {
  if (!hexBytes) return;
  const info = readHeaderAnalysis(hexBytes);
  if (!info.valid || !info.rows[rowIndex]) return;

  const existing = hexHeaderHighlights.findIndex(h => h.type === 'header' && h.rowIndex === rowIndex);
  if (existing !== -1) {
    hexHeaderHighlights.splice(existing, 1);
    renderHeaderAnalysis();
    renderHexViewport();
    return;
  }

  const [offset, size] = info.rows[rowIndex];
  const start = parseInt(offset, 16);
  const length = parseInt(size, 10);
  const used = new Set(hexHeaderHighlights.map(h => h.colorIndex));
  let colorIndex = 0;
  while (used.has(colorIndex) && colorIndex < 10) colorIndex++;
  if (colorIndex >= 10) colorIndex = rowIndex % 10;

  hexHeaderHighlights.push({ type: 'header', rowIndex, start, end: start + length, colorIndex });
  renderHeaderAnalysis();
  const rowTop = Math.floor(start / HEX_BYTES_PER_ROW) * HEX_ROW_HEIGHT;
  hexScrollEl.scrollTop = Math.max(0, rowTop - hexScrollEl.clientHeight / 2 + HEX_ROW_HEIGHT);
  renderHexViewport();
}

function renderHeaderAnalysis() {
  if (!hexBytes || !hexAnalysisEl) return;
  const info = readHeaderAnalysis(hexBytes);

  if (!info.valid) {
    hexAnalysisEl.innerHTML = `<div class="hex-analysis-error">${info.message}</div>`;
    hexAnalysisEl.hidden = false;
    return;
  }

  const status = info.warnings.length
    ? `<div class="hex-analysis-warnings">${info.warnings.map(w => `<div>⚠ ${w}</div>`).join('')}</div>`
    : `<div class="hex-analysis-ok">Header is structurally consistent with the 0x84-byte ART header layout.</div>`;

  const rowsHtml = info.rows.map((row, rowIndex) => {
    const [offset, size, field, value, note] = row;
    const selected = hexHeaderHighlights.find(h => h.type === 'header' && h.rowIndex === rowIndex);
    return `
      <tr class="hex-analysis-row${selected ? ` is-selected selected header-hl-${selected.colorIndex}` : ''}" data-header-row="${rowIndex}" title="Click to ${selected ? 'remove' : 'highlight'} this header field in the hex viewer">
        <td>${offset}</td>
        <td>${size}</td>
        <td>${field}</td>
        <td>${value}</td>
        <td>${note}</td>
      </tr>`;
  }).join('');

  hexAnalysisEl.innerHTML = `
      <div class="hex-analysis-title">ART header analysis <span class="hex-analysis-clickhint">Click rows to pin/unpin their byte ranges</span></div>
      <div class="hex-analysis-summary">
        <span><strong>Header:</strong> 0x000–0x083 (132 bytes)</span>
        <span><strong>Directions:</strong> ${info.directions}</span>
        <span><strong>Frames:</strong> ${info.totalFrames.toLocaleString()}</span>
        <span><strong>Palettes:</strong> ${info.paletteCount}</span>
        <span><strong>Frame info:</strong> 0x${info.frameInfoOffset.toString(16).toUpperCase().padStart(4, '0')}</span>
        <span><strong>Pixel data:</strong> 0x${info.pixelDataOffset.toString(16).toUpperCase().padStart(4, '0')}</span>
      </div>
      <div class="hex-analysis-table-wrap">
        <table class="hex-analysis-table">
          <thead><tr><th>Offset</th><th>Size</th><th>Field</th><th>Decoded value</th><th>Interpretation</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      ${status}
      <div class="hex-analysis-note">
        Values are 32-bit little-endian integers. The four fields at 0x0C are palette-presence values,
        not palette offsets. Present palettes follow immediately after the 0x84-byte header.
      </div>`;

  hexAnalysisEl.querySelectorAll('[data-header-row]').forEach(rowEl => {
    rowEl.addEventListener('click', () => toggleHeaderHighlight(Number(rowEl.dataset.headerRow)));
  });
  hexAnalysisEl.hidden = false;
}

function getFrameInfoRows(frame) {
  const base = frame.frameInfoOffset;
  const fmt = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
  return [
    [fmt(base + 0x00), 0x00, '4', 'Width', String(frame.width)],
    [fmt(base + 0x04), 0x04, '4', 'Height', String(frame.height)],
    [fmt(base + 0x08), 0x08, '4', "Number of stored bytes for this frame's pixels", String(frame.dataLength)],
    [fmt(base + 0x0C), 0x0C, '4', 'Hotspot X', String(frame.hotspotX)],
    [fmt(base + 0x10), 0x10, '4', 'Hotspot Y', String(frame.hotspotY)],
    [fmt(base + 0x14), 0x14, '4', 'Movement or drawing offset X', String(frame.movementOffsetX)],
    [fmt(base + 0x18), 0x18, '4', 'Movement or drawing offset Y', String(frame.movementOffsetY)]
  ];
}

function renderFrameAnalysis(frame) {
  if (!hexAnalysisEl || !frame) return;

  const rows = getFrameInfoRows(frame);
  const frameInfoStart = frame.frameInfoOffset;
  const frameInfoEnd = frameInfoStart + 0x1C;

  hexAnalysisEl.innerHTML = `
      <div class="hex-analysis-title">
        ART frame ${frame.index + 1} analysis
        <span class="hex-analysis-clickhint">Click rows to pin/unpin their byte ranges</span>
      </div>
      <div class="hex-analysis-summary">
        <span><strong>Frame record:</strong> 0x${frameInfoStart.toString(16).toUpperCase().padStart(4, '0')}–0x${(frameInfoEnd - 1).toString(16).toUpperCase().padStart(4, '0')}</span>
        <span><strong>Pixel data:</strong> 0x${frame.dataOffset.toString(16).toUpperCase().padStart(4, '0')}</span>
        <span><strong>Pixel bytes:</strong> ${frame.dataLength.toLocaleString()}</span>
      </div>
      <div class="hex-analysis-table-wrap">
        <table class="hex-analysis-table">
          <thead>
            <tr><th>Offset</th><th>Size</th><th>Meaning</th><th>Decoded value</th></tr>
          </thead>
          <tbody>
            ${rows.map((row, i) => {
            const selected = hexHeaderHighlights.find(h => h.type === 'frame' && h.frameInfoOffset === frame.frameInfoOffset && h.rowIndex === i);
            const color = selected ? HEADER_HIGHLIGHT_COLORS[selected.colorIndex] : null;
            return `
                <tr class="hex-analysis-row${selected ? ` is-selected selected header-hl-${selected.colorIndex}` : ''}"
                    data-frame-row="${i}"
                    ${color ? `style="--header-highlight:${color}"` : ''}
                    title="Click to ${selected ? 'remove' : 'highlight'} this frame field in the hex viewer">
                  <td>${row[0]}</td>
                  <td>${row[2]}</td>
                  <td>${row[3]}</td>
                  <td>${row[4]}</td>
                </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
      <div class="hex-analysis-note">
        Frame fields are 32-bit little-endian values. Offsets are absolute file offsets.
      </div>`;

  hexAnalysisEl.querySelectorAll('[data-frame-row]').forEach(rowEl => {
    rowEl.addEventListener('click', () => toggleFrameHeaderHighlight(frame, Number(rowEl.dataset.frameRow)));
  });
  hexAnalysisEl.hidden = false;
}

function toggleFrameHeaderHighlight(frame, rowIndex) {
  if (!hexBytes || !frame) return;

  const existing = hexHeaderHighlights.findIndex(h =>
    h.type === 'frame' &&
    h.frameInfoOffset === frame.frameInfoOffset &&
    h.rowIndex === rowIndex
  );

  if (existing !== -1) {
    hexHeaderHighlights.splice(existing, 1);
    renderFrameAnalysis(frame);
    renderHexViewport();
    return;
  }

  const rows = getFrameInfoRows(frame);
  const [, relativeOffset, size] = rows[rowIndex];
  const start = frame.frameInfoOffset + relativeOffset;
  const length = parseInt(size, 10);

  const used = new Set(hexHeaderHighlights.map(h => h.colorIndex));
  let colorIndex = 0;
  while (used.has(colorIndex) && colorIndex < HEADER_HIGHLIGHT_COLORS.length) colorIndex++;
  if (colorIndex >= HEADER_HIGHLIGHT_COLORS.length) colorIndex = hexHeaderHighlights.length % HEADER_HIGHLIGHT_COLORS.length;

  hexHeaderHighlights.push({
    type: 'frame',
    frameInfoOffset: frame.frameInfoOffset,
    rowIndex,
    start,
    end: start + length,
    colorIndex
  });

  renderFrameAnalysis(frame);
  const rowTop = Math.floor(start / HEX_BYTES_PER_ROW) * HEX_ROW_HEIGHT;
  hexScrollEl.scrollTop = Math.max(0, rowTop - hexScrollEl.clientHeight / 2 + HEX_ROW_HEIGHT);
  renderHexViewport();
}

function buildHexFrameStrip(group) {
  if (!hexFrameStripEl) return;
  hexFrameStripEl.innerHTML = '';

  const palettes = getPaletteDescriptors(hexBytes);

  const clearCardSelection = () => {
    hexFrameStripEl.querySelectorAll('.hex-frame-card.selected-frame')
      .forEach(el => el.classList.remove('selected-frame'));
  };

  const headerCard = document.createElement('button');
  headerCard.type = 'button';
  headerCard.className = 'hex-frame-card hex-header-card selected-frame';
  headerCard.title = 'ART file header';
  headerCard.innerHTML = `
      <div class="hex-header-preview" aria-hidden="true">
        <div class="hex-header-icon">
          <span class="hex-header-fold"></span>
          <span class="hex-header-title">ART</span>
          <span class="hex-header-line"></span>
          <span class="hex-header-line short"></span>
          <span class="hex-header-line"></span>
          <span class="hex-header-line tiny"></span>
        </div>
        <span class="hex-header-badge">HEADER</span>
      </div>
      <span class="hex-frame-label">Header · 0x00–0x83</span>
    `;
  headerCard.addEventListener('click', () => {
    hexSelectedFrame = null;
    hexSelectedPalette = null;
    hexPaletteHighlights = [];
    hexHeaderHighlights = [{ type: 'whole-header', start: 0, end: 0x84, colorIndex: 0 }];
    clearCardSelection();
    headerCard.classList.add('selected-frame');
    renderHeaderAnalysis();
    renderHexViewport();
    if (hexScrollEl) hexScrollEl.scrollTop = 0;
  });
  hexFrameStripEl.appendChild(headerCard);

  palettes.forEach((palette) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'hex-frame-card hex-palette-card';
    card.title = `Palette ${palette.index}`;
    const preview = document.createElement('div');
    preview.className = 'hex-palette-preview';
    palette.colors.forEach((rgb) => {
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = rgbToHex(rgb);
      preview.appendChild(swatch);
    });
    const label = document.createElement('span');
    label.className = 'hex-frame-label';
    label.textContent = `Palette ${palette.index} · ${fmtHex(palette.start)}–${fmtHex(palette.end - 1)}`;
    card.appendChild(preview);
    card.appendChild(label);
    card.addEventListener('click', () => {
      hexSelectedFrame = null;
      hexSelectedPalette = palette;
      hexHeaderHighlights = [];
      clearCardSelection();
      card.classList.add('selected-frame');
      togglePaletteHighlight(palette);
    });
    hexFrameStripEl.appendChild(card);
  });

  group.frames.forEach((entry, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'hex-frame-card';
    card.title = `Frame ${index + 1}`;

    const preview = document.createElement('div');
    preview.className = 'hex-frame-preview';
    const canvas = document.createElement('canvas');
    canvas.width = entry.frame.canvas.width;
    canvas.height = entry.frame.canvas.height;
    canvas.getContext('2d').drawImage(entry.frame.canvas, 0, 0);
    preview.appendChild(canvas);

    const label = document.createElement('span');
    label.className = 'hex-frame-label';
    label.textContent = `Frame ${index + 1} · Record ${fmtHex(entry.frame.frameInfoOffset)} · Pixel ${fmtHex(entry.frame.dataOffset)}`;

    card.appendChild(preview);
    card.appendChild(label);
    card.addEventListener('mouseenter', () => highlightFrameInHex(group, entry.frame, { scroll: false }));
    card.addEventListener('mouseleave', () => {
      if (hexPinnedFrame && hexActiveGroup === group) {
        highlightFrameInHex(group, hexPinnedFrame, { scroll: false });
      } else {
        clearHexHighlight(group);
      }
    });
    card.addEventListener('click', () => {
      const isSameFrame = hexSelectedFrame && hexSelectedFrame.frameInfoOffset === entry.frame.frameInfoOffset;

      setHexPin(card, group, entry.frame);
      clearCardSelection();

      if (isSameFrame) {
        hexSelectedFrame = null;
        hexSelectedPalette = null;
        hexPaletteHighlights = [];
        hexHeaderHighlights = [{ type: 'whole-header', start: 0, end: 0x84, colorIndex: 0 }];
        if (headerCard) headerCard.classList.add('selected-frame');
        renderHeaderAnalysis();
      } else {
        hexSelectedFrame = entry.frame;
        hexSelectedPalette = null;
        hexPaletteHighlights = [];
        hexHeaderHighlights = [];
        card.classList.add('selected-frame');
        renderFrameAnalysis(entry.frame);
      }

      renderHexViewport();
    });
    hexFrameStripEl.appendChild(card);
  });
}

function fmtHex(n) {
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}

export function openHexViewer(group) {
  if (!group.rawBuffer) {
    log(`${group.baseName}: raw file bytes aren't available for the hex view`, 'err');
    return;
  }
  hexBytes = new Uint8Array(group.rawBuffer);
  hexActiveGroup = group;
  hexHighlight = null;
  hexHeaderHighlights = [];
  if (hexPinnedPreviewEl) hexPinnedPreviewEl.classList.remove('hex-pinned');
  hexPinnedFrame = null;
  hexPinnedPreviewEl = null;
  hexSelectedFrame = null;
  hexSelectedPalette = null;
  hexPaletteHighlights = [];
  hexTotalRows = Math.max(1, Math.ceil(hexBytes.length / HEX_BYTES_PER_ROW));
  hexSpacerEl.style.height = `${hexTotalRows * HEX_ROW_HEIGHT}px`;
  hexTitleEl.textContent = `${group.baseName}.art — header + hex`;
  hexMetaEl.textContent = `${hexBytes.length.toLocaleString()} bytes`;
  renderHeaderAnalysis();
  buildHexFrameStrip(group);
  hexScrollEl.scrollTop = 0;
  hexOverlayEl.classList.add('open');
  document.body.classList.add('hex-view-open');
  renderHexViewport();
}

function closeHexViewer() {
  hexOverlayEl.classList.remove('open');
  if (hexAnalysisEl) {
    hexAnalysisEl.hidden = true;
    hexAnalysisEl.innerHTML = '';
  }
  if (hexFrameStripEl) hexFrameStripEl.innerHTML = '';
  document.body.classList.remove('hex-view-open');
  hexBytes = null;
  hexActiveGroup = null;
  hexHighlight = null;
  hexHeaderHighlights = [];
  if (hexPinnedPreviewEl) hexPinnedPreviewEl.classList.remove('hex-pinned');
  hexPinnedFrame = null;
  hexPinnedPreviewEl = null;
  hexSelectedFrame = null;
}

export function highlightFrameInHex(group, frame, opts) {
  if (hexActiveGroup !== group) return;
  if (!hexOverlayEl.classList.contains('open')) return;
  if (typeof frame.dataOffset !== 'number' || typeof frame.dataLength !== 'number') return;
  hexHighlight = { start: frame.dataOffset, end: frame.dataOffset + frame.dataLength };
  if (!opts || opts.scroll !== false) {
    const rowTop = Math.floor(hexHighlight.start / HEX_BYTES_PER_ROW) * HEX_ROW_HEIGHT;
    hexScrollEl.scrollTop = Math.max(0, rowTop - hexScrollEl.clientHeight / 2 + HEX_ROW_HEIGHT);
  }
  renderHexViewport();
}

export function clearHexHighlight(group) {
  if (hexActiveGroup !== group) return;
  if (!hexHighlight) return;
  hexHighlight = null;
  renderHexViewport();
}

export function setHexPin(previewEl, group, frame) {
  if (hexActiveGroup !== group || !hexOverlayEl.classList.contains('open')) return;
  if (hexPinnedFrame === frame) {
    // clicking the already-pinned frame unpins it
    previewEl.classList.remove('hex-pinned');
    hexPinnedFrame = null;
    hexPinnedPreviewEl = null;
    return;
  }
  if (hexPinnedPreviewEl) hexPinnedPreviewEl.classList.remove('hex-pinned');
  hexPinnedFrame = frame;
  hexPinnedPreviewEl = previewEl;
  previewEl.classList.add('hex-pinned');
  highlightFrameInHex(group, frame);
}

hexScrollEl.addEventListener('scroll', renderHexViewport);
hexCloseBtn.addEventListener('click', closeHexViewer);
document.addEventListener('keydown', (e) => {
  if (!hexOverlayEl.classList.contains('open')) return;
  if (e.key === 'Escape') closeHexViewer();
});
window.addEventListener('resize', () => {
  if (hexOverlayEl.classList.contains('open')) renderHexViewport();
});
