(function () {
  "use strict";

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const logEl = document.getElementById('log');
  const manualLoadEl = document.querySelector('.manual-load');
  const footerNoteEl = document.querySelector('footer.note');
  const viewerEl = document.getElementById('explorerViewer');
  let explorerMode = 'art';

  function log(message, kind) {
    const p = document.createElement('p');
    if (kind) p.className = kind;
    p.textContent = message;
    logEl.appendChild(p);
    logEl.classList.add('has-entries');
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---- ART decoding ----------------------------------------------------

  // The game always treats palette index 0 as the transparent/color-key
  // entry (see Arcanum_ART_Files_Explanation.txt, section 2) — it isn't
  // necessarily pure blue, that's just the common modding convention. This
  // fallback is only used if a file somehow has no palette at all.
  const DEFAULT_TRANSPARENT_COLOR = [0, 0, 255];

  function paletteZeroColor(palette) {
    return (palette && palette[0]) ? palette[0] : DEFAULT_TRANSPARENT_COLOR;
  }

  function composeFrameCanvasInPlace(frame, transparentRGB) {
    const { width: w, height: h, indices, palette } = frame;
    const total = w * h;
    const rgba = new Uint8ClampedArray(total * 4);
    const [tr, tg, tb] = transparentRGB;
    for (let i = 0; i < total; i++) {
      const [r, g, b] = palette[indices[i]];
      const o = i * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = (r === tr && g === tg && b === tb) ? 0 : 255;
    }
    frame.canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  }

  function decodeRLE(chunk) {
    const out = [];
    let ptr = 0;
    while (ptr < chunk.length) {
      const control = chunk[ptr++];
      const isRepeating = (control & 0x80) === 0;
      const count = control & 0x7F;
      if (isRepeating) {
        const val = chunk[ptr++];
        for (let i = 0; i < count; i++) out.push(val);
      } else {
        for (let i = 0; i < count; i++) out.push(chunk[ptr++]);
      }
    }
    return Uint8Array.from(out);
  }

  async function parseArtFile(file) {
    const buf = await file.arrayBuffer();
    const frames = await parseArtBuffer(buf);
    return { frames, buf };
  }

  async function parseArtBuffer(buf) {
    if (buf.byteLength < 0x84) {
      throw new Error(`file too small to contain valid headers (${buf.byteLength} bytes)`);
    }
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    const head = new Array(33);
    for (let i = 0; i < 33; i++) head[i] = view.getUint32(i * 4, true);

    let paletteCount;
    if (head[6] !== 0) paletteCount = 4;
    else if (head[5] !== 0) paletteCount = 3;
    else if (head[4] !== 0) paletteCount = 2;
    else paletteCount = 1;

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
    for (let idx = 0; idx < imageInfos.length; idx++) {
      const { width: w, height: h, size: compressedSize } = imageInfos[idx];
      if (w === 0 || h === 0) continue;

      if (offset + compressedSize > buf.byteLength) {
        throw new Error(`frame ${idx} pixel data runs past the end of the file`);
      }
      const dataOffset = offset;
      const chunk = bytes.subarray(offset, offset + compressedSize);
      offset += compressedSize;

      const total = w * h;
      let indices = (total === chunk.length) ? chunk : decodeRLE(chunk);

      let finalIndices;
      if (indices.length < total) {
        finalIndices = new Uint8Array(total);
        finalIndices.set(indices);
      } else {
        finalIndices = indices.subarray(0, total);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;

      const frame = {
        index: idx,
        direction: Math.floor(idx / framesPerDirection),
        width: w,
        height: h,
        canvas,
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
      composeFrameCanvasInPlace(frame, paletteZeroColor(activePalette));
      frames.push(frame);
    }

    // Exposed alongside the frames so callers can offer a per-direction
    // choice instead of dumping every direction's frames into one list —
    // the frame table is laid out direction by direction (see
    // Arcanum_ART_Files_Explanation.txt), so direction d's frames are
    // exactly frames[d * framesPerDirection .. (d+1) * framesPerDirection).
    frames.directionCount = directionCount;
    frames.framesPerDirection = framesPerDirection;

    return frames;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function frameCanvasForPalette(frame, palette, transparentIndex = 0) {
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

  function frameBlobForPalette(group, frame) {
    const palette = group.selectedPalette || group.palettes[0];
    return canvasToBlob(frameCanvasForPalette(frame, palette, group.transparentIndex));
  }

  function frameFilename(baseName, frame) {
    const suffix = frame.totalImages > 1 ? `_${frame.index}` : '';
    return `${baseName}${suffix}.png`;
  }

  // ---- UI ---------------------------------------------------------------

  let openGroup = null; // the single currently-open file's group, or null

  function showViewer(article, shareInfo) {
    gridEl.hidden = true;
    paginationEl.hidden = true;
    viewerEl.innerHTML = '';

    const backBar = document.createElement('div');
    backBar.className = 'viewer-backbar';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn-back';
    backBtn.textContent = '← Back to folder';
    backBtn.addEventListener('click', showBrowser);
    backBar.appendChild(backBtn);

    if (shareInfo) {
      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'btn-share';
      shareBtn.textContent = '🔗 Share';
      shareBtn.addEventListener('click', () => {
        copyShareLink(shareInfo.folder, shareInfo.folderName, shareInfo.file, shareBtn);
      });
      backBar.appendChild(shareBtn);
      updateUrlForItem(shareInfo.folder, shareInfo.folderName, shareInfo.file);
    }

    viewerEl.appendChild(backBar);
    viewerEl.appendChild(article);
    viewerEl.hidden = false;
    viewerEl.classList.add('revealed');
  }

  function showBrowser() {
    if (explorerMode === 'mob') { showMobBrowser(); return; }
    if (openGroup) closeGifBuilder();
    openGroup = null;
    viewerEl.hidden = true;
    viewerEl.innerHTML = '';
    gridEl.hidden = false;
    updatePaginationBar();
    clearShareUrl();
    gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Share links -----------------------------------------------------
  //
  // A share link encodes the item's folder path, the folder's own manifest
  // name (needed to fetch its manifest file), and the filename itself.

  function buildShareUrl(folder, folderName, filename) {
    const url = new URL(window.location.href);
    url.hash = '';
    const params = new URLSearchParams();
    if (folder) params.set('folder', folder);
    params.set('folderName', folderName || ROOT_FOLDER_NAME);
    params.set('file', filename);
    url.search = params.toString();
    return url.toString();
  }

  function updateUrlForItem(folder, folderName, filename) {
    window.history.replaceState(null, '', buildShareUrl(folder, folderName, filename));
  }

  function clearShareUrl() {
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState(null, '', url.pathname + url.hash);
  }

  async function copyShareLink(folder, folderName, filename, btn) {
    const link = buildShareUrl(folder, folderName, filename);
    const original = btn.textContent;
    const flash = (text) => {
      btn.textContent = text;
      btn.classList.add('flash');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('flash');
      }, 1600);
    };
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error('clipboard API unavailable');
      await navigator.clipboard.writeText(link);
      flash('Link copied!');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = link;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
        flash('Link copied!');
      } catch (e2) {
        flash('Copy failed');
        log(`couldn't copy share link: ${e2 && e2.message ? e2.message : e2}`, 'err');
      }
    }
  }

  function parseDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const file = params.get('file');
    if (!file) return null;
    return {
      folder: params.get('folder') || '',
      folderName: params.get('folderName') || ROOT_FOLDER_NAME,
      file,
    };
  }

  async function saveFile(filename, blob) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      log(`couldn't save ${filename}: ${e && e.message ? e.message : e}`, 'err');
    }
  }

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

  function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function refreshGroupBlobs(group) {
    group.frames.forEach(entry => {
      entry.blobPromise = canvasToBlob(entry.frame.canvas);
    });
  }

  function applyTransparencyKey(group, rgb) {
    group.transparentColor = rgb;
    group.sourceFrames.forEach(frame => composeFrameCanvasInPlace(frame, rgb));
    refreshGroupBlobs(group);
  }

  async function generateFolderPaletteSuggestions(shareInfo, excludeFn) {
    if (!shareInfo) {
      throw new Error('palette suggestions require a server folder');
    }

    // Use the exact file list belonging to the folder the user is currently
    // browsing whenever possible. This is the same list used to render the
    // explorer, so palette generation cannot accidentally sample some other
    // manifest/folder.
    let candidates;
    if (currentManifest && folderRelPath === shareInfo.folder && currentFolderName === shareInfo.folderName) {
      candidates = folderFiles.slice();
    } else {
      const manifest = await loadManifest(shareInfo.folder, shareInfo.folderName);
      candidates = (manifest.files || []).filter(f => /\.art$/i.test(f));
    }

    candidates = candidates
      .filter(f => /\.art$/i.test(f))
      .filter(f => !excludeFn(f));

    const totalOtherFiles = candidates.length;

    // Fisher-Yates shuffle: every Generate click gets a fresh random sample.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const sample = candidates.slice(0, Math.min(10, candidates.length));
    const suggestions = [];
    let sampledCount = 0;
    let parsedPaletteCount = 0;

    for (const filename of sample) {
      try {
        const prefix = shareInfo.folder ? `${shareInfo.folder}/` : '';
        const resp = await fetch(`${ART_ROOT}${prefix}${filename}`);
        if (!resp.ok) continue;

        const buf = await resp.arrayBuffer();
        const frames = await parseArtBuffer(buf);
        sampledCount++;

        const filePalettes = [];
        const seenInFile = new Set();
        for (const frame of frames) {
          const palettes = Array.isArray(frame.palettes) && frame.palettes.length
            ? frame.palettes
            : (frame.palette ? [frame.palette] : []);
          for (const palette of palettes) {
            if (!Array.isArray(palette) || palette.length === 0) continue;
            const key = palette.map(rgbToHex).join('');
            if (seenInFile.has(key)) continue;
            seenInFile.add(key);
            filePalettes.push({ palette, source: filename });
          }
        }
        if (filePalettes.length) parsedPaletteCount += filePalettes.length;
        suggestions.push(...filePalettes);
      } catch (_) {
        // Keep sampling if one ART is malformed or unavailable.
      }
    }

    return {
      suggestions,
      sampledCount,
      requestedCount: sample.length,
      totalOtherFiles,
      parsedPaletteCount,
    };
  }

  function renderFileGroup(baseName, frames, shareInfo, rawBuffer) {
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
      <button class="btn-palette" type="button">Palette</button>
      <button class="btn-hex">Hex</button>
      <button class="btn-gif">Build GIF…</button>
      <button class="btn-zip">Download all (.zip)</button>
    `;
    article.appendChild(header);

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

    const paletteBtn = header.querySelector('.btn-palette');
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

    function paletteKey(palette) {
      return palette.map(rgbToHex).join('');
    }

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


    header.querySelector('.btn-zip').addEventListener('click', (e) => {
      e.target.disabled = true;
      downloadGroupZip(group).finally(() => { e.target.disabled = false; });
    });

    header.querySelector('.btn-gif').addEventListener('click', () => openGifBuilder(group));
    header.querySelector('.btn-hex').addEventListener('click', () => openHexViewer(group));

    openGroup = group;
    showViewer(article, shareInfo);
  }

  async function handleFiles(fileList) {
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
        log(`${file.name}: ${err && err.message ? err.message : err}`, 'err');
      }
    }
  }

  // ---- GIF builder -------------------------------------------------------

  let activeGroup = null;    // the { frames, currentIndex, ... } state for the open builder
  let activeGroupRef = null; // the file-group it belongs to (for baseName / re-entry)
  let gifWorkerUrl = null;

  function computeBounds(frames) {
    const included = frames.filter(f => f.include);
    const list = included.length ? included : frames;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach(f => {
      minX = Math.min(minX, f.offsetX);
      minY = Math.min(minY, f.offsetY);
      maxX = Math.max(maxX, f.offsetX + f.ref.width);
      maxY = Math.max(maxY, f.offsetY + f.ref.height);
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function initZoom(gifState) {
    const bounds = computeBounds(gifState.frames);
    const maxDim = Math.max(bounds.width, bounds.height, 1);
    gifState.zoom = Math.max(0.25, Math.min(360 / maxDim, 8));
  }

  function redrawStage() {
    const gifState = activeGroup;
    if (!gifState) return;
    const bounds = computeBounds(gifState.frames);
    const zoom = gifState.zoom;
    const canvas = document.getElementById('gbStageCanvas');
    canvas.width = Math.max(1, Math.round(bounds.width * zoom));
    canvas.height = Math.max(1, Math.round(bounds.height * zoom));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const current = gifState.frames[gifState.currentIndex];

    function drawFrame(f, alpha) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        f.ref.canvas,
        (f.offsetX - bounds.minX) * zoom,
        (f.offsetY - bounds.minY) * zoom,
        f.ref.width * zoom,
        f.ref.height * zoom
      );
    }

    if (gifState.onionMode !== 'none') {
      if (gifState.onionMode === 'all') {
        gifState.frames.forEach((f, i) => {
          if (i === gifState.currentIndex || !f.include) return;
          drawFrame(f, gifState.onionOpacity);
        });
      } else {
        const prev = gifState.frames[gifState.currentIndex - 1];
        const next = gifState.frames[gifState.currentIndex + 1];
        if (prev) drawFrame(prev, gifState.onionOpacity);
        if (next) drawFrame(next, gifState.onionOpacity);
      }
    }

    ctx.globalAlpha = 1;
    drawFrame(current, 1);

    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--brass-strong').trim() || '#c9974f';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      (current.offsetX - bounds.minX) * zoom + 0.5,
      (current.offsetY - bounds.minY) * zoom + 0.5,
      Math.max(0, current.ref.width * zoom - 1),
      Math.max(0, current.ref.height * zoom - 1)
    );
    ctx.setLineDash([]);

    document.getElementById('gbOffsetX').value = current.offsetX;
    document.getElementById('gbOffsetY').value = current.offsetY;
    document.getElementById('gbFrameDuration').value = current.duration;
    document.getElementById('gbIncludeFrame').checked = current.include;
    document.getElementById('gbFrameLabel').textContent = `${gifState.currentIndex + 1} / ${gifState.frames.length}`;
    document.getElementById('gbEmbeddedHint').textContent =
      `Embedded header offset for this frame: ${current.ref.embeddedLeft}, ${current.ref.embeddedTop}`;

    renderThumbstrip();
  }

  function renderThumbstrip() {
    const gifState = activeGroup;
    const strip = document.getElementById('gbThumbstrip');
    strip.innerHTML = '';
    gifState.frames.forEach((f, i) => {
      const cell = document.createElement('div');
      cell.className = 'gb-thumb' + (i === gifState.currentIndex ? ' current' : '') + (!f.include ? ' excluded' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.include;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { f.include = cb.checked; redrawStage(); });
      cell.appendChild(cb);

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = f.ref.width;
      thumbCanvas.height = f.ref.height;
      thumbCanvas.getContext('2d').drawImage(f.ref.canvas, 0, 0);
      cell.appendChild(thumbCanvas);

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = `#${f.ref.index}`;
      cell.appendChild(idx);

      cell.addEventListener('click', () => { gifState.currentIndex = i; redrawStage(); });
      strip.appendChild(cell);
    });
  }

  function setupStageDrag() {
    const canvas = document.getElementById('gbStageCanvas');
    let dragging = false;
    let startClientX = 0, startClientY = 0, startOffsetX = 0, startOffsetY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      const gifState = activeGroup;
      if (!gifState) return;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      startClientX = e.clientX;
      startClientY = e.clientY;
      const current = gifState.frames[gifState.currentIndex];
      startOffsetX = current.offsetX;
      startOffsetY = current.offsetY;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const gifState = activeGroup;
      if (!gifState) return;
      const current = gifState.frames[gifState.currentIndex];
      const dx = (e.clientX - startClientX) / gifState.zoom;
      const dy = (e.clientY - startClientY) / gifState.zoom;
      current.offsetX = Math.round(startOffsetX + dx);
      current.offsetY = Math.round(startOffsetY + dy);
      redrawStage();
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
  }

  function buildGifStateForDirection(group, direction) {
    const frames = group.sourceFrames.filter(f => f.direction === direction);
    const state = {
      direction,
      // Default each frame's position from its hotspot, the same way the
      // game itself lines frames up: draw position = anchor - hotspot
      // (see Arcanum_ART_Files_Explanation.txt, section 2). With the
      // anchor fixed at (0,0) for every frame of this file, that puts all
      // their hotspots on top of one another, which is what a correctly
      // aligned animation looks like.
      frames: frames.map(f => ({
        ref: f,
        offsetX: -(f.hotspotX || 0),
        offsetY: -(f.hotspotY || 0),
        duration: 100,
        include: true,
      })),
      currentIndex: 0,
      onionMode: 'adjacent',
      onionOpacity: 0.35,
      loop: true,
      zoom: 1,
    };
    initZoom(state);
    return state;
  }

  function selectGifDirection(group, direction) {
    if (!group.gifByDirection[direction]) {
      group.gifByDirection[direction] = buildGifStateForDirection(group, direction);
    }
    activeGroup = group.gifByDirection[direction];
    activeGroupRef = group;

    const picker = document.getElementById('gbDirectionSelect');
    if (picker.value !== String(direction)) picker.value = String(direction);

    document.getElementById('gbOnionMode').value = activeGroup.onionMode;
    document.getElementById('gbOnionOpacity').value = activeGroup.onionOpacity;
    document.getElementById('gbLoop').checked = activeGroup.loop;
    document.getElementById('gbResult').classList.remove('show');
    document.getElementById('gbProgress').classList.remove('active');
    redrawStage();
  }

  function openGifBuilder(group) {
    document.getElementById('gbTitle').textContent = `Build GIF — ${group.baseName}.art`;

    const directionRow = document.getElementById('gbDirectionPicker');
    const picker = document.getElementById('gbDirectionSelect');
    if (group.directionCount > 1) {
      // The frame table is stored direction by direction, framesPerDirection
      // frames at a time (see Arcanum_ART_Files_Explanation.txt) — that's
      // exactly what splits the file into these choices.
      picker.innerHTML = '';
      for (let d = 0; d < group.directionCount; d++) {
        const opt = document.createElement('option');
        opt.value = String(d);
        opt.textContent = `Direction ${d + 1} (${group.framesPerDirection} frame${group.framesPerDirection === 1 ? '' : 's'})`;
        picker.appendChild(opt);
      }
      directionRow.hidden = false;
    } else {
      directionRow.hidden = true;
    }

    document.getElementById('gbOverlay').classList.add('open');
    selectGifDirection(group, group.lastDirection || 0);
  }

  function closeGifBuilder() {
    if (activeGroupRef && activeGroup) activeGroupRef.lastDirection = activeGroup.direction;
    document.getElementById('gbOverlay').classList.remove('open');
    activeGroup = null;
    activeGroupRef = null;
  }

  async function getGifWorkerUrl() {
    if (gifWorkerUrl) return gifWorkerUrl;
    const resp = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
    const text = await resp.text();
    gifWorkerUrl = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
    return gifWorkerUrl;
  }

  async function compileGif() {
    const gifState = activeGroup;
    const group = activeGroupRef;
    if (!gifState || !group) return;

    const included = gifState.frames.filter(f => f.include);
    if (included.length === 0) {
      log('select at least one frame to include in the GIF', 'err');
      return;
    }

    const bounds = computeBounds(gifState.frames);
    const compileBtn = document.getElementById('gbCompile');
    const progress = document.getElementById('gbProgress');
    const progressBar = document.getElementById('gbProgressBar');
    compileBtn.disabled = true;
    progress.classList.add('active');
    progressBar.style.width = '0%';
    document.getElementById('gbResult').classList.remove('show');

    try {
      const workerScript = await getGifWorkerUrl();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const gif = new GIF({
        workers: 2,
        quality: 10,
        width,
        height,
        transparent: 0xFF00FF,
        workerScript,
        repeat: gifState.loop ? 0 : -1,
      });

      for (const f of included) {
        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = width;
        frameCanvas.height = height;
        const ctx = frameCanvas.getContext('2d');
        ctx.fillStyle = '#FF00FF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(f.ref.canvas, Math.round(f.offsetX - bounds.minX), Math.round(f.offsetY - bounds.minY));
        gif.addFrame(frameCanvas, { delay: f.duration, copy: true });
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on('progress', (p) => { progressBar.style.width = `${Math.round(p * 100)}%`; });
        gif.on('finished', (b) => resolve(b));
        gif.on('abort', () => reject(new Error('GIF encoding was aborted')));
        gif.render();
      });

      const url = URL.createObjectURL(blob);
      document.getElementById('gbResultImg').src = url;
      document.getElementById('gbResult').classList.add('show');
      const suffix = group.directionCount > 1 ? `_dir${gifState.direction + 1}` : '';
      const outName = `${group.baseName}${suffix}.gif`;
      document.getElementById('gbDownload').onclick = () => saveFile(outName, blob);
      log(`${group.baseName}: compiled a ${included.length}-frame GIF${suffix ? ` for direction ${gifState.direction + 1}` : ''}`, 'ok');
    } catch (err) {
      log(`GIF compile failed: ${err && err.message ? err.message : err}`, 'err');
    } finally {
      compileBtn.disabled = false;
      progress.classList.remove('active');
    }
  }

  setupStageDrag();

  document.getElementById('gbClose').addEventListener('click', closeGifBuilder);
  document.getElementById('gbDirectionSelect').addEventListener('change', (e) => {
    if (!activeGroupRef) return;
    selectGifDirection(activeGroupRef, parseInt(e.target.value, 10) || 0);
  });
  document.getElementById('gbOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'gbOverlay') closeGifBuilder();
  });
  document.getElementById('gbPrev').addEventListener('click', () => {
    if (!activeGroup) return;
    activeGroup.currentIndex = (activeGroup.currentIndex - 1 + activeGroup.frames.length) % activeGroup.frames.length;
    redrawStage();
  });
  document.getElementById('gbNext').addEventListener('click', () => {
    if (!activeGroup) return;
    activeGroup.currentIndex = (activeGroup.currentIndex + 1) % activeGroup.frames.length;
    redrawStage();
  });
  document.getElementById('gbOffsetX').addEventListener('input', (e) => {
    if (!activeGroup) return;
    activeGroup.frames[activeGroup.currentIndex].offsetX = parseInt(e.target.value, 10) || 0;
    redrawStage();
  });
  document.getElementById('gbOffsetY').addEventListener('input', (e) => {
    if (!activeGroup) return;
    activeGroup.frames[activeGroup.currentIndex].offsetY = parseInt(e.target.value, 10) || 0;
    redrawStage();
  });
  document.getElementById('gbIncludeFrame').addEventListener('change', (e) => {
    if (!activeGroup) return;
    activeGroup.frames[activeGroup.currentIndex].include = e.target.checked;
    redrawStage();
  });
  document.getElementById('gbFrameDuration').addEventListener('input', (e) => {
    if (!activeGroup) return;
    const v = parseInt(e.target.value, 10);
    activeGroup.frames[activeGroup.currentIndex].duration = (Number.isFinite(v) && v > 0) ? v : 100;
  });
  document.getElementById('gbOnionMode').addEventListener('change', (e) => {
    if (!activeGroup) return;
    activeGroup.onionMode = e.target.value;
    redrawStage();
  });
  document.getElementById('gbOnionOpacity').addEventListener('input', (e) => {
    if (!activeGroup) return;
    activeGroup.onionOpacity = parseFloat(e.target.value) || 0.35;
    redrawStage();
  });
  document.getElementById('gbAlignTopLeft').addEventListener('click', () => {
    if (!activeGroup) return;
    const current = activeGroup.frames[activeGroup.currentIndex];
    current.offsetX = 0;
    current.offsetY = 0;
    redrawStage();
  });
  document.getElementById('gbAlignCenter').addEventListener('click', () => {
    if (!activeGroup) return;
    const bounds = computeBounds(activeGroup.frames);
    const current = activeGroup.frames[activeGroup.currentIndex];
    current.offsetX = Math.round(bounds.minX + (bounds.width - current.ref.width) / 2);
    current.offsetY = Math.round(bounds.minY + (bounds.height - current.ref.height) / 2);
    redrawStage();
  });
  document.getElementById('gbAlignEmbedded').addEventListener('click', () => {
    if (!activeGroup) return;
    const current = activeGroup.frames[activeGroup.currentIndex];
    current.offsetX = -(current.ref.embeddedLeft || 0);
    current.offsetY = -(current.ref.embeddedTop || 0);
    redrawStage();
  });
  document.getElementById('gbAlignAllCenter').addEventListener('click', () => {
    if (!activeGroup) return;
    const included = activeGroup.frames.filter(f => f.include);
    const list = included.length ? included : activeGroup.frames;
    const maxW = Math.max(...list.map(f => f.ref.width));
    const maxH = Math.max(...list.map(f => f.ref.height));
    activeGroup.frames.forEach(f => {
      f.offsetX = Math.round((maxW - f.ref.width) / 2);
      f.offsetY = Math.round((maxH - f.ref.height) / 2);
    });
    redrawStage();
  });
  document.getElementById('gbApplyDuration').addEventListener('click', () => {
    if (!activeGroup) return;
    const v = parseInt(document.getElementById('gbGlobalDuration').value, 10);
    const dur = (Number.isFinite(v) && v > 0) ? v : 100;
    activeGroup.frames.forEach(f => { f.duration = dur; });
    redrawStage();
  });
  document.getElementById('gbLoop').addEventListener('change', (e) => {
    if (!activeGroup) return;
    activeGroup.loop = e.target.checked;
  });
  document.getElementById('gbCompile').addEventListener('click', compileGif);

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('gbOverlay').classList.contains('open')) return;
    if (e.key === 'Escape') { closeGifBuilder(); return; }
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!activeGroup) return;
    const current = activeGroup.frames[activeGroup.currentIndex];
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    if (e.key === 'ArrowLeft') current.offsetX -= step;
    else if (e.key === 'ArrowRight') current.offsetX += step;
    else if (e.key === 'ArrowUp') current.offsetY -= step;
    else if (e.key === 'ArrowDown') current.offsetY += step;
    else handled = false;
    if (handled) { e.preventDefault(); redrawStage(); }
  });

  // ---- Hex viewer ---------------------------------------------------------
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
  let hexActiveGroup = null; // the file-group the hex view belongs to
  let hexTotalRows = 0;
  let hexHighlight = null;   // transient frame hover highlight, or null
  let hexHeaderHighlights = []; // persistent header field selections
  let hexPinnedFrame = null;       // frame object currently pinned, or null
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


  function getHexHighlightClass(byteOffset) {
    const match =
      hexHeaderHighlights.find(h => h.type !== 'whole-header' && byteOffset >= h.start && byteOffset < h.end) ||
      hexHeaderHighlights.find(h => h.type === 'whole-header' && byteOffset >= h.start && byteOffset < h.end);
    return match ? `header-hl-${match.colorIndex}` : '';
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
    const paletteCount = paletteFlags.filter(v => v !== 0).length;
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
    for (let paletteIndex = 0; paletteIndex < 4; paletteIndex++) {
      if (info.paletteFlags[paletteIndex] === 0) continue;
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

  function openHexViewer(group) {
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

  function highlightFrameInHex(group, frame, opts) {
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

  function clearHexHighlight(group) {
    if (hexActiveGroup !== group) return;
    if (!hexHighlight) return;
    hexHighlight = null;
    renderHexViewport();
  }

  function setHexPin(previewEl, group, frame) {
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

  // ---- DAT Packer (.bmp -> .art) -------------------------------------------
  //
  // Builds a simple multi-frame .art file (type 1: pictureCount static
  // frames, one image each, a single shared 256-colour palette) from a set
  // of 8-bit indexed, uncompressed .bmp images — the mirror image of
  // parseArtBuffer above. It does not attempt the 8-direction animated
  // creature layout (type 0), whose extra header fields aren't understood
  // well enough here to reconstruct reliably.

  function parseBmp(buf) {
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

  function buildBmpBuffer(width, height, indices, palette) {
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
    // A compressed length that coincidentally equals the raw pixel count
    // would make the decoder treat this chunk as "stored uncompressed"
    // instead of RLE. Force a structurally different (still perfectly
    // valid) encoding to break the tie.
    const rest = encodeRLE(indices.subarray(1));
    const adjusted = new Uint8Array(2 + rest.length);
    adjusted[0] = 0x81;
    adjusted[1] = indices[0];
    adjusted.set(rest, 2);
    return adjusted;
  }

  function readArtTemplate(buf) {
    if (buf.byteLength < 0x84) throw new Error('reference file is too small to be a valid .art file');
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const head = [];
    for (let i = 0; i < 33; i++) head.push(view.getUint32(i * 4, true));

    let paletteCount;
    if (head[6] !== 0) paletteCount = 4;
    else if (head[5] !== 0) paletteCount = 3;
    else if (head[4] !== 0) paletteCount = 2;
    else paletteCount = 1;

    // Flags bit 0: set = one direction, clear = eight directions (see
    // Arcanum_ART_Files_Explanation.txt). The other flag bits are unrelated,
    // so this has to be a bitwise test, not an equality check against
    // whatever flag values happened to be seen before.
    let pictureCount, frameCount;
    if ((head[0] & 1) === 0) {
      pictureCount = 8;
      frameCount = head[8];
    } else {
      pictureCount = head[8];
      frameCount = 1;
    }
    const totalImages = pictureCount * frameCount;
    if (!Number.isFinite(totalImages) || totalImages < 0 || totalImages > 20000) {
      throw new Error('reference file header looks invalid');
    }

    let offset = 0x84 + paletteCount * 1024;
    const reservedChunks = [];
    for (let i = 0; i < totalImages; i++) {
      if (offset + 28 > bytes.length) break;
      reservedChunks.push(bytes.slice(offset + 20, offset + 28));
      offset += 28;
    }
    if (reservedChunks.length === 0) reservedChunks.push(new Uint8Array(8));

    return { headerBytes: bytes.slice(0, 0x84), reservedChunks, headType: head[0] };
  }

  function buildArtBuffer(frames, palette, template) {
    const HEADER_FIELDS = 33;
    const headerBytes = (template && template.headerBytes)
      ? template.headerBytes.slice()
      : new Uint8Array(HEADER_FIELDS * 4);
    const headerView = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

    // Flags (0x00), bit 0: this packer only ever builds a single-direction,
    // static multi-frame file — it doesn't support the eight-direction
    // layout critters use. Force bit 0 on even when a reference template is
    // an eight-direction file, otherwise the game would expect 8x as many
    // frames as we actually wrote. Any other (still unidentified) flag bits
    // from the template are left alone.
    headerView.setUint32(0 * 4, headerView.getUint32(0 * 4, true) | 1, true);

    // Bits per pixel (0x08): Arcanum expects 8.
    headerView.setUint32(2 * 4, 8, true);

    // Palette-presence flags (0x0C, four values): we always emit exactly
    // one palette, so mark slot 0 present and the other three absent —
    // regardless of how many palettes a reference template had. Leaving a
    // template's original flags in place here (e.g. claiming 4 palettes
    // while the file only contains 1) makes the game misread everything
    // after the header, since it uses these flags to know where the frame
    // table starts.
    headerView.setUint32(3 * 4, 1, true);
    headerView.setUint32(4 * 4, 0, true);
    headerView.setUint32(5 * 4, 0, true);
    headerView.setUint32(6 * 4, 0, true);

    // Number of frames (0x20) — our own frame count.
    headerView.setUint32(8 * 4, frames.length, true);

    const paletteBytes = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = palette[i] || [0, 0, 0];
      paletteBytes[i * 4] = b;
      paletteBytes[i * 4 + 1] = g;
      paletteBytes[i * 4 + 2] = r;
      paletteBytes[i * 4 + 3] = 0;
    }

    const compressedChunks = frames.map(f => encodeRLESafe(f.indices));

    const descriptorBytes = new Uint8Array(frames.length * 28);
    const descView = new DataView(descriptorBytes.buffer);
    frames.forEach((f, i) => {
      const o = i * 28;
      descView.setUint32(o, f.width, true);
      descView.setUint32(o + 4, f.height, true);
      descView.setUint32(o + 8, compressedChunks[i].length, true);
      descView.setInt32(o + 12, f.offsetX | 0, true);
      descView.setInt32(o + 16, f.offsetY | 0, true);
      if (template && template.reservedChunks && template.reservedChunks.length) {
        descriptorBytes.set(template.reservedChunks[i % template.reservedChunks.length], o + 20);
      }
      // otherwise bytes 20-27 (reserved/unknown fields) are left as 0
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

  // -- PNG -> indexed conversion --
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
      const ctx = canvas.getContext('2d');
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

  async function convertPngToFrame(file) {
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
    // blue" (see Arcanum_ART_Files_Explanation.txt, section 2). So when a
    // frame needs transparency, index 0 has to be reserved for the chroma
    // key up front, not appended after the real colors.
    let palette;
    let usingSharedPalette = false;
    let reservesIndexZero = false;
    if (packerFrames.length > 0) {
      palette = packerFrames[0].palette;
      usingSharedPalette = true;
      const p0 = palette[0] || [0, 0, 0];
      reservesIndexZero = p0[0] === 0 && p0[1] === 0 && p0[2] === 255;
    } else {
      const maxOpaqueColors = hasTransparent ? 255 : 256;
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
      if (hasTransparent) {
        palette[0] = PNG_TRANSPARENT_KEY.slice();
        reduced.forEach((c, i) => { palette[i + 1] = c; });
        reservesIndexZero = true;
      } else {
        reduced.forEach((c, i) => { palette[i] = c; });
      }
    }

    if (hasTransparent && !reservesIndexZero) {
      packerLog(`${file.name}: this frame has transparent pixels, but frame 1's palette didn't set aside index 0 for them (frame 1 had no transparency of its own). Transparent pixels here will still be forced to index 0, which may make whatever color frame 1 put at index 0 turn transparent too — add transparency to frame 1 first, or use a reference .art file, to avoid this.`, 'err');
    }

    const indices = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      if (data[o + 3] < PNG_ALPHA_THRESHOLD) {
        indices[i] = 0;
      } else {
        // Never let an opaque pixel land on the reserved transparent slot.
        indices[i] = nearestPaletteIndex(palette, data[o], data[o + 1], data[o + 2], 256, reservesIndexZero ? 1 : 0);
      }
    }

    return { width, height, indices, palette, usingSharedPalette, hasTransparent };
  }

  // -- Packer UI --

  const packerOverlayEl = document.getElementById('packerOverlay');
  const packerLaunchBtn = document.getElementById('packerLaunchBtn');
  const packerCloseBtn = document.getElementById('packerClose');
  const packerDropzoneEl = document.getElementById('packerDropzone');
  const packerFileInputEl = document.getElementById('packerFileInput');
  const packerFrameListEl = document.getElementById('packerFrameList');
  const packerFilenameEl = document.getElementById('packerFilename');
  const packerTemplateInputEl = document.getElementById('packerTemplateInput');
  const packerTemplateStatusEl = document.getElementById('packerTemplateStatus');
  const packerBuildBtn = document.getElementById('packerBuild');
  const packerClearBtn = document.getElementById('packerClearBtn');
  const packerLogEl = document.getElementById('packerLog');
  const packerResultEl = document.getElementById('packerResult');
  const packerDownloadBtn = document.getElementById('packerDownload');

  let packerFrames = [];   // [{ id, name, width, height, indices, palette, paletteMismatch, offsetX, offsetY, canvas }]
  let packerFramesSeq = 0;
  let packerBlob = null;
  let packerTemplate = null; // { headerBytes, reservedChunks, headType } from a real reference .art file

  function packerLog(message, kind) {
    const p = document.createElement('p');
    if (kind) p.className = kind;
    p.textContent = message;
    packerLogEl.appendChild(p);
    packerLogEl.classList.add('has-entries');
    packerLogEl.scrollTop = packerLogEl.scrollHeight;
  }

  function palettesEqual(a, b) {
    for (let i = 0; i < 256; i++) {
      const ca = a[i] || [0, 0, 0];
      const cb = b[i] || [0, 0, 0];
      if (ca[0] !== cb[0] || ca[1] !== cb[1] || ca[2] !== cb[2]) return false;
    }
    return true;
  }

  function buildFrameThumbCanvas(width, height, indices, palette) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const total = width * height;
    const rgba = new Uint8ClampedArray(total * 4);
    for (let i = 0; i < total; i++) {
      const [r, g, b] = palette[indices[i]] || [0, 0, 0];
      const o = i * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
      rgba[o + 3] = (r === 0 && g === 0 && b === 255) ? 0 : 255;
    }
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas;
  }

  function invalidatePackerBuild() {
    packerBlob = null;
    packerResultEl.classList.remove('show');
  }

  function syncPackerFrames() {
    invalidatePackerBuild();
    if (packerFrames.length === 0) return;
    const base = packerFrames[0].palette;
    packerFrames.forEach((f, i) => {
      f.paletteMismatch = i > 0 && !palettesEqual(base, f.palette);
      f.canvas = buildFrameThumbCanvas(f.width, f.height, f.indices, base);
    });
  }

  function renderPackerFrameList() {
    packerFrameListEl.innerHTML = '';
    packerFrames.forEach((frame, idx) => {
      const li = document.createElement('li');
      li.className = 'packer-frame-item';

      const thumb = document.createElement('span');
      thumb.className = 'packer-frame-thumb';
      thumb.appendChild(frame.canvas);
      li.appendChild(thumb);

      const info = document.createElement('span');
      info.className = 'packer-frame-info';
      const name = document.createElement('span');
      name.className = 'packer-frame-name';
      name.textContent = `${idx}: ${frame.name}`;
      info.appendChild(name);
      const dims = document.createElement('span');
      dims.className = 'packer-frame-dims';
      dims.textContent = `${frame.width}×${frame.height}`;
      info.appendChild(dims);
      if (frame.paletteMismatch) {
        const warn = document.createElement('span');
        warn.className = 'packer-frame-warning';
        warn.textContent = 'palette differs from frame 0';
        info.appendChild(warn);
      }
      li.appendChild(info);

      const offsets = document.createElement('span');
      offsets.className = 'packer-frame-offsets';
      const offX = document.createElement('input');
      offX.type = 'number'; offX.step = '1'; offX.title = 'Offset X'; offX.value = frame.offsetX;
      offX.addEventListener('change', () => {
        frame.offsetX = parseInt(offX.value, 10) || 0;
        invalidatePackerBuild();
      });
      const offY = document.createElement('input');
      offY.type = 'number'; offY.step = '1'; offY.title = 'Offset Y'; offY.value = frame.offsetY;
      offY.addEventListener('change', () => {
        frame.offsetY = parseInt(offY.value, 10) || 0;
        invalidatePackerBuild();
      });
      offsets.appendChild(offX);
      offsets.appendChild(offY);
      li.appendChild(offsets);

      const actions = document.createElement('span');
      actions.className = 'packer-frame-actions';
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button'; dlBtn.textContent = '⬇'; dlBtn.title = 'Download as .bmp';
      dlBtn.addEventListener('click', () => downloadPackerFrameBmp(frame));
      const upBtn = document.createElement('button');
      upBtn.type = 'button'; upBtn.textContent = '↑'; upBtn.title = 'Move up'; upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', () => movePackerFrame(frame.id, -1));
      const downBtn = document.createElement('button');
      downBtn.type = 'button'; downBtn.textContent = '↓'; downBtn.title = 'Move down'; downBtn.disabled = idx === packerFrames.length - 1;
      downBtn.addEventListener('click', () => movePackerFrame(frame.id, 1));
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button'; removeBtn.textContent = '✕'; removeBtn.title = 'Remove'; removeBtn.className = 'packer-remove';
      removeBtn.addEventListener('click', () => removePackerFrame(frame.id));
      actions.appendChild(dlBtn);
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(removeBtn);
      li.appendChild(actions);

      packerFrameListEl.appendChild(li);
    });
  }

  function movePackerFrame(id, dir) {
    const idx = packerFrames.findIndex(f => f.id === id);
    const swapWith = idx + dir;
    if (idx === -1 || swapWith < 0 || swapWith >= packerFrames.length) return;
    [packerFrames[idx], packerFrames[swapWith]] = [packerFrames[swapWith], packerFrames[idx]];
    syncPackerFrames();
    renderPackerFrameList();
  }

  function removePackerFrame(id) {
    packerFrames = packerFrames.filter(f => f.id !== id);
    syncPackerFrames();
    renderPackerFrameList();
  }

  function clearPackerFrames() {
    packerFrames = [];
    invalidatePackerBuild();
    renderPackerFrameList();
  }

  async function handlePackerFiles(fileList) {
    const files = Array.from(fileList).filter(f => /\.(bmp|png)$/i.test(f.name));
    if (files.length === 0) {
      packerLog('no .BMP or .PNG files in that selection', 'err');
      return;
    }
    for (const file of files) {
      try {
        let width, height, indices, palette, note = '';
        if (/\.png$/i.test(file.name)) {
          const converted = await convertPngToFrame(file);
          width = converted.width;
          height = converted.height;
          indices = converted.indices;
          palette = converted.palette;
          note = converted.usingSharedPalette
            ? ' — mapped onto frame 0\'s palette'
            : ' — built a new palette from its colors';
        } else {
          const buf = await file.arrayBuffer();
          ({ width, height, indices, palette } = parseBmp(buf));
        }
        packerFramesSeq += 1;
        packerFrames.push({
          id: packerFramesSeq,
          name: file.name,
          width, height, indices, palette,
          paletteMismatch: false,
          offsetX: 0, offsetY: 0,
          canvas: buildFrameThumbCanvas(width, height, indices, palette),
        });
        packerLog(`${file.name}: added (${width}×${height})${note}`, 'ok');
        if (!packerFilenameEl.value) {
          packerFilenameEl.value = file.name.replace(/\.(bmp|png)$/i, '');
        }
      } catch (err) {
        packerLog(`${file.name}: ${err && err.message ? err.message : err}`, 'err');
      }
    }
    syncPackerFrames();
    renderPackerFrameList();
    const mismatched = packerFrames.filter(f => f.paletteMismatch);
    if (mismatched.length) {
      packerLog(`${mismatched.length} frame${mismatched.length === 1 ? '' : 's'} don't match frame 0's palette — they'll be recolored using frame 0's palette in the output`, 'err');
    }
  }

  async function downloadPackerFrameBmp(frame) {
    const buf = buildBmpBuffer(frame.width, frame.height, frame.indices, frame.palette);
    const blob = new Blob([buf], { type: 'image/bmp' });
    await saveFile(`${frame.name.replace(/\.(bmp|png)$/i, '')}.bmp`, blob);
  }

  function buildPacker() {
    if (packerFrames.length === 0) {
      packerLog('add at least one .BMP or .PNG frame first', 'err');
      return;
    }
    try {
      const buf = buildArtBuffer(packerFrames, packerFrames[0].palette, packerTemplate);
      packerBlob = new Blob([buf], { type: 'application/octet-stream' });
      packerResultEl.classList.add('show');
      const templateNote = packerTemplate ? ' (using the reference file\'s header/reserved fields)' : '';
      packerLog(`built ${packerFrames.length} frame${packerFrames.length === 1 ? '' : 's'} — ${buf.byteLength.toLocaleString()} bytes${templateNote}`, 'ok');
    } catch (err) {
      packerLog(`build failed: ${err && err.message ? err.message : err}`, 'err');
    }
  }

  async function downloadPacker() {
    if (!packerBlob) return;
    const name = (packerFilenameEl.value || 'output').trim().replace(/\.art$/i, '') || 'output';
    await saveFile(`${name}.art`, packerBlob);
  }

  function openPacker() {
    packerOverlayEl.classList.add('open');
  }

  function closePacker() {
    packerOverlayEl.classList.remove('open');
  }

  packerLaunchBtn.addEventListener('click', openPacker);
  packerCloseBtn.addEventListener('click', closePacker);
  packerOverlayEl.addEventListener('click', (e) => {
    if (e.target === packerOverlayEl) closePacker();
  });
  document.addEventListener('keydown', (e) => {
    if (!packerOverlayEl.classList.contains('open')) return;
    if (e.key === 'Escape') closePacker();
  });
  packerBuildBtn.addEventListener('click', buildPacker);
  packerClearBtn.addEventListener('click', clearPackerFrames);
  packerDownloadBtn.addEventListener('click', downloadPacker);
  packerTemplateInputEl.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      packerTemplate = readArtTemplate(buf);
      packerTemplateStatusEl.textContent = `using ${file.name} (type ${packerTemplate.headType}) for the header and reserved fields`;
      packerTemplateStatusEl.classList.remove('err');
      invalidatePackerBuild();
    } catch (err) {
      packerTemplate = null;
      packerTemplateStatusEl.textContent = `${file.name}: ${err && err.message ? err.message : err}`;
      packerTemplateStatusEl.classList.add('err');
    }
  });


  // ---- .MOB data-file explorer -------------------------------------------
  // The browser-side decoder mirrors dump_mob_fields.py / ObjectFieldData.cs.
  // MOB manifests describe a folder tree: the root mob_manifest.json can have
  // files AND subfolders, and each subfolder can have its own manifest.
  const MOB_ROOT = 'mob/';
  const MOB_MANIFEST_URLS = ['mob/mob_manifest.json', 'mob/manifest.json'];
  const MOB_OD_NAMES = {"0":"Invalid","1":"Begin","2":"End","3":"Int32","4":"Int64","5":"String","6":"Handle","7":"Int32Array","8":"Int64Array","9":"UInt32Array","10":"UInt64Array","11":"ScriptArray","12":"QuestArray","13":"HandleArray","14":"Ptr","15":"PtrArray"};
  const MOB_OD_TYPES = [1,3,4,3,3,3,9,9,9,3,3,3,3,3,3,3,9,9,9,3,3,3,3,3,3,3,3,3,3,3,3,7,11,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,3,13,3,3,3,3,9,10,2,1,3,6,3,3,9,10,2,1,3,3,3,6,3,3,9,10,2,1,3,6,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,7,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,3,3,3,3,9,10,2,1,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,9,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,7,7,7,9,3,3,3,3,9,9,6,3,6,6,6,6,6,3,13,3,3,13,4,3,3,3,3,3,3,9,10,2,1,3,3,9,10,3,3,12,9,10,9,10,3,10,9,9,9,3,5,3,9,9,3,3,9,10,2,1,3,6,3,6,6,3,3,10,3,4,4,3,3,3,6,3,3,13,9,9,3,3,3,9,13,2,1,3,3,3,9,10,2];
  const MOB_GROUP_BEGIN = [0,38,45,55,68,76,86,111,140,149,163,171,178,185,192,200,210,217,252,279,306];
  const MOB_GROUP_PARENT_LAST = [-1,36,36,36,36,36,36,109,109,109,109,109,109,109,109,109,109,36,250,250,36];
  const MOB_TYPE_RANGE_BEGIN = [38,45,55,68,76,86,111,86,140,86,149,86,163,86,171,86,178,86,185,86,192,86,200,86,210,217,252,217,279,306];
  const MOB_TYPE_RANGE_END = [44,54,67,75,85,110,139,110,148,110,162,110,170,110,177,110,184,110,191,110,199,110,209,110,216,251,278,251,305,312];
  const MOB_TYPE_RANGE_OFFSET = [0,1,2,3,4,5,7,9,11,13,15,17,19,21,23,25,27,29,30];
  const MOB_TYPE_LAST_FIELD = [43,53,66,74,84,138,147,161,169,176,183,190,198,208,215,277,304,311];
  const MOB_FIELD_NAMES = {"1":"F_CURRENT_AID","2":"F_LOCATION","3":"F_OFFSET_X","4":"F_OFFSET_Y","14":"F_LIGHT_AID","15":"F_LIGHT_COLOR","19":"F_FLAGS","20":"F_FLAGS2","22":"F_NAME","23":"F_DESCRIPTION","27":"F_HP_PTS","29":"F_HP_DAMAGE","30":"F_MATERIAL","31":"F_RESISTANCE","32":"F_SCRIPTS","33":"F_SOUND_EFFECT","34":"F_SOUND_FLAGS","46":"F_PORTAL_FLAGS","47":"F_PORTAL_LOCK_DIFFICULTY","48":"F_PORTAL_KEY_ID","56":"F_CONTAINER_FLAGS","57":"F_CONTAINER_LOCK_DIFFICULTY","58":"F_CONTAINER_KEY_ID","69":"F_SCENERY_FLAGS","87":"F_ITEM_FLAGS","88":"F_ITEM_PARENT","89":"F_ITEM_WEIGHT","91":"F_ITEM_WORTH","93":"F_ITEM_INV_AID","94":"F_ITEM_INV_LOCATION","96":"F_ITEM_MAGIC_TECH_COMPLEXITY","97":"F_ITEM_DISCIPLINE","100":"F_ITEM_SPELL_1","105":"F_ITEM_SPELL_MANA_STORE","112":"F_WEAPON_FLAGS","114":"F_WEAPON_BONUS_TO_HIT","116":"F_WEAPON_DAMAGE_LOWER","117":"F_WEAPON_DAMAGE_UPPER","119":"F_WEAPON_SPEED_FACTOR","121":"F_WEAPON_RANGE","123":"F_WEAPON_MIN_STRENGTH","125":"F_WEAPON_AMMO_TYPE","126":"F_WEAPON_AMMO_CONSUMPTION","127":"F_WEAPON_MISSILE_AID","142":"F_AMMO_QUANTITY","143":"F_AMMO_TYPE","152":"F_ARMOR_AC_ADJ","154":"F_ARMOR_RESISTANCE_ADJ","165":"F_GOLD_QUANTITY","186":"F_KEY_KEY_ID","202":"F_WRITTEN_SUBTYPE","203":"F_WRITTEN_TEXT_START_LINE","204":"F_WRITTEN_TEXT_END_LINE","218":"F_CRITTER_FLAGS","219":"F_CRITTER_FLAGS2","220":"F_CRITTER_STAT_BASE","221":"F_CRITTER_BASIC_SKILL","222":"F_CRITTER_TECH_SKILL","223":"F_CRITTER_SPELL_TECH","231":"F_CRITTER_PORTRAIT","280":"F_NPC_FLAGS","282":"F_NPC_AI_DATA","285":"F_NPC_EXPERIENCE_WORTH","291":"F_NPC_ORIGIN","292":"F_NPC_FACTION","293":"F_NPC_RETAIL_PRICE_MULTIPLIER","294":"F_NPC_SUBSTITUTE_INVENTORY","295":"F_NPC_REACTION_BASE","296":"F_NPC_SOCIAL_CLASS"};

  // Bit-flag breakdowns for known flag/bitmask fields, contributed from manual
  // reverse-engineering notes (object_data.txt) and cross-checked against the
  // field-ID layout above. Confidence varies per field — see MOB_FLAG_FIELD_NOTES.
  const MOB_FLAG_BITS = {
    19: [ // F_FLAGS — general per-object engine flags
      [0x00000004, 'Flat'],
      [0x00000010, 'SeeThrough'],
      [0x00000020, 'ShootThrough'],
      [0x00000400, 'NoBlock'],
      [0x00000800, 'ClickThrough'],
      [0x00100000, "Don'tLight"],
      [0x00400000, 'Invulnerable']
    ],
    20: [ // F_FLAGS2 — second flags dword (bit offsets tentative, see notes)
      [0x00008000, 'Illusion'],
      [0x00010000, 'Stoned']
    ],
    34: [ // F_SOUND_FLAGS — ambient/animation flags alongside the sound effect
      [0x0001, 'NoAutoAnimate'],
      [0x0004, 'Nocturnal'],
      [0x0010, 'IsFire'],
      [0x0040, 'Respawnable'],
      [0x0100, 'MarksTownmap']
    ],
    46: [ // F_PORTAL_FLAGS — door lock state
      [0x001, 'Locked'],
      [0x002, 'Jammed'],
      [0x004, 'MagicallyHeld'],
      [0x008, 'NeverLocked'],
      [0x010, 'AlwaysLocked'],
      [0x020, 'LockedDay'],
      [0x040, 'LockedNight'],
      [0x080, 'Busted'],
      [0x100, 'Sticky']
    ],
    56: [ // F_CONTAINER_FLAGS — same lock-state bits as F_PORTAL_FLAGS
      [0x001, 'Locked'],
      [0x002, 'Jammed'],
      [0x004, 'MagicallyHeld'],
      [0x008, 'NeverLocked'],
      [0x010, 'AlwaysLocked'],
      [0x020, 'LockedDay'],
      [0x040, 'LockedNight'],
      [0x080, 'Busted'],
      [0x100, 'Sticky']
    ]
  };
  // Per-field confidence notes (shown nowhere in the UI; kept here for future reference).
  // 19 F_FLAGS / 46+56 lock flags: high confidence — bit values and grouping match
  //   object_data.txt's byte-by-byte notes with no gaps.
  // 20 F_FLAGS2 / 34 F_SOUND_FLAGS: field-ID placement is high confidence (no group
  //   marker between 19/20 or 33/34), but the exact bit *shift* for F_FLAGS2 is
  //   inferred from an assumed byte offset in the source notes, not confirmed byte-for-byte.
  const MOB_RESISTANCE_LABELS = ['Damage', 'Fire', 'Electrical', 'Poison', 'Magic'];

  function mobDecodeFlagBits(field, num) {
    const table = MOB_FLAG_BITS[field];
    if (!table || typeof num !== 'number') return null;
    const set = table.filter(([mask]) => (num & mask) === mask).map(([, name]) => name);
    const known = table.reduce((acc, [mask]) => acc | mask, 0);
    const leftover = num & ~known;
    let text = set.length ? set.join(', ') : '(none of the known bits set)';
    if (leftover) text += ` [+ unrecognized bits: 0x${(leftover >>> 0).toString(16)}]`;
    return text;
  }

  // Field-aware value formatter: wraps mobValueText but adds a human-readable
  // flag breakdown for known bitmask fields, and resistance-type labels for
  // F_RESISTANCE array elements.
  function mobFieldValueText(field, value) {
    if (MOB_FLAG_BITS[field] && typeof value === 'number') {
      const decoded = mobDecodeFlagBits(field, value);
      return decoded ? `${value} (${decoded})` : mobValueText(value);
    }
    if (field === 31 && value && value.elements) { // F_RESISTANCE
      const lines = [`element_size=${value.element_size}`, `count=${value.count}`, `bitset_id=${value.bitset_id}`, `bitset=${value.bitset.join(' ')}`, 'elements:'];
      value.elements.forEach(e => {
        const label = MOB_RESISTANCE_LABELS[e.index] ? ` (${MOB_RESISTANCE_LABELS[e.index]})` : '';
        lines.push(`  [${e.index}]${label} ${typeof e.value === 'object' ? JSON.stringify(e.value) : e.value} | raw=${e.raw}`);
      });
      return lines.join('\n');
    }
    return mobValueText(value);
  }
  const MOB_SCRIPT_POINTS = {0:'SAP_EXAMINE',1:'SAP_USE',9:'SAP_DIALOG',10:'SAP_FIRST_HEARTBEAT',17:'SAP_BUY_OBJECT',22:'SAP_WILL_KOS',19:'SAP_HEARTBEAT',31:'SAP_DIALOG_OVERRIDE'};

  const mobExploreBtn = document.getElementById('mobExploreBtn');
  const artExploreBtn = document.getElementById('artExploreBtn');
  const explorerHome = document.getElementById('explorerHome');
  const artExplorerControls = document.getElementById('artExplorerControls');
  const mobManifestCache = new Map();
  let mobFiles = [];
  let mobManifest = null;
  let mobCurrentPath = '';
  let mobCurrentFolderName = 'mob';

  function mobU32(view, o) { return view.getUint32(o, true); }
  function mobI32(view, o) { return view.getInt32(o, true); }
  function mobI64(view, o) { return view.getBigInt64(o, true); }
  function mobHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join(' ').toUpperCase(); }
  function mobOidText(bytes) {
    if (bytes.length !== 24) return mobHex(bytes);
    const type = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    const number = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
    if (type === 1) return `A / number=${number} / raw=${mobHex(bytes)}`;
    if (type === 2) return `GUID / ${Array.from(bytes.slice(8,24), b => b.toString(16).padStart(2,'0')).join('')} / raw=${mobHex(bytes)}`;
    return `type=${type} / raw=${mobHex(bytes)}`;
  }
  function mobGroupStart(fld) { let start=0; for(const x of MOB_GROUP_BEGIN){if(x<fld)start=x;else break;} return start; }
  function mobGroupIndex(beginValue) { const i=MOB_GROUP_BEGIN.indexOf(beginValue); return i<0?0:i; }
  function buildMobEngine() {
    const n=MOB_OD_TYPES.length, changeIdx=new Array(n).fill(-1), masks=new Array(n).fill(0), baseDword=new Array(MOB_GROUP_BEGIN.length).fill(0);
    for(let fld=0;fld<n;fld++){const od=MOB_OD_TYPES[fld]; if(od===1){const gi=mobGroupIndex(fld), parentLast=MOB_GROUP_PARENT_LAST[gi]; baseDword[gi]=parentLast<0?0:changeIdx[parentLast]+1; continue;} if(od===2)continue; const gs=mobGroupStart(fld), localIdx=fld-gs-1; changeIdx[fld]=Math.floor(localIdx/32)+baseDword[mobGroupIndex(gs)]; masks[fld]=(1<<(localIdx%32))>>>0;}
    const dwordCount=[]; for(let type=0;type<18;type++){const last=MOB_TYPE_LAST_FIELD[type]; dwordCount.push(last>=0?changeIdx[last]+1:0);} return {changeIdx,masks,dwordCount};
  }
  const MOB_ENGINE=buildMobEngine();
  function enumerateMobFields(objType){const out=[];for(let f=1;f<37;f++)if(MOB_OD_TYPES[f]!==1&&MOB_OD_TYPES[f]!==2)out.push(f);const start=MOB_TYPE_RANGE_OFFSET[objType],end=MOB_TYPE_RANGE_OFFSET[objType+1];for(let r=start;r<end;r++)for(let f=MOB_TYPE_RANGE_BEGIN[r]+1;f<MOB_TYPE_RANGE_END[r];f++)if(MOB_OD_TYPES[f]!==1&&MOB_OD_TYPES[f]!==2)out.push(f);return out;}
  function mobBitIsSet(bitmap,fld){const ci=MOB_ENGINE.changeIdx[fld];return ci>=0&&ci<bitmap.length&&((bitmap[ci]>>>0)&MOB_ENGINE.masks[fld])!==0;}
  function mobArrayElement(od,bytes,elemSize){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if((od===7||od===9)&&elemSize===4)return od===7?v.getInt32(0,true):v.getUint32(0,true);if((od===8||od===10)&&elemSize===8){const x=od===8?v.getBigInt64(0,true):v.getBigUint64(0,true);return x.toString();}if(od===11&&elemSize===12){const a=v.getUint32(0,true),b=v.getUint32(4,true),c=v.getUint32(8,true);return {script_record:`${a}, ${b}, ${c}`,script_num:c};}if(od===13&&elemSize===24)return mobOidText(bytes);return `0x${mobHex(bytes).replaceAll(' ','')}`;}
  function readMobArray(view,bytes,offset,od){const start=offset,present=bytes[offset++];if(!present)return{value:'absent',size:1};if(offset+12>bytes.length)throw new Error('truncated array header');const elemSize=view.getInt32(offset,true),count=view.getInt32(offset+4,true),bitsetId=view.getInt32(offset+8,true);offset+=12;if(elemSize<0||count<0)throw new Error(`invalid array header size=${elemSize} count=${count}`);const dataBytes=elemSize*count;if(offset+dataBytes+4>bytes.length)throw new Error('truncated array payload');const payload=bytes.slice(offset,offset+dataBytes);offset+=dataBytes;const bitsetCount=view.getInt32(offset,true);offset+=4;if(bitsetCount<0||offset+bitsetCount*4>bytes.length)throw new Error('invalid array bitset');const bits=[];for(let i=0;i<bitsetCount;i++)bits.push(view.getUint32(offset+i*4,true));offset+=bitsetCount*4;const logical=[];for(let wi=0;wi<bits.length;wi++){let w=bits[wi]>>>0;for(let bit=0;w;bit++,w>>>=1)if(w&1)logical.push(wi*32+bit);}const elements=[];for(let i=0;i<count;i++){const chunk=payload.slice(i*elemSize,(i+1)*elemSize),logicalIndex=i<logical.length?logical[i]:`compact_${i}`,value=mobArrayElement(od,chunk,elemSize);if(od===11&&value&&typeof value==='object'){value.script_attachment=MOB_SCRIPT_POINTS[logicalIndex]||`SAP_${logicalIndex}`;value.script_attachment_index=logicalIndex;}elements.push({index:logicalIndex,value,raw:mobHex(chunk)});}return{value:{element_size:elemSize,count,bitset_id:bitsetId,bitset:bits,elements},size:offset-start};}
  function readMobField(view,bytes,offset,od){
    const start=offset;

    // INT32 is the one serialized object-field type without a presence byte.
    if(od===3){
      if(offset+4>bytes.length) throw new Error('truncated Int32');
      return {value:mobI32(view,offset),size:4};
    }

    if(offset>=bytes.length) throw new Error('truncated field presence byte');
    const present=bytes[offset++];

    if(od===4){
      if(!present) return {value:'absent',size:1};
      if(offset+8>bytes.length) throw new Error('truncated Int64');
      return {value:mobI64(view,offset).toString(),size:9};
    }

    if(od===5){
      if(!present) return {value:'absent',size:1};
      if(offset+4>bytes.length) throw new Error('truncated string length');
      const len=view.getInt32(offset,true);
      offset+=4;
      if(len<0 || offset+len+1>bytes.length) throw new Error('invalid string length');
      const raw=bytes.slice(offset,offset+len);
      offset+=len;
      const trailing=bytes[offset++];
      let value='';
      try{value=new TextDecoder('latin1').decode(raw);}catch(e){value=new TextDecoder().decode(raw);}
      return {value:{text:value,length:len,trailing_byte:trailing,raw:mobHex(raw)},size:offset-start};
    }

    if(od===6){
      if(!present) return {value:'absent',size:1};
      if(offset+24>bytes.length) throw new Error('truncated handle');
      return {value:mobOidText(bytes.slice(offset,offset+24)),size:25};
    }

    if(od===14){
      return {value:present?'unsupported transient PTR':'absent',size:1};
    }

    if(od===7||od===8||od===9||od===10||od===11||od===12||od===13){
      return readMobArray(view,bytes,start,od);
    }

    throw new Error(`unsupported serialized OdType ${od}`);
  }
  function decodeMobBuffer(buf,filename){const bytes=new Uint8Array(buf),view=new DataView(buf);if(bytes.length<62)throw new Error('file is too small to be a valid .mob');let offset=0;const version=mobU32(view,offset);offset+=4;const protoOid=bytes.slice(offset,offset+24);offset+=24;const objectOid=bytes.slice(offset,offset+24);offset+=24;const objType=view.getUint32(offset,true);offset+=4;const numFields=view.getUint16(offset,true);offset+=2;if(objType<0||objType>=MOB_TYPE_LAST_FIELD.length)throw new Error(`unsupported object type ${objType}`);const dwordCount=MOB_ENGINE.dwordCount[objType];if(offset+dwordCount*4>bytes.length)throw new Error('truncated FIELD_48 bitmap');const bitmap=[];for(let i=0;i<dwordCount;i++){bitmap.push(view.getUint32(offset,true));offset+=4;}const actualSet=bitmap.reduce((n,w)=>n+((w>>>0).toString(2).match(/1/g)||[]).length,0);const fields=[];for(const fld of enumerateMobFields(objType)){if(!mobBitIsSet(bitmap,fld))continue;const od=MOB_OD_TYPES[fld],fieldOffset=offset,parsed=readMobField(view,bytes,offset,od);offset+=parsed.size;fields.push({field:fld,name:MOB_FIELD_NAMES[fld]||`FIELD_${String(fld).padStart(3,'0')}`,od:MOB_OD_NAMES[od]||`OdType_${od}`,change_idx:MOB_ENGINE.changeIdx[fld],bit:MOB_ENGINE.masks[fld]?Math.round(Math.log2(MOB_ENGINE.masks[fld])):-1,offset:fieldOffset,size:parsed.size,raw:mobHex(bytes.slice(fieldOffset,offset)),value:parsed.value});}return{filename,size:bytes.length,version,objType,numFields,actualSet,bitmap,protoOid,objectOid,fields,endOffset:offset,trailing:bytes.slice(offset)};}
  function mobLocationInfo(value){if(value===null||value===undefined||value==='absent')return null;let v;try{v=BigInt(value);}catch(e){return null;}const ux=BigInt.asUintN(32,v),uy=BigInt.asUintN(32,v>>32n),worldX=Number(ux),worldY=Number(uy);return{worldX,worldY,sectorX:worldX>>6,sectorY:worldY>>6,tileX:worldX&63,tileY:worldY&63};}
  function mobValueText(value,indent=''){if(value===null||value===undefined)return'NULL / absent';if(typeof value==='object'){if(Array.isArray(value))return value.map((v,i)=>`${indent}[${i}] ${mobValueText(v,indent+'  ')}`).join('\n');if(value.elements)return[`element_size=${value.element_size}`,`count=${value.count}`,`bitset_id=${value.bitset_id}`,`bitset=${value.bitset.join(' ')}`,'elements:',...value.elements.map(e=>`  [${e.index}] ${typeof e.value==='object'?JSON.stringify(e.value):e.value} | raw=${e.raw}`)].join('\n');return Object.entries(value).map(([k,v])=>`${k}=${typeof v==='object'?JSON.stringify(v):v}`).join('\n');}return String(value);}

  // F_CURRENT_AID is a packed 32-bit value: 09 00 XX YY (little-endian
  // numeric form 0xYYXX0009). The YY byte selects the Art-ID block and XX
  // advances by 2 for each Art ID. For example:
  //   09 00 30 61 -> 9152
  //   09 00 3A 61 -> 9157
  //   09 00 8E 60 -> 9071
  // Keep the raw packed number in parentheses so the original field value
  // remains visible.
  function mobCurrentAidText(value, objectType){
    if (value === null || value === undefined) return mobValueText(value);
    const artId = protoCurrentAidArtId(value, objectType);
    if (artId === null) return mobValueText(value);
    const raw = Number(value) >>> 0;
    return `${artId} (${raw})`;
  }

  function mobJoinPath(parent, child) {
    const a=String(parent||'').replace(/^\/+|\/+$/g,'');
    const b=String(child||'').replace(/^\/+|\/+$/g,'');
    return a&&b?`${a}/${b}`:(a||b);
  }
  function mobManifestUrlCandidates(relativePath, folderName) {
    const prefix=relativePath?`${MOB_ROOT}${relativePath}/`:MOB_ROOT;
    if(!relativePath) return MOB_MANIFEST_URLS;
    return [`${prefix}${folderName}_manifest.json`,`${prefix}mob_manifest.json`,`${prefix}manifest.json`];
  }
  async function loadMobManifest(relativePath='',folderName='mob') {
    if(mobManifestCache.has(relativePath)) return mobManifestCache.get(relativePath);
    let lastError=null;
    for(const url of mobManifestUrlCandidates(relativePath,folderName)) {
      try { const resp=await fetch(url,{cache:'no-store'}); if(!resp.ok) throw new Error(`HTTP ${resp.status}`); const data=await resp.json(); mobManifestCache.set(relativePath,data); return data; }
      catch(err){lastError=err;}
    }
    throw new Error(`couldn't load manifest for ${relativePath||'/mob/'} (${lastError&&lastError.message?lastError.message:lastError})`);
  }
  function extractMobManifestFiles(manifest) {
    if(Array.isArray(manifest)) return manifest.filter(x=>typeof x==='string'&&/\.mob$/i.test(x)).sort((a,b)=>a.localeCompare(b));
    const files=Array.isArray(manifest?.files)?manifest.files:[];
    return files.map(x=>typeof x==='string'?x:(x&&(x.name||x.filename||x.file))).filter(x=>typeof x==='string'&&/\.mob$/i.test(x)).sort((a,b)=>a.localeCompare(b));
  }
  function mobSubfolders(manifest) {
    const sub=manifest&&manifest.subfolders&&typeof manifest.subfolders==='object'?manifest.subfolders:{};
    return Object.keys(sub).sort().map(k=>sub[k]).filter(sf=>sf&&typeof sf==='object'&&sf.folder_name);
  }
  function mobDisplayName(path, fallback) { return fallback || path.split('/').filter(Boolean).pop() || 'mob'; }
  function createDataFolderCard(folderName, fullPath, openFolderFn) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item explorer-folder-item';
    const thumb = document.createElement('span');
    thumb.className = 'explorer-thumb';
    thumb.innerHTML = '<span class="folder-glyph">📁</span>';
    card.appendChild(thumb);
    const name = document.createElement('span');
    name.className = 'explorer-filename';
    name.textContent = folderName;
    card.appendChild(name);
    card.addEventListener('click', () => openFolderFn(fullPath, folderName));
    return card;
  }

  function createDataFileCard(filename, fullPath, icon, onOpen) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item';
    const thumb = document.createElement('span');
    thumb.className = 'explorer-thumb';
    thumb.innerHTML = `<span class="folder-glyph">${icon}</span>`;
    card.appendChild(thumb);
    const name = document.createElement('span');
    name.className = 'explorer-filename';
    name.textContent = filename;
    card.appendChild(name);
    card._iconThumb = thumb;
    card.addEventListener('click', () => onOpen(card));
    return card;
  }

  async function applyProtoCurrentArtToFileCard(card, filename, relativePath = '') {
    if (!card) return;
    try {
      const decoded = await decodeProtoForSearch(filename, relativePath);
      const resolved = await resolveProtoCurrentAid(decoded);
      if (!resolved || !resolved.artName || resolved.artId === null) return;

      const canvas = document.createElement('canvas');
      canvas.className = 'proto-file-art-icon';
      canvas.width = 48;
      canvas.height = 48;
      canvas.title = `${resolved.artName} · Art ID ${resolved.artId}`;
      card._iconThumb.replaceChildren(canvas);
      await loadProtoCurrentAidArt(resolved.artId, resolved.artName, canvas);
      if (canvas.classList.contains('missing')) {
        card._iconThumb.innerHTML = '<span class="folder-glyph">🧬</span>';
      }
    } catch (_) {
      // Keep the normal prototype icon when the prototype or its Current art cannot be resolved.
    }
  }

  function renderDataExplorerTree(rootName, rootPath, rootManifest, loadManifestFn, openFolderFn, subfolderFn, fileFn = null, fileFilterFn = null) {
    treeEl.innerHTML = '';
    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    const rootNode = document.createElement('li');
    rootNode.className = 'tree-node';
    const rootRow = document.createElement('div');
    rootRow.className = 'tree-row';
    rootRow.dataset.relpath = rootPath;
    rootRow.style.paddingLeft = '10px';
    rootRow.innerHTML = '<span class="tree-toggle">▼</span><span class="tree-icon">📁</span><span class="tree-name"></span>';
    rootRow.querySelector('.tree-name').textContent = rootName;
    rootNode.appendChild(rootRow);
    const childList = document.createElement('ul');
    childList.className = 'tree-children open';
    rootNode.appendChild(childList);
    rootUl.appendChild(rootNode);
    treeEl.appendChild(rootUl);

    const addFiles = async (manifest, container, depth, parentPath) => {
      if (!fileFn) return;
      const files = extractProtoManifestFiles(manifest);
      for (const filename of files) {
        let visible = true;
        if (fileFilterFn) {
          try { visible = await fileFilterFn(filename, parentPath); } catch (_) { visible = false; }
        }
        if (!visible) continue;
        const li = document.createElement('li');
        li.className = 'tree-node tree-file-node';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'mob-file-row';
        row.style.paddingLeft = `${10 + depth * 16}px`;
        row.innerHTML = '<span class="tree-icon">🧬</span><span class="tree-name"></span>';
        row.querySelector('.tree-name').textContent = filename;
        row.addEventListener('click', () => fileFn(filename, row, parentPath));
        li.appendChild(row);
        container.appendChild(li);
      }
    };

    const buildChildren = async (manifest, container, depth, parentPath) => {
      container.innerHTML = '';
      const subs = subfolderFn(manifest);
      for (const sf of subs) {
        const fullPath = mobJoinPath(parentPath, sf.relative_path);
        const li = document.createElement('li');
        li.className = 'tree-node';
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.dataset.relpath = fullPath;
        row.style.paddingLeft = `${10 + depth * 16}px`;
        row.innerHTML = '<span class="tree-toggle">▶</span><span class="tree-icon">📁</span><span class="tree-name"></span>';
        row.querySelector('.tree-name').textContent = sf.folder_name;
        li.appendChild(row);
        const children = document.createElement('ul');
        children.className = 'tree-children';
        li.appendChild(children);
        let loaded = false;
        let expanded = false;
        row.addEventListener('click', async () => {
          openFolderFn(fullPath, sf.folder_name);
          if (expanded) { children.classList.remove('open'); row.querySelector('.tree-toggle').textContent='▶'; expanded=false; return; }
          if (!loaded) {
            row.classList.add('loading');
            try { const m = await loadManifestFn(fullPath, sf.folder_name); await buildChildren(m, children, depth + 1, fullPath); loaded = true; }
            catch (err) { log(`explorer: ${err && err.message ? err.message : err}`, 'err'); row.classList.remove('loading'); return; }
            row.classList.remove('loading');
          }
          children.classList.add('open'); row.querySelector('.tree-toggle').textContent='▼'; expanded=true;
        });
        container.appendChild(li);
      }
      await addFiles(manifest, container, depth, parentPath);
    };
    buildChildren(rootManifest, childList, 1, rootPath);
    rootRow.addEventListener('click', () => openFolderFn(rootPath, rootName));
  }

  function renderDataFolderGrid({ subfolders, files, relativePath, openFolderFn, openFileFn, fileIcon, afterFileCard = null }) {
    gridEl.innerHTML = '';
    const folders = Array.isArray(subfolders) ? subfolders : [];
    const fileList = Array.isArray(files) ? files : [];
    if (!folders.length && !fileList.length) {
      const p = document.createElement('p');
      p.className = 'explorer-status';
      p.textContent = 'This folder is empty.';
      gridEl.appendChild(p);
      paginationEl.hidden = true;
      return;
    }
    if (relativePath) {
      const backPath = relativePath.split('/').slice(0, -1).join('/');
      const backName = backPath ? backPath.split('/').pop() : (explorerMode === 'pro' ? 'proto' : 'mob');
      const back = createDataFolderCard('..', backPath, openFolderFn);
      back.classList.add('explorer-parent-item');
      gridEl.appendChild(back);
    }
    for (const sf of folders) {
      const fullPath = mobJoinPath(relativePath, sf.relative_path);
      gridEl.appendChild(createDataFolderCard(sf.folder_name, fullPath, openFolderFn));
    }
    for (const filename of fileList) {
      const fullPath = relativePath ? `${relativePath}/${filename}` : filename;
      const card = createDataFileCard(filename, fullPath, fileIcon, card => openFileFn(filename, card, relativePath));
      gridEl.appendChild(card);
      if (afterFileCard) afterFileCard(card, filename, fullPath);
    }
    paginationEl.hidden = true;
  }

  function renderMobTree(manifest, relativePath, folderName) {
    renderDataExplorerTree('mob', '', manifest, loadMobManifest, openMobFolder, mobSubfolders);
    const subfolders = mobSubfolders(manifest);
    const files = extractMobManifestFiles(manifest);
    renderDataFolderGrid({
      subfolders, files, relativePath, openFolderFn: openMobFolder, openFileFn: loadMobFromServer, fileIcon: '📦'
    });
  }
  async function openMobFolder(relativePath,folderName) {
    treeEl.innerHTML='<p class="mob-loading">Loading folder…</p>';
    breadcrumbEl.textContent=`/mob/${relativePath?relativePath+'/':''}`;
    try { mobCurrentPath=relativePath;mobCurrentFolderName=mobDisplayName(relativePath,folderName);saveDataExplorerState('mob',mobCurrentPath,mobCurrentFolderName,null);mobManifest=await loadMobManifest(relativePath,folderName);mobFiles=extractMobManifestFiles(mobManifest);renderMobTree(mobManifest,relativePath,mobCurrentFolderName);gridEl.hidden=false;viewerEl.hidden=true; }
    catch(err){treeEl.innerHTML='';const p=document.createElement('p');p.className='explorer-status err';p.textContent=err&&err.message?err.message:String(err);treeEl.appendChild(p);}
  }
  async function enterMobExplorer() {
    leaveExplorerHome();
    explorerMode='mob';saveDataExplorerState('mob','', 'mob', null);artExplorerControls.hidden=true;gridEl.hidden=false;viewerEl.hidden=true;viewerEl.innerHTML='';paginationEl.hidden=true;breadcrumbEl.textContent='/mob/';treeEl.innerHTML='<p class="mob-loading">Loading /mob/ manifest…</p>';
    try { mobCurrentPath='';mobCurrentFolderName='mob';mobManifest=await loadMobManifest('','mob');mobFiles=extractMobManifestFiles(mobManifest);renderMobTree(mobManifest,'','mob'); }
    catch(err){treeEl.innerHTML='';const p=document.createElement('p');p.className='explorer-status err';p.textContent=err&&err.message?err.message:String(err);treeEl.appendChild(p);gridEl.innerHTML='';}
  }
  function leaveMobExplorer(){leaveDataExplorer();}
  function showMobBrowser(){if(openGroup)closeGifBuilder();openGroup=null;viewerEl.hidden=true;viewerEl.innerHTML='';gridEl.hidden=false;paginationEl.hidden=true;clearShareUrl();gridEl.innerHTML='<p class="explorer-status">Select a .mob file or folder from the list.</p>';}
  let mobViewerRequestToken = 0;
  async function loadMobFromServer(filename,rowEl,relativePath='') {
    treeEl.querySelectorAll('.mob-file-row.active').forEach(r=>r.classList.remove('active'));if(rowEl)rowEl.classList.add('active');
    const url=`${MOB_ROOT}${relativePath?relativePath+'/':''}${filename}`;
    saveDataExplorerState('mob',relativePath,mobDisplayName(relativePath,rowEl?.parentElement?.querySelector?.('.mob-list-heading strong')?.textContent?.replace(/^📦\s*/, '') || mobCurrentFolderName),filename);
    const requestId = ++mobViewerRequestToken;
    try {
      const resp=await fetch(url,{cache:'no-store'});
      if(!resp.ok)throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const decoded=decodeMobBuffer(await resp.arrayBuffer(),filename);
      if (requestId !== mobViewerRequestToken) return;
      const { protoSection } = renderMobViewer(decoded);
      resolveMobPrototype(decoded).then(proto => {
        if (requestId !== mobViewerRequestToken) return;
        renderMobPrototypeInfo(decoded, proto, protoSection);
      }).catch(err => {
        if (requestId !== mobViewerRequestToken) return;
        protoSection.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'explorer-status err';
        p.textContent = `Prototype resolution failed: ${err && err.message ? err.message : err}`;
        protoSection.appendChild(p);
      });
    }
    catch(err){log(`${filename}: ${err&&err.message?err.message:err}`,'err');}
  }
  const MOB_OBJECT_TYPE_NAMES = [
    'WALL', 'PORTAL', 'CONTAINER', 'SCENERY', 'PROJECTILE', 'WEAPON', 'AMMO',
    'ARMOR', 'GOLD (money)', 'FOOD', 'SCROLL', 'KEY', 'KEY_RING', 'WRITTEN',
    'GENERIC (item)', 'PC', 'NPC', 'TRAP', 'MONSTER', 'UNIQUE_NPC'
  ];

  function mobObjectTypeName(type){
    return MOB_OBJECT_TYPE_NAMES[type] || `Unknown object type`;
  }

  // ---- .PRO prototype explorer ------------------------------------------
  // .PRO records use the same object-field schema as .MOB records, but their
  // prototype OID is BLOCKED (-1), they carry an available-field bitmap, and
  // then serialize every field of the object's type in enum order.
  const PRO_ROOT = 'proto/';
  const PRO_MANIFEST_URLS = ['proto/proto_manifest.json', 'proto/manifest.json'];
  const protoExploreBtn = document.getElementById('protoExploreBtn');
  const protoManifestCache = new Map();
  let protoFiles = [];
  let protoManifest = null;
  let protoCurrentPath = '';
  let protoCurrentFolderName = 'proto';
  let protoBrowseMode = 'folder'; // 'folder' | 'search'
  let protoViewerFilename = '';
  let protoSearchResults = [];
  let protoLastSearchQuery = '';
  let protoObjectTypeFilter = 'all';
  const PROTO_SEARCH_RESULT_LIMIT = 300;
  const protoDecodedCache = new Map();

  // Arcanum's .mes files are brace-delimited number -> string tables.
  // F_DESCRIPTION stores the numeric key into text/mes/description.mes.
  const DESCRIPTION_MES_URL = 'text/mes/description.mes';
  const ITEM_INVEN_MES_URL = 'art/item/item_inven.mes';
  const ITEM_ART_ROOT = 'art/item/';
  let descriptionMesPromise = null;
  let descriptionMesMap = null;
  let itemInvenMesPromise = null;
  let itemInvenMesMap = null;

  function parseMesText(text) {
    const map = new Map();
    const fields = [];
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const close = text.indexOf('}', open + 1);
      if (close === -1) break;
      fields.push(text.slice(open + 1, close));
      i = close + 1;
    }
    for (let n = 0; n + 1 < fields.length; n += 2) {
      const keyText = fields[n].trim();
      if (!/^[-+]?\d+$/.test(keyText)) continue;
      const key = Number(keyText);
      if (!Number.isSafeInteger(key)) continue;
      map.set(key, fields[n + 1]);
    }
    return map;
  }

  async function loadDescriptionMes() {
    if (descriptionMesMap) return descriptionMesMap;
    if (descriptionMesPromise) return descriptionMesPromise;
    descriptionMesPromise = fetch(DESCRIPTION_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${DESCRIPTION_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try {
          text = new TextDecoder('windows-1252').decode(buf);
        } catch (_) {
          text = new TextDecoder('latin1').decode(buf);
        }
        descriptionMesMap = parseMesText(text);
        return descriptionMesMap;
      })
      .catch(err => {
        descriptionMesPromise = null;
        throw err;
      });
    return descriptionMesPromise;
  }

  function protoDescriptionInfo(value) {
    const id = Number(value);
    if (!Number.isFinite(id)) return null;
    if (!descriptionMesMap) return { id, text: null, loading: true };
    return { id, text: descriptionMesMap.get(id) ?? null, loading: false };
  }

  async function loadItemInvenMes() {
    if (itemInvenMesMap) return itemInvenMesMap;
    if (itemInvenMesPromise) return itemInvenMesPromise;
    itemInvenMesPromise = fetch(ITEM_INVEN_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${ITEM_INVEN_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        itemInvenMesMap = parseMesText(text);
        return itemInvenMesMap;
      })
      .catch(err => {
        itemInvenMesPromise = null;
        throw err;
      });
    return itemInvenMesPromise;
  }

  function protoCurrentAidArtId(value, objectType) {
    const raw = Number(value) >>> 0;
    if (!Number.isFinite(raw)) return null;
    const b0 = raw & 0xFF;
    const b1 = (raw >>> 8) & 0xFF;
    const b2 = (raw >>> 16) & 0xFF;
    const b3 = (raw >>> 24) & 0xFF;
    if (b3 !== 0x60 && b3 !== 0x61) return null;

    // Confirmed item-family encoding (Gold through Generic): PP 00 XX YY.
    // PP is the thousand block; YY advances by 128; XX/2 is the position.
    if (b1 === 0x00 && b0 >= 0x03 && b0 <= 0x09 && (b2 & 1) === 0) {
      return b0 * 1000 + ((b3 - 0x60) * 128) + (b2 >> 1);
    }

    // Confirmed weapon encoding:
    //   80 00 08 60 -> 40
    //   80 00 10 60 -> 48
    //   80 02 0A 60 -> 205
    // The observed fields decode as (top two bits of b0)*20 + b1*80 + b2/2.
    if (objectType === 5) {
      if ((b2 & 1) !== 0) return null;
      return ((b0 >>> 6) * 20) + (b1 * 80) + (b2 >> 1);
    }

    // Confirmed ammo encoding from:
    //   01 00 00 60 -> 1000
    //   41 00 00 60 -> 1020
    //   81 00 00 60 -> 1040
    //   C1 00 00 60 -> 1060
    // The low six bits select the thousand block; the top two bits add 20-point
    // steps, and the third byte contributes its half-value.
    if (objectType === 6) {
      if ((b2 & 1) !== 0) return null;
      return (b0 & 0x3F) * 1000 + ((b0 >>> 6) * 20) + (b2 >> 1);
    }

    // Confirmed armor encoding. The low six bits of b0 select the thousand
    // block and its top two bits add 20-point steps.  The known b1 variants
    // currently observed are retained explicitly until more armor samples
    // establish the remaining bit layout.
    if (objectType === 7) {
      if ((b2 & 1) !== 0) return null;
      const base = (b0 & 0x3F) * 1000 + ((b0 >>> 6) * 20);
      const b1Offset = { 0x00: 0, 0x40: 700, 0x80: 824 }[b1 & 0xC0];
      if (b1Offset === undefined) return null;
      return base + b1Offset + (b2 >> 1);
    }

    return null;
  }

  async function loadProtoCurrentAidArt(artId, artName, previewCanvas) {
    if (!artName) return;
    const filename = artName.replace(/^.*[\/]/, '');
    const url = `${ITEM_ART_ROOT}${filename}`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const frames = await parseArtBuffer(await resp.arrayBuffer());
      if (!frames.length || !frames[0].canvas) throw new Error('no drawable frame');
      const source = frames[0].canvas;
      const maxSide = 92;
      const scale = Math.max(1, Math.min(maxSide / source.width, maxSide / source.height));
      const w = Math.max(1, Math.round(source.width * scale));
      const h = Math.max(1, Math.round(source.height * scale));
      previewCanvas.width = w;
      previewCanvas.height = h;
      previewCanvas.style.width = `${w}px`;
      previewCanvas.style.height = `${h}px`;
      const ctx = previewCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      previewCanvas.title = `${artName} · Art ID ${artId}`;
    } catch (err) {
      previewCanvas.classList.add('missing');
      previewCanvas.title = `${artName} · bitmap unavailable`;
    }
  }

  async function resolveProtoCurrentAid(decoded) {
    const field = decoded.fields.find(f => f.field === 1);
    if (!field) return null;
    const artId = protoCurrentAidArtId(field.value, decoded.objType);
    if (artId === null || !itemInvenMesMap) return { artId, artName: null };
    return { artId, artName: itemInvenMesMap.get(artId) ?? null };
  }

  function protoManifestUrlCandidates(relativePath, folderName) {
    const prefix = relativePath ? `${PRO_ROOT}${relativePath}/` : PRO_ROOT;
    if (!relativePath) return PRO_MANIFEST_URLS;
    return [`${prefix}${folderName}_manifest.json`, `${prefix}manifest.json`];
  }

  async function loadProtoManifest(relativePath, folderName) {
    if (protoManifestCache.has(relativePath)) return protoManifestCache.get(relativePath);
    let lastError = null;
    for (const url of protoManifestUrlCandidates(relativePath, folderName)) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        protoManifestCache.set(relativePath, data);
        return data;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`couldn't load .pro manifest for /proto/${relativePath}${lastError ? ` (${lastError.message || lastError})` : ''}`);
  }

  function extractProtoManifestFiles(manifest) {
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    return files
      .map(x => typeof x === 'string' ? x : (x && (x.name || x.filename || x.file)))
      .filter(x => typeof x === 'string' && /\.pro$/i.test(x))
      .sort((a, b) => a.localeCompare(b));
  }

  function protoSubfolders(manifest) {
    const sub = manifest?.subfolders && typeof manifest.subfolders === 'object' ? manifest.subfolders : {};
    return Object.keys(sub).sort().map(k => sub[k]).filter(sf => sf && typeof sf === 'object' && sf.folder_name);
  }

  function protoDisplayName(path, fallback) {
    return fallback || path.split('/').filter(Boolean).pop() || 'proto';
  }

  function decodeProtoBuffer(buf, filename) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    if (bytes.length < 56) throw new Error('file is too small to be a valid .pro');

    let offset = 0;
    const version = mobI32(view, offset); offset += 4;
    if (version !== 119) throw new Error(`version=${version}, expected 119`);

    const protoOid = bytes.slice(offset, offset + 24); offset += 24;
    const objectOid = bytes.slice(offset, offset + 24); offset += 24;
    const objType = mobI32(view, offset); offset += 4;
    if (objType < 0 || objType >= MOB_TYPE_LAST_FIELD.length) {
      throw new Error(`unsupported object type ${objType}`);
    }

    const dwordCount = MOB_ENGINE.dwordCount[objType];
    if (!Number.isFinite(dwordCount) || dwordCount <= 0) throw new Error(`no field-bitmap schema for object type ${objType}`);
    if (offset + dwordCount * 4 > bytes.length) throw new Error('truncated available-field bitmap');

    const bitmap = [];
    for (let i = 0; i < dwordCount; i++) {
      bitmap.push(view.getUint32(offset, true));
      offset += 4;
    }
    const actualAvailable = bitmap.reduce((n, w) => n + ((w >>> 0).toString(2).match(/1/g) || []).length, 0);

    const fields = [];
    for (const fld of enumerateMobFields(objType)) {
      const fieldOffset = offset;
      const od = MOB_OD_TYPES[fld];
      const parsed = readMobField(view, bytes, offset, od);
      offset += parsed.size;
      fields.push({
        field: fld,
        name: MOB_FIELD_NAMES[fld] || `FIELD_${fld}`,
        od: MOB_OD_NAMES[od] || `OdType_${od}`,
        available: mobBitIsSet(bitmap, fld),
        change_idx: MOB_ENGINE.changeIdx[fld],
        bit: MOB_ENGINE.masks[fld] ? Math.round(Math.log2(MOB_ENGINE.masks[fld])) : -1,
        offset: fieldOffset,
        size: parsed.size,
        raw: mobHex(bytes.slice(fieldOffset, offset)),
        value: parsed.value
      });
    }

    return {
      filename,
      size: bytes.length,
      version,
      protoOid,
      objectOid,
      objType,
      bitmap,
      actualAvailable,
      fields,
      endOffset: offset,
      trailing: bytes.slice(offset)
    };
  }


  async function decodeProtoForSearch(filename, relativePath = '') {
    const key = `${relativePath}\0${filename}`;
    if (protoDecodedCache.has(key)) return protoDecodedCache.get(key);
    const url = `${PRO_ROOT}${relativePath ? relativePath + '/' : ''}${filename}`;
    const promise = fetch(url, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        return resp.arrayBuffer();
      })
      .then(buf => decodeProtoBuffer(buf, filename));
    protoDecodedCache.set(key, promise);
    try {
      return await promise;
    } catch (err) {
      protoDecodedCache.delete(key);
      throw err;
    }
  }

  // ---- .MOB → .PRO prototype resolution -----------------------------------
  // data-formats.md: an instance record stores only its overridden fields; every
  // unset bit means "use the prototype's value". To show a .mob's *effective*
  // fields we need to resolve its linked prototype (by number, from prototype_oid's
  // OID_TYPE_A payload) and merge. protoNumberIndex walks the /proto/ manifest tree
  // once (folder listings only, cheap) to map "NNNNNN - Name.pro" -> path.
  let protoNumberIndexPromise = null;

  async function buildProtoNumberIndex() {
    const index = new Map();
    const visited = new Set();
    async function walk(relativePath, folderName) {
      if (visited.has(relativePath)) return;
      visited.add(relativePath);
      let manifest;
      try { manifest = await loadProtoManifest(relativePath, folderName); } catch (_) { return; }
      for (const f of extractProtoManifestFiles(manifest)) {
        const m = /^(\d+)\s*-\s*/.exec(f);
        if (m) {
          const num = parseInt(m[1], 10);
          if (!index.has(num)) index.set(num, { relPath: relativePath, filename: f });
        }
      }
      for (const sf of protoSubfolders(manifest)) {
        await walk(mobJoinPath(relativePath, sf.relative_path), sf.folder_name);
      }
    }
    await walk('', 'proto');
    return index;
  }

  function getProtoNumberIndex() {
    if (!protoNumberIndexPromise) {
      protoNumberIndexPromise = buildProtoNumberIndex().catch(err => {
        protoNumberIndexPromise = null;
        throw err;
      });
    }
    return protoNumberIndexPromise;
  }

  // ObjectID union: int16 type, 2 bytes padding, int32 padding, then a 16-byte
  // union — for OID_TYPE_A (type 1) the union's first dword (offset +8) is the
  // prototype number. Mirrors ObjectOidNumberOffset/OidNumberOffset in the C# readers.
  function mobOidTypeAndNumber(bytes) {
    if (!bytes || bytes.length !== 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { type: view.getUint32(0, true), number: view.getUint32(8, true) };
  }

  async function resolveMobPrototype(decoded) {
    const info = mobOidTypeAndNumber(decoded.protoOid);
    if (!info || info.type !== 1) return { protoNumber: null, entry: null, decodedProto: null, error: null };
    const protoNumber = info.number;
    try {
      const index = await getProtoNumberIndex();
      const entry = index.get(protoNumber);
      if (!entry) return { protoNumber, entry: null, decodedProto: null, error: `#${protoNumber} not found under /proto/` };
      const url = `${PRO_ROOT}${entry.relPath ? entry.relPath + '/' : ''}${entry.filename}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const decodedProto = decodeProtoBuffer(await resp.arrayBuffer(), entry.filename);
      return { protoNumber, entry, decodedProto, error: null };
    } catch (err) {
      return { protoNumber, entry: null, decodedProto: null, error: err && err.message ? err.message : String(err) };
    }
  }

  function renderMobPrototypeInfo(decoded, proto, container) {
    container.innerHTML = '';

    if (proto.protoNumber === null) {
      const p = document.createElement('p');
      p.className = 'explorer-status';
      p.textContent = "This object's prototype OID isn't a numbered (A-type) reference, so effective fields can't be resolved.";
      container.appendChild(p);
      return;
    }
    if (proto.error || !proto.decodedProto) {
      const p = document.createElement('p');
      p.className = 'explorer-status err';
      p.textContent = `Prototype #${proto.protoNumber}: ${proto.error || 'not found'}`;
      container.appendChild(p);
      return;
    }

    const linkWrap = document.createElement('p');
    linkWrap.className = 'mob-proto-link-wrap';
    linkWrap.append(`Prototype #${proto.protoNumber}: `);
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'mob-proto-link';
    link.textContent = `→ ${proto.entry.filename}`;
    link.title = 'Open this prototype in the .PRO explorer';
    link.addEventListener('click', async () => {
      await enterProtoExplorer();
      await loadProtoFromServer(proto.entry.filename, null, proto.entry.relPath);
    });
    linkWrap.appendChild(link);
    container.appendChild(linkWrap);

    if (proto.decodedProto.objType !== decoded.objType) {
      const warn = document.createElement('p');
      warn.className = 'explorer-status err';
      warn.textContent = `Prototype object type (${proto.decodedProto.objType}) doesn't match this instance's type (${decoded.objType}) — skipping the merge.`;
      container.appendChild(warn);
      return;
    }

    const overrideMap = new Map(decoded.fields.map(f => [f.field, f]));
    const title = document.createElement('h3');
    title.className = 'mob-section-title';
    title.textContent = 'Effective fields (override + inherited)';
    container.appendChild(title);

    const table = document.createElement('div');
    table.className = 'mob-field-table proto-field-table';
    const head = document.createElement('div');
    head.className = 'mob-field-row mob-field-head';
    ['Field', 'Source', 'Type', 'Value', 'Raw'].forEach(t => {
      const c = document.createElement('div'); c.textContent = t; head.appendChild(c);
    });
    table.appendChild(head);

    for (const pf of proto.decodedProto.fields) {
      const override = overrideMap.get(pf.field);
      const f = override || pf;
      const row = document.createElement('div');
      row.className = 'mob-field-row';
      const c1 = document.createElement('div');
      c1.innerHTML = `<strong>${f.name}</strong><small>#${f.field}</small>`;
      const c2 = document.createElement('div');
      c2.textContent = override ? 'Overridden' : 'Inherited';
      c2.classList.add(override ? 'proto-available' : 'mob-field-inherited');
      const c3 = document.createElement('div'); c3.textContent = f.od;
      const c4 = document.createElement('div'); c4.className = 'mob-value';
      c4.textContent = f.field === 1 ? mobCurrentAidText(f.value, decoded.objType) : mobFieldValueText(f.field, f.value);
      const c5 = document.createElement('div'); c5.className = 'mob-raw'; c5.textContent = f.raw;
      [c1, c2, c3, c4, c5].forEach(c => row.appendChild(c));
      table.appendChild(row);
    }
    container.appendChild(table);
  }

  async function protoFileMatchesType(filename, relativePath, filter = protoObjectTypeFilter) {
    if (!filter || filter === 'all') return true;
    try {
      const decoded = await decodeProtoForSearch(filename, relativePath);
      return String(decoded.objType) === String(filter);
    } catch (_) { return false; }
  }

  async function filterProtoFilesByObjectType(files, relativePath) {
    if (protoObjectTypeFilter === 'all') return files;
    const out = [];
    for (const filename of files) {
      if (await protoFileMatchesType(filename, relativePath)) out.push(filename);
    }
    return out;
  }

  function populateProtoObjectTypeFilter() {
    const select = document.getElementById('protoObjectTypeFilter');
    if (!select || select.options.length > 1) return;
    MOB_OBJECT_TYPE_NAMES.forEach((name, type) => {
      const opt = document.createElement('option');
      opt.value = String(type);
      opt.textContent = `${name} (${type})`;
      select.appendChild(opt);
    });
  }

  async function renderProtoTree(manifest, relativePath, folderName) {
    populateProtoObjectTypeFilter();
    const typeFilter = protoObjectTypeFilter;
    renderDataExplorerTree('proto', '', manifest, loadProtoManifest, openProtoFolder, protoSubfolders, loadProtoFromServer,
      async (filename, path) => protoFileMatchesType(filename, path, typeFilter));
    const subfolders = protoSubfolders(manifest);
    const allFiles = extractProtoManifestFiles(manifest);
    const files = await filterProtoFilesByObjectType(allFiles, relativePath);
    renderDataFolderGrid({
      subfolders, files, relativePath, openFolderFn: openProtoFolder, openFileFn: loadProtoFromServer, fileIcon: '🧬',
      afterFileCard: (card, filename) => applyProtoCurrentArtToFileCard(card, filename, relativePath)
    });
  }

  async function openProtoFolder(relativePath, folderName) {
    treeEl.innerHTML = '<p class="mob-loading">Loading folder…</p>';
    breadcrumbEl.textContent = `/proto/${relativePath ? relativePath + '/' : ''}`;
    try {
      protoCurrentPath = relativePath;
      protoCurrentFolderName = protoDisplayName(relativePath, folderName);
      protoBrowseMode = 'folder';
      protoSearchResults = [];
      protoLastSearchQuery = '';
      searchInputEl.value = '';
      searchClearBtnEl.hidden = true;
      saveDataExplorerState('pro', protoCurrentPath, protoCurrentFolderName, null);
      protoManifest = await loadProtoManifest(relativePath, folderName);
      protoFiles = extractProtoManifestFiles(protoManifest);
      await renderProtoTree(protoManifest, relativePath, protoCurrentFolderName);
      gridEl.hidden = false;
      viewerEl.hidden = true;
    } catch (err) {
      treeEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'explorer-status err';
      p.textContent = err && err.message ? err.message : String(err);
      treeEl.appendChild(p);
    }
  }

  async function enterProtoExplorer() {
    leaveExplorerHome();
    explorerHome.hidden = true;
    document.querySelector('.explorer').hidden = false;
    if (manualLoadEl) manualLoadEl.hidden = true;
    if (logEl) logEl.hidden = false;
    if (footerNoteEl) footerNoteEl.hidden = false;
    explorerMode = 'pro';
    artExplorerControls.hidden = false;
    if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = false;
    searchInputEl.placeholder = 'Search .PRO descriptions…';
    searchInputEl.setAttribute('aria-label', 'Search .PRO descriptions');
    saveDataExplorerState('pro', '', 'proto', null);
    gridEl.hidden = false;
    viewerEl.hidden = true;
    viewerEl.innerHTML = '';
    paginationEl.hidden = true;
    breadcrumbEl.textContent = '/proto/';
    treeEl.innerHTML = '<p class="mob-loading">Loading /proto/ manifest…</p>';
    try {
      protoCurrentPath = '';
      protoCurrentFolderName = 'proto';
      protoManifest = await loadProtoManifest('', 'proto');
      protoFiles = extractProtoManifestFiles(protoManifest);
      await renderProtoTree(protoManifest, '', 'proto');
    } catch (err) {
      treeEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'explorer-status err';
      p.textContent = err && err.message ? err.message : String(err);
      treeEl.appendChild(p);
      gridEl.innerHTML = '';
    }
  }

  function leaveDataExplorer() {
    explorerHome.hidden = true;
    document.querySelector('.explorer').hidden = false;
    explorerMode = 'art';
    artExplorerControls.hidden = false;
    if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = true;
    searchInputEl.placeholder = 'Search .ART files by name…';
    searchInputEl.setAttribute('aria-label', 'Search all folders');
    searchInputEl.value = '';
    searchClearBtnEl.hidden = true;
    showBrowser();
    treeEl.innerHTML = '';
    initExplorer(false);
  }

  async function showProtoBrowser() {
    if (openGroup) closeGifBuilder();
    openGroup = null;
    viewerEl.hidden = true;
    viewerEl.innerHTML = '';
    gridEl.hidden = false;
    paginationEl.hidden = true;
    clearShareUrl();
    try {
      if (!protoManifest) protoManifest = await loadProtoManifest(protoCurrentPath, protoCurrentFolderName);
      await renderProtoTree(protoManifest, protoCurrentPath, protoCurrentFolderName);
    } catch (_) {
      gridEl.innerHTML = '<p class="explorer-status">Select a .pro file or folder from the list.</p>';
    }
  }

  async function loadProtoFromServer(filename, rowEl, relativePath = '') {
    protoCurrentPath = relativePath || '';
    protoBrowseMode = 'folder';
    try {
      protoManifest = await loadProtoManifest(protoCurrentPath, protoCurrentPath ? protoCurrentPath.split('/').pop() : 'proto');
      protoFiles = extractProtoManifestFiles(protoManifest);
    } catch (err) {
      protoFiles = [];
    }
    protoCurrentFolderName = protoCurrentPath ? protoCurrentPath.split('/').pop() : 'proto';
    treeEl.querySelectorAll('.mob-file-row.active').forEach(r => r.classList.remove('active'));
    if (rowEl) rowEl.classList.add('active');
    const url = `${PRO_ROOT}${relativePath ? relativePath + '/' : ''}${filename}`;
    saveDataExplorerState('pro', relativePath, protoCurrentFolderName, filename);
    protoViewerFilename = filename;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const decoded = decodeProtoBuffer(await resp.arrayBuffer(), filename);
      try { await Promise.all([loadDescriptionMes(), loadItemInvenMes()]); }
      catch (mesErr) { log(`.mes lookup: ${mesErr && mesErr.message ? mesErr.message : mesErr}`, 'err'); }
      renderProtoViewer(decoded);
    } catch (err) {
      log(`${filename}: ${err && err.message ? err.message : err}`, 'err');
      gridEl.hidden = true;
      viewerEl.hidden = false;
      viewerEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'explorer-status err';
      p.textContent = `Couldn't open ${filename}: ${err && err.message ? err.message : err}`;
      viewerEl.appendChild(p);
    }
  }

  async function navigateProtoFile(delta) {
    if (explorerMode !== 'pro' || viewerEl.hidden) return;
    if (!protoFiles.length) {
      try {
        protoManifest = await loadProtoManifest(protoCurrentPath, protoCurrentFolderName);
        protoFiles = extractProtoManifestFiles(protoManifest);
      } catch (_) { return; }
    }
    const currentIndex = protoFiles.findIndex(name => name.toLowerCase() === String(protoViewerFilename || '').toLowerCase());
    if (currentIndex < 0) return;
    const nextIndex = currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= protoFiles.length) return;
    const filename = protoFiles[nextIndex];
    const row = Array.from(treeEl.querySelectorAll('.mob-file-row')).find(r => r.querySelector('.tree-name')?.textContent === filename);
    await loadProtoFromServer(filename, row || null, protoCurrentPath);
  }

  document.addEventListener('keydown', (e) => {
    if (explorerMode !== 'pro' || viewerEl.hidden) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (document.getElementById('gbOverlay').classList.contains('open')) return;
    e.preventDefault();
    navigateProtoFile(e.key === 'ArrowUp' ? -1 : 1);
  });

  function renderProtoViewer(decoded) {
    gridEl.hidden = true;
    paginationEl.hidden = true;
    viewerEl.innerHTML = '';
    viewerEl.hidden = false;
    viewerEl.classList.add('revealed');

    const article = document.createElement('article');
    article.className = 'mob-viewer';

    const backBar = document.createElement('div');
    backBar.className = 'viewer-backbar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn-back';
    back.textContent = '← Back to prototypes';
    back.addEventListener('click', showProtoBrowser);
    backBar.appendChild(back);
    article.appendChild(backBar);

    const header = document.createElement('div');
    header.className = 'file-group-header';
    header.innerHTML = `<h2>${decoded.filename}</h2><span class="meta">${decoded.fields.length} serialized fields</span>`;
    article.appendChild(header);

    const aidField = decoded.fields.find(f => f.field === 1);
    const aidArtId = aidField ? protoCurrentAidArtId(aidField.value, decoded.objType) : null;
    const aidArtName = aidArtId !== null && itemInvenMesMap ? (itemInvenMesMap.get(aidArtId) ?? null) : null;
    const descriptionField = decoded.fields.find(f => f.field === 23);
    const descriptionInfo = descriptionField ? protoDescriptionInfo(descriptionField.value) : null;
    if (aidField || descriptionField) {
      const aidArt = document.createElement('div');
      aidArt.className = 'proto-current-aid-art';

      const artPreview = document.createElement('div');
      artPreview.className = 'proto-current-aid-preview';
      const artCanvas = document.createElement('canvas');
      artCanvas.className = 'proto-current-aid-canvas';
      artPreview.appendChild(artCanvas);

      const artMeta = document.createElement('div');
      artMeta.className = 'proto-current-aid-meta';
      const artLabel = document.createElement('span');
      artLabel.className = 'proto-current-aid-label';
      artLabel.textContent = 'Current art';
      const artNameEl = document.createElement('strong');
      artNameEl.textContent = aidArtId !== null ? (aidArtName || `Art ID ${aidArtId}`) : 'Art ID unavailable';
      artMeta.append(artLabel, artNameEl);

      const descLabel = document.createElement('span');
      descLabel.className = 'proto-current-aid-label';
      descLabel.textContent = 'F_DESCRIPTION';
      const descEl = document.createElement('div');
      descEl.className = 'proto-current-aid-description';
      if (descriptionInfo && descriptionInfo.text != null) {
        descEl.textContent = `${descriptionInfo.text} (${descriptionInfo.id})`;
      } else if (descriptionInfo && descriptionInfo.loading) {
        descEl.textContent = `${mobValueText(descriptionField.value)} (loading description.mes…)`;
      } else if (descriptionInfo) {
        descEl.textContent = `${mobValueText(descriptionField.value)} (not found in description.mes)`;
      } else {
        descEl.textContent = 'Not present';
      }
      artMeta.append(descLabel, descEl);

      aidArt.append(artPreview, artMeta);
      article.appendChild(aidArt);
      if (aidArtName) loadProtoCurrentAidArt(aidArtId, aidArtName, artCanvas);
    }

    // F_ITEM_INV_AID (field 93) — a separate "compact inventory-icon art id" per
    // ObjectProto.cs, distinct from F_CURRENT_AID (field 1). It's already parsed
    // into decoded.fields with no extra work. We don't have a confirmed bit-decode
    // formula for it yet, so this looks the raw value up in item_inven.mes directly
    // (no bit-shuffling) — shown side-by-side with Current art so the two can be
    // compared against known-good examples while the Art-ID bitfield format is
    // still being reverse-engineered.
    const invAidField = decoded.fields.find(f => f.field === 93);
    if (invAidField) {
      const rawInvAid = Number(invAidField.value) >>> 0;
      const invAidName = itemInvenMesMap ? (itemInvenMesMap.get(rawInvAid) ?? null) : null;

      const invArt = document.createElement('div');
      invArt.className = 'proto-current-aid-art';

      const invPreview = document.createElement('div');
      invPreview.className = 'proto-current-aid-preview';
      const invCanvas = document.createElement('canvas');
      invCanvas.className = 'proto-current-aid-canvas';
      invPreview.appendChild(invCanvas);

      const invMeta = document.createElement('div');
      invMeta.className = 'proto-current-aid-meta';
      const invLabel = document.createElement('span');
      invLabel.className = 'proto-current-aid-label';
      invLabel.textContent = 'F_ITEM_INV_AID · raw value, direct .mes lookup (unconfirmed)';
      const invNameEl = document.createElement('strong');
      invNameEl.textContent = invAidName || `raw ${rawInvAid} — not found in item_inven.mes`;
      invMeta.append(invLabel, invNameEl);

      invArt.append(invPreview, invMeta);
      article.appendChild(invArt);
      if (invAidName) loadProtoCurrentAidArt(rawInvAid, invAidName, invCanvas);
    }

    const summary = document.createElement('div');
    summary.className = 'mob-summary';
    summary.innerHTML = `
      <div><span>Size</span><strong>${decoded.size} bytes</strong></div>
      <div><span>Version</span><strong>${decoded.version}</strong></div>
      <div><span>Object type</span><strong>${mobObjectTypeName(decoded.objType)} (${decoded.objType})</strong></div>
      <div><span>Available fields</span><strong>${decoded.actualAvailable}</strong></div>
      <div><span>Serialized fields</span><strong>${decoded.fields.length}</strong></div>
    `;
    article.appendChild(summary);

    const ids = document.createElement('div');
    ids.className = 'mob-ids';
    ids.innerHTML = `
      <div><b>Prototype OID</b><pre>${mobOidText(decoded.protoOid)}</pre></div>
      <div><b>Object OID</b><pre>${mobOidText(decoded.objectOid)}</pre></div>
      <div><b>Available mask</b><pre>${decoded.bitmap.map(x => `0x${x.toString(16).padStart(8,'0').toUpperCase()}`).join(' ')}</pre></div>
    `;
    article.appendChild(ids);

    const title = document.createElement('h3');
    title.className = 'mob-section-title';
    title.textContent = 'Prototype fields';
    article.appendChild(title);

    const note = document.createElement('p');
    note.className = 'mob-tail';
    note.textContent = `Every field is serialized in enum order. “Available” comes from the prototype’s available-field bitmap. Canonical names are shown where supplied by ObjectInstanceReader.cs/ObjectFieldData.cs; unnamed ordinals are shown as FIELD_### until the original obj.h enum is supplied.`;
    article.appendChild(note);

    const table = document.createElement('div');
    table.className = 'mob-field-table proto-field-table';
    const head = document.createElement('div');
    head.className = 'mob-field-row mob-field-head';
    ['Field','Available','Type','Offset','Size','Value','Raw'].forEach(t => {
      const c = document.createElement('div'); c.textContent = t; head.appendChild(c);
    });
    table.appendChild(head);

    for (const f of decoded.fields) {
      const row = document.createElement('div');
      row.className = 'mob-field-row';
      const c1 = document.createElement('div');
      c1.innerHTML = `<strong>${f.name}</strong><small>#${f.field} · change[${f.change_idx}] bit ${f.bit}</small>`;
      if (f.field === 23) {
        const source = document.createElement('small');
        source.className = 'proto-description-source';
        source.textContent = 'From description.mes';
        c1.appendChild(source);
      }
      const c2 = document.createElement('div');
      c2.textContent = f.available ? 'Yes' : 'No';
      if (f.available) c2.classList.add('proto-available');
      const c3 = document.createElement('div'); c3.textContent = f.od;
      const c4 = document.createElement('div'); c4.textContent = `0x${f.offset.toString(16).toUpperCase().padStart(4,'0')}`;
      const c5 = document.createElement('div'); c5.textContent = String(f.size);
      const c6 = document.createElement('div');
      c6.className = 'mob-value';
      if (f.field === 23) {
        const info = protoDescriptionInfo(f.value);
        if (info && info.text !== null) {
          c6.textContent = `${info.text} (${info.id})`;
        } else if (info && info.loading) {
          c6.textContent = `${mobValueText(f.value)} (loading description.mes…)`;
        } else if (info) {
          c6.textContent = `${mobValueText(f.value)} (not found in description.mes)`;
        } else {
          c6.textContent = mobValueText(f.value);
        }
      } else if (f.field === 1) {
        c6.textContent = mobCurrentAidText(f.value, decoded.objType);
      } else if ((f.field === 89 || f.field === 91) && Number(f.value) === -1) {
        // data-formats.md: shipped .pro files store weight/worth as a -1 sentinel;
        // the real number is filled in at runtime from internal default tables,
        // not read from the file. Flag it so -1 doesn't look like real data.
        c6.textContent = `${mobValueText(f.value)} (sentinel — game computes default at runtime)`;
      } else {
        c6.textContent = mobFieldValueText(f.field, f.value);
      }
      const c7 = document.createElement('div'); c7.className = 'mob-raw'; c7.textContent = f.raw;
      [c1,c2,c3,c4,c5,c6,c7].forEach(c => row.appendChild(c));
      table.appendChild(row);
    }
    article.appendChild(table);

    const tail = document.createElement('div');
    tail.className = 'mob-tail';
    tail.textContent = decoded.trailing.length
      ? `Trailing bytes: ${decoded.trailing.length}\n${mobHex(decoded.trailing)}`
      : `End offset: 0x${decoded.endOffset.toString(16).toUpperCase()} · no trailing bytes`;
    article.appendChild(tail);

    viewerEl.appendChild(article);
    viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderMobViewer(decoded) {
    gridEl.hidden = true;
    paginationEl.hidden = true;
    viewerEl.innerHTML = '';
    viewerEl.hidden = false;
    viewerEl.classList.add('revealed');

    const article = document.createElement('article');
    article.className = 'mob-viewer';

    const backBar = document.createElement('div');
    backBar.className = 'viewer-backbar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn-back';
    back.textContent = '← Back to data files';
    back.addEventListener('click', showMobBrowser);
    backBar.appendChild(back);
    article.appendChild(backBar);

    const header = document.createElement('div');
    header.className = 'file-group-header';
    header.innerHTML = `<h2>${decoded.filename}</h2><span class="meta">${decoded.fields.length} overridden field${decoded.fields.length === 1 ? '' : 's'}</span>`;
    article.appendChild(header);

    const summary = document.createElement('div');
    summary.className = 'mob-summary';
    const locField = decoded.fields.find(f => f.field === 2);
    const loc = locField ? mobLocationInfo(locField.value) : null;
    summary.innerHTML = `
      <div><span>Size</span><strong>${decoded.size} bytes</strong></div>
      <div><span>Version</span><strong>${decoded.version}</strong></div>
      <div><span>Object type</span><strong>${mobObjectTypeName(decoded.objType)} (${decoded.objType})</strong></div>
      <div><span>NUM_FIELDS</span><strong>${decoded.numFields}</strong></div>
      <div><span>Set bits</span><strong>${decoded.actualSet}</strong></div>
      ${loc ? `<div><span>World X / Y</span><strong>${loc.worldX} / ${loc.worldY}</strong></div><div><span>Sector X / Y</span><strong>${loc.sectorX} / ${loc.sectorY}</strong></div><div><span>Tile X / Y</span><strong>${loc.tileX} / ${loc.tileY}</strong></div>` : ''}
    `;
    article.appendChild(summary);

    const ids = document.createElement('div');
    ids.className = 'mob-ids';
    ids.innerHTML = `
      <div><b>Prototype OID</b><pre>${mobOidText(decoded.protoOid)}</pre></div>
      <div><b>Object OID</b><pre>${mobOidText(decoded.objectOid)}</pre></div>
      <div><b>FIELD_48</b><pre>${decoded.bitmap.map(x => `0x${x.toString(16).padStart(8,'0').toUpperCase()}`).join(' ')}</pre></div>
    `;
    article.appendChild(ids);

    // Filled in asynchronously by loadMobFromServer once the linked prototype
    // (if any) has been resolved — see resolveMobPrototype/renderMobPrototypeInfo.
    const protoSection = document.createElement('div');
    protoSection.className = 'mob-proto-section';
    const resolving = document.createElement('p');
    resolving.className = 'explorer-status';
    resolving.textContent = 'Resolving prototype…';
    protoSection.appendChild(resolving);
    article.appendChild(protoSection);

    const title = document.createElement('h3');
    title.className = 'mob-section-title';
    title.textContent = 'Serialized / overridden fields';
    article.appendChild(title);

    const table = document.createElement('div');
    table.className = 'mob-field-table';
    const head = document.createElement('div');
    head.className = 'mob-field-row mob-field-head';
    ['Field', 'Type', 'Offset', 'Size', 'Value', 'Raw'].forEach(t => {
      const c = document.createElement('div'); c.textContent = t; head.appendChild(c);
    });
    table.appendChild(head);
    for (const f of decoded.fields) {
      const row = document.createElement('div');
      row.className = 'mob-field-row';
      const c1 = document.createElement('div');
      c1.innerHTML = `<strong>${f.name}</strong><small>#${f.field} · change[${f.change_idx}] bit ${f.bit}</small>`;
      const c2 = document.createElement('div'); c2.textContent = f.od;
      const c3 = document.createElement('div'); c3.textContent = `0x${f.offset.toString(16).toUpperCase().padStart(4,'0')}`;
      const c4 = document.createElement('div'); c4.textContent = String(f.size);
      const c5 = document.createElement('div');
      c5.className = 'mob-value';
      c5.textContent = f.field === 1 ? mobCurrentAidText(f.value, decoded.objType) : mobFieldValueText(f.field, f.value);
      const c6 = document.createElement('div'); c6.className = 'mob-raw'; c6.textContent = f.raw;
      [c1, c2, c3, c4, c5, c6].forEach(c => row.appendChild(c));
      table.appendChild(row);
    }
    article.appendChild(table);

    const tail = document.createElement('div');
    tail.className = 'mob-tail';
    tail.textContent = decoded.trailing.length
      ? `Trailing bytes: ${decoded.trailing.length}\n${mobHex(decoded.trailing)}`
      : `End offset: 0x${decoded.endOffset.toString(16).toUpperCase()} · no trailing bytes`;
    article.appendChild(tail);

    viewerEl.appendChild(article);
    viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return { protoSection };
  }
  function showExplorerHome() {
    document.body.classList.add('home-active');
    explorerHome.hidden = false;
    document.querySelector('.explorer').hidden = true;
    if (manualLoadEl) manualLoadEl.hidden = true;
    if (logEl) logEl.hidden = true;
    if (footerNoteEl) footerNoteEl.hidden = true;
  }

  function leaveExplorerHome() {
    document.body.classList.remove('home-active');
  }
  function enterArtExplorer() {
    leaveExplorerHome();
    explorerHome.hidden = true;
    document.querySelector('.explorer').hidden = false;
    if (manualLoadEl) manualLoadEl.hidden = false;
    if (logEl) logEl.hidden = false;
    if (footerNoteEl) footerNoteEl.hidden = false;
    explorerMode = 'art';
    artExplorerControls.hidden = false;
    if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = true;
    searchInputEl.placeholder = 'Search .ART files by name…';
    searchInputEl.setAttribute('aria-label', 'Search all folders');
    searchInputEl.value = '';
    searchClearBtnEl.hidden = true;
    showBrowser();
    treeEl.innerHTML = '';
    initExplorer(false);
  }
  const appTitle = document.getElementById('appTitle');
  if (appTitle) {
    appTitle.addEventListener('click', showExplorerHome);
    appTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showExplorerHome();
      }
    });
  }

  mobExploreBtn.addEventListener('click',()=>{ enterMobExplorer(); });
  protoExploreBtn.addEventListener('click',()=>{ enterProtoExplorer(); });
  artExploreBtn.addEventListener('click',()=>{ enterArtExplorer(); });
  explorerHome.querySelectorAll('[data-open-mode]').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.dataset.openMode;
      if (mode === 'art') enterArtExplorer();
      else if (mode === 'pro') enterProtoExplorer();
      else if (mode === 'mob') enterMobExplorer();
    });
  });

  // ---- File explorer -------------------------------------------------------
  //
  // Folder structure comes from per-folder "<foldername>_manifest.json" files
  // sitting next to the folders they describe under ART_ROOT. Only the
  // manifest for a folder the user actually clicks on gets fetched.

  const ART_ROOT = 'art/';
  const THUMB_ROOT = 'thumbnail/';
  // Assumption: the root manifest follows the same "<foldername>_manifest.json"
  // convention as every other folder, with the root folder itself named "art".
  // If your root manifest lives somewhere else, adjust these two constants.
  const ROOT_FOLDER_NAME = 'art';
  const ROOT_RELATIVE_PATH = '';

  const treeEl = document.getElementById('explorerTree');
  const gridEl = document.getElementById('explorerGrid');
  const breadcrumbEl = document.getElementById('explorerBreadcrumb');
  const manifestCache = new Map(); // relativePath -> parsed manifest json

  function manifestUrl(relativePath, folderName) {
    const prefix = relativePath ? `${ART_ROOT}${relativePath}/` : ART_ROOT;
    return `${prefix}${folderName}_manifest.json`;
  }

  async function loadManifest(relativePath, folderName) {
    if (manifestCache.has(relativePath)) return manifestCache.get(relativePath);
    const url = manifestUrl(relativePath, folderName);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`couldn't load ${url} (HTTP ${resp.status})`);
    const data = await resp.json();
    manifestCache.set(relativePath, data);
    return data;
  }

  const PAGE_SIZE_OPTIONS = [50, 100, 200, 'all'];
  let pageSize = PAGE_SIZE_OPTIONS[0]; // 50, 100, 200, or 'all'
  let folderFiles = [];     // all .art files in the currently browsed folder, sorted
  let folderRelPath = '';
  let currentFolderName = '';
  let currentManifest = null;
  let filesOffset = 0;

  // Search ("research") across the whole library
  let browseMode = 'folder'; // 'folder' | 'search'
  let searchResults = [];    // [{ filename, relPath, folderName }]
  let lastSearchQuery = '';
  const SEARCH_RESULT_LIMIT = 300;
  const EXPLORER_STATE_KEY = 'arcanum-art-explorer-state-v1';

  function saveExplorerState(extra = {}) {
    try {
      const state = {
        folder: folderRelPath,
        folderName: currentFolderName,
        file: extra.file !== undefined ? extra.file : null,
        offset: filesOffset,
        pageSize,
        browseMode,
        searchQuery: lastSearchQuery,
      };
      localStorage.setItem(EXPLORER_STATE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function loadExplorerState() {
    try {
      const raw = localStorage.getItem(EXPLORER_STATE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || typeof state !== 'object') return null;
      return state;
    } catch (_) {
      return null;
    }
  }


  const DATA_EXPLORER_STATE_KEY = 'arcanum-data-explorer-state-v1';

  function saveDataExplorerState(mode, path, folderName, file = null) {
    try {
      localStorage.setItem(DATA_EXPLORER_STATE_KEY, JSON.stringify({
        mode,
        path: path || '',
        folderName: folderName || (mode === 'pro' ? 'proto' : 'mob'),
        file: file || null,
      }));
    } catch (_) {}
  }

  function loadDataExplorerState() {
    try {
      const raw = localStorage.getItem(DATA_EXPLORER_STATE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || (state.mode !== 'pro' && state.mode !== 'mob')) return null;
      return state;
    } catch (_) {
      return null;
    }
  }

  const paginationEl = document.getElementById('explorerPagination');
  const paginationStatusEl = document.getElementById('explorerPaginationStatus');
  const nextBtn = document.getElementById('explorerLoadMoreBtn');
  const backBtn = document.getElementById('explorerBackBtn');
  const pageSizeSelect = document.getElementById('explorerPageSize');
  const protoObjectTypeFilterEl = document.getElementById('protoObjectTypeFilter');
  if (protoObjectTypeFilterEl) {
    protoObjectTypeFilterEl.addEventListener('change', async () => {
      protoObjectTypeFilter = protoObjectTypeFilterEl.value;
      if (explorerMode !== 'pro') return;
      if (protoBrowseMode === 'search') {
        await runProtoSearch(protoLastSearchQuery);
      } else {
        await renderProtoTree(protoManifest, protoCurrentPath, protoCurrentFolderName);
      }
    });
  }
  const searchInputEl = document.getElementById('explorerSearchInput');
  const searchBtnEl = document.getElementById('explorerSearchBtn');
  const searchClearBtnEl = document.getElementById('explorerSearchClear');

  function currentItemCount() {
    return browseMode === 'search' ? searchResults.length : folderFiles.length;
  }

  function effectivePageSize() {
    return pageSize === 'all' ? (currentItemCount() || 1) : pageSize;
  }

  function renderGrid(manifest, relativePath, folderName) {
    currentManifest = manifest;
    folderFiles = (manifest.files || [])
      .filter(f => /\.art$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    folderRelPath = relativePath;
    currentFolderName = folderName;
    filesOffset = 0;
    breadcrumbEl.textContent = `/${relativePath}`.replace(/\/+/g, '/') || '/';
    renderFilePage();
  }

  function createFileCard(filename, relPath, folderName, opts) {
    const baseName = filename.replace(/\.art$/i, '');
    const prefix = relPath ? `${relPath}/` : '';
    const artUrl = `${ART_ROOT}${prefix}${filename}`;
    const thumbUrl = `${THUMB_ROOT}${prefix}${baseName}.gif`;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item';

    const thumb = document.createElement('span');
    thumb.className = 'explorer-thumb';
    const img = document.createElement('img');
    img.src = thumbUrl;
    img.alt = filename;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      thumb.classList.add('missing');
      thumb.textContent = '🖼';
      img.remove();
    }, { once: true });
    thumb.appendChild(img);
    card.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'explorer-filename';
    name.textContent = filename;
    card.appendChild(name);

    if (opts && opts.showPath) {
      const pathLabel = document.createElement('span');
      pathLabel.className = 'explorer-item-path';
      pathLabel.textContent = `/${relPath}`.replace(/\/+/g, '/') || '/';
      card.appendChild(pathLabel);
    }

    card.addEventListener('click', () => {
      folderRelPath = relPath;
      currentFolderName = folderName;
      saveExplorerState({ file: filename });
      loadArtFromServer(artUrl, filename);
    });
    gridEl.appendChild(card);
    return card;
  }

  function renderSubfolderCard(sf, parentRelPath) {
    const fullPath = joinPath(parentRelPath, sf.relative_path);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item explorer-folder-item';

    const thumb = document.createElement('span');
    thumb.className = 'explorer-thumb explorer-thumb-mosaic';
    thumb.innerHTML = '<span class="folder-glyph">📁</span>';
    card.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'explorer-filename';
    name.textContent = sf.folder_name;
    card.appendChild(name);

    card.addEventListener('click', () => openFolder(fullPath, sf.folder_name));
    gridEl.appendChild(card);

    findFirstThumbnails(fullPath, sf.folder_name, 4).then(urls => {
      if (!urls.length) return;
      thumb.innerHTML = '';
      thumb.classList.add('has-mosaic');
      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('span');
        cell.className = 'mosaic-cell';
        if (urls[i]) {
          const cellImg = document.createElement('img');
          cellImg.src = urls[i];
          cellImg.alt = '';
          cellImg.loading = 'lazy';
          cellImg.addEventListener('error', () => cell.classList.add('missing'), { once: true });
          cell.appendChild(cellImg);
        } else {
          cell.classList.add('empty');
        }
        thumb.appendChild(cell);
      }
    }).catch(() => {});
  }

  async function findFirstThumbnails(relativePath, folderName, limit) {
    const urls = [];
    const visited = new Set();
    const MAX_FETCHES = 40;
    let fetches = 0;

    async function walk(relPath, fName) {
      if (urls.length >= limit || fetches >= MAX_FETCHES) return;
      if (visited.has(relPath)) return;
      visited.add(relPath);

      let manifest;
      try {
        fetches++;
        manifest = await loadManifest(relPath, fName);
      } catch (err) {
        return;
      }

      const files = (manifest.files || [])
        .filter(f => /\.art$/i.test(f))
        .sort((a, b) => a.localeCompare(b));
      const prefix = relPath ? `${relPath}/` : '';
      for (const f of files) {
        if (urls.length >= limit) return;
        urls.push(`${THUMB_ROOT}${prefix}${f.replace(/\.art$/i, '')}.gif`);
      }
      if (urls.length >= limit) return;

      const subfolders = manifest.subfolders || {};
      const keys = Object.keys(subfolders).sort();
      for (const key of keys) {
        if (urls.length >= limit || fetches >= MAX_FETCHES) return;
        const sf = subfolders[key];
        await walk(joinPath(relPath, sf.relative_path), sf.folder_name);
      }
    }

    await walk(relativePath, folderName);
    return urls.slice(0, limit);
  }

  function openFolder(relativePath, folderName) {
    let rowEl = null;
    try {
      rowEl = treeEl.querySelector(`.tree-row[data-relpath="${CSS.escape(relativePath)}"]`);
    } catch (err) {
      rowEl = null;
    }
    if (rowEl) {
      rowEl.click();
    } else {
      selectFolder(relativePath, folderName, document.createElement('div'));
    }
  }

  async function collectFilesRecursive(relativePath, folderName, query, results, limit, visited) {
    if (results.length >= limit) return;
    if (visited.has(relativePath)) return;
    visited.add(relativePath);

    let manifest;
    try {
      manifest = await loadManifest(relativePath, folderName);
    } catch (err) {
      return;
    }

    const files = (manifest.files || []).filter(f => /\.art$/i.test(f));
    for (const f of files) {
      if (results.length >= limit) return;
      if (f.toLowerCase().includes(query)) {
        results.push({ filename: f, relPath: relativePath, folderName });
      }
    }

    const subfolders = manifest.subfolders || {};
    const keys = Object.keys(subfolders).sort();
    for (const key of keys) {
      if (results.length >= limit) return;
      const sf = subfolders[key];
      await collectFilesRecursive(joinPath(relativePath, sf.relative_path), sf.folder_name, query, results, limit, visited);
    }
  }

  async function runSearch(rawQuery) {
    const query = (rawQuery || '').trim();
    if (!query) return;

    lastSearchQuery = query;
    browseMode = 'search';
    searchResults = [];
    filesOffset = 0;
    searchClearBtnEl.hidden = false;
    saveExplorerState({ file: null });

    treeEl.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
    showBrowser();
    breadcrumbEl.textContent = `Searching for "${query}"…`;
    gridEl.innerHTML = '<p class="explorer-status">Searching…</p>';
    paginationEl.hidden = true;

    const results = [];
    try {
      await collectFilesRecursive(ROOT_RELATIVE_PATH, ROOT_FOLDER_NAME, query.toLowerCase(), results, SEARCH_RESULT_LIMIT, new Set());
    } catch (err) {
      log(`search: ${err && err.message ? err.message : err}`, 'err');
    }
    results.sort((a, b) => a.filename.localeCompare(b.filename));
    searchResults = results;

    const cappedNote = results.length >= SEARCH_RESULT_LIMIT ? ` (showing first ${SEARCH_RESULT_LIMIT})` : '';
    breadcrumbEl.textContent = `Search results for "${query}" — ${results.length} match${results.length === 1 ? '' : 'es'}${cappedNote}`;
    renderFilePage();
  }

  function clearSearch() {
    browseMode = 'folder';
    searchResults = [];
    filesOffset = 0;
    searchInputEl.value = '';
    searchClearBtnEl.hidden = true;
    saveExplorerState({ file: null });
    breadcrumbEl.textContent = `/${folderRelPath}`.replace(/\/+/g, '/') || '/';
    renderFilePage();
  }

  // ---- .PRO search --------------------------------------------------------
  // Mirrors collectFilesRecursive/runSearch/clearSearch above, but walks the
  // /proto/ manifest tree, matches by filename, and — like the folder view —
  // honors protoObjectTypeFilter by decoding only the name-matched candidates.

  async function collectProtoFilesRecursive(relativePath, folderName, query, results, limit, visited) {
    if (results.length >= limit) return;
    if (visited.has(relativePath)) return;
    visited.add(relativePath);

    let manifest;
    try {
      manifest = await loadProtoManifest(relativePath, folderName);
    } catch (err) {
      return;
    }

    const candidates = extractProtoManifestFiles(manifest).filter(f => f.toLowerCase().includes(query));
    for (const f of candidates) {
      if (results.length >= limit) return;
      if (await protoFileMatchesType(f, relativePath)) {
        results.push({ filename: f, relPath: relativePath, folderName });
      }
    }

    const subfolders = protoSubfolders(manifest);
    for (const sf of subfolders) {
      if (results.length >= limit) return;
      await collectProtoFilesRecursive(mobJoinPath(relativePath, sf.relative_path), sf.folder_name, query, results, limit, visited);
    }
  }

  function renderProtoSearchResults() {
    gridEl.innerHTML = '';
    paginationEl.hidden = true;
    if (protoSearchResults.length === 0) {
      const p = document.createElement('p');
      p.className = 'explorer-status';
      p.textContent = `No .pro files match "${protoLastSearchQuery}".`;
      gridEl.appendChild(p);
      return;
    }
    for (const item of protoSearchResults) {
      const fullPath = item.relPath ? `${item.relPath}/${item.filename}` : item.filename;
      const card = createDataFileCard(item.filename, fullPath, '🧬', card =>
        loadProtoFromServer(item.filename, card, item.relPath));
      const pathLabel = document.createElement('span');
      pathLabel.className = 'explorer-item-path';
      pathLabel.textContent = `/proto/${item.relPath}`.replace(/\/+/g, '/') || '/proto/';
      card.appendChild(pathLabel);
      gridEl.appendChild(card);
      applyProtoCurrentArtToFileCard(card, item.filename, item.relPath);
    }
  }

  async function runProtoSearch(rawQuery) {
    const query = (rawQuery || '').trim();
    if (!query) return;

    protoLastSearchQuery = query;
    protoBrowseMode = 'search';
    protoSearchResults = [];
    searchClearBtnEl.hidden = false;
    saveDataExplorerState('pro', protoCurrentPath, protoCurrentFolderName, null);

    treeEl.querySelectorAll('.tree-row.active, .mob-file-row.active').forEach(r => r.classList.remove('active'));
    gridEl.hidden = false;
    viewerEl.hidden = true;
    breadcrumbEl.textContent = `Searching for "${query}"…`;
    gridEl.innerHTML = '<p class="explorer-status">Searching…</p>';
    paginationEl.hidden = true;

    const results = [];
    try {
      await collectProtoFilesRecursive('', 'proto', query.toLowerCase(), results, PROTO_SEARCH_RESULT_LIMIT, new Set());
    } catch (err) {
      log(`.pro search: ${err && err.message ? err.message : err}`, 'err');
    }
    results.sort((a, b) => a.filename.localeCompare(b.filename));
    protoSearchResults = results;

    const cappedNote = results.length >= PROTO_SEARCH_RESULT_LIMIT ? ` (showing first ${PROTO_SEARCH_RESULT_LIMIT})` : '';
    breadcrumbEl.textContent = `Search results for "${query}" — ${results.length} match${results.length === 1 ? '' : 'es'}${cappedNote}`;
    renderProtoSearchResults();
  }

  function clearProtoSearch() {
    protoBrowseMode = 'folder';
    protoSearchResults = [];
    protoLastSearchQuery = '';
    searchInputEl.value = '';
    searchClearBtnEl.hidden = true;
    saveDataExplorerState('pro', protoCurrentPath, protoCurrentFolderName, null);
    breadcrumbEl.textContent = `/proto/${protoCurrentPath ? protoCurrentPath + '/' : ''}`;
    renderProtoTree(protoManifest, protoCurrentPath, protoCurrentFolderName);
  }

  searchBtnEl.addEventListener('click', () => {
    if (explorerMode === 'pro') runProtoSearch(searchInputEl.value);
    else runSearch(searchInputEl.value);
  });
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (explorerMode === 'pro') runProtoSearch(searchInputEl.value);
      else runSearch(searchInputEl.value);
    }
  });
  searchClearBtnEl.addEventListener('click', () => {
    if (explorerMode === 'pro') clearProtoSearch();
    else clearSearch();
  });

  function renderFilePage() {
    gridEl.innerHTML = '';

    if (browseMode === 'search') {
      if (searchResults.length === 0) {
        const p = document.createElement('p');
        p.className = 'explorer-status';
        p.textContent = `No .ART files match "${lastSearchQuery}".`;
        gridEl.appendChild(p);
        paginationEl.hidden = true;
        return;
      }
      const size = effectivePageSize();
      const pageItems = searchResults.slice(filesOffset, filesOffset + size);
      for (const item of pageItems) {
        createFileCard(item.filename, item.relPath, item.folderName, { showPath: true });
      }
      updatePaginationBar();
      return;
    }

    if (folderFiles.length === 0) {
      const subfolders = (currentManifest && currentManifest.subfolders) || {};
      const keys = Object.keys(subfolders).sort();
      if (keys.length === 0) {
        const p = document.createElement('p');
        p.className = 'explorer-status';
        p.textContent = 'This folder is empty.';
        gridEl.appendChild(p);
      } else {
        keys.forEach(key => renderSubfolderCard(subfolders[key], folderRelPath));
      }
      paginationEl.hidden = true;
      return;
    }

    const pageFiles = folderFiles.slice(filesOffset, filesOffset + effectivePageSize());
    for (const filename of pageFiles) {
      createFileCard(filename, folderRelPath, currentFolderName);
    }

    updatePaginationBar();
  }

  function updatePaginationBar() {
    const total = currentItemCount();
    if (total <= PAGE_SIZE_OPTIONS[0]) {
      paginationEl.hidden = true;
      return;
    }
    const size = effectivePageSize();
    const shownEnd = Math.min(filesOffset + size, total);
    paginationStatusEl.textContent = `Showing ${filesOffset + 1}–${shownEnd} of ${total}`;
    backBtn.disabled = filesOffset === 0;
    nextBtn.disabled = shownEnd >= total;
    paginationEl.hidden = false;
  }

  nextBtn.addEventListener('click', () => {
    if (nextBtn.disabled) return;
    filesOffset += effectivePageSize();
    saveExplorerState();
    renderFilePage();
    gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  backBtn.addEventListener('click', () => {
    if (backBtn.disabled) return;
    filesOffset = Math.max(0, filesOffset - effectivePageSize());
    saveExplorerState();
    renderFilePage();
    gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  pageSizeSelect.addEventListener('change', () => {
    const v = pageSizeSelect.value;
    pageSize = v === 'all' ? 'all' : parseInt(v, 10);
    filesOffset = 0;
    saveExplorerState();
    renderFilePage();
  });

  document.addEventListener('keydown', (e) => {
    if (paginationEl.hidden) return;
    if (document.getElementById('gbOverlay').classList.contains('open')) return;
    if (document.getElementById('packerOverlay').classList.contains('open')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft' && !backBtn.disabled) {
      e.preventDefault();
      backBtn.click();
    } else if (e.key === 'ArrowRight' && !nextBtn.disabled) {
      e.preventDefault();
      nextBtn.click();
    }
  });

  async function loadArtFromServer(url, filename) {
    log(`decoding ${filename}…`);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const buf = await resp.arrayBuffer();
      const frames = await parseArtBuffer(buf);
      if (frames.length === 0) {
        log(`${filename}: header parsed but no drawable frames were found`, 'err');
        return;
      }
      log(`${filename}: extracted ${frames.length} frame${frames.length === 1 ? '' : 's'}`, 'ok');
      renderFileGroup(filename.replace(/\.art$/i, ''), frames, {
        folder: folderRelPath,
        folderName: currentFolderName,
        file: filename,
      }, buf);
      viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      log(`${filename}: ${err && err.message ? err.message : err}`, 'err');
    }
  }

  async function selectFolder(relativePath, folderName, rowEl) {
    saveExplorerState({ file: null });
    treeEl.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
    rowEl.classList.add('active');
    showBrowser();
    paginationEl.hidden = true;
    gridEl.innerHTML = '<p class="explorer-status">Loading…</p>';
    try {
      const manifest = await loadManifest(relativePath, folderName);
      renderGrid(manifest, relativePath, folderName);
    } catch (err) {
      gridEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'explorer-status err';
      p.textContent = err && err.message ? err.message : String(err);
      gridEl.appendChild(p);
    }
  }

  function joinPath(parentPath, childSegment) {
    return parentPath ? `${parentPath}/${childSegment}` : childSegment;
  }

  function renderTreeChildren(manifest, container, depth, parentRelativePath) {
    container.innerHTML = '';
    const subfolders = manifest.subfolders || {};
    Object.keys(subfolders).sort().forEach(key => {
      const sf = subfolders[key];
      const fullPath = joinPath(parentRelativePath, sf.relative_path);
      container.appendChild(createTreeNode(sf.folder_name, fullPath, depth));
    });
  }

  function createTreeNode(folderName, relativePath, depth) {
    const li = document.createElement('li');
    li.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.relpath = relativePath;
    row.style.paddingLeft = `${10 + depth * 16}px`;
    row.innerHTML = `<span class="tree-toggle">▶</span><span class="tree-icon">📁</span><span class="tree-name"></span>`;
    row.querySelector('.tree-name').textContent = folderName;
    li.appendChild(row);

    const childList = document.createElement('ul');
    childList.className = 'tree-children';
    li.appendChild(childList);

    let loaded = false;
    let expanded = false;

    row.addEventListener('click', async () => {
      selectFolder(relativePath, folderName, row);
      if (expanded) {
        childList.classList.remove('open');
        row.querySelector('.tree-toggle').textContent = '▶';
        expanded = false;
        return;
      }
      if (!loaded) {
        row.classList.add('loading');
        try {
          const manifest = await loadManifest(relativePath, folderName);
          renderTreeChildren(manifest, childList, depth + 1, relativePath);
          loaded = true;
        } catch (err) {
          log(`explorer: ${err && err.message ? err.message : err}`, 'err');
          row.classList.remove('loading');
          return;
        }
        row.classList.remove('loading');
      }
      childList.classList.add('open');
      row.querySelector('.tree-toggle').textContent = '▼';
      expanded = true;
    });

    return li;
  }

  function initExplorer(skipAutoOpen) {
    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    const rootNode = createTreeNode(ROOT_FOLDER_NAME, ROOT_RELATIVE_PATH, 0);
    rootUl.appendChild(rootNode);
    treeEl.appendChild(rootUl);
    if (!skipAutoOpen) rootNode.querySelector('.tree-row').click();
  }

  async function openDeepLink(target) {
    const manifest = await loadManifest(target.folder, target.folderName);
    renderGrid(manifest, target.folder, target.folderName);

    const idx = folderFiles.indexOf(target.file);
    if (idx === -1) {
      log(`share link: "${target.file}" wasn't found in that folder`, 'err');
      return;
    }
    const size = effectivePageSize();
    filesOffset = Math.floor(idx / size) * size;
    saveExplorerState({ file: target.file });
    renderFilePage();

    const folderPrefix = target.folder ? `${target.folder}/` : '';
    const artUrl = `${ART_ROOT}${folderPrefix}${target.file}`;
    await loadArtFromServer(artUrl, target.file);
  }

  // The landing page is intentionally minimal: no explorer, search, local drop zone, or log.
  document.body.classList.add('home-active');
  showExplorerHome();

  const deepLinkTarget = parseDeepLink();
  const savedExplorerState = loadExplorerState();
  if (savedExplorerState && [50, 100, 200, 'all'].includes(savedExplorerState.pageSize)) {
    pageSize = savedExplorerState.pageSize;
    pageSizeSelect.value = String(pageSize);
  }
  if (deepLinkTarget) {
    if (manualLoadEl) manualLoadEl.hidden = false;
    if (logEl) logEl.hidden = false;
    if (footerNoteEl) footerNoteEl.hidden = false;
    document.querySelector('.explorer').hidden = false;
    explorerHome.hidden = true;
    initExplorer(true);
    openDeepLink(deepLinkTarget).catch(err => {
      log(`share link: couldn't open — ${err && err.message ? err.message : err}`, 'err');
      const rootRow = treeEl.querySelector('.tree-row');
      if (rootRow) rootRow.click();
    });
  }

  // Saved .PRO/.MOB positions remain stored, but the app now opens on the file-type home screen.


  // ---- Drop zone wiring ---------------------------------------------------

  function wireDropzone(zoneEl, inputEl, onFiles) {
    zoneEl.addEventListener('click', () => inputEl.click());
    zoneEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        inputEl.click();
      }
    });
    inputEl.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) onFiles(e.target.files);
      inputEl.value = '';
    });

    ['dragenter', 'dragover'].forEach(evt =>
      zoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        zoneEl.classList.add('dragging');
      })
    );
    ['dragleave', 'drop'].forEach(evt =>
      zoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        zoneEl.classList.remove('dragging');
      })
    );
    zoneEl.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        onFiles(e.dataTransfer.files);
      }
    });
  }

  wireDropzone(dropzone, fileInput, handleFiles);
  wireDropzone(packerDropzoneEl, packerFileInputEl, handlePackerFiles);

  // ---- Text table search (/semes/, /dlg/, /mes/, /oemes/, /Rules/) --------
  //
  // Each of these root folders is expected to carry the same
  // "<foldername>_manifest.json" convention (with an optional generic
  // "manifest.json" fallback and optional "subfolders", exactly like the
  // ART/PRO/MOB explorers above). This walks every listed file across all
  // five roots and applies the same matching + {dialog} cleanup rules as
  // research.py: an exact, case-sensitive substring match against each raw
  // line, with empty/numeric/duplicate-per-file {tokens} stripped out.

  const TEXT_TABLE_ROOTS = [
    { key: 'semes', root: 'semes/', folderName: 'semes' },
    { key: 'dlg', root: 'dlg/', folderName: 'dlg' },
    { key: 'mes', root: 'mes/', folderName: 'mes' },
    { key: 'oemes', root: 'oemes/', folderName: 'oemes' },
    { key: 'rules', root: 'Rules/', folderName: 'Rules' },
  ];

  const TEXT_SEARCH_MATCH_LIMIT = 2000;
  const TEXT_SEARCH_CONCURRENCY = 8;

  const textTableManifestCache = new Map(); // "root::relativePath" -> parsed manifest json
  let textTableFileIndexPromise = null;

  function textTableManifestUrls(root, relativePath, folderName) {
    const prefix = relativePath ? `${root}${relativePath}/` : root;
    return [`${prefix}${folderName}_manifest.json`, `${prefix}manifest.json`];
  }

  async function loadTextTableManifest(root, relativePath, folderName) {
    const cacheKey = `${root}::${relativePath}`;
    if (textTableManifestCache.has(cacheKey)) return textTableManifestCache.get(cacheKey);
    const urls = textTableManifestUrls(root, relativePath, folderName);
    let lastErr = null;
    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status} for ${url}`); continue; }
        const data = await resp.json();
        textTableManifestCache.set(cacheKey, data);
        return data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`couldn't load a manifest for ${root}${relativePath}`);
  }

  async function collectTextTableRootFiles(rootDef, relativePath, folderName, out, visited) {
    const visitKey = `${rootDef.key}::${relativePath}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    let manifest;
    try {
      manifest = await loadTextTableManifest(rootDef.root, relativePath, folderName);
    } catch (err) {
      out.errors.push(`${rootDef.root}${relativePath ? relativePath + '/' : ''}: ${err && err.message ? err.message : err}`);
      return;
    }

    const rootLabel = rootDef.root.replace(/\/$/, '');
    const folderDisplay = relativePath ? `${rootLabel}/${relativePath}` : rootLabel;

    const files = manifest.files || [];
    for (const f of files) {
      out.files.push({
        root: rootDef.root,
        relPath: relativePath,
        filename: f,
        folderDisplay,
        filePath: `${folderDisplay}/${f}`,
      });
    }

    const subfolders = manifest.subfolders || {};
    const keys = Object.keys(subfolders).sort();
    for (const key of keys) {
      const sf = subfolders[key];
      await collectTextTableRootFiles(rootDef, joinPath(relativePath, sf.relative_path), sf.folder_name, out, visited);
    }
  }

  function buildTextTableFileIndex() {
    if (!textTableFileIndexPromise) {
      textTableFileIndexPromise = (async () => {
        const out = { files: [], errors: [] };
        await Promise.all(TEXT_TABLE_ROOTS.map(rootDef =>
          collectTextTableRootFiles(rootDef, '', rootDef.folderName, out, new Set())
        ));
        return out;
      })().catch(err => {
        // Let the next search attempt retry from scratch instead of caching a failure.
        textTableFileIndexPromise = null;
        throw err;
      });
    }
    return textTableFileIndexPromise;
  }

  async function poolRun(items, limit, worker) {
    let i = 0;
    const n = Math.max(1, Math.min(limit, items.length));
    const runners = new Array(n).fill(0).map(async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx]);
      }
    });
    await Promise.all(runners);
  }

  // Mirrors research.py's process_dialog(): strips empty, purely-numeric,
  // and (per-file) duplicate {tokens}; a line with no brackets is left as-is.
  function processTextTableLine(rawLine, seenDialogsForFile) {
    const clean = rawLine.trim();
    if (!clean) return null;
    const hasBrackets = /\{[^}]*\}/.test(clean);
    let hasValidContent = !hasBrackets;
    const modified = clean.replace(/\{([^}]*)\}/g, (match, inner) => {
      const stripped = inner.trim();
      if (!stripped) return '';
      if (/^\d+$/.test(stripped)) return '';
      if (seenDialogsForFile.has(stripped)) return '';
      seenDialogsForFile.add(stripped);
      hasValidContent = true;
      return stripped;
    });
    const collapsed = modified.replace(/\s+/g, ' ').trim();
    return (hasValidContent && collapsed) ? collapsed : null;
  }

  async function runTextTableSearch(rawQuery) {
    const query = rawQuery || '';
    if (!query.trim()) {
      tsStatusEl.textContent = 'Search expression cannot be empty.';
      tsResultsEl.textContent = '';
      return;
    }

    tsSearchBtnEl.disabled = true;
    tsStatusEl.textContent = `Searching for "${query}" in /semes/, /dlg/, /mes/, /oemes/ and /Rules/…`;
    tsResultsEl.textContent = '';

    try {
      const index = await buildTextTableFileIndex();
      const folderGroups = new Map(); // folderDisplay -> Map(filePath -> [{lineNum, text}])
      const readErrors = index.errors.slice();
      let matchCount = 0;
      let capped = false;

      await poolRun(index.files, TEXT_SEARCH_CONCURRENCY, async (entry) => {
        if (capped) return;
        let text;
        try {
          const resp = await fetch(`${entry.root}${entry.relPath ? entry.relPath + '/' : ''}${entry.filename}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          text = await resp.text();
        } catch (err) {
          readErrors.push(`${entry.filePath}: ${err && err.message ? err.message : err}`);
          return;
        }

        const seenDialogsForFile = new Set();
        const rawLines = text.split(/\r\n|\r|\n/);
        const fileMatches = [];
        for (let i = 0; i < rawLines.length; i++) {
          if (capped) break;
          const rawLine = rawLines[i];
          if (!rawLine.includes(query)) continue;
          const processed = processTextTableLine(rawLine, seenDialogsForFile);
          if (processed === null) continue;
          fileMatches.push({ lineNum: i + 1, text: processed });
          matchCount++;
          if (matchCount >= TEXT_SEARCH_MATCH_LIMIT) capped = true;
        }

        if (fileMatches.length) {
          if (!folderGroups.has(entry.folderDisplay)) folderGroups.set(entry.folderDisplay, new Map());
          folderGroups.get(entry.folderDisplay).set(entry.filePath, fileMatches);
        }
      });

      renderTextTableResults(query, folderGroups, readErrors, capped);
    } catch (err) {
      tsStatusEl.textContent = `Search failed: ${err && err.message ? err.message : err}`;
    } finally {
      tsSearchBtnEl.disabled = false;
    }
  }

  function renderTextTableResults(query, folderGroups, errors, capped) {
    const folders = Array.from(folderGroups.keys()).sort((a, b) => a.localeCompare(b));
    let totalFiles = 0;
    let totalMatches = 0;
    const lines = [];

    if (folders.length === 0) {
      lines.push('No matches found.');
    } else {
      for (const folder of folders) {
        lines.push('='.repeat(60));
        lines.push(`📁 FOLDER: ${folder}`);
        lines.push('='.repeat(60));
        const filesMap = folderGroups.get(folder);
        const filePaths = Array.from(filesMap.keys()).sort((a, b) => a.localeCompare(b));
        for (const filePath of filePaths) {
          totalFiles++;
          lines.push(`[MATCH] ${filePath}`);
          for (const m of filesMap.get(filePath)) {
            totalMatches++;
            lines.push(`[LINE ${m.lineNum}]: ${m.text}`);
          }
          lines.push('');
        }
        lines.push('');
      }
      if (capped) lines.push(`… output capped at ${TEXT_SEARCH_MATCH_LIMIT} matches — refine your search for more.`);
    }

    tsResultsEl.textContent = lines.join('\n');

    const summary = folders.length
      ? `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${totalFiles} file${totalFiles === 1 ? '' : 's'} across ${folders.length} folder${folders.length === 1 ? '' : 's'} for "${query}"${capped ? ' (capped)' : ''}`
      : `No matches for "${query}".`;
    tsStatusEl.textContent = errors.length
      ? `${summary} — ${errors.length} file${errors.length === 1 ? '' : 's'} couldn't be read.`
      : summary;
  }

  const textTableSearchBtnEl = document.getElementById('textTableSearchBtn');
  const textSearchOverlayEl = document.getElementById('textSearchOverlay');
  const tsCloseBtnEl = document.getElementById('tsClose');
  const tsInputEl = document.getElementById('tsInput');
  const tsSearchBtnEl = document.getElementById('tsSearchBtn');
  const tsStatusEl = document.getElementById('tsStatus');
  const tsResultsEl = document.getElementById('tsResults');

  function openTextTableSearch() {
    textSearchOverlayEl.classList.add('open');
    tsInputEl.focus();
  }

  function closeTextTableSearch() {
    textSearchOverlayEl.classList.remove('open');
  }

  if (textTableSearchBtnEl) {
    textTableSearchBtnEl.addEventListener('click', openTextTableSearch);
  }
  tsCloseBtnEl.addEventListener('click', closeTextTableSearch);
  textSearchOverlayEl.addEventListener('click', (e) => {
    if (e.target === textSearchOverlayEl) closeTextTableSearch();
  });
  document.addEventListener('keydown', (e) => {
    if (!textSearchOverlayEl.classList.contains('open')) return;
    if (e.key === 'Escape') closeTextTableSearch();
  });
  tsSearchBtnEl.addEventListener('click', () => runTextTableSearch(tsInputEl.value));
  tsInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runTextTableSearch(tsInputEl.value);
    }
  });
})();
