(function () {
  "use strict";

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const logEl = document.getElementById('log');
  const viewerEl = document.getElementById('explorerViewer');

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

  const paginationEl = document.getElementById('explorerPagination');
  const paginationStatusEl = document.getElementById('explorerPaginationStatus');
  const nextBtn = document.getElementById('explorerLoadMoreBtn');
  const backBtn = document.getElementById('explorerBackBtn');
  const pageSizeSelect = document.getElementById('explorerPageSize');
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
    breadcrumbEl.textContent = `/${folderRelPath}`.replace(/\/+/g, '/') || '/';
    renderFilePage();
  }

  searchBtnEl.addEventListener('click', () => runSearch(searchInputEl.value));
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch(searchInputEl.value);
    }
  });
  searchClearBtnEl.addEventListener('click', clearSearch);

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
    renderFilePage();
    gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  backBtn.addEventListener('click', () => {
    if (backBtn.disabled) return;
    filesOffset = Math.max(0, filesOffset - effectivePageSize());
    renderFilePage();
    gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  pageSizeSelect.addEventListener('change', () => {
    const v = pageSizeSelect.value;
    pageSize = v === 'all' ? 'all' : parseInt(v, 10);
    filesOffset = 0;
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
    renderFilePage();

    const folderPrefix = target.folder ? `${target.folder}/` : '';
    const artUrl = `${ART_ROOT}${folderPrefix}${target.file}`;
    await loadArtFromServer(artUrl, target.file);
  }

  const deepLinkTarget = parseDeepLink();
  initExplorer(!!deepLinkTarget);
  if (deepLinkTarget) {
    openDeepLink(deepLinkTarget).catch(err => {
      log(`share link: couldn't open — ${err && err.message ? err.message : err}`, 'err');
      const rootRow = treeEl.querySelector('.tree-row');
      if (rootRow) rootRow.click();
    });
  }

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
})();
