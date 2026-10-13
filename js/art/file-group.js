// Viewer for one opened .ART file (frames, downloads, zip) and local file handling.

import { errText } from '../core/text-io.js';
import { paletteZeroColor, parseArtFile } from './art-decoder.js';
import { canvasToBlob, frameBlobForPalette, frameCanvasForPalette, frameFilename } from './art-export.js';

import { openGifBuilder } from './gif-builder.js';
import { addContextTool } from '../ui/shell.js';

import {
  clearHexHighlight,
  hexActiveGroup,
  hexPinnedFrame,
  highlightFrameInHex,
  openHexViewer,
  setHexPin,
} from './hex-viewer.js';

import { log } from '../core/log.js';

import { setOpenGroup } from '../core/state.js';

import { rgbToHex, saveFile } from '../core/util.js';
import { showViewer } from '../explorer/viewer-shell.js';

async function downloadGroupZip(group) {
  const zip = new JSZip();
  const folder = zip.folder(group.baseName);
  for (const entry of group.frames) {
    const blob = await frameBlobForPalette(group, entry.frame);
    folder.file(entry.filename, blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  await saveFile(`${group.baseName}.zip`, zipBlob);
}

export function renderFileGroup(baseName, frames, shareInfo, rawBuffer) {
  const paletteBg = paletteZeroColor(frames[0] && frames[0].palette);
  const directionCount = frames.directionCount || 1;
  const framesPerDirection = frames.framesPerDirection || frames.length;
  const group = {
    baseName, frames: [], sourceFrames: frames,
    transparentColor: paletteBg,
    transparentIndex: 0,
    rawBuffer: rawBuffer || null,
    palettes: frames[0] && frames[0].palettes ? frames[0].palettes : [frames[0].palette],
    selectedPaletteIndex: 0,
    directionCount, framesPerDirection,
    gifByDirection: {}, // one cached builder state per direction, keyed by direction index
  };

  const article = document.createElement('article');
  article.className = 'file-group';

  const header = document.createElement('div');
  header.className = 'file-group-header';
  header.innerHTML = `
      <h2>${baseName}.art</h2>
      <span class="meta">${frames.length} frame${frames.length === 1 ? '' : 's'}</span>
    `;
  article.appendChild(header);

  // Palette / Hex / Build GIF live in the top bar (next to the .ART Packer) for as long as this file is open;
  // "Download all" goes to the right side bar.
  const toolButton = (cls, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = label;
    return b;
  };
  const paletteBtn = toolButton('art-tool-palette', 'Palette');
  const hexBtn = toolButton('art-tool-hex', 'Hex');
  const gifBtn = toolButton('art-tool-gif', 'Build GIF…');
  for (const b of [gifBtn, hexBtn, paletteBtn]) addContextTool(b, article);   // each one is put in front of the last
  const actions = document.createElement('section');
  actions.className = 'side-card art-side-actions';
  actions.innerHTML = '<h3>Export</h3>';
  const zipBtn = toolButton('btn-zip', 'Download all (.zip)');
  actions.appendChild(zipBtn);
  article.appendChild(actions);

  const grid = document.createElement('div');
  grid.className = 'frame-grid';

  for (const frame of frames) {
    const filename = frameFilename(baseName, frame);
    const entry = { filename, frame, blobPromise: canvasToBlob(frame.canvas) };
    group.frames.push(entry);

    const card = document.createElement('figure');
    card.className = 'frame-card';

    const preview = document.createElement('div');
    preview.className = 'frame-preview';
    preview.appendChild(frame.canvas);
    preview.addEventListener('mouseenter', () => highlightFrameInHex(group, frame));
    preview.addEventListener('mouseleave', () => {
      if (hexPinnedFrame && hexActiveGroup === group) {
        highlightFrameInHex(group, hexPinnedFrame, { scroll: false });
      } else {
        clearHexHighlight(group);
      }
    });
    preview.addEventListener('click', () => setHexPin(preview, group, frame));
    card.appendChild(preview);

    const caption = document.createElement('figcaption');
    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = `${frame.width}×${frame.height}`;
    const btn = document.createElement('button');
    btn.className = 'btn-download';
    btn.type = 'button';
    btn.textContent = 'PNG';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const blob = await frameBlobForPalette(group, frame);
      await saveFile(filename, blob);
      btn.disabled = false;
    });
    caption.appendChild(dims);
    caption.appendChild(btn);
    card.appendChild(caption);

    grid.appendChild(card);
  }

  article.appendChild(grid);

  const palettePanel = document.createElement('div');
  palettePanel.className = 'palette-panel';
  palettePanel.hidden = true;

  const palettePanelTop = document.createElement('div');
  palettePanelTop.className = 'palette-panel-top';
  const palettePanelTitle = document.createElement('strong');
  palettePanelTitle.textContent = 'Palettes';

  const tintControl = document.createElement('label');
  tintControl.className = 'palette-tint-control';
  const tintLabel = document.createElement('span');
  tintLabel.textContent = 'Tint';
  const tintInput = document.createElement('input');
  tintInput.type = 'color';
  tintInput.className = 'palette-tint-input';
  tintInput.value = '#808080';
  tintInput.title = 'Choose a color to turn the current palette into shades of it';
  tintInput.setAttribute('aria-label', 'Choose palette tint');
  tintControl.append(tintLabel, tintInput);
  palettePanelTop.append(palettePanelTitle, tintControl);
  palettePanel.appendChild(palettePanelTop);

  const paletteList = document.createElement('div');
  paletteList.className = 'palette-list';
  palettePanel.appendChild(paletteList);
  header.appendChild(palettePanel);

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        default: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  function tintPalette(palette, hex) {
    const n = hex.slice(1);
    const target = [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
    const [targetH, targetS] = rgbToHsl(target);
    return palette.map((rgb, index) => {
      if (!Array.isArray(rgb) || index === group.transparentIndex) return Array.isArray(rgb) ? rgb.slice() : [0, 0, 0];
      const [, sourceS, sourceL] = rgbToHsl(rgb);
      // Keep each original color's lightness, but give it the chosen hue.
      // This preserves the palette's highlights/shadows while making the whole set
      // read as shades of the selected color instead of one flat replacement color.
      const saturation = Math.min(1, targetS * (0.35 + sourceS * 0.65));
      return hslToRgb(targetH, saturation, sourceL);
    });
  }

  function applyPalette(palette, label, buttonToSelect = null) {
    group.previewPalette = palette;
    group.selectedPalette = palette;
    paletteList.querySelectorAll('.palette-option').forEach(b => b.classList.remove('selected'));
    if (buttonToSelect) buttonToSelect.classList.add('selected');
    group.sourceFrames.forEach(frame => {
      const rendered = frameCanvasForPalette(frame, palette, group.transparentIndex);
      frame.canvas.width = rendered.width;
      frame.canvas.height = rendered.height;
      frame.canvas.getContext('2d').drawImage(rendered, 0, 0);
    });
    group.frames.forEach(entry => { entry.blobPromise = frameBlobForPalette(group, entry.frame); });
    log(`${baseName}: previewing ${label}`, 'ok');
  }

  function renderPaletteButton(palette, label, selected) {
    const wrap = document.createElement('div');
    wrap.className = 'palette-choice';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-option';
    button.title = label;
    button.setAttribute('aria-label', label);
    for (let i = 0; i < 256; i++) {
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = rgbToHex(palette[i] || [0, 0, 0]);
      button.appendChild(swatch);
    }
    if (selected) button.classList.add('selected');
    button.addEventListener('click', () => applyPalette(palette, label, button));
    const caption = document.createElement('span');
    caption.className = 'palette-choice-label';
    caption.textContent = label;
    wrap.append(button, caption);
    paletteList.appendChild(wrap);
  }

  group.previewPalette = group.palettes[0];
  group.selectedPalette = group.palettes[0];
  group.palettes.forEach((palette, index) => renderPaletteButton(palette, `Built-in palette ${index + 1}`, index === 0));

  paletteBtn.addEventListener('click', () => {
    palettePanel.hidden = !palettePanel.hidden;
    paletteBtn.classList.toggle('active', !palettePanel.hidden);
  });

  tintInput.addEventListener('input', () => {
    const sourcePalette = group.selectedPalette || group.palettes[0];
    const tinted = tintPalette(sourcePalette, tintInput.value);
    const label = `Tint ${tintInput.value.toUpperCase()}`;
    applyPalette(tinted, label);
  });

  zipBtn.addEventListener('click', () => {
    zipBtn.disabled = true;
    downloadGroupZip(group).finally(() => { zipBtn.disabled = false; });
  });

  gifBtn.addEventListener('click', () => openGifBuilder(group));
  hexBtn.addEventListener('click', () => openHexViewer(group));

  setOpenGroup(group);
  showViewer(article, shareInfo);
}

export async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.art$/i.test(f.name));
  if (files.length === 0) {
    log('no .ART files in that selection', 'err');
    return;
  }
  for (const file of files) {
    const baseName = file.name.replace(/\.art$/i, '');
    log(`decoding ${file.name}…`);
    try {
      const { frames, buf } = await parseArtFile(file);
      if (frames.length === 0) {
        log(`${file.name}: header parsed but no drawable frames were found`, 'err');
        continue;
      }
      log(`${file.name}: extracted ${frames.length} frame${frames.length === 1 ? '' : 's'}`, 'ok');
      renderFileGroup(baseName, frames, undefined, buf);
    } catch (err) {
      log(`${file.name}: ${errText(err)}`, 'err');
    }
  }
}
