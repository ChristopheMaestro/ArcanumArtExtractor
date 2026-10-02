(function () {
  "use strict";

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const logEl = document.getElementById('log');
  const manualLoadEl = document.querySelector('.manual-load');
  const footerNoteEl = document.querySelector('footer.note');
  const viewerEl = document.getElementById('explorerViewer');
  const DATA_ROOT = 'data/';

  // Reads a canvas's pixels without triggering Chrome's "Multiple readback
  // operations using getImageData" warning. That warning fires when a canvas
  // that was created WITHOUT willReadFrequently is read back repeatedly (once
  // per wall sprite, hundreds of times). The sprite canvases are drawn to the
  // map every frame, so they stay GPU-friendly; instead the pixels are copied
  // once into a shared scratch canvas created with willReadFrequently:true and
  // read from there. The full ImageData is cached per source canvas.
  const canvasPixelCache = new WeakMap();
  let pixelScratch = null;
  function readCanvasPixels(canvas) {
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
  let explorerMode = 'art';

  // ---- Collapsible left sidebar ---------------------------------------------
  // Hides the folder tree so the map viewer can use the full page width.
  (function initSidebarToggle() {
    const explorer = document.querySelector('section.explorer');
    const btn = document.getElementById('sidebarToggleBtn');
    if (!explorer || !btn) return;
    const KEY = 'arcanum.sidebarCollapsed';
    const apply = (collapsed) => {
      explorer.classList.toggle('sidebar-collapsed', collapsed);
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed ? '▶ Show sidebar' : '◀ Hide sidebar';
      btn.title = collapsed ? 'Show the folder sidebar' : 'Hide the folder sidebar to enlarge the viewer';
      // Canvases listen to their own size (ResizeObserver); this covers the rest.
      window.dispatchEvent(new Event('resize'));
    };
    let collapsed = false;
    try { collapsed = localStorage.getItem(KEY) === '1'; } catch (_) {}
    apply(collapsed);
    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) {}
      apply(collapsed);
    });
  })();

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

  // Refuse frames whose pixel buffer would be absurd; a corrupt header could
  // otherwise ask for gigabytes.
  const MAX_FRAME_PIXELS = 1 << 26;

  // Encode each path segment so names containing #, ?, % or spaces survive
  // being put into a URL. Slashes are kept as separators.
  function encPath(p) {
    return String(p ?? '').split('/').map(encodeURIComponent).join('/');
  }

  // ART header: how many 1 KB palettes follow the 0x84-byte header. One shared
  // rule for the parser, the packer's template reader and the hex viewer.
  // `flags` are the four uint32 presence values at 0x0C..0x18.
  function artPaletteCount(flags) {
    if (flags[3] !== 0) return 4;
    if (flags[2] !== 0) return 3;
    if (flags[1] !== 0) return 2;
    return 1;
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

  async function parseArtFile(file) {
    const buf = await file.arrayBuffer();
    const frames = await parseArtBuffer(buf);
    return { frames, buf };
  }

  async function parseArtBuffer(buf, maxFrames = Infinity) {
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
    for (let idx = 0; idx < imageInfos.length && frames.length < maxFrames; idx++) {
      const { width: w, height: h, size: compressedSize } = imageInfos[idx];
      if (w === 0 || h === 0) continue;

      if (offset + compressedSize > buf.byteLength) {
        throw new Error(`frame ${idx} pixel data runs past the end of the file`);
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
    const folder = params.get('folder') || '';
    const folderName = params.get('folderName') || ROOT_FOLDER_NAME;
    // Share links come from the address bar: never let them climb out of art/.
    const unsafe = (s) => /^[\\/]/.test(s) || s.split(/[\\/]/).some(seg => seg === '..');
    if (unsafe(folder) || unsafe(folderName) || unsafe(file)) return null;
    return { folder, folderName, file };
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
        const resp = await fetch(`${ART_ROOT}${encPath(prefix)}${encPath(filename)}`);
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
    if (!resp.ok) throw new Error(`couldn't load the GIF worker script (HTTP ${resp.status})`);
    const text = await resp.text();
    gifWorkerUrl = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
    return gifWorkerUrl;
  }

  // GIF has one transparent colour. Pick a key that no included frame uses
  // (and that is far from the colours they do use, since the encoder matches
  // by nearest palette entry) instead of always sacrificing pure magenta.
  function pickGifTransparentKey(frames) {
    const used = new Set();
    for (const f of frames) {
      const c = f.ref.canvas;
      if (!c.width || !c.height) continue;
      const px = readCanvasPixels(c); if (!px) continue;
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) used.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        if (used.size > 20000) break;
      }
    }
    const usedList = Array.from(used);
    const candidates = [0xFF00FF, 0x00FFFF, 0xFFFF00, 0x00FF00, 0xFF0000, 0x0000FF, 0x7F007F, 0x007F7F, 0x7F7F00];
    let best = candidates[0], bestDist = -1;
    for (const cand of candidates) {
      const cr = cand >> 16, cg = (cand >> 8) & 255, cb = cand & 255;
      let min = Infinity;
      for (const u of usedList) {
        const dr = (u >> 16) - cr, dg = ((u >> 8) & 255) - cg, db = (u & 255) - cb;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < min) min = dist;
        if (min <= bestDist) break;
      }
      if (min > bestDist) { bestDist = min; best = cand; }
    }
    return best;
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
      const keyColor = pickGifTransparentKey(included);
      const keyCss = '#' + keyColor.toString(16).padStart(6, '0');
      const gif = new GIF({
        workers: 2,
        quality: 10,
        width,
        height,
        transparent: keyColor,
        workerScript,
        repeat: gifState.loop ? 0 : -1,
      });

      for (const f of included) {
        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = width;
        frameCanvas.height = height;
        const ctx = frameCanvas.getContext('2d');
        ctx.fillStyle = keyCss;
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

      const resultImg = document.getElementById('gbResultImg');
      if (resultImg.src && resultImg.src.startsWith('blob:')) URL.revokeObjectURL(resultImg.src);
      const url = URL.createObjectURL(blob);
      resultImg.src = url;
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
    if (paletteFlags.filter(v => v !== 0).length !== paletteCount) {
      warnings.push(`Palette presence flags are not contiguous from P0 (or all zero); the parser assumes ${paletteCount} palette${paletteCount === 1 ? '' : 's'}.`);
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
    // A compressed length that coincidentally equals the raw pixel count would
    // make the decoder treat this chunk as "stored uncompressed". Break the tie
    // by splitting the first repeat token [n, v] into [1, v][n-1, v]: identical
    // pixels, two bytes longer, so the length can no longer match.
    for (let p = 0; p < out.length;) {
      const control = out[p];
      const n = control & 0x7F;
      if ((control & 0x80) === 0) {
        if (n >= 2) {
          const r = new Uint8Array(out.length + 2);
          r.set(out.subarray(0, p), 0);
          r[p] = 1; r[p + 1] = out[p + 1];
          r[p + 2] = n - 1; r[p + 3] = out[p + 1];
          r.set(out.subarray(p + 2), p + 4);
          return r;
        }
        p += 2;
      } else {
        p += 1 + n;
      }
    }
    // Only literals, no repeats: a raw-length tie is impossible here (literal
    // tokens always add one control byte per <=127 pixels), so this is unreachable.
    return out;
  }

  function readArtTemplate(buf) {
    if (buf.byteLength < 0x84) throw new Error('reference file is too small to be a valid .art file');
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const head = [];
    for (let i = 0; i < 33; i++) head.push(view.getUint32(i * 4, true));

    const paletteCount = artPaletteCount([head[3], head[4], head[5], head[6]]);

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
  // MOB and SEC files are described by the single root maps manifest.
  const MOB_ROOT = `${DATA_ROOT}maps/`;
  const MOB_OD_NAMES = {"0":"Invalid","1":"Begin","2":"End","3":"Int32","4":"Int64","5":"String","6":"Handle","7":"Int32Array","8":"Int64Array","9":"UInt32Array","10":"UInt64Array","11":"ScriptArray","12":"QuestArray","13":"HandleArray","14":"Ptr","15":"PtrArray"};
  const MOB_OD_TYPES = [1,3,4,3,3,3,9,9,9,3,3,3,3,3,3,3,9,9,9,3,3,3,3,3,3,3,3,3,3,3,3,7,11,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,3,13,3,3,3,3,9,10,2,1,3,6,3,3,9,10,2,1,3,3,3,6,3,3,9,10,2,1,3,6,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,7,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,3,3,3,3,9,10,2,1,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,9,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,7,7,7,9,3,3,3,3,9,9,6,3,6,6,6,6,6,3,13,3,3,13,4,3,3,3,3,3,3,9,10,2,1,3,3,9,10,3,3,12,9,10,9,10,3,10,9,9,9,3,5,3,9,9,3,3,9,10,2,1,3,6,3,6,6,3,3,10,3,4,4,3,3,3,6,3,3,13,9,9,3,3,3,9,13,2,1,3,3,3,9,10,2];
  const MOB_GROUP_BEGIN = [0,38,45,55,68,76,86,111,140,149,163,171,178,185,192,200,210,217,252,279,306];
  const MOB_GROUP_PARENT_LAST = [-1,36,36,36,36,36,36,109,109,109,109,109,109,109,109,109,109,36,250,250,36];
  const MOB_TYPE_RANGE_BEGIN = [38,45,55,68,76,86,111,86,140,86,149,86,163,86,171,86,178,86,185,86,192,86,200,86,210,217,252,217,279,306];
  const MOB_TYPE_RANGE_END = [44,54,67,75,85,110,139,110,148,110,162,110,170,110,177,110,184,110,191,110,199,110,209,110,216,251,278,251,305,312];
  const MOB_TYPE_RANGE_OFFSET = [0,1,2,3,4,5,7,9,11,13,15,17,19,21,23,25,27,29,30];
  const MOB_TYPE_LAST_FIELD = [43,53,66,74,84,138,147,161,169,176,183,190,198,208,215,277,304,311];
  // Generated from game/obj.h (OBJ_F_* enum order) and game/obj_flags.h (the
  // obj_flags_fields_lookup_tbl mapping of flag sets to fields). Names are the
  // game's own field names; regenerate rather than editing by hand.
  const MOB_FIELD_NAMES = {"1":"F_CURRENT_AID","2":"F_LOCATION","3":"F_OFFSET_X","4":"F_OFFSET_Y","5":"F_SHADOW","6":"F_OVERLAY_FORE","7":"F_OVERLAY_BACK","8":"F_UNDERLAY","9":"F_BLIT_FLAGS","10":"F_BLIT_COLOR","11":"F_BLIT_ALPHA","12":"F_BLIT_SCALE","13":"F_LIGHT_FLAGS","14":"F_LIGHT_AID","15":"F_LIGHT_COLOR","16":"F_OVERLAY_LIGHT_FLAGS","17":"F_OVERLAY_LIGHT_AID","18":"F_OVERLAY_LIGHT_COLOR","19":"F_FLAGS","20":"F_SPELL_FLAGS","21":"F_BLOCKING_MASK","22":"F_NAME","23":"F_DESCRIPTION","24":"F_AID","25":"F_DESTROYED_AID","26":"F_AC","27":"F_HP_PTS","28":"F_HP_ADJ","29":"F_HP_DAMAGE","30":"F_MATERIAL","31":"F_RESISTANCE_IDX","32":"F_SCRIPTS_IDX","33":"F_SOUND_EFFECT","34":"F_CATEGORY","35":"F_PAD_IAS_1","36":"F_PAD_I64AS_1","39":"F_WALL_FLAGS","40":"F_WALL_PAD_I_1","41":"F_WALL_PAD_I_2","42":"F_WALL_PAD_IAS_1","43":"F_WALL_PAD_I64AS_1","46":"F_PORTAL_FLAGS","47":"F_PORTAL_LOCK_DIFFICULTY","48":"F_PORTAL_KEY_ID","49":"F_PORTAL_NOTIFY_NPC","50":"F_PORTAL_PAD_I_1","51":"F_PORTAL_PAD_I_2","52":"F_PORTAL_PAD_IAS_1","53":"F_PORTAL_PAD_I64AS_1","56":"F_CONTAINER_FLAGS","57":"F_CONTAINER_LOCK_DIFFICULTY","58":"F_CONTAINER_KEY_ID","59":"F_CONTAINER_INVENTORY_NUM","60":"F_CONTAINER_INVENTORY_LIST_IDX","61":"F_CONTAINER_INVENTORY_SOURCE","62":"F_CONTAINER_NOTIFY_NPC","63":"F_CONTAINER_PAD_I_1","64":"F_CONTAINER_PAD_I_2","65":"F_CONTAINER_PAD_IAS_1","66":"F_CONTAINER_PAD_I64AS_1","69":"F_SCENERY_FLAGS","70":"F_SCENERY_WHOS_IN_ME","71":"F_SCENERY_RESPAWN_DELAY","72":"F_SCENERY_PAD_I_2","73":"F_SCENERY_PAD_IAS_1","74":"F_SCENERY_PAD_I64AS_1","77":"F_PROJECTILE_FLAGS_COMBAT","78":"F_PROJECTILE_FLAGS_COMBAT_DAMAGE","79":"F_PROJECTILE_HIT_LOC","80":"F_PROJECTILE_PARENT_WEAPON","81":"F_PROJECTILE_PAD_I_1","82":"F_PROJECTILE_PAD_I_2","83":"F_PROJECTILE_PAD_IAS_1","84":"F_PROJECTILE_PAD_I64AS_1","87":"F_ITEM_FLAGS","88":"F_ITEM_PARENT","89":"F_ITEM_WEIGHT","90":"F_ITEM_MAGIC_WEIGHT_ADJ","91":"F_ITEM_WORTH","92":"F_ITEM_MANA_STORE","93":"F_ITEM_INV_AID","94":"F_ITEM_INV_LOCATION","95":"F_ITEM_USE_AID_FRAGMENT","96":"F_ITEM_MAGIC_TECH_COMPLEXITY","97":"F_ITEM_DISCIPLINE","98":"F_ITEM_DESCRIPTION_UNKNOWN","99":"F_ITEM_DESCRIPTION_EFFECTS","100":"F_ITEM_SPELL_1","101":"F_ITEM_SPELL_2","102":"F_ITEM_SPELL_3","103":"F_ITEM_SPELL_4","104":"F_ITEM_SPELL_5","105":"F_ITEM_SPELL_MANA_STORE","106":"F_ITEM_AI_ACTION","107":"F_ITEM_PAD_I_1","108":"F_ITEM_PAD_IAS_1","109":"F_ITEM_PAD_I64AS_1","112":"F_WEAPON_FLAGS","113":"F_WEAPON_PAPER_DOLL_AID","114":"F_WEAPON_BONUS_TO_HIT","115":"F_WEAPON_MAGIC_HIT_ADJ","116":"F_WEAPON_DAMAGE_LOWER_IDX","117":"F_WEAPON_DAMAGE_UPPER_IDX","118":"F_WEAPON_MAGIC_DAMAGE_ADJ_IDX","119":"F_WEAPON_SPEED_FACTOR","120":"F_WEAPON_MAGIC_SPEED_ADJ","121":"F_WEAPON_RANGE","122":"F_WEAPON_MAGIC_RANGE_ADJ","123":"F_WEAPON_MIN_STRENGTH","124":"F_WEAPON_MAGIC_MIN_STRENGTH_ADJ","125":"F_WEAPON_AMMO_TYPE","126":"F_WEAPON_AMMO_CONSUMPTION","127":"F_WEAPON_MISSILE_AID","128":"F_WEAPON_VISUAL_EFFECT_AID","129":"F_WEAPON_CRIT_HIT_CHART","130":"F_WEAPON_MAGIC_CRIT_HIT_CHANCE","131":"F_WEAPON_MAGIC_CRIT_HIT_EFFECT","132":"F_WEAPON_CRIT_MISS_CHART","133":"F_WEAPON_MAGIC_CRIT_MISS_CHANCE","134":"F_WEAPON_MAGIC_CRIT_MISS_EFFECT","135":"F_WEAPON_PAD_I_1","136":"F_WEAPON_PAD_I_2","137":"F_WEAPON_PAD_IAS_1","138":"F_WEAPON_PAD_I64AS_1","141":"F_AMMO_FLAGS","142":"F_AMMO_QUANTITY","143":"F_AMMO_TYPE","144":"F_AMMO_PAD_I_1","145":"F_AMMO_PAD_I_2","146":"F_AMMO_PAD_IAS_1","147":"F_AMMO_PAD_I64AS_1","150":"F_ARMOR_FLAGS","151":"F_ARMOR_PAPER_DOLL_AID","152":"F_ARMOR_AC_ADJ","153":"F_ARMOR_MAGIC_AC_ADJ","154":"F_ARMOR_RESISTANCE_ADJ_IDX","155":"F_ARMOR_MAGIC_RESISTANCE_ADJ_IDX","156":"F_ARMOR_SILENT_MOVE_ADJ","157":"F_ARMOR_MAGIC_SILENT_MOVE_ADJ","158":"F_ARMOR_UNARMED_BONUS_DAMAGE","159":"F_ARMOR_PAD_I_2","160":"F_ARMOR_PAD_IAS_1","161":"F_ARMOR_PAD_I64AS_1","164":"F_GOLD_FLAGS","165":"F_GOLD_QUANTITY","166":"F_GOLD_PAD_I_1","167":"F_GOLD_PAD_I_2","168":"F_GOLD_PAD_IAS_1","169":"F_GOLD_PAD_I64AS_1","172":"F_FOOD_FLAGS","173":"F_FOOD_PAD_I_1","174":"F_FOOD_PAD_I_2","175":"F_FOOD_PAD_IAS_1","176":"F_FOOD_PAD_I64AS_1","179":"F_SCROLL_FLAGS","180":"F_SCROLL_PAD_I_1","181":"F_SCROLL_PAD_I_2","182":"F_SCROLL_PAD_IAS_1","183":"F_SCROLL_PAD_I64AS_1","186":"F_KEY_KEY_ID","187":"F_KEY_PAD_I_1","188":"F_KEY_PAD_I_2","189":"F_KEY_PAD_IAS_1","190":"F_KEY_PAD_I64AS_1","193":"F_KEY_RING_FLAGS","194":"F_KEY_RING_LIST_IDX","195":"F_KEY_RING_PAD_I_1","196":"F_KEY_RING_PAD_I_2","197":"F_KEY_RING_PAD_IAS_1","198":"F_KEY_RING_PAD_I64AS_1","201":"F_WRITTEN_FLAGS","202":"F_WRITTEN_SUBTYPE","203":"F_WRITTEN_TEXT_START_LINE","204":"F_WRITTEN_TEXT_END_LINE","205":"F_WRITTEN_PAD_I_1","206":"F_WRITTEN_PAD_I_2","207":"F_WRITTEN_PAD_IAS_1","208":"F_WRITTEN_PAD_I64AS_1","211":"F_GENERIC_FLAGS","212":"F_GENERIC_USAGE_BONUS","213":"F_GENERIC_USAGE_COUNT_REMAINING","214":"F_GENERIC_PAD_IAS_1","215":"F_GENERIC_PAD_I64AS_1","218":"F_CRITTER_FLAGS","219":"F_CRITTER_FLAGS2","220":"F_CRITTER_STAT_BASE_IDX","221":"F_CRITTER_BASIC_SKILL_IDX","222":"F_CRITTER_TECH_SKILL_IDX","223":"F_CRITTER_SPELL_TECH_IDX","224":"F_CRITTER_FATIGUE_PTS","225":"F_CRITTER_FATIGUE_ADJ","226":"F_CRITTER_FATIGUE_DAMAGE","227":"F_CRITTER_CRIT_HIT_CHART","228":"F_CRITTER_EFFECTS_IDX","229":"F_CRITTER_EFFECT_CAUSE_IDX","230":"F_CRITTER_FLEEING_FROM","231":"F_CRITTER_PORTRAIT","232":"F_CRITTER_GOLD","233":"F_CRITTER_ARROWS","234":"F_CRITTER_BULLETS","235":"F_CRITTER_POWER_CELLS","236":"F_CRITTER_FUEL","237":"F_CRITTER_INVENTORY_NUM","238":"F_CRITTER_INVENTORY_LIST_IDX","239":"F_CRITTER_INVENTORY_SOURCE","240":"F_CRITTER_DESCRIPTION_UNKNOWN","241":"F_CRITTER_FOLLOWER_IDX","242":"F_CRITTER_TELEPORT_DEST","243":"F_CRITTER_TELEPORT_MAP","244":"F_CRITTER_DEATH_TIME","245":"F_CRITTER_AUTO_LEVEL_SCHEME","246":"F_CRITTER_PAD_I_1","247":"F_CRITTER_PAD_I_2","248":"F_CRITTER_PAD_I_3","249":"F_CRITTER_PAD_IAS_1","250":"F_CRITTER_PAD_I64AS_1","253":"F_PC_FLAGS","254":"F_PC_FLAGS_FATE","255":"F_PC_REPUTATION_IDX","256":"F_PC_REPUTATION_TS_IDX","257":"F_PC_BACKGROUND","258":"F_PC_BACKGROUND_TEXT","259":"F_PC_QUEST_IDX","260":"F_PC_BLESSING_IDX","261":"F_PC_BLESSING_TS_IDX","262":"F_PC_CURSE_IDX","263":"F_PC_CURSE_TS_IDX","264":"F_PC_PARTY_ID","265":"F_PC_RUMOR_IDX","266":"F_PC_PAD_IAS_2","267":"F_PC_SCHEMATICS_FOUND_IDX","268":"F_PC_LOGBOOK_EGO_IDX","269":"F_PC_FOG_MASK","270":"F_PC_PLAYER_NAME","271":"F_PC_BANK_MONEY","272":"F_PC_GLOBAL_FLAGS","273":"F_PC_GLOBAL_VARIABLES","274":"F_PC_PAD_I_1","275":"F_PC_PAD_I_2","276":"F_PC_PAD_IAS_1","277":"F_PC_PAD_I64AS_1","280":"F_NPC_FLAGS","281":"F_NPC_LEADER","282":"F_NPC_AI_DATA","283":"F_NPC_COMBAT_FOCUS","284":"F_NPC_WHO_HIT_ME_LAST","285":"F_NPC_EXPERIENCE_WORTH","286":"F_NPC_EXPERIENCE_POOL","287":"F_NPC_WAYPOINTS_IDX","288":"F_NPC_WAYPOINT_CURRENT","289":"F_NPC_STANDPOINT_DAY","290":"F_NPC_STANDPOINT_NIGHT","291":"F_NPC_ORIGIN","292":"F_NPC_FACTION","293":"F_NPC_RETAIL_PRICE_MULTIPLIER","294":"F_NPC_SUBSTITUTE_INVENTORY","295":"F_NPC_REACTION_BASE","296":"F_NPC_SOCIAL_CLASS","297":"F_NPC_REACTION_PC_IDX","298":"F_NPC_REACTION_LEVEL_IDX","299":"F_NPC_REACTION_TIME_IDX","300":"F_NPC_WAIT","301":"F_NPC_GENERATOR_DATA","302":"F_NPC_PAD_I_1","303":"F_NPC_DAMAGE_IDX","304":"F_NPC_SHIT_LIST_IDX","307":"F_TRAP_FLAGS","308":"F_TRAP_DIFFICULTY","309":"F_TRAP_PAD_I_2","310":"F_TRAP_PAD_IAS_1","311":"F_TRAP_PAD_I64AS_1"};

  // Bit-flag breakdowns, one entry per flag-bearing field, with the masks taken
  // straight from the game's #defines (names are the C names in CamelCase).
  const MOB_FLAG_BITS = {
    19: [ // F_FLAGS (OF_*)
      [0x00000001, 'Destroyed'],
      [0x00000002, 'Off'],
      [0x00000004, 'Flat'],
      [0x00000008, 'Text'],
      [0x00000010, 'SeeThrough'],
      [0x00000020, 'ShootThrough'],
      [0x00000040, 'Translucent'],
      [0x00000080, 'Shrunk'],
      [0x00000100, 'Dontdraw'],
      [0x00000200, 'Invisible'],
      [0x00000400, 'NoBlock'],
      [0x00000800, 'ClickThrough'],
      [0x00001000, 'Inventory'],
      [0x00002000, 'Dynamic'],
      [0x00004000, 'ProvidesCover'],
      [0x00008000, 'HasOverlays'],
      [0x00010000, 'HasUnderlays'],
      [0x00020000, 'Wading'],
      [0x00040000, 'WaterWalking'],
      [0x00080000, 'Stoned'],
      [0x00100000, 'Dontlight'],
      [0x00200000, 'TextFloater'],
      [0x00400000, 'Invulnerable'],
      [0x00800000, 'Extinct'],
      [0x01000000, 'TrapPc'],
      [0x02000000, 'TrapSpotted'],
      [0x04000000, 'DisallowWading'],
      [0x08000000, 'MultiplayerLock'],
      [0x10000000, 'Frozen'],
      [0x20000000, 'AnimatedDead'],
      [0x40000000, 'Teleported']
    ],
    20: [ // F_SPELL_FLAGS (OSF_*)
      [0x00000001, 'Invisible'],
      [0x00000002, 'Floating'],
      [0x00000004, 'BodyOfAir'],
      [0x00000008, 'BodyOfEarth'],
      [0x00000010, 'BodyOfFire'],
      [0x00000020, 'BodyOfWater'],
      [0x00000040, 'DetectingMagic'],
      [0x00000080, 'DetectingAlignment'],
      [0x00000100, 'DetectingTraps'],
      [0x00000200, 'DetectingInvisible'],
      [0x00000400, 'Shielded'],
      [0x00000800, 'AntiMagicShell'],
      [0x00001000, 'BondsOfMagic'],
      [0x00002000, 'FullReflection'],
      [0x00004000, 'Summoned'],
      [0x00008000, 'Illusion'],
      [0x00010000, 'Stoned'],
      [0x00020000, 'Polymorphed'],
      [0x00040000, 'Mirrored'],
      [0x00080000, 'Shrunk'],
      [0x00100000, 'Passwalled'],
      [0x00200000, 'WaterWalking'],
      [0x00400000, 'MagneticInversion'],
      [0x00800000, 'Charmed'],
      [0x01000000, 'Entangled'],
      [0x02000000, 'SpokenWithDead'],
      [0x04000000, 'TempusFugit'],
      [0x08000000, 'MindControlled'],
      [0x10000000, 'Drunk'],
      [0x20000000, 'Enshrouded'],
      [0x40000000, 'Familiar'],
      [0x80000000, 'HardenedHands']
    ],
    39: [ // F_WALL_FLAGS (OWAF_*)
      [0x00000001, 'TransDisallow'],
      [0x00000002, 'TransLeft'],
      [0x00000004, 'TransRight'],
      [0x00000008, 'TransAll']
    ],
    46: [ // F_PORTAL_FLAGS (OPF_*)
      [0x00000001, 'Locked'],
      [0x00000002, 'Jammed'],
      [0x00000004, 'MagicallyHeld'],
      [0x00000008, 'NeverLocked'],
      [0x00000010, 'AlwaysLocked'],
      [0x00000020, 'LockedDay'],
      [0x00000040, 'LockedNight'],
      [0x00000080, 'Busted'],
      [0x00000100, 'Sticky']
    ],
    56: [ // F_CONTAINER_FLAGS (OCOF_*)
      [0x00000001, 'Locked'],
      [0x00000002, 'Jammed'],
      [0x00000004, 'MagicallyHeld'],
      [0x00000008, 'NeverLocked'],
      [0x00000010, 'AlwaysLocked'],
      [0x00000020, 'LockedDay'],
      [0x00000040, 'LockedNight'],
      [0x00000080, 'Busted'],
      [0x00000100, 'Sticky'],
      [0x00000200, 'InvenSpawnOnce'],
      [0x00000400, 'InvenSpawnIndependent']
    ],
    69: [ // F_SCENERY_FLAGS (OSCF_*)
      [0x00000001, 'NoAutoAnimate'],
      [0x00000002, 'Busted'],
      [0x00000004, 'Nocturnal'],
      [0x00000008, 'MarksTownmap'],
      [0x00000010, 'IsFire'],
      [0x00000020, 'Respawnable'],
      [0x00000040, 'SoundSmall'],
      [0x00000080, 'SoundMedium'],
      [0x00000100, 'SoundExtraLarge'],
      [0x00000200, 'UnderAll'],
      [0x00000400, 'Respawning']
    ],
    87: [ // F_ITEM_FLAGS (OIF_*)
      [0x00000001, 'Identified'],
      [0x00000002, 'WontSell'],
      [0x00000004, 'IsMagical'],
      [0x00000008, 'TransferLight'],
      [0x00000010, 'NoDisplay'],
      [0x00000020, 'NoDrop'],
      [0x00000040, 'Hexed'],
      [0x00000080, 'CanUseBox'],
      [0x00000100, 'NeedsTarget'],
      [0x00000200, 'LightSmall'],
      [0x00000400, 'LightMedium'],
      [0x00000800, 'LightLarge'],
      [0x00001000, 'LightXlarge'],
      [0x00002000, 'Persistent'],
      [0x00004000, 'MtTriggered'],
      [0x00008000, 'Stolen'],
      [0x00010000, 'UseIsThrow'],
      [0x00020000, 'NoDecay'],
      [0x00040000, 'Uber'],
      [0x00080000, 'NoNpcPickup'],
      [0x00100000, 'NoRangedUse'],
      [0x00200000, 'ValidAiAction'],
      [0x00400000, 'MpInserted']
    ],
    112: [ // F_WEAPON_FLAGS (OWF_*)
      [0x00000001, 'Loud'],
      [0x00000002, 'Silent'],
      [0x00000004, 'TwoHanded'],
      [0x00000008, 'HandCountFixed'],
      [0x00000010, 'Throwable'],
      [0x00000020, 'TransProjectile'],
      [0x00000040, 'Boomerangs'],
      [0x00000080, 'IgnoreResistance'],
      [0x00000100, 'DamageArmor'],
      [0x00000200, 'DefaultThrows']
    ],
    141: [ // F_AMMO_FLAGS (OAF_*)
      [0x00000001, 'None']
    ],
    150: [ // F_ARMOR_FLAGS (OARF_*)
      [0x00000001, 'SizeSmall'],
      [0x00000002, 'SizeMedium'],
      [0x00000004, 'SizeLarge'],
      [0x00000008, 'MaleOnly'],
      [0x00000010, 'FemaleOnly']
    ],
    164: [ // F_GOLD_FLAGS (OGOF_*)
      [0x00000001, 'None']
    ],
    172: [ // F_FOOD_FLAGS (OFF_*)
      [0x00000001, 'None']
    ],
    179: [ // F_SCROLL_FLAGS (OSRF_*)
      [0x00000001, 'None']
    ],
    193: [ // F_KEY_RING_FLAGS (OKRF_*)
      [0x00000001, 'PrimaryRing']
    ],
    201: [ // F_WRITTEN_FLAGS (OWRF_*)
      [0x00000001, 'None']
    ],
    211: [ // F_GENERIC_FLAGS (OGF_*)
      [0x00000001, 'UsesTorchShieldLocation'],
      [0x00000002, 'IsLockpick'],
      [0x00000004, 'IsTrapDevice'],
      [0x00000008, 'IsHealingItem'],
      [0x00000010, 'IsGrenade']
    ],
    218: [ // F_CRITTER_FLAGS (OCF_*)
      [0x00000001, 'IsConcealed'],
      [0x00000002, 'MovingSilently'],
      [0x00000004, 'Undead'],
      [0x00000008, 'Animal'],
      [0x00000010, 'Fleeing'],
      [0x00000020, 'Stunned'],
      [0x00000040, 'Paralyzed'],
      [0x00000080, 'Blinded'],
      [0x00000100, 'CrippledArmsOne'],
      [0x00000200, 'CrippledArmsBoth'],
      [0x00000400, 'CrippledLegsBoth'],
      [0x00000800, 'Unused'],
      [0x00001000, 'Sleeping'],
      [0x00002000, 'Mute'],
      [0x00004000, 'Surrendered'],
      [0x00008000, 'Monster'],
      [0x00010000, 'SpellFlee'],
      [0x00020000, 'Encounter'],
      [0x00040000, 'CombatModeActive'],
      [0x00080000, 'LightSmall'],
      [0x00100000, 'LightMedium'],
      [0x00200000, 'LightLarge'],
      [0x00400000, 'LightXlarge'],
      [0x00800000, 'Unrevivifiable'],
      [0x01000000, 'Unressurectable'],
      [0x02000000, 'Demon'],
      [0x04000000, 'FatigueImmune'],
      [0x08000000, 'NoFlee'],
      [0x10000000, 'NonLethalCombat'],
      [0x20000000, 'Mechanical'],
      [0x40000000, 'AnimalEnshroud'],
      [0x80000000, 'FatigueLimiting']
    ],
    219: [ // F_CRITTER_FLAGS2 (OCF2_*)
      [0x00000001, 'ItemStolen'],
      [0x00000002, 'AutoAnimates'],
      [0x00000004, 'UsingBoomerang'],
      [0x00000008, 'FatigueDraining'],
      [0x00000010, 'SlowParty'],
      [0x00000020, 'CombatToggleFx'],
      [0x00000040, 'NoDecay'],
      [0x00000080, 'NoPickpocket'],
      [0x00000100, 'NoBloodSplotches'],
      [0x00000200, 'NighInvulnerable'],
      [0x00000400, 'Elemental'],
      [0x00000800, 'DarkSight'],
      [0x00001000, 'NoSlip'],
      [0x00002000, 'NoDisintegrate'],
      [0x00004000, 'Reaction0'],
      [0x00008000, 'Reaction1'],
      [0x00010000, 'Reaction2'],
      [0x00020000, 'Reaction3'],
      [0x00040000, 'Reaction4'],
      [0x00080000, 'Reaction5'],
      [0x00100000, 'Reaction6'],
      [0x00200000, 'TargetLock'],
      [0x00400000, 'PermaPolymorph'],
      [0x00800000, 'SafeOff'],
      [0x01000000, 'CheckReactionBad'],
      [0x02000000, 'CheckAlignGood'],
      [0x04000000, 'CheckAlignBad']
    ],
    253: [ // F_PC_FLAGS (OPCF_*)
      [0x00000004, 'UseAltData'],
      [0x00000020, 'FollowerSkillsOn']
    ],
    280: [ // F_NPC_FLAGS (ONF_*)
      [0x00000001, 'Fighting'],
      [0x00000002, 'WaypointsDay'],
      [0x00000004, 'WaypointsNight'],
      [0x00000008, 'AiWaitHere'],
      [0x00000010, 'AiSpreadOut'],
      [0x00000020, 'Jilted'],
      [0x00000040, 'CheckWield'],
      [0x00000080, 'CheckWeapon'],
      [0x00000100, 'Kos'],
      [0x00000200, 'WaypointsBed'],
      [0x00000400, 'ForcedFollower'],
      [0x00000800, 'KosOverride'],
      [0x00001000, 'Wanders'],
      [0x00002000, 'WandersInDark'],
      [0x00004000, 'Fence'],
      [0x00008000, 'Familiar'],
      [0x00010000, 'CheckLeader'],
      [0x00020000, 'Aloof'],
      [0x00040000, 'CastHighest'],
      [0x00080000, 'Generator'],
      [0x00100000, 'Generated'],
      [0x00200000, 'GeneratorRate1'],
      [0x00400000, 'GeneratorRate2'],
      [0x00800000, 'GeneratorRate3'],
      [0x01000000, 'DemaintainSpells'],
      [0x02000000, 'LookForWeapon'],
      [0x04000000, 'LookForArmor'],
      [0x08000000, 'LookForAmmo'],
      [0x10000000, 'BackingOff'],
      [0x20000000, 'NoAttack'],
      [0x40000000, 'CheckGrenade']
    ],
    307: [ // F_TRAP_FLAGS (OTF_*)
      [0x00000001, 'Busted']
    ]
  };

  const MOB_RESISTANCE_LABELS = ['Damage', 'Fire', 'Electrical', 'Poison', 'Magic'];

  function mobDecodeFlagBits(field, num) {
    const table = MOB_FLAG_BITS[field];
    if (!table || typeof num !== 'number') return null;
    const set = table.filter(([mask]) => ((num & mask) >>> 0) === (mask >>> 0)).map(([, name]) => name);
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
  const secExploreBtn = document.getElementById('secExploreBtn');
  const artExploreBtn = document.getElementById('artExploreBtn');
  const explorerHome = document.getElementById('explorerHome');
  const artExplorerControls = document.getElementById('artExplorerControls');
  const mobManifestCache = new Map();
  let mobFiles = [];
  let mobManifest = null;
  let mobCurrentPath = '';
  let mobCurrentFolderName = 'maps';

  function mobU32(view, o) { return view.getUint32(o, true); }
  function mobI32(view, o) { return view.getInt32(o, true); }
  function mobI64(view, o) { return view.getBigInt64(o, true); }
  function mobHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join(' ').toUpperCase(); }
  function mobOidText(bytes) {
    if (bytes.length !== 24) return mobHex(bytes);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // ObjectID: int16 type, 2 bytes padding, int32 padding, 16-byte union (obj_id.h).
    const type = dv.getInt16(0, true);
    const number = dv.getUint32(8, true);
    if (type === 1) return `A / number=${number} / raw=${mobHex(bytes)}`;
    if (type === 2) return `GUID / ${Array.from(bytes.slice(8,24), b => b.toString(16).padStart(2,'0')).join('')} / raw=${mobHex(bytes)}`;
    if (type === 3) return `P / location=${dv.getBigInt64(8, true)} / temp_id=${dv.getInt32(16, true)} / map=${dv.getInt32(20, true)} / raw=${mobHex(bytes)}`;
    if (type === -1) return `BLOCKED (prototype) / raw=${mobHex(bytes)}`;
    if (type === 0) return `NULL / raw=${mobHex(bytes)}`;
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
    if (artId === null) {
      const critter = protoCritterAidInfo(value, objectType);
      return critter ? critter.text : mobValueText(value);
    }
    const raw = Number(value) >>> 0;
    return `${artId} (${raw})`;
  }

  function mobJoinPath(parent, child) {
    const a=String(parent||'').replace(/^\/+|\/+$/g,'');
    const b=String(child||'').replace(/^\/+|\/+$/g,'');
    return a&&b?`${a}/${b}`:(a||b);
  }
  async function loadMobManifest(relativePath='',folderName='maps') {
    const path = String(relativePath || '').replace(/^\/+|\/+$/g, '');
    const cacheKey = path || 'maps-root';
    if (mobManifestCache.has(cacheKey)) return mobManifestCache.get(cacheKey);
    // The root manifest is always maps_manifest.json (there is no mob_manifest.json),
    // and a '..' card passes '..' as its label, which is not a folder name.
    const manifestFolder = !path ? 'maps' : ((folderName && folderName !== '..') ? folderName : path.split('/').pop());
    const url = `${MOB_ROOT}${path ? `${encPath(path)}/` : ''}${encodeURIComponent(manifestFolder)}_manifest.json`;
    try {
      const resp = await fetch(url,{cache:'no-store'});
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      mobManifestCache.set(cacheKey,data);
      return data;
    } catch(err) {
      throw new Error(`couldn't load manifest for ${path ? `/maps/${path}/` : '/maps/'} (${err&&err.message?err.message:err})`);
    }
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
  function mobDisplayName(path, fallback) { return (fallback && fallback !== '..') ? fallback : (path.split('/').filter(Boolean).pop() || 'maps'); }
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
    if (!card?._iconThumb) return;
    try {
      const decoded = await decodeProtoForSearch(filename, relativePath);
      const aidField = decoded.fields.find(f => f.field === 1);
      const critterInfo = protoCritterAidInfo(aidField ? aidField.value : null, decoded.objType);
      if (critterInfo && critterInfo.filename) {
        const critterCanvas = document.createElement('canvas');
        critterCanvas.className = 'proto-file-art-icon';
        critterCanvas.width = 48;
        critterCanvas.height = 48;
        card._iconThumb.replaceChildren(critterCanvas);
        if (!(await loadCritterAidArt(critterInfo, critterCanvas, 48))) card._iconThumb.innerHTML = '<span class="folder-glyph">🧬</span>';
        return;
      }
      const resolved = await resolveProtoFileCardArts(decoded);
      if (!resolved || resolved.artId === null) return;
      const candidates = [resolved.inventoryArtName, resolved.currentArtName]
        .filter((name, index, names) => name && names.findIndex(item => item?.toLowerCase() === name.toLowerCase()) === index);
      if (!candidates.length) return;

      const canvas = document.createElement('canvas');
      canvas.className = 'proto-file-art-icon';
      canvas.width = 48;
      canvas.height = 48;
      card._iconThumb.replaceChildren(canvas);
      for (const artName of candidates) {
        if (await loadProtoCurrentAidArt(resolved.artId, artName, canvas, protoArtObjectType(aidField?.value, decoded.objType), aidField?.value)) return;
      }
      card._iconThumb.innerHTML = '<span class="folder-glyph">🧬</span>';
    } catch (_) {
      // Keep the normal prototype icon when the prototype or its art cannot be resolved.
    }
  }

  function renderDataExplorerTree(rootName, rootPath, rootManifest, loadManifestFn, openFolderFn, subfolderFn, fileFn = null, fileFilterFn = null, filesExtractorFn = extractProtoManifestFiles, fileIcon = '🧬', rootOpenPath = rootPath, rootOpenFolderName = rootName, currentFolderName = null) {
    treeEl.innerHTML = '';
    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    const rootNode = document.createElement('li');
    rootNode.className = 'tree-node';
    const rootRow = document.createElement('div');
    rootRow.className = 'tree-row';
    rootRow.dataset.relpath = rootOpenPath;
    rootRow.style.paddingLeft = '10px';
    rootRow.innerHTML = '<span class="tree-toggle">▼</span><span class="tree-icon">📁</span><span class="tree-name"></span>';
    rootRow.querySelector('.tree-name').textContent = rootName;
    rootNode.appendChild(rootRow);
    const childList = document.createElement('ul');
    childList.className = 'tree-children open';
    rootNode.appendChild(childList);
    rootUl.appendChild(rootNode);
    treeEl.appendChild(rootUl);

    let contentContainer = childList;
    let contentDepth = 1;
    if (rootPath && currentFolderName) {
      const currentNode = document.createElement('li');
      currentNode.className = 'tree-node';
      const currentRow = document.createElement('div');
      currentRow.className = 'tree-row active';
      currentRow.dataset.relpath = rootPath;
      currentRow.style.paddingLeft = '26px';
      currentRow.innerHTML = '<span class="tree-toggle">▼</span><span class="tree-icon">📁</span><span class="tree-name"></span>';
      currentRow.querySelector('.tree-name').textContent = currentFolderName;
      currentNode.appendChild(currentRow);
      contentContainer = document.createElement('ul');
      contentContainer.className = 'tree-children open';
      currentNode.appendChild(contentContainer);
      childList.appendChild(currentNode);
      contentDepth = 2;
    }

    const addFiles = async (manifest, container, depth, parentPath) => {
      if (!fileFn) return;
      const files = filesExtractorFn(manifest);
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
        row.innerHTML = `<span class="tree-icon">${fileIcon}</span><span class="tree-name"></span>`;
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
    buildChildren(rootManifest, contentContainer, contentDepth, rootPath);
    rootRow.addEventListener('click', () => openFolderFn(rootOpenPath, rootOpenFolderName));
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
    renderDataExplorerTree('maps', '', manifest, loadMobManifest, openMobFolder, mobSubfolders);
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
  async function enterMobExplorer(restoreState = false) {
    leaveExplorerHome();
    explorerHome.hidden = true;
    document.querySelector('.explorer').hidden = false;
    explorerMode='mob';syncSidebarLaunchButtons();artExplorerControls.hidden=true;gridEl.hidden=false;viewerEl.hidden=true;viewerEl.innerHTML='';paginationEl.hidden=true;
    const saved = restoreState ? loadDataExplorerState() : null;
    const savedPath = saved?.mode === 'mob' ? (saved.path || '') : '';
    const savedName = savedPath ? ((saved.folderName && saved.folderName !== '..') ? saved.folderName : savedPath.split('/').pop()) : 'maps';
    const savedFile = saved?.mode === 'mob' ? saved.file : null;
    breadcrumbEl.textContent=`/mob/${savedPath?savedPath+'/':''}`;
    treeEl.innerHTML='<p class="mob-loading">Loading /mob/ manifest…</p>';
    try {
      mobCurrentPath=savedPath;mobCurrentFolderName=savedName;mobManifest=await loadMobManifest(savedPath,savedName);mobFiles=extractMobManifestFiles(mobManifest);renderMobTree(mobManifest,savedPath,savedName);
      if (savedFile && mobFiles.includes(savedFile)) await loadMobFromServer(savedFile, null, savedPath);
    }
    catch(err){treeEl.innerHTML='';const p=document.createElement('p');p.className='explorer-status err';p.textContent=err&&err.message?err.message:String(err);treeEl.appendChild(p);gridEl.innerHTML='';}
  }
  function leaveMobExplorer(){leaveDataExplorer();}
  function showMobBrowser(){if(openGroup)closeGifBuilder();openGroup=null;viewerEl.hidden=true;viewerEl.innerHTML='';gridEl.hidden=false;paginationEl.hidden=true;clearShareUrl();gridEl.innerHTML='<p class="explorer-status">Select a .mob file or folder from the list.</p>';}
  let mobViewerRequestToken = 0;
  async function loadMobFromServer(filename,rowEl,relativePath='') {
    treeEl.querySelectorAll('.mob-file-row.active').forEach(r=>r.classList.remove('active'));if(rowEl)rowEl.classList.add('active');
    const url=`${MOB_ROOT}${relativePath?encPath(relativePath)+'/':''}${encPath(filename)}`;
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

  // ---- .MOB "Display on map" ---------------------------------------------
  // Plots every .mob of the folder currently open in the browser at its
  // F_LOCATION world X/Y (tile units; 64x64 tiles per sector). The map starts
  // blank and fills in as the files are fetched and decoded. Drag = pan,
  // wheel / +/- buttons = zoom.
  const mobMapLaunchBtn = document.getElementById('mobMapLaunchBtn');
  let mobMapToken = 0;

  // The packer is only for .ART work; the map action is only for .MOB files.
  function syncSidebarLaunchButtons() {
    const isMob = explorerMode === 'mob';
    if (packerLaunchBtn) packerLaunchBtn.hidden = explorerMode !== 'art';
    if (mobMapLaunchBtn) mobMapLaunchBtn.hidden = !isMob;
  }

  function mobMapTypeColor(type) { return `hsl(${(type * 47) % 360}, 70%, 60%)`; }

  function openMobMap() {
    const token = ++mobMapToken;
    const files = mobFiles.slice();
    const folderPath = mobCurrentPath;
    const folderLabel = `/mob/${folderPath ? folderPath + '/' : ''}`;

    gridEl.hidden = true;
    paginationEl.hidden = true;
    viewerEl.innerHTML = '';
    viewerEl.hidden = false;
    viewerEl.classList.add('revealed');

    const wrap = document.createElement('article');
    wrap.className = 'mob-map';
    wrap.innerHTML = `
      <div class="viewer-backbar"><button type="button" class="btn-back" data-act="back">← Back to folder</button></div>
      <div class="file-group-header"><h2></h2><span class="meta" data-role="status">Starting…</span></div>
      <div class="mob-map-toolbar">
        <button type="button" class="mob-map-btn" data-act="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" class="mob-map-btn" data-act="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" class="mob-map-btn" data-act="fit" title="Fit all points in view">Fit all</button>
        <label class="mob-map-check"><input type="checkbox" data-role="grid"> Sector grid</label>
        <span class="mob-map-coords" data-role="coords">—</span>
      </div>
      <div class="mob-map-legend" data-role="legend"></div>
      <div class="mob-map-stage" data-role="stage"><canvas></canvas><div class="mob-map-tip" hidden></div></div>
      <p class="mob-map-hint">Drag to pan · scroll to zoom · click a point to open that .mob · click a legend chip to hide/show a type</p>`;
    wrap.querySelector('h2').textContent = `Mob map — ${folderLabel}`;
    viewerEl.appendChild(wrap);
    viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const q = (role) => wrap.querySelector(`[data-role="${role}"]`);
    const statusEl = q('status'), coordsEl = q('coords'), legendEl = q('legend'), stage = q('stage');
    const gridChk = q('grid');
    const canvas = stage.querySelector('canvas');
    const tip = stage.querySelector('.mob-map-tip');
    const ctx = canvas.getContext('2d');

    const points = [];                       // { file, x, y, type, artId, artName, artCanvas }
    const protoResolveCache = new Map();     // proto number -> Promise<resolved prototype>
    const artImageCache = new Map();
    const typeCounts = new Array(MOB_OBJECT_TYPE_NAMES.length).fill(0);
    const hiddenTypes = new Set();
    let noLocation = 0, failed = 0, processed = 0, finished = false;

    async function loadMobMapArt(artId, objectType) {
      if (artId === null || artId === undefined) return null;
      const numericId = Number(artId);
      if (!Number.isFinite(numericId)) return null;
      const cacheKey = `${objectType}:${numericId}`;
      if (artImageCache.has(cacheKey)) return artImageCache.get(cacheKey);

      let artName = null;
      try {
        await ensureProtoArtMesLoaded(objectType, 1);
        artName = protoArtMesMap(objectType, 1)?.get(numericId) || null;
      } catch (_) {}

      const candidates = [];
      if (artName) candidates.push(`${protoArtRoot(objectType)}${encPath(String(artName).replace(/^.*[\\/]/, ''))}`);
      const idText = String(Math.trunc(numericId));
      const padded = idText.padStart(6, '0');
      candidates.push(`${ART_ROOT}${idText}.art`, `${ART_ROOT}${padded}.art`, `${ART_ROOT}${idText}.ART`, `${ART_ROOT}${padded}.ART`);

      for (const url of [...new Set(candidates)]) {
        try {
          const resp = await fetch(url, { cache: 'no-store' });
          if (!resp.ok) continue;
          const frames = await parseArtBuffer(await resp.arrayBuffer());
          if (!frames.length || !frames[0].canvas) continue;
          const source = frames[0].canvas;
          const maxSide = 72;
          const scale = Math.max(1, Math.min(maxSide / source.width, maxSide / source.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(source.width * scale));
          canvas.height = Math.max(1, Math.round(source.height * scale));
          const c = canvas.getContext('2d');
          c.imageSmoothingEnabled = false;
          c.clearRect(0, 0, canvas.width, canvas.height);
          c.drawImage(source, 0, 0, canvas.width, canvas.height);
          const result = { canvas, artId: numericId, artName: artName || url.split('/').pop() };
          artImageCache.set(cacheKey, result);
          return result;
        } catch (_) {}
      }
      artImageCache.set(cacheKey, null);
      return null;
    }

    const MIN_SCALE = 0.0005, MAX_SCALE = 240;  // screen px per tile; supports very large sector maps
    const view = { scale: 1, ox: 0, oy: 0, fitted: false, userMoved: false };
    let w = 1, h = 1, dpr = 1;
    let hover = null, drawQueued = false;
    let backgroundImage = null;
    let backgroundStatus = 'not loaded';

    const alive = () => token === mobMapToken && canvas.isConnected && !viewerEl.hidden;
    const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

    function resize() {
      const r = stage.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      w = Math.max(1, Math.floor(r.width));
      h = Math.max(1, Math.floor(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      requestDraw();
    }

    function fitView() {
      const visible = points.filter(p => !hiddenTypes.has(p.type));
      const src = visible.length ? visible : points;
      if (!src.length) { view.scale = 4; view.ox = w / 2; view.oy = h / 2; return; }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of src) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const pad = 40;
      const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
      view.scale = clampScale(Math.min(24, (w - pad * 2) / spanX, (h - pad * 2) / spanY));
      view.ox = backgroundImage ? w / 2 + ((minX + maxX) / 2) * view.scale : w / 2 - ((minX + maxX) / 2) * view.scale;
      view.oy = h / 2 - ((minY + maxY) / 2) * view.scale;
    }

    function zoomAt(factor, cx, cy) {
      const next = clampScale(view.scale * factor);
      const k = next / view.scale;
      view.ox = cx - (cx - view.ox) * k;
      view.oy = cy - (cy - view.oy) * k;
      view.scale = next;
      view.userMoved = true;
      requestDraw();
    }

    function requestDraw() {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(() => { drawQueued = false; if (alive()) draw(); });
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { scale, ox, oy } = view;

      // map.bmp is a sector map: one image pixel = one sector (64 tiles).
      // The game's sector X axis is reversed on the map: sector 0,0 is the
      // top-right, while sector 2000,2000 is the bottom-left.
      if (backgroundImage && backgroundImage.complete && backgroundImage.naturalWidth) {
        const mapW = backgroundImage.naturalWidth * 64;
        const mapH = backgroundImage.naturalHeight * 64;
        // Draw the image with its right edge at world X=0 and top edge at Y=0.
        const left = ox - mapW * scale;
        const top = oy;
        const dw = mapW * scale;
        const dh = mapH * scale;
        // Treat every source pixel as one solid sector color. Disable
        // interpolation so adjacent sectors never blend into each other.
        // A source pixel therefore occupies exactly a 64x64-tile world sector.
        ctx.imageSmoothingEnabled = false;
        if (dw >= 1 || dh >= 1) ctx.drawImage(backgroundImage, left, top, dw, dh);
        ctx.imageSmoothingEnabled = true;
      }

      if (gridChk.checked) {
        const tileStep = scale;       // one tile
        const sectorStep = 64 * scale;
        // Draw individual tile boundaries when they are large enough to be useful.
        // Sector boundaries remain visible at lower zoom levels.
        ctx.lineWidth = 1;
        if (sectorStep >= 6) {
          ctx.strokeStyle = 'rgba(201,157,75,.22)';
          ctx.beginPath();
          const sx0 = Math.floor((ox - w) / sectorStep), sx1 = Math.ceil(ox / sectorStep);
          const sy0 = Math.floor(-oy / sectorStep), sy1 = Math.ceil((h - oy) / sectorStep);
          for (let i = sx0; i <= sx1; i++) {
            const x = Math.round(ox - i * sectorStep) + .5;
            ctx.moveTo(x, 0); ctx.lineTo(x, h);
          }
          for (let j = sy0; j <= sy1; j++) {
            const y = Math.round(oy + j * sectorStep) + .5;
            ctx.moveTo(0, y); ctx.lineTo(w, y);
          }
          ctx.stroke();
        }
        if (tileStep >= 4) {
          ctx.strokeStyle = 'rgba(255,255,255,.10)';
          ctx.beginPath();
          const tx0 = Math.floor((ox - w) / tileStep), tx1 = Math.ceil(ox / tileStep);
          const ty0 = Math.floor(-oy / tileStep), ty1 = Math.ceil((h - oy) / tileStep);
          for (let i = tx0; i <= tx1; i++) {
            const x = Math.round(ox - i * tileStep) + .5;
            ctx.moveTo(x, 0); ctx.lineTo(x, h);
          }
          for (let j = ty0; j <= ty1; j++) {
            const y = Math.round(oy + j * tileStep) + .5;
            ctx.moveTo(0, y); ctx.lineTo(w, y);
          }
          ctx.stroke();
        }
      }

      // Each MOB occupies exactly one tile: a square whose edges are the tile
      // boundaries. Its position is therefore the tile itself, not a point at
      // its centre. The map uses sector-sized pixels, with 64 tiles per sector.
      const markerRects = new Map();
      const groups = new Map();
      for (const p of points) {
        if (hiddenTypes.has(p.type)) continue;
        const key = `${p.x},${p.y}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }

      for (const group of groups.values()) {
        const p = group[0];
        const tileX = p.x;
        const tileY = p.y;
        const left = ox + (backgroundImage ? -(tileX + 1) * scale : tileX * scale);
        const top = oy + tileY * scale;
        const size = Math.max(1, scale);
        const displayed = group.filter(q => q.artCanvas).slice(0, 4);

        // Keep a single tile-sized square for the location. If several MOBs
        // occupy the same tile, their first four art images are fitted inside
        // that same square rather than expanding the marker beyond the tile.
        ctx.fillStyle = displayed.length ? 'rgba(20,20,20,.72)' : mobMapTypeColor(p.type);
        ctx.fillRect(Math.round(left), Math.round(top), Math.max(1, Math.round(size)), Math.max(1, Math.round(size)));
        ctx.lineWidth = Math.max(1, Math.min(2, scale * .35));
        ctx.strokeStyle = 'rgba(255,255,255,.8)';
        ctx.strokeRect(Math.round(left) + .5, Math.round(top) + .5, Math.max(1, Math.round(size) - 1), Math.max(1, Math.round(size) - 1));

        if (displayed.length && size >= 6) {
          const cols = displayed.length > 1 ? 2 : 1;
          const rows = displayed.length > 2 ? 2 : 1;
          const gap = Math.max(1, size * .03);
          const cellW = (size - gap * (cols - 1)) / cols;
          const cellH = (size - gap * (rows - 1)) / rows;
          displayed.forEach((q, index) => {
            const col = index % cols, row = Math.floor(index / cols);
            const cellX = left + col * (cellW + gap);
            const cellY = top + row * (cellH + gap);
            const fit = Math.min(cellW / q.artCanvas.width, cellH / q.artCanvas.height);
            const dw = Math.max(1, q.artCanvas.width * fit);
            const dh = Math.max(1, q.artCanvas.height * fit);
            const px = cellX + (cellW - dw) / 2;
            const py = cellY + (cellH - dh) / 2;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(q.artCanvas, Math.round(px), Math.round(py), Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)));
            markerRects.set(q, { x:left, y:top, w:size, h:size });
          });
        } else {
          markerRects.set(p, { x:left, y:top, w:size, h:size });
        }
        // Stacked mobs share the tile's rect so hovering any of them highlights it.
        for (const q of group) if (!markerRects.has(q)) markerRects.set(q, { x:left, y:top, w:size, h:size });
      }
      if (hover) {
        const rect = markerRects.get(hover);
        const hx = ox + (backgroundImage ? -(hover.x + 0.5) * scale : (hover.x + 0.5) * scale), hy = oy + (hover.y + 0.5) * scale;
        ctx.lineWidth = 2; ctx.strokeStyle = '#ffd700';
        if (rect) {
          ctx.strokeRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
        } else {
          const hr = Math.max(4, scale / 2);
          ctx.beginPath(); ctx.arc(hx, hy, hr + 3, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    function pickPoint(mx, my) {
      const scale = view.scale;
      let best = null;
      let bestD = Infinity;
      for (const p of points) {
        if (hiddenTypes.has(p.type)) continue;
        const left = view.ox + (backgroundImage ? -(p.x + 1) * scale : p.x * scale);
        const top = view.oy + p.y * scale;
        const size = Math.max(1, scale);
        if (mx < left - 3 || mx > left + size + 3 || my < top - 3 || my > top + size + 3) continue;
        const cx = left + size / 2, cy = top + size / 2;
        const d = (cx - mx) ** 2 + (cy - my) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    }

    function updateHover(mx, my) {
      const p = pickPoint(mx, my);
      if (p !== hover) { hover = p; requestDraw(); }
      if (!p) { tip.hidden = true; return; }
      tip.textContent = `${p.file}\n${mobObjectTypeName(p.type)}${p.artId !== null && p.artId !== undefined ? `\nArt ID ${p.artId}` : ''}\nTile ${p.x}, ${p.y}  ·  Sector ${p.x >> 6}, ${p.y >> 6}`;
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = `${Math.max(4, Math.min(w - tw - 4, mx + 14))}px`;
      tip.style.top = `${Math.max(4, Math.min(h - th - 4, my + 14))}px`;
    }

    function updateLegend() {
      legendEl.innerHTML = '';
      typeCounts.forEach((count, type) => {
        if (!count) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mob-map-chip' + (hiddenTypes.has(type) ? ' off' : '');
        chip.dataset.type = String(type);
        chip.innerHTML = '<span class="mob-map-dot"></span><span class="mob-map-chip-label"></span>';
        chip.querySelector('.mob-map-dot').style.background = mobMapTypeColor(type);
        chip.querySelector('.mob-map-chip-label').textContent = `${mobObjectTypeName(type)} ${count}`;
        legendEl.appendChild(chip);
      });
    }

    function updateStatus() {
      const parts = [];
      if (finished) parts.push(`${points.length} of ${files.length} plotted`);
      else parts.push(`Loading ${processed}/${files.length} · ${points.length} plotted`);
      if (noLocation) parts.push(`${noLocation} without a location`);
      if (failed) parts.push(`${failed} failed to load`);
      statusEl.textContent = parts.join(' · ');
    }

    // ---- interaction ----
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const tx = backgroundImage ? Math.floor((view.ox - mx) / view.scale) : Math.floor((mx - view.ox) / view.scale), ty = Math.floor((my - view.oy) / view.scale);
      coordsEl.textContent = `Tile ${tx}, ${ty} · Sector ${Math.floor(tx / 64)}, ${Math.floor(ty / 64)}`;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; canvas.classList.add('dragging'); tip.hidden = true; }
        if (drag.moved) {
          view.ox = drag.ox + dx; view.oy = drag.oy + dy; view.userMoved = true;
          requestDraw();
          return;
        }
      }
      updateHover(mx, my);
    });
    canvas.addEventListener('pointerup', (e) => {
      const wasClick = drag && !drag.moved;
      drag = null;
      canvas.classList.remove('dragging');
      if (wasClick && hover) {
        const file = hover.file;
        mobMapToken++;                                  // stop this map's loader
        ro.disconnect();
        loadMobFromServer(file, null, folderPath);
      }
    });
    canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });
    canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; tip.hidden = true; requestDraw(); } });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'back') {
          mobMapToken++; ro.disconnect();
          viewerEl.hidden = true; viewerEl.innerHTML = '';
          gridEl.hidden = false;
        } else if (act === 'zoom-in') zoomAt(1.5, w / 2, h / 2);
        else if (act === 'zoom-out') zoomAt(1 / 1.5, w / 2, h / 2);
        else if (act === 'fit') { fitView(); view.userMoved = false; requestDraw(); }
        return;
      }
      const chip = e.target.closest('.mob-map-chip');
      if (chip) {
        const type = Number(chip.dataset.type);
        if (hiddenTypes.has(type)) hiddenTypes.delete(type); else hiddenTypes.add(type);
        chip.classList.toggle('off', hiddenTypes.has(type));
        if (hover && hiddenTypes.has(hover.type)) { hover = null; tip.hidden = true; }
        requestDraw();
      }
    });
    gridChk.addEventListener('change', requestDraw);

    const ro = new ResizeObserver(() => { if (alive()) resize(); });
    ro.observe(stage);
    resize();
    view.scale = 4; view.ox = w / 2; view.oy = h / 2;
    updateStatus();

    // Load map.bmp from the same MOB folder. A missing map is intentionally
    // silent: the canvas simply remains blank behind the plotted objects.
    (async () => {
      try {
        const mapUrl = `${MOB_ROOT}${folderPath ? encPath(folderPath) + '/' : ''}map.bmp`;
        const resp = await fetch(mapUrl, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (view.userMoved) {
            // The axis mirrors once the map is present: keep whatever world
            // point is at the stage centre there instead of letting points jump.
            const cx = (w / 2 - view.ox) / view.scale;
            backgroundImage = img;
            view.ox = w / 2 + cx * view.scale;
          } else {
            backgroundImage = img;
            fitView();
          }
          backgroundStatus = `${img.naturalWidth}×${img.naturalHeight}`;
          URL.revokeObjectURL(url);
          requestDraw();
        };
        img.onerror = () => { backgroundStatus = 'unavailable'; URL.revokeObjectURL(url); };
        img.src = url;
      } catch (_) {
        backgroundStatus = 'blank';
      }
    })();

    // ---- progressive load ----
    (async () => {
      if (!files.length) {
        finished = true;
        statusEl.textContent = 'No .mob files in this folder.';
        return;
      }
      const BATCH = 16;
      for (let i = 0; i < files.length; i += BATCH) {
        if (!alive()) return;
        await Promise.all(files.slice(i, i + BATCH).map(async (name) => {
          try {
            const url = `${MOB_ROOT}${folderPath ? encPath(folderPath) + '/' : ''}${encPath(name)}`;
            const resp = await fetch(url, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const decoded = decodeMobBuffer(await resp.arrayBuffer(), name);
            const locField = decoded.fields.find(f => f.field === 2);
            const loc = locField ? mobLocationInfo(locField.value) : null;
            if (!loc) { noLocation++; return; }
            const aidField = decoded.fields.find(f => f.field === 1);
            let artId = aidField ? protoCurrentAidArtId(aidField.value, decoded.objType) : null;
            let inheritedAid = null;
            const point = { file: name, x: loc.worldX, y: loc.worldY, type: decoded.objType, artId, artName: null, artCanvas: null };
            points.push(point);
            typeCounts[decoded.objType] = (typeCounts[decoded.objType] || 0) + 1;

            // If the MOB doesn't override F_CURRENT_AID, inherit it from its .PRO.
            (async () => {
              try {
                if (artId === null) {
                  const proto = await resolveMobPrototype(decoded, protoResolveCache);
                  const pf = proto.decodedProto?.fields?.find(f => f.field === 1);
                  if (pf) { artId = protoCurrentAidArtId(pf.value, decoded.objType); inheritedAid = pf.value; }
                  point.artId = artId;
                }
                if (artId !== null) {
                  const art = await loadMobMapArt(artId, protoArtObjectType(inheritedAid ?? aidField?.value, decoded.objType));
                  if (art && alive()) {
                    point.artCanvas = art.canvas;
                    point.artName = art.artName;
                    requestDraw();
                  }
                }
              } catch (_) {}
            })();
          } catch (_) {
            failed++;
          } finally {
            processed++;
          }
        }));
        if (!alive()) return;
        if (!view.fitted && points.length) { fitView(); view.fitted = true; }
        updateStatus();
        updateLegend();
        requestDraw();
      }
      if (!alive()) return;
      finished = true;
      if (!view.userMoved) fitView();
      updateStatus();
      updateLegend();
      requestDraw();
    })();
  }

  if (mobMapLaunchBtn) mobMapLaunchBtn.addEventListener('click', openMobMap);

  // ---- .PRO prototype explorer ------------------------------------------
  // .PRO records use the same object-field schema as .MOB records, but their
  // prototype OID is BLOCKED (-1), they carry an available-field bitmap, and
  // then serialize every field of the object's type in enum order.
  const PRO_ROOT = `${DATA_ROOT}proto/`;
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
  const DESCRIPTION_MES_URL = `${DATA_ROOT}mes/description.mes`;
  const ITEM_INVEN_MES_URL = `${DATA_ROOT}art/item/item_inven.mes`;
  const ITEM_GROUND_MES_URL = `${DATA_ROOT}art/item/item_ground.mes`;
  const ITEM_PAPER_MES_URL = `${DATA_ROOT}art/item/item_paper.mes`;
  const ITEM_ART_ROOT = `${DATA_ROOT}art/item/`;
  // Containers use a completely separate name table and art folder from items
  // (see game/name.c's TIG_ART_TYPE_CONTAINER case) -- a container's art id is
  // NOT an item id and must never be looked up in item_inven.mes.
  const CONTAINER_MES_URL = `${DATA_ROOT}art/container/container.mes`;
  const CONTAINER_ART_ROOT = `${DATA_ROOT}art/container/`;
  // Portals use their own MES table and ART folder. Windows are stored in
  // portal.mes at key (portal number + 1001), as implemented by a_name.c.
  const PORTAL_MES_URL = `${DATA_ROOT}art/portal/portal.mes`;
  const PORTAL_ART_ROOT = `${DATA_ROOT}art/portal/`;
  const SCENERY_MES_URL = `${DATA_ROOT}art/scenery/scenery.mes`;
  const SCENERY_ART_ROOT = `${DATA_ROOT}art/scenery/`;
  // Eye-Candy ARTs are a separate TIG ART type. Trap prototypes store an
  // eye-candy AID with type=2 (UNDERLAY), which the game names as <name>_U.art.
  const EYE_CANDY_MES_URL = `${DATA_ROOT}art/eye_candy/eye_candy.mes`;
  const EYE_CANDY_ART_ROOT = `${DATA_ROOT}art/eye_candy/`;
  const CRITTER_ART_ROOT = `${DATA_ROOT}art/critter/`;
  const PROTO_ART_TYPE_EYE_CANDY = 18;
  let descriptionMesPromise = null;
  let descriptionMesMap = null;
  let itemInvenMesPromise = null;
  let itemInvenMesMap = null;
  let itemGroundMesPromise = null;
  let itemGroundMesMap = null;
  let itemPaperMesPromise = null;
  let itemPaperMesMap = null;
  let containerMesPromise = null;
  let containerMesMap = null;
  let portalMesPromise = null;
  let portalMesMap = null;
  let sceneryMesPromise = null;
  let sceneryMesMap = null;
  let eyeCandyMesPromise = null;
  let eyeCandyMesMap = null;

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


  // ---- Wall ART -----------------------------------------------------------
  // Wall art IDs are resolved exactly like game/a_name.c does it:
  //   wallname.mes    -> an ORDERED list of entries. Entry i is the first 3
  //                      characters of its text (init_wall_names(): the 4th
  //                      character onward is a wallproto.mes key and is cut off).
  //   structure.mes   -> an ORDERED list (keys < 1000) of "<int> <ext> <floor>
  //                      <roof>" strings. The first two tokens are
  //                      "<3-letter name><param>". parse_wall_structure() looks
  //                      the 3-letter name up in the wallname list by NAME
  //                      (sub_4ED030) and stores the list INDEX. The trailing
  //                      digit is only a parameter; it is not a wallname key.
  //   a_name_wall_aid_to_fname() then picks interior or exterior by
  //   rotation / 2 and builds  <name><piece><U|L|R><variation>.art
  const WALL_PIECES = [
    'bse','lfc','bse','bcl','bcr','tcl','tcr','uec','lec',
    'w3l','w3a','w3r','w4l','w4a','w4b','w4r',
    'w5l','w5a','w5b','w5c','w5r',
    'd3l','d3a','d3r','d4l','d4a','d4b','d4r',
    'd6l','d6a','d6b','d6c','d6d','d6r',
    'p3l','p3a','p3r','p4l','p4a','p4b','p4r',
    'p5l','p5a','p5b','p5c','p5r'
  ];
  const WALL_DAMAGE_SUFFIX = ['U','L','R'];
  const SEC_ART_TYPE_WALL = 1;
  let wallNameTablePromise = null;
  let wallNameTable = null;        // [{ name }]  (position == a_name wall_file_names index)
  let wallStructureTablePromise = null;
  let wallStructureTable = null;   // [{ interior, exterior, interiorParam, exteriorParam, flags }]
  let wallManifestPromise = null;
  let wallManifestNames = null;    // lower-case file name -> exact file name
  const wallFileCache = new Map();
  let portalManifestPromise = null;

  async function fetchWallText(url) {
    const resp = await fetch(url, {cache:'no-store'});
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = await resp.arrayBuffer();
    try { return new TextDecoder('windows-1252').decode(buf); }
    catch (_) { return new TextDecoder('latin1').decode(buf); }
  }

  function wallMesEntries(text, maxKeyExclusive = Infinity) {
    const out = [];
    for (const [key, value] of parseMesText(text)) {
      if (key < 0 || key >= maxKeyExclusive) continue;
      out.push([key, String(value)]);
    }
    out.sort((x, y) => x[0] - y[0]);
    return out;
  }

  function loadWallNameTable() {
    if (!wallNameTablePromise) {
      wallNameTablePromise = fetchWallText(`${ART_ROOT}wall/wallname.mes`)
        .then(text => (wallNameTable = wallMesEntries(text).map(([, v]) => ({ name: v.trim().slice(0, 3) }))))
        .catch(err => { wallNameTablePromise = null; throw err; });
    }
    return wallNameTablePromise;
  }

  function wallNameIndex(name) {
    const want = String(name).toLowerCase();
    return wallNameTable.findIndex(e => e.name.toLowerCase() === want);
  }

  function loadWallStructureTable() {
    if (!wallStructureTablePromise) {
      wallStructureTablePromise = Promise.all([fetchWallText(`${ART_ROOT}wall/structure.mes`), loadWallNameTable()])
        .then(([text]) => {
          // init_wall_structures() stops at the first key >= 1000 (thumbnail names).
          wallStructureTable = wallMesEntries(text, 1000).map(([, v]) => {
            const tok = v.trim().split(/\s+/);
            const side = t => {
              const s = String(t || '');
              return { index: wallNameIndex(s.slice(0, 3)), param: parseInt(s.slice(3), 10) || 0 };
            };
            const interior = side(tok[0]), exterior = side(tok[1]);
            let flags = 0;
            for (const t of tok.slice(4)) {
              const l = t.toLowerCase();
              if (l === '/nowindows') flags |= 1; else if (l === '/nodoors') flags |= 2; else if (l === '/fence') flags |= 4;
            }
            return { interior: interior.index, interiorParam: interior.param, exterior: exterior.index, exteriorParam: exterior.param, flags };
          });
          return wallStructureTable;
        })
        .catch(err => { wallStructureTablePromise = null; throw err; });
    }
    return wallStructureTablePromise;
  }

  // art/portal/portal_manifest.json (if present): lower-case name -> exact file name.
  function loadPortalManifest() {
    if (!portalManifestPromise) {
      portalManifestPromise = (async () => {
        const map = new Map();
        try {
          const resp = await fetch(`${PORTAL_ART_ROOT}portal_manifest.json`, { cache: 'no-store' });
          if (resp.ok) {
            const data = await resp.json();
            const list = Array.isArray(data) ? data : (Array.isArray(data?.files) ? data.files : []);
            for (const x of list) {
              const name = typeof x === 'string' ? x : (x && (x.name || x.filename || x.file));
              if (typeof name === 'string' && /\.art$/i.test(name)) map.set(name.split('/').pop().toLowerCase(), name.split('/').pop());
            }
          }
        } catch (_) {}
        return map;
      })();
    }
    return portalManifestPromise;
  }

  async function loadWallManifest() {
    if (wallManifestNames) return wallManifestNames;
    if (!wallManifestPromise) {
      wallManifestPromise = (async () => {
        const map = new Map();
        try {
          const resp = await fetch(`${ART_ROOT}wall/wall_manifest.json`, {cache:'no-store'});
          if (resp.ok) {
            const data = await resp.json();
            const list = Array.isArray(data) ? data : (Array.isArray(data?.files) ? data.files : []);
            for (const x of list) {
              const name = typeof x === 'string' ? x : (x && (x.name || x.filename || x.file));
              if (typeof name === 'string' && /\.art$/i.test(name)) map.set(name.split('/').pop().toLowerCase(), name.split('/').pop());
            }
          }
        } catch (_) {}
        wallManifestNames = map;
        return map;
      })();
    }
    return wallManifestPromise;
  }

  // TIG wall art ID layout (derived from the wall objects of the Iron Clan HQ
  // sectors; the TIG bit macros are not part of the CE source tree):
  //   28-31 type (=1 wall)   20-27 structure number (8 bits)
  //   14-19 piece            11-13 rotation            8-9 variation
  //   bit 10 and bit 7: damage flags (0x400 / 0x80, see a_name.c)
  //   4-5 palette (generic TIG position; not used for picking art)
  //
  // The structure number used to be read from bits 22-27 only, with bits 20-21
  // treated as a "palette". Walls have no palette there: those two bits are the
  // low bits of the structure number, so every wall whose structure number is
  // not a multiple of 4 resolved to the wrong structure (e.g. structure 3 was
  // read as structure 0) and got the wrong wallname stem (IN5.. instead of IN4..).
  function decodeWallArtId(rawValue) {
    const raw = Number(rawValue) >>> 0;
    if ((raw >>> 28) !== SEC_ART_TYPE_WALL) return null;
    return {
      raw,
      num: (raw >>> 20) & 0xFF,
      palette: (raw >>> 4) & 0x3,
      piece: (raw >>> 14) & 0x3F,
      rotation: (raw >>> 11) & 0x7,
      variation: (raw >>> 8) & 0x3,
      damage: raw & 0x480
    };
  }

  // a_name_wall_aid_to_fname() + build_wall_file_name()
  function wallFilenameFromDecoded(d, structures, names) {
    if (!d || !structures || !names) return null;
    if (d.num >= structures.length) return null;
    const st = structures[d.num];
    const side = (((d.rotation / 2) | 0) === 0 || ((d.rotation / 2) | 0) === 3) ? st.interior : st.exterior;
    if (side < 0 || side >= names.length) return null;

    let damage = d.damage;
    if (d.rotation === 2 || d.rotation === 3 || d.rotation === 6 || d.rotation === 7) {
      let swapped = 0;
      if (damage & 0x400) swapped |= 0x80;
      if (damage & 0x80) swapped |= 0x400;
      damage = swapped;
    }
    let piece = d.piece, newDamage = 0;
    if (damage & 0x400) { newDamage = 0x400; if (piece === 7) piece = 0; }
    else if (damage & 0x80) { newDamage = 0x80; if (piece === 8) piece = 0; }
    if (piece < 0 || piece >= WALL_PIECES.length) return null;

    let suffixIndex = 0;
    if (newDamage & 0x400) suffixIndex = 1;
    else if (newDamage & 0x80) suffixIndex = (piece >= 2 && piece <= 6) ? 1 : 2;

    const stem = names[side].name;
    return {
      filename: `${stem}${WALL_PIECES[piece]}${WALL_DAMAGE_SUFFIX[suffixIndex]}${d.variation}.art`,
      stem, pieceName: WALL_PIECES[piece], structureNum: d.num,
      interiorStem: names[st.interior]?.name ?? '?', exteriorStem: names[st.exterior]?.name ?? '?',
      usedSide: (((d.rotation / 2) | 0) === 0 || ((d.rotation / 2) | 0) === 3) ? 'interior' : 'exterior'
    };
  }

  function loadWallArtFile(filename) {
    const key = filename.toLowerCase();
    let promise = wallFileCache.get(key);
    if (!promise) {
      promise = (async () => {
        const manifest = await loadWallManifest();
        const requestedNames = [filename];
        const variation = /^(.*[ULR])(\d+)(\.art)$/i.exec(filename);
        if (variation && variation[2] !== '0') requestedNames.push(`${variation[1]}0${variation[3]}`);

        for (const requestedName of requestedNames) {
          const exact = manifest.get(requestedName.toLowerCase());
          // The original game runs on a case-insensitive file system; a web server
          // usually is not, so try the manifest spelling first, then common variants.
          const tries = [];
          const base = requestedName.replace(/\.art$/i, '');
          const stem = base.slice(0, 3), piece = base.slice(3, 6), tail = base.slice(6);
          const spellings = [exact, requestedName, requestedName.toLowerCase(), requestedName.toUpperCase(),
            `${stem.toLowerCase()}${piece}${tail}.art`, `${stem.toUpperCase()}${piece.toUpperCase()}${tail}.art`,
            `${stem}${piece.toUpperCase()}${tail}.art`, `${stem.toLowerCase()}${piece.toLowerCase()}${tail.toLowerCase()}.ART`,
            `${stem.toUpperCase()}${piece.toLowerCase()}${tail}.art`];
          for (const name of spellings) if (name && !tries.includes(name)) tries.push(name);
          for (const name of tries) {
            try {
              const resp = await fetch(`${ART_ROOT}wall/${encPath(name)}`);
              if (!resp.ok) continue;
              const frames = await parseArtBuffer(await resp.arrayBuffer());
              if (frames.length && frames[0]?.indices?.length) {
                return { frames, fileName: name, requestedFileName: filename };
              }
            } catch (_) {}
          }
        }
        return null;
      })();
      wallFileCache.set(key, promise);
    }
    return promise;
  }

  const wallArtRawCache = new Map();
  function loadWallArtFromRaw(rawValue) {
    const key = Number(rawValue) >>> 0;
    let p = wallArtRawCache.get(key);
    if (!p) {
      p = loadWallArtFromRawUncached(rawValue);
      wallArtRawCache.set(key, p);
      p.catch(() => wallArtRawCache.delete(key));
    }
    return p;
  }
  async function loadWallArtFromRawUncached(rawValue) {
    const raw = Number(rawValue) >>> 0;
    if (!Number.isFinite(raw) || raw === 0xFFFFFFFF) return null;
    const d = decodeWallArtId(raw);
    if (!d) return null;

    const [structures, names] = await Promise.all([loadWallStructureTable(), loadWallNameTable()]);
    const desc = wallFilenameFromDecoded(d, structures, names);
    if (!desc) return {wallDecode:{...d, raw}, missing:true};

    const file = await loadWallArtFile(desc.filename);
    if (!file) return {wallDecode:{...d, ...desc, raw, tried:[desc.filename]}, missing:true};

    // A wall's rotation (always odd for placed walls) is the outward direction
    // of the edge it stands on: 1 = x-1, 3 = y+1, 5 = x+1, 7 = y-1
    // (location_in_dir() in location.c; wall.c draws 6/7 on the top edge, 2/3 on
    // the bottom edge, 4/5 left, 0/1 right). Interior art serves rotations
    // 0,1,6,7 and exterior art 2..5 (a_name_wall_aid_to_fname), so each file
    // only needs the two odd rotations of its side.
    //
    // TIG stores the images of an 8-direction ART in its own direction order
    // and the CE source does not include that table, so do not assume it. Look
    // at which directions of THIS file really contain an image and pick the
    // rotation->direction offset under which both rotations of the side that
    // was requested are present (offset 0 first, then 5, then the rest).
    const frames = file.frames;
    const fpd = frames.framesPerDirection || 1;
    const dirCount = frames.directionCount || 1;
    const firstOfDir = new Map();
    for (const f of frames) {
      if (!(f.indices && f.indices.length && f.width > 0 && f.height > 0)) continue;
      const have = firstOfDir.get(f.direction);
      // Prefer the real first frame of the direction, otherwise the first one
      // that is not empty (empty images are dropped by parseArtBuffer).
      if (!have || (f.index % fpd === 0 && have.index % fpd !== 0)) firstOfDir.set(f.direction, f);
    }
    let dir = 0, offset = 0, mappingNote = 'single direction';
    if (dirCount === 8) {
      const interior = ((d.rotation / 2) | 0) === 0 || ((d.rotation / 2) | 0) === 3;
      const needed = interior ? [1, 7] : [3, 5];
      let best = -1;
      for (const off of [0, 5, 1, 2, 3, 4, 6, 7]) {
        const score = needed.filter(r => firstOfDir.has((r + off) % 8)).length
          + (firstOfDir.has((d.rotation + off) % 8) ? 0.5 : 0);
        if (score > best) { best = score; offset = off; }
      }
      dir = (d.rotation + offset) % 8;
      mappingNote = `8 dirs, populated [${[...firstOfDir.keys()].sort().join(',')}], offset ${offset}`;
    }
    let frame = firstOfDir.get(dir);
    if (!frame) {
      // Requested direction is empty: use the nearest populated one rather than
      // an arbitrary frame, and say so in the diagnostics.
      let bestDist = 9;
      for (const [k, f] of firstOfDir) {
        const dist = Math.min((k - dir + 8) % 8, (dir - k + 8) % 8);
        if (dist < bestDist) { bestDist = dist; frame = f; }
      }
      mappingNote += ' · requested direction empty';
    }
    if (!frame) frame = frames.find(f => f.direction === 0) || frames[0];
    const palettes = frame.palettes || [];
    // The palette bits of the wall ID are not confirmed, so always use the
    // file's first palette (same as facades) instead of guessing a variant.
    const palette = palettes[0] || frame.palette;
    let canvas = palette ? frameCanvasForPalette(frame, palette, 0) : frame.canvas;
    let hotspotX = Number(frame.hotspotX) || 0;
    const hotspotY = Number(frame.hotspotY) || 0;

    // Wall ART files are one single-direction, single-frame image. The
    // orientation of a placed wall comes from its rotation alone: the same
    // picture is used for both wall axes and is mirrored horizontally for the
    // other one. a_name_wall_aid_to_fname() shows which rotations those are:
    // for rotations 2, 3, 6 and 7 it swaps the left/right damage bits because
    // the image is drawn mirrored. The anchor point mirrors with the image.
    const mirrored = (d.rotation & 2) !== 0;
    if (mirrored && canvas) {
      const flipped = document.createElement('canvas');
      flipped.width = canvas.width; flipped.height = canvas.height;
      const fctx = flipped.getContext('2d');
      fctx.imageSmoothingEnabled = false;
      fctx.translate(canvas.width, 0);
      fctx.scale(-1, 1);
      fctx.drawImage(canvas, 0, 0);
      hotspotX = canvas.width - hotspotX;
      canvas = flipped;
    }
    mappingNote += mirrored ? ' · mirrored horizontally (rotation 2/3/6/7)' : ' · not mirrored';

    return {
      canvas,
      hotspotX,
      hotspotY,
      artName: file.fileName,
      wallDecode: {
        ...d, ...desc, raw, variation: d.variation, artDirection: dir, mappingNote,
        requestedFilename: file.requestedFileName || desc.filename,
        variationFallback: file.fileName.toLowerCase() !== desc.filename.toLowerCase()
      }
    };
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

  async function loadItemGroundMes() {
    if (itemGroundMesMap) return itemGroundMesMap;
    if (itemGroundMesPromise) return itemGroundMesPromise;
    itemGroundMesPromise = fetch(ITEM_GROUND_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${ITEM_GROUND_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        itemGroundMesMap = parseMesText(text);
        return itemGroundMesMap;
      })
      .catch(err => {
        itemGroundMesPromise = null;
        throw err;
      });
    return itemGroundMesPromise;
  }

  async function loadItemPaperMes() {
    if (itemPaperMesMap) return itemPaperMesMap;
    if (itemPaperMesPromise) return itemPaperMesPromise;
    itemPaperMesPromise = fetch(ITEM_PAPER_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${ITEM_PAPER_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        itemPaperMesMap = parseMesText(text);
        return itemPaperMesMap;
      })
      .catch(err => {
        itemPaperMesPromise = null;
        throw err;
      });
    return itemPaperMesPromise;
  }

  async function loadContainerMes() {
    if (containerMesMap) return containerMesMap;
    if (containerMesPromise) return containerMesPromise;
    containerMesPromise = fetch(CONTAINER_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${CONTAINER_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        containerMesMap = parseMesText(text);
        return containerMesMap;
      })
      .catch(err => {
        containerMesPromise = null;
        throw err;
      });
    return containerMesPromise;
  }

  async function loadPortalMes() {
    if (portalMesMap) return portalMesMap;
    if (portalMesPromise) return portalMesPromise;
    portalMesPromise = fetch(PORTAL_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${PORTAL_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        portalMesMap = parseMesText(text);
        return portalMesMap;
      })
      .catch(err => { portalMesPromise = null; throw err; });
    return portalMesPromise;
  }

  async function loadSceneryMes() {
    if (sceneryMesMap) return sceneryMesMap;
    if (sceneryMesPromise) return sceneryMesPromise;
    sceneryMesPromise = fetch(SCENERY_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${SCENERY_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        sceneryMesMap = parseMesText(text);
        return sceneryMesMap;
      })
      .catch(err => {
        sceneryMesPromise = null;
        throw err;
      });
    return sceneryMesPromise;
  }

  async function loadEyeCandyMes() {
    if (eyeCandyMesMap) return eyeCandyMesMap;
    if (eyeCandyMesPromise) return eyeCandyMesPromise;
    eyeCandyMesPromise = fetch(EYE_CANDY_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${EYE_CANDY_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        eyeCandyMesMap = parseMesText(text);
        return eyeCandyMesMap;
      })
      .catch(err => {
        eyeCandyMesPromise = null;
        throw err;
      });
    return eyeCandyMesPromise;
  }

  // Which name table and art folder apply to a given object type. Containers are
  // their own TIG art category (see game/name.c) and must never share the item
  // lookup -- this is the single place that decides, so every caller (the PRO
  // viewer, the map, file-card thumbnails) agrees.
  function protoArtMesMap(objectType, fieldNumber) {
    if (objectType === 1) return portalMesMap;
    if (objectType === PROTO_ART_TYPE_EYE_CANDY) return eyeCandyMesMap;
    if (objectType === 2) return containerMesMap;
    if (objectType === 3) return sceneryMesMap;
    if (fieldNumber === 95 || fieldNumber === 113 || fieldNumber === 151) return itemPaperMesMap;
    if (fieldNumber === 1) return itemGroundMesMap;
    return itemInvenMesMap;
  }
  function protoArtRoot(objectType) {
    if (objectType === 1) return PORTAL_ART_ROOT;
    if (objectType === PROTO_ART_TYPE_EYE_CANDY) return EYE_CANDY_ART_ROOT;
    if (objectType === 2) return CONTAINER_ART_ROOT;
    if (objectType === 3) return SCENERY_ART_ROOT;
    return ITEM_ART_ROOT;
  }
  async function ensureProtoArtMesLoaded(objectType, fieldNumber) {
    if (objectType === 1) return loadPortalMes();
    if (objectType === PROTO_ART_TYPE_EYE_CANDY) return loadEyeCandyMes();
    if (objectType === 2) return loadContainerMes();
    if (objectType === 3) return loadSceneryMes();
    if (fieldNumber === 95 || fieldNumber === 113 || fieldNumber === 151) return loadItemPaperMes();
    if (fieldNumber === 1) return loadItemGroundMes();
    return loadItemInvenMes();
  }

  // Shared MOB-map artwork loader.  The standalone MOB map has its own
  // loader, but the SEC viewer lives outside that function's scope.  Keep the
  // same ART/MES resolution available to both viewers.
  // Scenery (and any other 8-direction ART) stores one group of frames per
  // rotation. The placed object's F_CURRENT_AID carries that rotation in bits
  // 11-13 (same field the wall decoder uses), so the sprite has to come from
  // that direction's group rather than from frames[0].
  // F_OFFSET_X / F_OFFSET_Y (fields 3 and 4): signed pixel offsets the game
  // adds to the tile-centre position of an object before subtracting the ART
  // hotspot. This is what places an object "between" tiles.
  function secFieldInt(fields, n) {
    const f = Array.isArray(fields) ? fields.find(x => x.field === n) : null;
    const v = f ? Number(f.value) : NaN;
    return Number.isFinite(v) ? v : null;
  }
  async function secObjectPixelOffsets(obj, protoCache) {
    let ox = secFieldInt(obj.fields, 3), oy = secFieldInt(obj.fields, 4);
    if (ox === null || oy === null) {
      // Absent on the instance means "same as the prototype".
      try {
        const proto = await resolveMobPrototype(obj, protoCache);
        const pf = proto?.decodedProto?.fields;
        if (ox === null) ox = secFieldInt(pf, 3);
        if (oy === null) oy = secFieldInt(pf, 4);
      } catch (_) {}
    }
    return { offsetX: ox ?? 0, offsetY: oy ?? 0 };
  }

  // Objects can carry lights too (game/light.c sub_4D9590, run for every object of a
  // sector by sector_light_list_fold()): F_LIGHT_FLAGS / F_LIGHT_AID / F_LIGHT_COLOR
  // (13-15) plus four overlay lights F_OVERLAY_LIGHT_* (16-18, arrays). Colour packs
  // as 0xRRGGBB, and an AID of 0xFFFFFFFF means "no light". Fields missing on the
  // placed object come from its prototype. Overlay lights are created with the main
  // light's flags (| their overlay bit), exactly as the game does when it loads them.
  function secFieldArray(fields, n) {
    const f = Array.isArray(fields) ? fields.find(x => x.field === n) : null;
    const v = f?.value;
    if (!v || typeof v !== 'object' || !Array.isArray(v.elements)) return null;
    const m = new Map();
    for (const e of v.elements) if (typeof e.index === 'number') m.set(e.index, e.value);
    return m;
  }
  async function secObjectLightSources(obj, protoCache) {
    const inst = Array.isArray(obj.fields) ? obj.fields : [];
    const has = n => inst.some(f => f.field === n && f.value !== 'absent' && f.value != null);
    const wanted = [13, 14, 15, 16, 17, 18].concat(obj.objType === 3 ? [69] : []);
    let pf = null;
    if (!wanted.every(has)) {
      try { pf = (await resolveMobPrototype(obj, protoCache))?.decodedProto?.fields || null; } catch (_) {}
    }
    const geti = n => { const v = secFieldInt(inst, n); return v !== null ? v : secFieldInt(pf, n); };
    const arr = n => secFieldArray(inst, n) || secFieldArray(pf, n);
    const valid = aid => aid !== 0xFFFFFFFF && aid !== 0 && (aid >>> 28) !== 0;
    const unpack = c => { c = (c ?? 0) >>> 0; return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 }; };
    const sources = [];
    const mainFlags = (geti(13) ?? 0) >>> 0;
    const mainAid = geti(14);
    if (mainAid !== null && valid(mainAid >>> 0)) sources.push({ aid: mainAid >>> 0, flags: mainFlags, ...unpack(geti(15)), overlay: -1 });
    const aids = arr(17), cols = arr(18);
    if (aids) for (let i = 0; i < 4; i++) {
      if (!aids.has(i)) continue;
      const aid = Number(aids.get(i)) >>> 0;
      if (valid(aid)) sources.push({ aid, flags: mainFlags, ...unpack(cols?.get(i)), overlay: i });
    }
    return { sources, nocturnal: obj.objType === 3 && ((geti(69) ?? 0) & 0x4) !== 0 };
  }

  function aidRotation(rawValue) {
    const raw = Number(rawValue);
    return Number.isFinite(raw) ? ((raw >>> 11) & 0x7) : null;
  }

  // Picks the frame for `rotation`. parseArtBuffer() drops empty images, so
  // frames[] is not indexable by direction -- go through frame.direction.
  // When the wanted direction has no image, the opposite-handed direction
  // (8 - r) is used mirrored; failing that, the nearest populated direction.
  function pickArtFrameForRotation(frames, rotation) {
    const fpd = frames.framesPerDirection || 1;
    if (!Number.isInteger(rotation) || (frames.directionCount || 1) < 8) {
      return { frame: frames[0], mirrored: false };
    }
    const firstOfDir = new Map();
    for (const f of frames) {
      if (!(f.width > 0 && f.height > 0)) continue;
      const have = firstOfDir.get(f.direction);
      if (!have || (f.index % fpd === 0 && have.index % fpd !== 0)) firstOfDir.set(f.direction, f);
    }
    const want = ((rotation % 8) + 8) % 8;
    if (firstOfDir.has(want)) return { frame: firstOfDir.get(want), mirrored: false };
    const opposite = (8 - want) % 8;
    if (firstOfDir.has(opposite)) return { frame: firstOfDir.get(opposite), mirrored: true };
    let best = null, bestDist = 9;
    for (const [d, f] of firstOfDir) {
      const dist = Math.min((d - want + 8) % 8, (want - d + 8) % 8);
      if (dist < bestDist) { bestDist = dist; best = f; }
    }
    return { frame: best || frames[0], mirrored: false };
  }

  // Portals stand on a tile edge exactly like walls, so their ART uses the same
  // TIG direction order as wall ART (see loadWallArtFromRaw): the order is not
  // assumed, it is derived from which directions of THIS file hold an image.
  // Interior side serves rotations 0,1,6,7 (odd ones 1,7); exterior 2..5 (3,5).
  const PORTAL_FULL_DIR_OFFSET = 6;
  function pickPortalFrameForRotation(frames, rotation) {
    if (!Number.isInteger(rotation)) return null;
    const fpd = frames.framesPerDirection || 1;
    if ((frames.directionCount || 1) !== 8) {
      // Door ART such as IN4E4aU0.ART is ONE direction holding the opening
      // animation (7 frames: closed, swinging, open). Like single-direction wall
      // ART, it is drawn mirrored horizontally for rotations 2/3/6/7 (rot & 2).
      // Frame 0 is the closed door; the AID's low bits (0x11 on every rot-7
      // portal AND on the rot-7 wall beside it) belong to that mirroring, not to
      // an animation frame.
      const first = frames.find(f => f.width > 0 && f.height > 0);
      if (!first) return null;
      const m = (rotation & 2) !== 0;
      return { frame: first, mirrored: m,
        note: `single-direction ART (${fpd} frames), rot ${rotation & 7} -> frame 1${m ? ' mirrored' : ''}` };
    }
    const firstOfDir = new Map();
    for (const f of frames) {
      if (!(f.width > 0 && f.height > 0)) continue;
      const have = firstOfDir.get(f.direction);
      if (!have || (f.index % fpd === 0 && have.index % fpd !== 0)) firstOfDir.set(f.direction, f);
    }
    const r = rotation & 7;
    const interior = ((r / 2) | 0) === 0 || ((r / 2) | 0) === 3;
    const needed = interior ? [1, 7] : [3, 5];
    let best = -1, offset = 0;
    // All eight directions present: the file cannot reveal the order, so use the
    // calibrated offset (rot 7 -> direction 5, the 6th image) instead of 0.
    const order = firstOfDir.size === 8 ? [PORTAL_FULL_DIR_OFFSET] : [0, 5, 1, 2, 3, 4, 6, 7];
    for (const off of order) {
      const score = needed.filter(n => firstOfDir.has((n + off) % 8)).length
        + (firstOfDir.has((r + off) % 8) ? 0.5 : 0);
      if (score > best) { best = score; offset = off; }
    }
    const dir = (r + offset) % 8;
    let frame = firstOfDir.get(dir), exact = !!frame;
    if (!frame) {
      let bestDist = 9;
      for (const [k, f] of firstOfDir) {
        const dist = Math.min((k - dir + 8) % 8, (dir - k + 8) % 8);
        if (dist < bestDist) { bestDist = dist; frame = f; }
      }
    }
    if (!frame) return null;
    return { frame, mirrored: false,
      note: `${firstOfDir.size === 8 ? 'full-8 calibrated; ' : ''}rot ${r} -> dir ${frame.direction}${exact ? '' : ' (nearest, wanted ' + dir + ')'}, offset ${offset}, image #${frames.indexOf(frame) + 1} of ${frames.length} (${frames.directionCount} dirs x ${fpd} frames), populated [${[...firstOfDir.keys()].sort().join(',')}]` };
  }

  function flipCanvasHorizontally(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const c = out.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.translate(canvas.width, 0);
    c.scale(-1, 1);
    c.drawImage(canvas, 0, 0);
    return out;
  }

  // Map-tile art for placed NPCs/PCs: art/critter/<dir>/<file>.art, frame chosen
  // by the object's own rotation (same selection as scenery/portals).
  async function loadCritterMapArt(info) {
    if (!info || !info.filename) return null;
    if (!window.__arcanumMobArtFrames) window.__arcanumMobArtFrames = new Map();
    const url = `${CRITTER_ART_ROOT}${info.filename.split('\\').map(encodeURIComponent).join('/')}`;
    try {
      let framesPromise = window.__arcanumMobArtFrames.get(url);
      if (!framesPromise) {
        framesPromise = fetch(url).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        }).then(b => parseArtBuffer(b));
        window.__arcanumMobArtFrames.set(url, framesPromise);
      }
      const frames = await framesPromise;
      if (!frames.length || !frames[0]?.canvas) return null;
      const { frame, mirrored } = pickArtFrameForRotation(frames, info.rotation);
      if (!frame?.canvas) return null;
      let source = frame.canvas;
      let hotspotX = Number(frame.hotspotX) || 0;
      if (mirrored) { source = flipCanvasHorizontally(source); hotspotX = source.width - hotspotX; }
      return {
        canvas: source, hotspotX, hotspotY: Number(frame.hotspotY) || 0,
        artName: info.filename, artFile: info.filename.split('\\').pop(),
        artNote: info.exact ? null : 'critter art approx. (weapon/animation bits not decoded)'
      };
    } catch (_) {
      window.__arcanumMobArtFrames.delete(url);
      return null;
    }
  }

  function loadMobMapArtShared(artId, objectType, paletteIndex = null, rotation = null, rawAid = null) {
    if (artId === null || artId === undefined) return Promise.resolve(null);
    const numericId = Number(artId);
    if (!Number.isFinite(numericId)) return Promise.resolve(null);
    // Cache the in-flight promise (not just the finished result) so objects that
    // share art and are loaded concurrently trigger a single load.
    const cacheKey = `sec-mob:${objectType}:${numericId}:${paletteIndex ?? 'default'}:r${Number.isInteger(rotation) ? rotation : 'x'}`;
    if (!window.__arcanumMobArtCache) window.__arcanumMobArtCache = new Map();
    const cache = window.__arcanumMobArtCache;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const p = loadMobMapArtSharedUncached(artId, objectType, paletteIndex, rotation, rawAid).catch(() => null);
    cache.set(cacheKey, p);
    return p;
  }

  async function loadMobMapArtSharedUncached(artId, objectType, paletteIndex = null, rotation = null, rawAid = null) {
    if (artId === null || artId === undefined) return null;
    const numericId = Number(artId);
    if (!Number.isFinite(numericId)) return null;
    if (!window.__arcanumMobArtFrames) window.__arcanumMobArtFrames = new Map();

    let artName = null;
    try {
      await ensureProtoArtMesLoaded(objectType, 1);
      artName = protoArtMesMap(objectType, 1)?.get(numericId) || null;
    } catch (_) {}

    const candidates = [];
    if (artName) {
      let filename = String(artName).replace(/^.*[\\/]/, '');
      // portal.mes stores the ART filename followed by the numeric portal
      // display/name value, e.g. `BR2f5cu2.art 2036`. The numeric value is
      // a MES lookup value, not part of the filesystem filename.
      if (objectType === 1) {
        const portalFilename = filename.match(/^(.*?\.art)(?:\s+\d+)?$/i);
        if (portalFilename) filename = portalFilename[1];
      }
      // eye_candy.mes stores the base name only. The actual game filename
      // includes _f, _b or _u according to the packed eye-candy layer type.
      if (objectType === PROTO_ART_TYPE_EYE_CANDY) {
        const raw = Number(rawAid);
        const eyeCandyType = Number.isFinite(raw) ? ((raw >>> 6) & 0x7) : null;
        const suffix = eyeCandyType === 0 ? '_f' : eyeCandyType === 1 ? '_b' : eyeCandyType === 2 ? '_u' : null;
        if (suffix && !new RegExp(`${suffix}\\.art$`, 'i').test(filename)) filename = `${filename}${suffix}.art`;
      }
      if (objectType === 1) {
        // Spelling in portal.mes is not guaranteed to match the file on disk.
        let exact = null;
        try { exact = (await loadPortalManifest()).get(filename.toLowerCase()) || null; } catch (_) {}
        if (exact) candidates.push(`${PORTAL_ART_ROOT}${encPath(exact)}`);
        candidates.push(`${PORTAL_ART_ROOT}${encPath(filename)}`);
        candidates.push(`${PORTAL_ART_ROOT}${encPath(filename.toLowerCase())}`);
        candidates.push(`${PORTAL_ART_ROOT}${encPath(filename.replace(/\.art$/i, '.ART'))}`);
      } else {
        candidates.push(`${protoArtRoot(objectType)}${encPath(filename)}`);
      }
    }
    const idText = String(Math.trunc(numericId));
    const padded = idText.padStart(6, '0');
    // Keep the numeric fallback for ordinary item/scenery art, but prefer the
    // MES-resolved filename above (containers in particular require
    // art/container/container.mes + art/container/).
    candidates.push(
      `${ART_ROOT}${encPath(idText)}.art`,
      `${ART_ROOT}${encPath(padded)}.art`,
      `${ART_ROOT}${encPath(idText)}.ART`,
      `${ART_ROOT}${encPath(padded)}.ART`
    );

    for (const url of [...new Set(candidates)]) {
      try {
        // Fetch + parse each ART url once (hits and misses); every rotation and
        // palette of the same art reuses it.
        let framesPromise = window.__arcanumMobArtFrames.get(url);
        if (!framesPromise) {
          framesPromise = fetch(url).then(r => (r.ok ? r.arrayBuffer().then(b => parseArtBuffer(b)) : null)).catch(() => null);
          window.__arcanumMobArtFrames.set(url, framesPromise);
        }
        const frames = await framesPromise;
        if (!frames || !frames.length || !frames[0]?.canvas) continue;
        const portalPick = objectType === 1 ? pickPortalFrameForRotation(frames, rotation) : null;
        const { frame, mirrored } = portalPick || pickArtFrameForRotation(frames, rotation);
        if (!frame?.canvas) continue;
        const palettes = frame.palettes || [];
        const selectedPaletteIndex = Number.isInteger(paletteIndex)
          ? Math.max(0, Math.min(palettes.length - 1, paletteIndex))
          : null;
        const selectedPalette = selectedPaletteIndex === null ? null : palettes[selectedPaletteIndex];
        let source = selectedPalette
          ? frameCanvasForPalette(frame, selectedPalette, 0)
          : frame.canvas;
        let frameHotspotX = Number(frame.hotspotX) || 0;
        if (mirrored) {
          source = flipCanvasHorizontally(source);
          frameHotspotX = source.width - frameHotspotX;
        }
        // Keep the MOB sprite at its actual ART dimensions. The map renderer
        // applies the current map zoom when drawing it, so the sprite can
        // naturally extend beyond the tile it is positioned on. Preserve the
        // ART hotspot as the anchor, matching the game's sprite placement.
        const result = {
          canvas: source,
          hotspotX: frameHotspotX,
          hotspotY: Number(frame.hotspotY) || 0,
          direction: frame.direction,
          mirrored,
          artId: numericId,
          artName: artName || url.split('/').pop(),
          artFile: url.split('/').pop(),
          artNote: portalPick ? portalPick.note : null,
          paletteIndex: selectedPalette ? selectedPaletteIndex : 0
        };
        return result;
      } catch (_) {}
    }
    return null;
  }

  // The art table an object uses is decided by the type of the art id it
  // holds, not by the object's own type. TIG art types: 4 = scenery, 6 = item,
  // 7 = container. Several containers (barrels, crates, ...) are container
  // objects whose F_CURRENT_AID is a *scenery* art id, so looking them up in
  // container.mes either fails or shows the wrong picture.
  function protoArtObjectType(rawValue, objectType) {
    const raw = Number(rawValue);
    if (!Number.isFinite(raw)) return objectType;
    const typeNibble = (raw >>> 28) & 0xF;
    // .PRO trap F_CURRENT_AID values are encoded as TIG eye-candy IDs with
    // nibble E. Their numeric Art ID is still the normal tig_art_num_get()
    // value; only the TIG type/folder is different from scenery/items.
    if (typeNibble === 0xE) return PROTO_ART_TYPE_EYE_CANDY;
    if (typeNibble === 0x3) return 1; // portal
    if (typeNibble === 0x4) return 3; // scenery
    if (objectType === 2 && typeNibble === 0x7) return 2; // container
    return objectType;
  }

  // NPC / PC (critter) art ids. Unlike scenery, containers or items, a critter
  // art id is not a key into any .mes table: game/name.c builds the ART filename
  // directly from the id's gender / body type / armor / shield / weapon / anim
  // parts, so the "Art ID" shown for an NPC proto is the packed TIG id itself.
  // Layout (type nibble 2 = critter):
  //   bit 27      gender (0 = F, 1 = M)         bits 24-26  body type
  //   bits 11-13  rotation
  // Body type order is name_body_type_strs[] in game/name.c. The gender/body bit
  // positions are inferred, not read from TIG source (not in the CE src zip): they
  // reproduce a human-male NPC .mob (body 0, gender 1) and the three supplied
  // NPC .pro files (all rotation 4, no other bits set). Armor/shield/weapon/anim
  // bit positions are NOT decoded; the filename is only offered when every bit
  // outside gender/body/rotation is zero, which is how game/proto.c creates the
  // default NPC art id (armor UNDERWEAR, no shield/weapon, anim 0).
  const CRITTER_BODY_NAMES = ['Human', 'Dwarf', 'Halfling', 'Half-ogre', 'Elf'];
  const CRITTER_BODY_CODES = ['HM', 'DF', 'GH', 'HG', 'EF'];
  const CRITTER_ARMOR_CODES = ['UW', 'V1', 'LA', 'CM', 'PM', 'RB', 'PC', 'BN', 'CD'];
  const CRITTER_ARMOR_NAMES = ['underwear', 'villager', 'leather', 'chain', 'plate', 'robe', 'plate (classic)', 'barbarian', 'city dweller'];
  // Additional layout, inferred from the order of tig_art_critter_id_create()'s
  // arguments (gender, body, armor, shield, frame, rotation, anim, weapon, palette)
  // packed from the high bits down, which the verified gender/body/rotation
  // positions fit exactly:  bits 20-23 armor, bit 19 shield, bits 14-18 frame.
  // Bits 0-10 (anim / weapon / palette) are NOT decoded.
  function protoCritterAidInfo(value, objectType) {
    if (objectType !== 15 && objectType !== 16) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const raw = numeric >>> 0;
    if (raw === 0xFFFFFFFF || ((raw >>> 28) & 0xF) !== 0x2) return null;
    const hex = '0x' + raw.toString(16).toUpperCase().padStart(8, '0');
    const rotation = (raw >>> 11) & 0x7;
    const gender = (raw >>> 27) & 0x1;
    const body = (raw >>> 24) & 0x7;
    const armor = (raw >>> 20) & 0xF;
    const shield = (raw >>> 19) & 0x1;
    const bodyName = CRITTER_BODY_NAMES[body];
    const parts = [bodyName ? `${bodyName} ${gender ? 'male' : 'female'}` : `body type ${body}`];
    if (armor) parts.push(CRITTER_ARMOR_NAMES[armor] ? `${CRITTER_ARMOR_NAMES[armor]} armor` : `armor ${armor}`);
    parts.push(`rotation ${rotation}`);
    // bits 0-10 (anim/weapon/palette) and 14-18 (frame) must be zero for the
    // filename to be exact (the default NPC proto); otherwise it is an
    // approximation (no weapon, idle animation).
    const exact = (raw & 0x7FF) === 0 && ((raw >>> 14) & 0x1F) === 0;
    let filename = null;
    if (bodyName && CRITTER_ARMOR_CODES[armor]) {
      let g = gender, b = body;
      if (b === 4 && !g) b = 0;               // name_normalize_aid(): elf female uses human art
      if (armor === 4 || armor === 6) {        // plate: male only, elf->human, halfling->dwarf
        g = 1;
        if (b === 4) b = 0; else if (b === 2) b = 1;
      }
      const bodyCode = CRITTER_BODY_CODES[b];
      const gc = g ? 'M' : 'F';
      filename = `${bodyCode}${gc}\\${bodyCode}${gc}${CRITTER_ARMOR_CODES[armor]}${shield ? 'S' : 'X'}Aa.art`;
      parts.push(exact ? filename : `${filename} (approx.: weapon/animation bits not decoded)`);
    }
    return { raw, hex, rotation, gender, body, armor, shield, exact, filename, text: `${raw} (${hex}) \u00b7 ${parts.join(' \u00b7 ')}` };
  }

  function protoCurrentAidArtId(value, objectType) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const raw = numeric >>> 0;
    if (raw === 0xFFFFFFFF) return null; // TIG_ART_ID_INVALID -- "no art", not an unknown format

    const rawArtType = (raw >>> 28) & 0xF;
    // Verified directly against all eight supplied trap .PRO files. The raw
    // F_CURRENT_AID values are 0xE..., and the encoded eye-candy number is
    // bits 19..27. These produce exactly 351..357, matching eye_candy.mes:
    // 351 trap_arrow, 352 trap_elec, 353 trap_fire, 354 trap_gun,
    // 355 trap_magick, 356 trap_mechanical, 357 trap_poison.
    if (rawArtType === 0xE) {
      const eyeCandyType = (raw >>> 6) & 0x7;
      if (eyeCandyType < 0 || eyeCandyType > 2) return null;
      return (raw >>> 19) & 0x1FF;
    }

    objectType = protoArtObjectType(raw, objectType);

    // Portal encoding verified against the supplied SEC portal objects and
    // tig_art_portal_id_create()/name.c:
    //   Art type nibble = 0x3 (TIG_ART_TYPE_PORTAL)
    //   bits 19..27 = portal number
    //   bit 10 = portal type. Checked against 67108865.sec: all 20 portals there
    //   have bit 10 SET and they resolve to doors (adjacent a/b halves such as
    //   IN4E4aU0 + IN4E4bU0), so SET = door and CLEAR = window (the old reading
    //   was inverted and sent every door to the window table, e.g. VTIF4bu0).
    // name.c::sub_4EC8F0() looks up doors at `num` and windows at `num + 1001`.
    if (objectType === 1) {
      if (rawArtType !== 0x3) return null;
      const num = (raw >>> 19) & 0x1FF;
      const isWindow = ((raw >>> 10) & 0x1) === 0;
      return num + (isWindow ? 1001 : 0);
    }

    // Confirmed container encoding (game/name.c: mes_file_entry.num = 1000*type + num,
    // looked up in container.mes -- NOT item_inven.mes). Solved and round-trip-verified
    // against every F_CURRENT_AID/F_DESTROYED_AID in the game's 38 container .pro files,
    // cross-checked against game/proto.c's named container blueprints (BP_WOOD_CHEST_1,
    // BP_SAFE_1, the crate family, etc.) -- every non-invalid sample re-encodes exactly.
    //   bits 19-24 (6 bits): num        bits 6-7 + bit 8 (3 bits): type
    if (objectType === 2) {
      const num = (raw >>> 19) & 0x3F;
      const type = ((raw >>> 6) & 0x3) | (((raw >>> 8) & 0x1) << 2);
      const reencoded = (0x70000000 | (num << 19) | ((type & 0x3) << 6) | (((type >> 2) & 1) << 8)) >>> 0;
      // Placed containers carry extra state in F_CURRENT_AID (rotation in bits
      // 11-13, plus palette/frame bits) that the .pro files leave at zero.
      // Ignore those bits when matching num/type, or a rotated chest would
      // fail the round-trip check and lose its art.
      return reencoded === (raw & ~0x3E30) >>> 0 ? (type * 1000 + num) : null;
    }

    // Confirmed scenery encoding (game/name.c: mes_file_entry.num = 1000*type + num,
    // looked up in scenery.mes). Solved and round-trip-verified against every real
    // scenery .pro in the game (45/45), matching every named blueprint in proto.c
    // (trees, stones, lights 1-13, wall-of-fire/stone/force, dynamite, smoke, ...).
    //   bits 19-25 (7 bits): num        bits 6-10 (5 bits): type
    if (objectType === 3) {
      const num = (raw >>> 19) & 0x7F;
      const type = (raw >>> 6) & 0x1F;
      if ((raw >>> 28) !== 0x4) return null;
      return type * 1000 + num;
    }

    // Confirmed unified item encoding (game/a_name.c's a_name_item_aid_to_fname):
    //   mes_file_entry.num = tig_art_num_get(aid) + 20*(subtype + 50*type)
    //   if type==ARMOR and coverage!=TORSO: += 20*(5*coverage+10)
    // Solved and validated against game/proto.c's named item blueprints (every
    // weapon family: dagger/sword/axe/mace/revolver/broadsword/bow/shotgun/staff/
    // elephant gun/tesla rod/flame thrower; every armor family: wool clothes/
    // guard leather/chainmail/platemail/priest robes/mithril/dread armour/nice
    // suit/shield/helmet; gold/key/key ring) and cross-checked against every real
    // .pro of every item type in the game (742/744 = 99.7% resolve correctly;
    // the two misses are plausibly one-off unused/placeholder prototypes).
    //   bits 0-3 (4 bits): type (WEAPON=0..GENERIC=9, matches objectType-5)
    //   bits 6-9 (4 bits): subtype (weapon family; 0 for non-weapon/armor)
    //   bits 14-16 (3 bits, armor only): coverage (TORSO=0, SHIELD=1, HELMET=2, ...)
    //   bits 17-21 (5 bits): num
    // bits 4,5,12 encode disposition (which of ground/inven/paper/schematic a
    // FIELD is meant to read) but are not needed here: the caller already knows
    // which table to search from the field itself (see protoArtMesMap).
    if (objectType === 5 || objectType === 6 || objectType === 7 || (objectType >= 8 && objectType <= 14)) {
      const b3 = (raw >>> 24) & 0xFF;
      if (b3 !== 0x60 && b3 !== 0x61) return null;
      const type = raw & 0xF;
      const expectedType = objectType - 5;
      if (type !== expectedType) return null; // the value's own type bits must agree with the object's type
      const subtype = (raw >>> 6) & 0xF;
      const coverage = (raw >>> 14) & 0x7;
      const num = (raw >>> 17) & 0x1F;
      let key = num + 20 * subtype + 1000 * type;
      if (type === 2 && coverage !== 0) key += 20 * (5 * coverage + 10);
      return key;
    }

    return null;
  }

  // Critter (NPC/PC) preview: fetch art/critter/<dir>/<file>.art and draw the
  // frame for the proto's rotation (an 8-direction ART stores frames
  // direction-major, so index = rotation * framesPerDirection).
  async function loadCritterAidArt(info, previewCanvas, maxSide = 92) {
    if (!info || !info.filename) return false;
    const url = `${CRITTER_ART_ROOT}${info.filename.split('\\').map(encodeURIComponent).join('/')}`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const frames = await parseArtBuffer(buf);
      if (!frames.length) throw new Error('no drawable frame');
      const hv = new DataView(buf);
      const directions = (hv.getUint32(0, true) & 1) === 0 ? 8 : 1;
      const perDir = Math.max(1, hv.getUint32(8 * 4, true));
      const index = (directions === 8 ? info.rotation % 8 : 0) * perDir;
      const source = (frames[index] || frames[0]).canvas;
      if (!source) throw new Error('no drawable frame');
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
      previewCanvas.title = `${info.filename} · Art ID ${info.raw}`;
      previewCanvas.classList.remove('missing');
      return true;
    } catch (err) {
      previewCanvas.classList.add('missing');
      previewCanvas.title = `${info.filename} · bitmap unavailable (${url})`;
      return false;
    }
  }

  async function loadProtoCurrentAidArt(artId, artName, previewCanvas, objectType, rawAid = null) {
    if (!artName) return false;
    let filename = artName.replace(/^.*[\/]/, '');

    // portal.mes stores the ART filename followed by the numeric display/name
    // value, e.g. `BR2f5cu2.art 2036`. The game uses the filename portion for
    // the actual asset path; do not include the trailing MES number in the URL.
    if (objectType === 1) {
      const portalFilename = filename.match(/^(.*?\.art)(?:\s+\d+)?$/i);
      if (portalFilename) filename = portalFilename[1];
    }

    // eye_candy.mes explicitly defines the filename suffix from the eye-candy
    // type: foreground overlay = _f, background overlay = _b, underlay = _u.
    // Read that type from the packed AID instead of assuming every eye-candy
    // prototype is an underlay.
    if (objectType === PROTO_ART_TYPE_EYE_CANDY) {
      const raw = Number(rawAid);
      const eyeCandyType = Number.isFinite(raw) ? ((raw >>> 6) & 0x7) : null;
      const suffix = eyeCandyType === 0 ? '_f' : eyeCandyType === 1 ? '_b' : eyeCandyType === 2 ? '_u' : null;
      if (suffix && !new RegExp(`${suffix}\\.art$`, 'i').test(filename)) {
        filename = `${filename}${suffix}.art`;
      }
    }
    const url = `${protoArtRoot(objectType)}${encPath(filename)}`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const frames = await parseArtBuffer(await resp.arrayBuffer(), 1);
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
      previewCanvas.classList.remove('missing');
      return true;
    } catch (err) {
      previewCanvas.classList.add('missing');
      previewCanvas.title = `${artName} · bitmap unavailable`;
      return false;
    }
  }

  async function resolveProtoFileCardArts(decoded) {
    const field = decoded.fields.find(f => f.field === 1);
    if (!field) return null;
    const artId = protoCurrentAidArtId(field.value, decoded.objType);
    if (artId === null) return { artId, inventoryArtName: null, currentArtName: null };

    let inventoryArtName = null;
    let currentArtName = null;
    if (decoded.objType !== 1 && decoded.objType !== 2 && decoded.objType !== 3) {
      try {
        const inventoryMap = await ensureProtoArtMesLoaded(decoded.objType, 0);
        inventoryArtName = inventoryMap.get(artId) ?? null;
      } catch (_) {}
    }
    try {
      const currentMap = await ensureProtoArtMesLoaded(protoArtObjectType(field.value, decoded.objType), 1);
      currentArtName = currentMap.get(artId) ?? null;
    } catch (_) {}
    return { artId, inventoryArtName, currentArtName };
  }

  async function resolveProtoCurrentAid(decoded) {
    const field = decoded.fields.find(f => f.field === 1);
    if (!field) return null;
    const artId = protoCurrentAidArtId(field.value, decoded.objType);
    const mesMap = protoArtMesMap(protoArtObjectType(field.value, decoded.objType), 1);
    if (artId === null || !mesMap) return { artId, artName: null };
    return { artId, artName: mesMap.get(artId) ?? null };
  }

  function protoManifestUrlCandidates(relativePath, folderName) {
    const path = String(relativePath || '').replace(/^\/+|\/+$/g, '');
    const manifestFolder = folderName || path.split('/').pop() || 'proto';
    const prefix = path ? `${PRO_ROOT}${encPath(path)}/` : PRO_ROOT;
    return `${prefix}${encodeURIComponent(manifestFolder)}_manifest.json`;
  }

  async function loadProtoManifest(relativePath, folderName) {
    if (protoManifestCache.has(relativePath)) return protoManifestCache.get(relativePath);
    const url = protoManifestUrlCandidates(relativePath, folderName);
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      protoManifestCache.set(relativePath, data);
      return data;
    } catch (err) {
      throw new Error(`couldn't load .pro manifest at ${url} (${err && (err.message || err)})`);
    }
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
    const url = `${PRO_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;
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
      await Promise.all(protoSubfolders(manifest).map(sf =>
        walk(mobJoinPath(relativePath, sf.relative_path), sf.folder_name)));
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
    return { type: view.getInt16(0, true), number: view.getUint32(8, true) };
  }

  // `cache` (optional Map) memoizes by prototype number so a map with thousands
  // of mobs fetches and decodes each .pro once. Failures are not cached.
  const sharedProtoResolveCache = new Map();
  async function resolveMobPrototype(decoded, cache, _internal) {
    const info = mobOidTypeAndNumber(decoded.protoOid);
    if (!info || info.type !== 1) return { protoNumber: null, entry: null, decodedProto: null, error: null };
    if (!_internal) {
      cache = cache || sharedProtoResolveCache;
      if (cache.has(info.number)) return cache.get(info.number);
      const pending = resolveMobPrototype(decoded, null, true);
      cache.set(info.number, pending);
      const result = await pending;
      if (result.error) cache.delete(info.number);
      return result;
    }
    const protoNumber = info.number;
    try {
      const index = await getProtoNumberIndex();
      const entry = index.get(protoNumber);
      if (!entry) return { protoNumber, entry: null, decodedProto: null, error: `#${protoNumber} not found under /proto/` };
      const url = `${PRO_ROOT}${entry.relPath ? encPath(entry.relPath) + '/' : ''}${encPath(entry.filename)}`;
      const resp = await fetch(url);
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

  async function enterProtoExplorer(restoreState = false) {
    leaveExplorerHome();
    explorerHome.hidden = true;
    document.querySelector('.explorer').hidden = false;
    if (manualLoadEl) manualLoadEl.hidden = true;
    if (logEl) logEl.hidden = false;
    if (footerNoteEl) footerNoteEl.hidden = false;
    explorerMode = 'pro';
    syncSidebarLaunchButtons();
    artExplorerControls.hidden = false;
    if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = false;
    searchInputEl.placeholder = 'Search .PRO descriptions…';
    searchInputEl.setAttribute('aria-label', 'Search .PRO descriptions');
    const saved = restoreState ? loadDataExplorerState() : null;
    const savedPath = saved?.mode === 'pro' ? (saved.path || '') : '';
    const savedName = saved?.mode === 'pro' ? (saved.folderName || (savedPath ? savedPath.split('/').pop() : 'proto')) : 'proto';
    const savedFile = saved?.mode === 'pro' ? saved.file : null;
    gridEl.hidden = false;
    viewerEl.hidden = true;
    viewerEl.innerHTML = '';
    paginationEl.hidden = true;
    breadcrumbEl.textContent = `/proto/${savedPath ? savedPath + '/' : ''}`;
    treeEl.innerHTML = '<p class="mob-loading">Loading /proto/ manifest…</p>';
    try {
      protoCurrentPath = savedPath;
      protoCurrentFolderName = savedName;
      protoManifest = await loadProtoManifest(savedPath, savedName);
      protoFiles = extractProtoManifestFiles(protoManifest);
      await renderProtoTree(protoManifest, savedPath, savedName);
      if (savedFile && protoFiles.includes(savedFile)) await loadProtoFromServer(savedFile, null, savedPath);
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
    syncSidebarLaunchButtons();
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
    const url = `${PRO_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;
    saveDataExplorerState('pro', relativePath, protoCurrentFolderName, filename);
    protoViewerFilename = filename;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const decoded = decodeProtoBuffer(await resp.arrayBuffer(), filename);
      try { await Promise.all([loadDescriptionMes(), loadItemInvenMes(), loadItemGroundMes(), loadItemPaperMes(), loadContainerMes(), loadSceneryMes()]); }
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

    // Every one of these fields is populated by the game's own tig_art_*_id_create()
    // for this object's type (see obj.c), so they all share one decode: the raw
    // 32-bit value goes through protoCurrentAidArtId() the same way regardless of
    // which field it came from. F_CURRENT_AID and F_ITEM_INV_AID used to be treated
    // differently — the latter as a raw, un-decoded .mes lookup — which was both
    // inconsistent and, since a packed art id is nothing like a small sequential
    // .mes key, effectively never resolved anything. A field decoding to null here
    // just means this object type's layout isn't confirmed yet, not that the field
    // is absent.
    function decodeProtoArt(rawValue, fieldNumber) {
      const artId = protoCurrentAidArtId(rawValue, decoded.objType);
      const mesMap = protoArtMesMap(protoArtObjectType(rawValue, decoded.objType), fieldNumber);
      const artName = artId !== null && mesMap ? (mesMap.get(artId) ?? null) : null;
      return { artId, artName };
    }

    function renderProtoArtField(label, fieldNumber, { evenIfAbsent = false } = {}) {
      const field = decoded.fields.find(f => f.field === fieldNumber);
      if (!field && !evenIfAbsent) return;
      const { artId, artName } = decodeProtoArt(field ? field.value : undefined, fieldNumber);

      const art = document.createElement('div');
      art.className = 'proto-current-aid-art';

      const preview = document.createElement('div');
      preview.className = 'proto-current-aid-preview';
      const canvas = document.createElement('canvas');
      canvas.className = 'proto-current-aid-canvas';
      preview.appendChild(canvas);

      const meta = document.createElement('div');
      meta.className = 'proto-current-aid-meta';
      const labelEl = document.createElement('span');
      labelEl.className = 'proto-current-aid-label';
      labelEl.textContent = label;
      const nameEl = document.createElement('strong');
      if (artId !== null) {
        nameEl.textContent = artName || `Art ID ${artId}`;
      } else if (decoded.objType === 0) {
        // A wall's F_CURRENT_AID on the .pro is only ever the seed value for a
        // brand-new, unplaced wall (see obj.c's default wall creation). The moment
        // it's placed next to other walls the game overwrites it per-tile with a
        // computed piece/rotation/variation based on adjacency (see wall.c,
        // sub_4E2C50 and friends) — so there is no single "correct" art for a
        // wall prototype in isolation, and this isn't a decode failure.
        nameEl.textContent = 'Not applicable — wall art is computed per-tile from map adjacency, not stored on the prototype (see game/wall.c)';
      } else if (protoCritterAidInfo(field ? field.value : null, decoded.objType)) {
        nameEl.textContent = `Critter art ID ${protoCritterAidInfo(field.value, decoded.objType).text}`;
      } else {
        nameEl.textContent = 'Art ID unavailable';
      }
      meta.append(labelEl, nameEl);

      if (fieldNumber === 1) {
        const descriptionField = decoded.fields.find(f => f.field === 23);
        const descriptionInfo = descriptionField ? protoDescriptionInfo(descriptionField.value) : null;
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
        meta.append(descLabel, descEl);
      }

      art.append(preview, meta);

      // The MES tables are loaded asynchronously.  In particular, eye_candy.mes
      // is not necessarily loaded yet when a .PRO viewer is opened.  Do not let
      // that race leave the panel stuck at just "Art ID NNN"; load the relevant
      // table here and then resolve the filename and ART bitmap.
      if (artId === null) {
        const critterInfo = protoCritterAidInfo(field ? field.value : null, decoded.objType);
        if (critterInfo && critterInfo.filename) loadCritterAidArt(critterInfo, canvas);
      }
      if (artId !== null) {
        const effectiveArtType = protoArtObjectType(field ? field.value : null, decoded.objType);
        const loadAndRender = async () => {
          try {
            const map = await ensureProtoArtMesLoaded(effectiveArtType, fieldNumber);
            const resolvedName = map?.get(artId) ?? null;
            if (!resolvedName) return;
            nameEl.textContent = resolvedName;
            await loadProtoCurrentAidArt(artId, resolvedName, canvas, effectiveArtType, field ? field.value : null);
          } catch (_) {
            // Keep the already-visible Art ID when the MES/ART asset is unavailable.
          }
        };
        // If the map was already loaded this remains effectively synchronous;
        // otherwise the async path fills the preview as soon as the MES is ready.
        if (artName) {
          loadProtoCurrentAidArt(artId, artName, canvas, effectiveArtType, field ? field.value : null);
        } else {
          loadAndRender();
        }
      }
      return art;
    }

    // Field 1 renders whenever it or F_DESCRIPTION is present, even if F_CURRENT_AID
    // itself is missing, so the description still shows; the rest only render when present.
    // Each field looks up its own art in its own table (see protoArtMesMap) and all of them
    // are laid out side by side in one row so they're easy to compare at a glance.
    const hasCurrentAidOrDescription = decoded.fields.some(f => f.field === 1 || f.field === 23);
    const aidPanels = [];
    if (hasCurrentAidOrDescription) aidPanels.push(renderProtoArtField('Current art (F_CURRENT_AID)', 1, { evenIfAbsent: true }));
    aidPanels.push(renderProtoArtField('Inventory icon (F_ITEM_INV_AID)', 93));
    aidPanels.push(renderProtoArtField('Use icon (F_ITEM_USE_AID_FRAGMENT)', 95));
    if (decoded.objType === 5) aidPanels.push(renderProtoArtField('Paper doll (F_WEAPON_PAPER_DOLL_AID)', 113));
    if (decoded.objType === 7) aidPanels.push(renderProtoArtField('Paper doll (F_ARMOR_PAPER_DOLL_AID)', 151));
    const aidPanelsPresent = aidPanels.filter(Boolean);
    if (aidPanelsPresent.length) {
      const aidRow = document.createElement('div');
      aidRow.className = 'proto-aid-row';
      aidRow.append(...aidPanelsPresent);
      article.appendChild(aidRow);
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
    syncSidebarLaunchButtons();
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
  if (secExploreBtn) secExploreBtn.addEventListener('click',()=>{ enterSecExplorer(); });
  protoExploreBtn.addEventListener('click',()=>{ enterProtoExplorer(); });
  artExploreBtn.addEventListener('click',()=>{ enterArtExplorer(); });
  explorerHome.querySelectorAll('[data-open-mode]').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.dataset.openMode;
      if (mode === 'art') enterArtExplorer();
      else if (mode === 'pro') enterProtoExplorer();
      else if (mode === 'mob') enterMobExplorer();
      else if (mode === 'sec') enterSecExplorer();
    });
  });

  // ---- File explorer -------------------------------------------------------
  //
  // Folder structure comes from per-folder "<foldername>_manifest.json" files
  // sitting next to the folders they describe under ART_ROOT. Only the
  // manifest for a folder the user actually clicks on gets fetched.

  const ART_ROOT = `${DATA_ROOT}art/`;
  // The root manifest follows the same <foldername>_manifest.json convention.
  const ROOT_FOLDER_NAME = 'art';
  const ROOT_RELATIVE_PATH = '';

  const treeEl = document.getElementById('explorerTree');
  const gridEl = document.getElementById('explorerGrid');
  const breadcrumbEl = document.getElementById('explorerBreadcrumb');
  const manifestCache = new Map(); // relativePath -> parsed manifest json



  const secMobInfoStyle = document.createElement('style');
  secMobInfoStyle.textContent = '.sec-mob-info-row{padding:4px 0;border-bottom:1px solid rgba(127,127,127,.25);overflow-wrap:anywhere;font-size:12px}';
  document.head.appendChild(secMobInfoStyle);

  // ---- .SEC sector explorer ----------------------------------------------
  // A sector stores a variable-length light list followed by exactly 4096
  // uint32 tile Art IDs. The engine addresses those tiles as x + 64*y.
  // See sector_tile_list.c and tile.h in the Arcanum CE source.
  const SEC_ROOT = `${DATA_ROOT}maps/`;
  const secManifestCache = new Map();
  let secManifest = null;
  let secFiles = [];
  let secCurrentPath = '';
  let secCurrentFolderName = 'maps';
  let secMapToken = 0;

  function secJoinPath(parent, child) {
    const a = String(parent || '').replace(/^\/+|\/+$/g, '');
    const b = String(child || '').replace(/^\/+|\/+$/g, '');
    return a && b ? `${a}/${b}` : (a || b);
  }

  async function loadSecManifest(relativePath = '', folderName = 'maps') {
    const path = String(relativePath || '').replace(/^\/+|\/+$/g, '');
    const cacheKey = path || 'maps-root';
    if (secManifestCache.has(cacheKey)) return secManifestCache.get(cacheKey);
    const manifestFolder = !path ? 'maps' : ((folderName && folderName !== '..') ? folderName : path.split('/').pop());
    const url = `${SEC_ROOT}${path ? `${encPath(path)}/` : ''}${encodeURIComponent(manifestFolder)}_manifest.json`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      secManifestCache.set(cacheKey, data);
      return data;
    } catch (err) {
      throw new Error(`couldn't load manifest for ${path ? `/maps/${path}/` : '/maps/'} (${err && err.message ? err.message : err})`);
    }
  }

  function extractSecManifestFiles(manifest) {
    if (Array.isArray(manifest)) {
      return manifest.filter(x => typeof x === 'string' && /\.sec$/i.test(x)).sort((a, b) => a.localeCompare(b));
    }
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    return files
      .map(x => typeof x === 'string' ? x : (x && (x.name || x.filename || x.file)))
      .filter(x => typeof x === 'string' && /\.sec$/i.test(x))
      .sort((a, b) => a.localeCompare(b));
  }

  function secSubfolders(manifest) {
    const sub = manifest?.subfolders && typeof manifest.subfolders === 'object' ? manifest.subfolders : {};
    return Object.keys(sub).sort().map(k => sub[k]).filter(sf => sf && typeof sf === 'object' && sf.folder_name);
  }

  function secDisplayName(path, fallback) {
    return (fallback && fallback !== '..') ? fallback : (path.split('/').filter(Boolean).pop() || 'maps');
  }

  function renderSecTree(manifest, relativePath, folderName) {
    renderDataExplorerTree('maps', relativePath, manifest, loadSecManifest, openSecFolder, secSubfolders,
      (filename, row, path) => openSecFile(filename, path, row), null, extractSecManifestFiles, '🗺️', '', 'maps',
      secDisplayName(relativePath, folderName));
  }

  function renderSecFolderGrid(manifest, relativePath) {
    gridEl.innerHTML = '';
    const subfolders = secSubfolders(manifest);
    for (const sf of subfolders) {
      const fullPath = secJoinPath(relativePath, sf.relative_path || sf.folder_name);
      const card = createDataFolderCard(sf.folder_name, fullPath, openSecFolder);
      gridEl.appendChild(card);
    }
    for (const filename of secFiles) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'explorer-item sec-file-item';
      card.innerHTML = '<span class="explorer-thumb">🗺️</span><span class="explorer-filename"></span>';
      card.querySelector('.explorer-filename').textContent = filename;
      card.addEventListener('click', () => openSecFile(filename, relativePath, null));
      gridEl.appendChild(card);
    }
    if (!subfolders.length && !secFiles.length) {
      gridEl.innerHTML = '<p class="explorer-status">This folder is empty.</p>';
    }
  }

  // SEC static objects are loaded by sector_object_list.c::objlist_load().
  // That routine reads the final int32 as the object count, seeks back to the
  // object-list start, then calls obj_read() once per object. Do NOT call the
  // MOB loader here: the SEC path is deliberately parsed independently even
  // though obj_read() and the standalone .mob writer share the same object
  // serialization primitives.
  //
  // The implementation below mirrors obj_read() / obj_inst_read_file() and
  // obj_data_read_file_fast() from obj.c / obj_private.c: version, two 0x18-byte
  // ObjectIDs, type, num_fields, type-specific change bitmap, then only the
  // overridden fields in object_inst_enumerate_overridden_fields() order.
  function decodeSecStaticObject(bytes, offset, limit, filename, index) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = offset;
    const need = n => {
      if (offset + n > limit) throw new Error(`truncated SEC object #${index} at 0x${offset.toString(16).toUpperCase()}`);
    };
    need(4 + 24 + 24 + 4 + 2);
    const version = view.getUint32(offset, true); offset += 4;
    if (version !== 119) throw new Error(`SEC object #${index}: object file version ${version}, expected 119`);
    const protoOid = bytes.slice(offset, offset + 24); offset += 24;
    const objectOid = bytes.slice(offset, offset + 24); offset += 24;
    const objType = view.getInt32(offset, true); offset += 4;
    const numFields = view.getInt16(offset, true); offset += 2;
    if (objType < 0 || objType >= MOB_TYPE_LAST_FIELD.length) throw new Error(`SEC object #${index}: unsupported object type ${objType}`);
    if (numFields < 0 || numFields > 10000) throw new Error(`SEC object #${index}: invalid num_fields ${numFields}`);

    // sub_40C030(object->type) determines the number of change-array dwords.
    const dwordCount = MOB_ENGINE.dwordCount[objType];
    need(dwordCount * 4);
    const bitmap = [];
    for (let i = 0; i < dwordCount; i++) { bitmap.push(view.getUint32(offset, true)); offset += 4; }

    const fields = [];
    for (const fld of enumerateMobFields(objType)) {
      if (!mobBitIsSet(bitmap, fld)) continue;
      const od = MOB_OD_TYPES[fld];
      const fieldOffset = offset;
      const parsed = readMobField(view, bytes, offset, od);
      offset += parsed.size;
      if (offset > limit) throw new Error(`SEC object #${index}: field ${fld} extends past object-list count`);
      fields.push({
        field: fld,
        name: MOB_FIELD_NAMES[fld] || `FIELD_${String(fld).padStart(3, '0')}`,
        od: MOB_OD_NAMES[od] || `OdType_${od}`,
        change_idx: MOB_ENGINE.changeIdx[fld],
        bit: MOB_ENGINE.masks[fld] ? Math.round(Math.log2(MOB_ENGINE.masks[fld])) : -1,
        offset: fieldOffset,
        size: parsed.size,
        raw: mobHex(bytes.slice(fieldOffset, offset)),
        value: parsed.value
      });
    }

    return {
      filename: `${filename}#object${index}`, size: offset - start, version, objType, numFields,
      actualSet: bitmap.reduce((n, w) => n + ((w >>> 0).toString(2).match(/1/g) || []).length, 0),
      bitmap, protoOid, objectOid, fields, endOffset: offset - start, trailing: new Uint8Array(0)
    };
  }

  function readSecStaticObjects(bytes, objectStart, filename) {
    if (objectStart < 0 || objectStart + 4 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // objlist_load() reads the count by seeking to the final sizeof(int).
    const countPos = bytes.length - 4;
    const count = view.getInt32(countPos, true);
    if (count < 0 || count > 100000) return null;

    let offset = objectStart;
    const objects = [];
    for (let i = 0; i < count; i++) {
      const obj = decodeSecStaticObject(bytes, offset, countPos, filename, i);
      if (!obj || !Number.isInteger(obj.endOffset) || obj.endOffset <= 0) return null;
      offset += obj.endOffset;
      if (offset > countPos) return null;
      objects.push(obj);
    }
    // objlist_load() immediately reads the same final count and rejects if the
    // number of successfully read objects does not match it.
    if (offset !== countPos) {
      throw new Error(`SEC static object list ended at 0x${offset.toString(16).toUpperCase()}, expected final count at 0x${countPos.toString(16).toUpperCase()}`);
    }
    return { offset: objectStart, count, objects };
  }

  function parseSecStaticObjectList(bytes, tileEnd, filename) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = tileEnd;
    const readI32 = () => {
      if (offset + 4 > bytes.length) throw new Error('truncated SEC while reading static-object sections');
      const v = view.getInt32(offset, true); offset += 4; return v;
    };
    const skip = n => {
      if (n < 0 || offset + n > bytes.length) throw new Error('truncated SEC while skipping static-object sections');
      offset += n;
    };

    // sector_roof_list_load(): int empty, followed by 256 art IDs only when the
    // list is NOT empty. (The test used to be inverted, so every sector with an
    // empty roof list skipped 1 KB of object data and the wall list was lost.)
    const roofEmpty = readI32();
    if (roofEmpty === 0) skip(256 * 4);

    // sector_load_editor(): placeholder determines which following sections exist.
    const placeholder = readI32();
    if (placeholder < 0xAA0000 || placeholder > 0xAA0004) {
      throw new Error(`invalid SEC placeholder 0x${(placeholder >>> 0).toString(16).toUpperCase()}`);
    }

    if (placeholder !== 0xAA0000) {
      // tile_script_list_load(): count + 0x18-byte serialized nodes.
      const tileScriptCount = readI32();
      if (tileScriptCount < 0 || tileScriptCount > 100000) throw new Error(`invalid tile-script count ${tileScriptCount}`);
      skip(tileScriptCount * 0x18);

      if (placeholder >= 0xAA0002) {
        // sector_script_list_load(): Script is exactly 0x0C bytes.
        // (script.h: static_assert(sizeof(Script) == 0xC)).
        skip(0x0C);
      }

      if (placeholder >= 0xAA0003) {
        // townmap_info, aptitude_adj, light_scheme, SectorSoundList.
        skip(4 + 4 + 4 + 0x0C);
      }

      if (placeholder >= 0xAA0004) {
        // sector_block_list_load(): uint32_t mask[128] = 512 bytes.
        skip(128 * 4);
      }
    }

    const objectList = readSecStaticObjects(bytes, offset, filename);
    if (!objectList) throw new Error(`could not decode static object list at 0x${offset.toString(16).toUpperCase()}`);
    return { ...objectList, placeholder, roofEmpty, objectListOffset: offset };
  }

  function readSecTileData(buf, filename) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    if (bytes.length < 4) throw new Error('file is too small to contain a sector light count');
    const lightCount = view.getUint32(0, true);
    const tileOffset = 4 + lightCount * 0x30;
    const tileEnd = tileOffset + 4096 * 4;
    if (lightCount > 100000 || tileOffset < 4 || tileEnd > bytes.length) {
      throw new Error(`invalid sector layout: ${lightCount} light records would place the tile list at 0x${tileOffset.toString(16).toUpperCase()}`);
    }
    const tiles = new Uint32Array(4096);
    for (let i = 0; i < 4096; i++) {
      tiles[i] = view.getUint32(tileOffset + i * 4, true);
    }

    // Light records (LightSerializedData, 0x30 bytes, game/light.c): obj i64,
    // loc i64 (x = low dword, y = high dword), offset_x/y i32, flags u32,
    // art_id u32, then r, b, g bytes (in that order), tint, palette, padding.
    const lights = [];
    for (let i = 0; i < lightCount; i++) {
      const o = 4 + i * 0x30;
      lights.push({
        x: view.getUint32(o + 8, true), y: view.getUint32(o + 12, true),
        offsetX: view.getInt32(o + 0x10, true), offsetY: view.getInt32(o + 0x14, true),
        flags: view.getUint32(o + 0x18, true), artId: view.getUint32(o + 0x1C, true),
        r: bytes[o + 0x20], b: bytes[o + 0x21], g: bytes[o + 0x22]
      });
    }

    let objectList = null;
    let staticObjectError = null;
    try {
      objectList = parseSecStaticObjectList(bytes, tileEnd, filename);
    } catch (err) {
      staticObjectError = String(err?.message || err);
    }
    const staticObjects = objectList?.objects || [];
    return {
      filename, size: bytes.length, lightCount, lights, tileOffset, tiles,
      staticObjectOffset: objectList?.offset ?? null,
      staticObjectCount: staticObjects.length,
      staticObjects,
      staticObjectError,
      staticObjectPlaceholder: objectList?.placeholder ?? null
    };
  }

  // Keep the source-derived SEC parser above as the single implementation.
  // The older experimental version accidentally called a removed
  // findSecStaticObjects() helper here, which caused every SEC load to fail.

  // Tile Art IDs in a .sec are packed TIG tile IDs, not the object/item
  // Art IDs used by .mob. The game resolves the user-facing tile number through
  // tilename.mes, then builds the actual ART filename from the tile name plus
  // the canonicalized a3/a4 orientation values.
  const SEC_TILE_NAME_MES_URL = `${DATA_ROOT}art/tile/tilename.mes`;
  // Facades are a separate TIG art type. The CE source resolves them through
  // art\\facade\\facadename.mes and then loads art\\Facade\\<name>.art
  // (a_name.c::a_name_facade_aid_to_fname/build_facade_file_name).
  const SEC_FACADE_NAME_MES_URL = `${DATA_ROOT}art/facade/facadename.mes`;
  let secFacadeNamePromise = null;
  let secFacadeNameMap = null;
  const secFacadeFileCache = new Map();
  const secFacadeFileMissing = new Set();

  const SEC_TILE_MANIFEST_URL = `${DATA_ROOT}art/tile/tile_manifest.json`;
  const SEC_TILE_A3_CODES = '06b489237ea5dc10';
  const SEC_TILE_A3_SET = [0, 1, 8, 3, 4, 5, 6, 7, 8, 3, 10, 11, 6, 7, 14, 15];
  const SEC_TILE_A3_UNSET = [0, 1, 2, 9, 4, 5, 12, 13, 2, 9, 10, 11, 12, 13, 14, 15];
  let secTileNameMesPromise = null;
  let secTileNameMesMap = null;
  let secTileManifestPromise = null;
  let secTileManifestNames = null;
  const secTileArtCache = new Map();
  const secTileArtMissing = new Set();
  // Cache the actual ART file independently from the SEC tile/palette cache.
  // Different SEC tile values can point at the same ART file; the file must
  // only be fetched and parsed once. Promises also collapse simultaneous loads.
  const secTileFileCache = new Map();
  const secTileFileMissing = new Set();

  function parseSecTileNameMes(text) {
    // The game does not use the MES key as the array index. load_tile_names()
    // walks tilename.mes in order and stores entries from each 100-key range
    // into a zero-based array; sub_4EB0C0() later indexes that array with
    // tig_art_tile_id_num1/num2. Mirror that behavior exactly.
    const map = new Map();
    const groups = [[], [], [], []];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*\{(\d+)\}\{([^}]*)\}\s*(.*)$/);
      if (!m) continue;
      const key = Number(m[1]);
      if (!Number.isSafeInteger(key) || key < 0 || key >= 400) continue;
      const raw = m[2].trim();
      const comment = m[3].trim();
      const name = raw.split(/[\s\/]+/)[0] || '';
      const flags = raw.includes('/') ? raw.split('/').slice(1).join('/') : '';
      const group = Math.floor(key / 100);
      groups[group].push({ key, name, raw, comment, flags });
    }
    for (let group = 0; group < groups.length; group++) {
      groups[group].sort((a, b) => a.key - b.key);
      for (let index = 0; index < groups[group].length; index++) {
        // Store by the actual packed tile-name index used by the game.
        map.set(group * 100 + index, groups[group][index]);
      }
    }
    return map;
  }

  // a_name.c::sub_4EC4B0() does NOT index facadename.mes by its {key}. It walks
  // the entries in ascending key order and stores them in a plain array, and
  // build_facade_file_name() then reads facade_names[num]. Mirror that exactly:
  // the facade number is a POSITION in the list.
  function parseSecFacadeNameMes(text) {
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*\{(\d+)\}\{([^}]*)\}/);
      if (!m) continue;
      entries.push([Number(m[1]), m[2].trim()]);
    }
    entries.sort((x, y) => x[0] - y[0]);
    return entries.map(e => e[1]);
  }

  async function loadSecFacadeNames() {
    if (secFacadeNameMap) return secFacadeNameMap;
    if (secFacadeNamePromise) return secFacadeNamePromise;
    secFacadeNamePromise = fetch(SEC_FACADE_NAME_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${SEC_FACADE_NAME_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        secFacadeNameMap = parseSecFacadeNameMes(text);
        return secFacadeNameMap;
      })
      .catch(err => { secFacadeNamePromise = null; throw err; });
    return secFacadeNamePromise;
  }

  // TIG art IDs store the art type in the high nibble.  The object-art
  // values already decoded elsewhere in this viewer confirm the same layout:
  // for example 0x61003A09 is an ITEM art ID (type 6).  Facade is type 11.
  // Do NOT try facade filenames for ordinary tile IDs: doing so can turn a
  // missing tile into an unrelated, but valid-looking, facade.
  const SEC_ART_TYPE_SHIFT = 28;
  const SEC_ART_TYPE_MASK = 0x0F;
  const SEC_ART_TYPE_FACADE = 11;
  const SEC_FACADE_ARTID_BASE = 10000;

  function secArtType(raw) {
    return ((Number(raw) >>> SEC_ART_TYPE_SHIFT) & SEC_ART_TYPE_MASK) >>> 0;
  }

  function secIsFacadeArtId(raw) {
    return secArtType(raw) === SEC_ART_TYPE_FACADE;
  }

  // Facade TIG art ID layout (verified against the facade IDs stored in the
  // Iron Clan HQ sectors):
  //   bit  0       walkable
  //   bits 1-10    frame (index of this cell inside the facade's ART file)
  //   bits 17-24   facade number, low 8 bits
  //   bit  27      facade number, bit 8
  // The number is split around other fields, so it is NOT simply the low 9 bits
  // of the ID. Reading (raw & 0x1FF) returned the walkable/frame bits instead,
  // which is why unrelated facades were being picked.
  function secFacadeNumber(raw) {
    const v = Number(raw) >>> 0;
    return ((v >>> 17) & 0xFF) | ((v >>> 19) & 0x100);
  }

  function secFacadeFrame(raw) {
    return (Number(raw) >>> 1) & 0x3FF;
  }

  function secFacadeWalkable(raw) {
    return (Number(raw) >>> 0) & 1;
  }

  async function loadSecFacadeArt(raw) {
    if (!secIsFacadeArtId(raw)) return null;

    const names = await loadSecFacadeNames();
    const facadeNum = secFacadeNumber(raw);
    const facadeFrame = secFacadeFrame(raw);
    const name = names[facadeNum];
    if (!name) return null;

    const key = name.toLowerCase();
    if (secFacadeFileMissing.has(key)) return null;

    let promise = secFacadeFileCache.get(key);
    if (!promise) {
      promise = (async () => {
        try {
          const resp = await fetch(`${DATA_ROOT}art/facade/${encPath(name)}.art`, { cache: 'no-store' });
          if (!resp.ok) return null;
          const frames = await parseArtBuffer(await resp.arrayBuffer());
          if (!frames.length || !frames[0]?.indices?.length) return null;
          return { frames, filename: `${name}.art`, facadeName: name };
        } catch (_) {
          return null;
        }
      })();
      secFacadeFileCache.set(key, promise);
    }

    const file = await promise;
    if (!file) {
      secFacadeFileMissing.add(key);
      return null;
    }

    // A facade is one big picture cut into many 80x40 cells; each cell in the
    // sector stores which cell (frame) of the ART file it shows. Use the frame
    // from the ID instead of always drawing frame 0. parseArtBuffer() skips
    // empty frames, so look the frame up by its original index.
    const frame = file.frames.find(f => f.index === facadeFrame && f.direction === 0);
    if (!frame) return null;
    const palette = (frame.palettes && frame.palettes[0]) || frame.palette;
    if (!palette) return null;

    return {
      canvas: frameCanvasForPalette(frame, palette, 0),
      filename: file.filename,
      facadeNum,
      facadeFrame,
      facadeName: file.facadeName,
      paletteIndex: 0,
      width: frame.width,
      height: frame.height
    };
  }

  async function loadSecTileNameMes() {
    if (secTileNameMesMap) return secTileNameMesMap;
    if (secTileNameMesPromise) return secTileNameMesPromise;
    secTileNameMesPromise = fetch(SEC_TILE_NAME_MES_URL, { cache: 'no-store' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${SEC_TILE_NAME_MES_URL}`);
        return resp.arrayBuffer();
      })
      .then(buf => {
        let text;
        try { text = new TextDecoder('windows-1252').decode(buf); }
        catch (_) { text = new TextDecoder('latin1').decode(buf); }
        secTileNameMesMap = parseSecTileNameMes(text);
        return secTileNameMesMap;
      })
      .catch(err => { secTileNameMesPromise = null; throw err; });
    return secTileNameMesPromise;
  }

  async function loadSecTileManifest() {
    if (secTileManifestNames) return secTileManifestNames;
    if (secTileManifestPromise) return secTileManifestPromise;
    secTileManifestPromise = (async () => {
      try {
        const resp = await fetch(SEC_TILE_MANIFEST_URL, { cache: 'no-store' });
        if (resp.ok) {
          const data = await resp.json();
          const files = Array.isArray(data)
            ? data
            : (Array.isArray(data?.files) ? data.files.map(x => typeof x === 'string' ? x : (x && (x.name || x.filename || x.file))) : []);
          secTileManifestNames = new Map(files.filter(f => typeof f === 'string' && /\.art$/i.test(f)).map(f => [f.toLowerCase(), f]));
          return secTileManifestNames;
        }
      } catch (_) {}
      // A missing manifest should not break the viewer. The filename itself
      // remains usable as a last-resort fetch target.
      secTileManifestNames = new Map();
      return secTileManifestNames;
    })().catch(err => { secTileManifestPromise = null; throw err; });
    return secTileManifestPromise;
  }

  function decodeSecTileArtId(raw) {
    const aid = Number(raw) >>> 0;
    const num1 = (aid >>> 22) & 0x3F;
    const num2 = (aid >>> 16) & 0x3F;
    const type = (aid >>> 8) & 0x01;
    const flippable1 = (aid >>> 7) & 0x01;
    const flippable2 = (aid >>> 6) & 0x01;
    const flags = aid & 0x0F;
    const storedA3 = (aid >>> 12) & 0x0F;
    const storedA4 = (aid >>> 9) & 0x07;

    // Exact inverse of sub_503700()/sub_5037B0() in art.c.
    // The extracted edge ART files (e.g. sw1sw24h.art) are named from the STORED
    // a3/a4 values. Remapping a3 through the UNSET table produced codes for which
    // no file exists (b/c/d/e), so edge and sector-border tiles drew nothing.
    // Verified against tile_manifest.json: every tile in the test sector resolves.
    const a3 = storedA3;
    const a4 = storedA4;

    const artId = type === 1
      ? (flippable1 ? 0 : 100) + num1
      : (flippable1 ? 200 : 300) + num1;
    return { raw: aid, artId, num1, num2, type, flippable1, flippable2, a3, a4, flags };
  }

  function secTileInfo(raw) {
    if (secIsFacadeArtId(raw)) {
      const facadeNum = secFacadeNumber(raw);
      const facadeFrame = secFacadeFrame(raw);
      const facadeName = Array.isArray(secFacadeNameMap) ? (secFacadeNameMap[facadeNum] || null) : null;
      // artId is offset so facades never share a legend/colour bucket with a
      // real tile that happens to have the same number.
      return {
        ...decodeSecTileArtId(raw),
        raw: Number(raw) >>> 0,
        isFacade: true, facadeNum, facadeFrame, facadeName,
        artId: SEC_FACADE_ARTID_BASE + facadeNum,
        name: facadeName ? `Facade ${facadeNum}: ${facadeName}` : `Facade ${facadeNum}`,
        mesRaw: null
      };
    }
    const decoded = decodeSecTileArtId(raw);
    const entry = secTileNameMesMap ? secTileNameMesMap.get(decoded.artId) : null;
    return { ...decoded, name: entry ? entry.name : null, mesRaw: entry ? entry.raw : null };
  }

  function secTileArtFilename(tile) {
    // This mirrors a_name.c::build_tile_file_name() exactly.
    const e1 = secTileNameMesMap?.get(tile.artId);
    const num2Id = (tile.type === 1
      ? (tile.flippable2 ? 0 : 100)
      : (tile.flippable2 ? 200 : 300)) + tile.num2;
    const e2 = secTileNameMesMap?.get(num2Id);
    const name1 = e1?.name || `tile${tile.artId}`;
    const name2 = e2?.name || name1;
    const index1 = e1 ? tile.artId : 999999;
    const index2 = e2 ? num2Id : 999999;
    const candidates = [];
    const add = value => {
      if (value && !candidates.some(c => c.toLowerCase() === value.toLowerCase())) candidates.push(value);
    };
    const suffix = (name, a3, a4) => {
      const safeA3 = Math.max(0, Math.min(15, a3 | 0));
      const safeA4 = Math.max(0, Math.min(15, a4 | 0));
      const aa4 = safeA4 >= 8 ? safeA4 - 8 : safeA4;
      return `${name}bse${SEC_TILE_A3_CODES[safeA3]}${String.fromCharCode(97 + aa4)}.art`;
    };

    if (tile.a4 >= 0) {
      if (tile.a3 === 15 || name1.toLowerCase() === name2.toLowerCase()) {
        add(suffix(name1, tile.a3, tile.a4));
      } else if (tile.a3 === 0) {
        add(suffix(name2, 0, tile.a4));
      } else if (!e1) {
        add(suffix(name1, tile.a3, tile.a4));
      } else if (!e2) {
        add(suffix(name1, tile.a3, tile.a4));
      } else if (index1 < index2) {
        add(`${name1}${name2}${SEC_TILE_A3_CODES[tile.a3]}${String.fromCharCode(97 + (tile.a4 >= 8 ? tile.a4 - 8 : tile.a4))}.art`);
      } else {
        add(`${name2}${name1}${SEC_TILE_A3_CODES[15 - tile.a3]}${String.fromCharCode(97 + (tile.a4 >= 8 ? tile.a4 - 8 : tile.a4))}.art`);
      }
    }

    // Do not fall back to a bare <name>.art here. The game constructs exactly
    // one tile filename from the packed tile ID; choosing another valid ART
    // file can make a SEC tile look plausible while actually being wrong.
    return candidates;
  }

  function secTileColor(artId) {
    if (artId >= SEC_FACADE_ARTID_BASE) {
      const h = Math.imul((artId >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
      const f = 0.8 + ((h >>> 8) % 40) / 100;
      return `rgb(${Math.round(130 * f)}, ${Math.round(90 * f)}, ${Math.round(160 * f)})`;
    }
    const info = secTileNameMesMap?.get(artId);
    const text = `${info?.name || ''} ${info?.comment || ''} ${info?.raw || ''}`.toLowerCase();

    // Keep colors semantically coherent with tilename.mes, while still giving
    // different Art IDs slightly different shades inside the same material.
    let base = [82, 82, 82];
    const families = [
      [/\bblack(?:ened)?\b|\bobsidian\b/, [56,56,56]],
      [/\bdead\s+grass\b/, [135,125,62]],
      [/\bgrass\b|\bmeadow\b|\bvegetation\b|\bleaf\b|\bleaves\b/, [67,125,48]],
      [/\bdirt\b|\bmud\b|\bearth\b|\bsoil\b|\bbog\b/, [112,75,42]],
      [/\bsand\b|\bdesert\b|\bbeach\b/, [194,161,91]],
      [/\bsnow\b|\bice\b|\bfrost\b/, [207,222,232]],
      [/\bwater\b|\bsea\b|\blake\b|\briver\b|\bpond\b|\bshallow\s+water\b|\bdeep\s+water\b/, [53,116,154]],
      [/\brock\b|\bstone\b|\bgranite\b|\bmarble\b|\bconcrete\b|\bbrick\b|\bsidewalk\b|\bpavement\b|\basphalt\b/, [105,105,105]],
      [/\bwood\b|\bplank\b|\btimber\b|\blog\b/, [137,91,55]],
      [/\bmetal\b|\biron\b|\bsteel\b/, [112,119,125]],
      [/\bmarsh\b|\bswamp\b/, [92,108,62]],
      [/\bdark\b/, [48,48,48]],
      [/\blight\b|\bwhite\b/, [198,198,198]]
    ];
    for (const [re, rgb] of families) {
      if (re.test(text)) { base = rgb; break; }
    }

    // tilename.mes explicitly defines the footstep number: 0 dirt, 1 sand,
    // 2 snow, 3 stone, 4 water, 5 wood. Use it only when the description did
    // not already identify a material.
    if (base[0] === 82 && base[1] === 82 && base[2] === 82) {
      const sound = Number((info?.raw || '').match(/(?:^|\s)([0-5])\s*$/)?.[1]);
      const soundBase = {
        0: [112,75,42], 1: [194,161,91], 2: [207,222,232],
        3: [105,105,105], 4: [53,116,154], 5: [137,91,55]
      };
      if (soundBase[sound]) base = soundBase[sound];
    }

    // Deterministic shade variation: same material family stays visually
    // coherent, but each Art ID remains distinguishable on the map.
    let h = Math.imul((artId >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 13;
    const factor = 0.82 + ((h >>> 8) % 37) / 100;
    const rgb = base.map(v => Math.max(0, Math.min(255, Math.round(v * factor))));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function secTileLegendEntries(tiles) {
    const counts = new Map();
    for (const raw of tiles) {
      const info = secTileInfo(raw);
      const entry = counts.get(info.artId) || { artId: info.artId, name: info.name, count: 0, color: secTileColor(info.artId) };
      entry.count++;
      if (!entry.name && info.name) entry.name = info.name;
      counts.set(info.artId, entry);
    }
    return [...counts.values()].sort((a, b) => a.artId - b.artId);
  }

  async function loadSecTileFile(exact) {
    const key = String(exact).toLowerCase();
    if (secTileFileCache.has(key)) return secTileFileCache.get(key);
    if (secTileFileMissing.has(key)) return null;

    const promise = (async () => {
      try {
        const url = `${DATA_ROOT}art/tile/${encPath(exact)}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) return null;
        const buffer = await resp.arrayBuffer();
        const frames = await parseArtBuffer(buffer);
        if (!frames.length || !frames[0] || !frames[0].indices?.length) return null;
        return { frames, filename: exact };
      } catch (_) {
        return null;
      }
    })();

    secTileFileCache.set(key, promise);
    const result = await promise;
    if (!result) secTileFileMissing.add(key);
    return result;
  }

  async function loadSecTileArt(tile) {
    // A facade ID must never go through the ordinary-tile path: decoding it as a
    // tile produces a bogus tile number, and if a tile ART with that name exists
    // it would be drawn instead of the facade. Resolve facades first.
    if (secIsFacadeArtId(tile?.raw)) {
      const fKey = `${tile.raw}|facade`;
      if (secTileArtCache.has(fKey)) return secTileArtCache.get(fKey);
      if (secTileArtMissing.has(fKey)) return null;
      try {
        const facade = await loadSecFacadeArt(tile.raw);
        if (facade) { secTileArtCache.set(fKey, facade); return facade; }
      } catch (_) {}
      secTileArtMissing.add(fKey);
      return null;
    }

    // BLK is a deliberate empty/blank tile. There is no useful ART file to
    // fetch for it, and large sectors can contain thousands of these.
    if (String(tile?.name || '').trim().toUpperCase() === 'BLK') return null;

    const cacheKey = `${tile.raw}|${tile.artId}`;
    if (secTileArtCache.has(cacheKey)) return secTileArtCache.get(cacheKey);
    if (secTileArtMissing.has(cacheKey)) return null;

    const manifest = await loadSecTileManifest();
    const candidates = secTileArtFilename(tile);
    const tried = [];

    // Resolve the filename first, then use the shared ART-file cache. This is
    // important because multiple SEC tile encodings can refer to the same ART
    // file while selecting different palettes/orientations.
    for (const candidate of candidates) {
      const exact = manifest.get(String(candidate).toLowerCase()) || candidate;
      if (tried.some(v => v.toLowerCase() === exact.toLowerCase())) continue;
      tried.push(exact);

      const file = await loadSecTileFile(exact);
      if (!file) continue;

      const frame = file.frames[0];
      const palettes = frame.palettes || [];
      const paletteIndex = palettes.length
        ? Math.max(0, Math.min(palettes.length - 1, (tile.raw >>> 4) & 3))
        : 0;
      const palette = palettes[paletteIndex] || frame.palette;
      if (!palette) continue;

      const rendered = frameCanvasForPalette(frame, palette, 0);
      const result = {
        canvas: rendered,
        filename: file.filename,
        paletteIndex,
        width: frame.width,
        height: frame.height
      };
      secTileArtCache.set(cacheKey, result);
      return result;
    }

    secTileArtMissing.add(cacheKey);
    return null;
  }

  function secIsoFitView(cssW, cssH, bounds) {
    const iso = secIsoMetrics(bounds);
    const zoom = Math.max(.01, Math.min((cssW - 24) / iso.width, (cssH - 24) / iso.height));
    return {
      zoom,
      offsetX: (cssW - iso.width * zoom) / 2,
      offsetY: (cssH - iso.height * zoom) / 2
    };
  }

  // Map viewer background (plain black).
  const SEC_MAP_BACKGROUND = '#000000';
  function drawSecMap(canvas, tiles, selected, mode, artTiles) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(320, Math.floor(canvas.clientWidth || 760));
    const cssH = Math.max(260, Math.floor(canvas.clientHeight || 620));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = SEC_MAP_BACKGROUND;
    ctx.fillRect(0, 0, cssW, cssH);

    const bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const iso = secIsoMetrics(bounds);

    if (mode === 'color') {
      const cell = Math.min(cssW, cssH) / 64;
      const left = (cssW - cell * 64) / 2;
      const top = (cssH - cell * 64) / 2;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const raw = tiles[y * 64 + x] >>> 0;
        const tile = secTileInfo(raw);
        ctx.fillStyle = secTileColor(tile.artId);
        ctx.fillRect(left + x * cell, top + y * cell, Math.ceil(cell + .1), Math.ceil(cell + .1));
      }
      ctx.strokeStyle = 'rgba(0,0,0,.16)';
      ctx.lineWidth = .5;
      for (let i = 0; i <= 64; i++) {
        const px = Math.round(left + i * cell) + .5;
        const py = Math.round(top + i * cell) + .5;
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + 64 * cell); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(left + 64 * cell, py); ctx.stroke();
      }
      if (selected) {
        ctx.strokeStyle = '#ffe066';
        ctx.lineWidth = Math.max(1.5, cell * .08);
        ctx.strokeRect(left + selected.x * cell + .5, top + selected.y * cell + .5, cell - 1, cell - 1);
      }
      return;
    }

    const fit = secIsoFitView(cssW, cssH, bounds);
    const ox = fit.offsetX, oy = fit.offsetY, fitZoom = fit.zoom;
    drawSecActualTiles(ctx, [{ decoded: { tiles }, position: { x: 0, y: 0 } }], bounds, artTiles, fit);

    if (selected) {
      const p = secIsoProject(selected.x, selected.y, iso);
      const px = p.x * fitZoom + ox, py = p.y * fitZoom + oy;
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = Math.max(1.5, Math.min(4, fitZoom * .18));
      ctx.beginPath();
      ctx.moveTo(px, py - SEC_ISO_HALF_H * fitZoom);
      ctx.lineTo(px + SEC_ISO_HALF_W * fitZoom, py);
      ctx.lineTo(px, py + SEC_ISO_HALF_H * fitZoom);
      ctx.lineTo(px - SEC_ISO_HALF_W * fitZoom, py);
      ctx.closePath();
      ctx.stroke();
    }
  }

  function drawSecActualTiles(ctx, sectors, bounds, artTiles, view) {
    const iso = secIsoMetrics(bounds);
    const zoom = Math.max(0.01, Math.min(32, Number(view?.zoom) || 1));
    const ox = Number(view?.offsetX) || 0;
    const oy = Number(view?.offsetY) || 0;
    const dpr = window.devicePixelRatio || 1;
    const cssW = ctx.canvas.width / dpr;
    const cssH = ctx.canvas.height / dpr;

    for (const sector of sectors || []) {
      if (!sector?.decoded || !sector.position) continue;
      const baseX = (sector.position.x - bounds.minX) * 64;
      const baseY = (sector.position.y - bounds.minY) * 64;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const raw = sector.decoded.tiles[y * 64 + x] >>> 0;
        if (raw === 0) continue;
        const center = secIsoProject(baseX + x, baseY + y, iso);
        const art = artTiles?.get(raw);
        if (!art?.canvas) continue;
        // Draw the ART frame at its own native size, centred on the tile.
        // Edge/transition tiles are not guaranteed to be the same size as a
        // plain 78x40 floor tile; forcing them into 78x40 squashed or clipped
        // their blended borders.
        const artW = art.canvas.width || SEC_ISO_TILE_W;
        const artH = art.canvas.height || SEC_ISO_TILE_H;
        const left = center.x - artW / 2;
        const right = center.x + artW / 2;
        const top = center.y - artH / 2;
        const bottom = center.y + artH / 2;
        if (right * zoom + ox < 0 || left * zoom + ox > cssW || bottom * zoom + oy < 0 || top * zoom + oy > cssH) continue;
        const dw = artW * zoom;
        const dh = artH * zoom;
        const px = center.x * zoom + ox;
        const py = center.y * zoom + oy;
        ctx.drawImage(art.canvas, px - dw / 2, py - dh / 2, dw, dh);
      }
    }
  }

  function renderSecViewer(decoded, relativePath) {
    const article = document.createElement('article');
    article.className = 'sec-viewer';
    const head = document.createElement('div');
    head.className = 'sec-viewer-head';
    head.innerHTML = `<div><h2 class="sec-viewer-title"></h2><div class="sec-viewer-meta"></div></div>`;
    head.querySelector('.sec-viewer-title').textContent = decoded.filename;
    head.querySelector('.sec-viewer-meta').textContent = `${decoded.size.toLocaleString()} bytes · ${decoded.lightCount} light record${decoded.lightCount === 1 ? '' : 's'} · tile list @ 0x${decoded.tileOffset.toString(16).toUpperCase()}`;
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'btn-back'; back.textContent = '← Back to folder';
    back.addEventListener('click', () => openSecFolder(relativePath, secCurrentFolderName));
    head.appendChild(back);
    article.appendChild(head);

    let mobPoints = [];
    let mobDiagnostics = null;
    loadMobsForSecMap(relativePath, secManifest).then(points => { mobPoints = points; mobDiagnostics = points.mobDiagnostics || null; redraw(); }).catch(err => { mobDiagnostics = { relativePath, manifestLoaded: false, manifestError: String(err?.message || err), manifestMobFiles: 0, filesExamined: 0, fetchFailures: [], decodeFailures: [], locationFailures: [], loaded: 0, wallLoaded: 0, objectTypeCounts: {} }; redraw(); });

    const layout = document.createElement('div');
    layout.className = 'sec-map-layout';
    const mapCard = document.createElement('section'); mapCard.className = 'sec-map-card';
    const toolbar = document.createElement('div'); toolbar.className = 'sec-map-toolbar';
    const status = document.createElement('span'); status.className = 'sec-viewer-meta';
    status.textContent = '64 × 64 tiles';
    toolbar.appendChild(status);
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button'; modeBtn.className = 'btn-back sec-map-mode';
    modeBtn.textContent = 'Show actual tiles';
    toolbar.appendChild(modeBtn);
    mapCard.appendChild(toolbar);
    const stage = document.createElement('div'); stage.className = 'sec-map-stage';
    const canvas = document.createElement('canvas');
    const tip = document.createElement('div'); tip.className = 'sec-map-tooltip'; tip.hidden = true;
    stage.appendChild(canvas); stage.appendChild(tip); mapCard.appendChild(stage);
    const hint = document.createElement('p'); hint.className = 'sec-map-hint';
    hint.textContent = "Actual tiles are shown in the game's isometric 78 × 40 format. Hover for coordinates and Art ID; click a tile to inspect it.";
    mapCard.appendChild(hint);

    const info = document.createElement('aside'); info.className = 'sec-tile-info';
    info.innerHTML = '<h3>Art IDs on map</h3><div class="sec-art-legend"></div><hr><h3>Selected tile</h3><div class="sec-info-row"><span>Position</span><span>—</span></div><div class="sec-info-row"><span>Index</span><span>—</span></div><div class="sec-info-row"><span>Art ID</span><span>—</span></div><div class="sec-info-row"><span>Tile</span><span>—</span></div><div class="sec-info-row"><span>Hex</span><span>—</span></div>';
    layout.appendChild(mapCard); layout.appendChild(info); article.appendChild(layout);

    const legendEl = info.querySelector('.sec-art-legend');
    const legendEntries = secTileLegendEntries(decoded.tiles);
    legendEntries.forEach(entry => {
      const row = document.createElement('div'); row.className = 'sec-art-legend-row';
      const swatch = document.createElement('span'); swatch.className = 'sec-art-legend-swatch'; swatch.style.background = entry.color;
      const label = document.createElement('span'); label.className = 'sec-art-legend-label';
      label.textContent = `${entry.artId}${entry.name ? ` · ${entry.name}` : ''}`;
      const count = document.createElement('span'); count.className = 'sec-art-legend-count'; count.textContent = String(entry.count);
      row.append(swatch, label, count); legendEl.appendChild(row);
    });

    let selected = null;
    let mode = 'color';
    let artTiles = new Map();
    let artLoadStarted = false;
    const infoRows = info.querySelectorAll('.sec-info-row span:last-child');
    const redraw = () => drawSecMap(canvas, decoded.tiles, selected, mode, artTiles);
    const updateInfo = (x, y) => {
      const index = y * 64 + x;
      const rawAid = decoded.tiles[index] >>> 0;
      const tile = secTileInfo(rawAid);
      infoRows[0].textContent = `${x}, ${y}`;
      infoRows[1].textContent = String(index);
      infoRows[2].textContent = String(tile.artId);
      infoRows[3].textContent = tile.name || '—';
      infoRows[4].textContent = `0x${rawAid.toString(16).padStart(8, '0').toUpperCase()}`;
      selected = { x, y }; redraw();
    };
    const pointFromEvent = (event) => {
      const r = canvas.getBoundingClientRect();
      const sx = event.clientX - r.left;
      const sy = event.clientY - r.top;
      if (mode === 'art') {
        const fit = secIsoFitView(r.width, r.height, { minX: 0, maxX: 0, minY: 0, maxY: 0 });
        const isoPoint = secIsoUnproject((sx - fit.offsetX) / fit.zoom, (sy - fit.offsetY) / fit.zoom, secIsoMetrics({ minX: 0, maxX: 0, minY: 0, maxY: 0 }));
        return {
          x: Math.max(0, Math.min(63, Math.floor(isoPoint.x + .5))),
          y: Math.max(0, Math.min(63, Math.floor(isoPoint.y + .5)))
        };
      }
      const cell = Math.min(r.width, r.height) / 64;
      const left = (r.width - cell * 64) / 2;
      const top = (r.height - cell * 64) / 2;
      return {
        x: Math.max(0, Math.min(63, Math.floor((sx - left) / cell))),
        y: Math.max(0, Math.min(63, Math.floor((sy - top) / cell)))
      };
    };
    canvas.addEventListener('mousemove', (event) => {
      const { x, y } = pointFromEvent(event);
      const rawAid = decoded.tiles[y * 64 + x] >>> 0;
      const tile = secTileInfo(rawAid);
      tip.hidden = false;
      tip.textContent = `Tile ${x}, ${y} · index ${y * 64 + x} · Art ID ${tile.artId}${tile.name ? ` · ${tile.name}` : ''}`;
      const sr = stage.getBoundingClientRect();
      tip.style.left = `${event.clientX - sr.left}px`;
      tip.style.top = `${event.clientY - sr.top}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
    canvas.addEventListener('click', (event) => { const p = pointFromEvent(event); updateInfo(p.x, p.y); });

    modeBtn.addEventListener('click', async () => {
      mode = mode === 'color' ? 'art' : 'color';
      modeBtn.textContent = mode === 'art' ? 'Show colors' : 'Show actual tiles';
      if (mode === 'art' && !artLoadStarted) {
        artLoadStarted = true;
        modeBtn.disabled = true;
        modeBtn.textContent = 'Loading tiles…';
        try {
          await loadSecTileNameMes();
          await loadSecTileManifest();
          const uniqueRaw = [...new Set(decoded.tiles.map(v => v >>> 0))];
          // Fetch/decode each distinct packed tile only once. Drawing 4096
          // positions then becomes a cheap canvas operation.
          await Promise.all(uniqueRaw.map(async raw => {
            const tile = secTileInfo(raw);
            const art = await loadSecTileArt(tile);
            if (art) artTiles.set(raw, art);
          }));
          const loadedCount = artTiles.size;
          status.textContent = `${loadedCount}/${uniqueRaw.length} distinct tile art files loaded`;
          if (!loadedCount) {
            console.warn('SEC actual-tile mode: no ART files could be loaded', uniqueRaw.map(raw => ({ raw, ...secTileInfo(raw), candidates: secTileArtFilename(secTileInfo(raw)) })));
          }
        } finally {
          modeBtn.disabled = false;
          modeBtn.textContent = 'Show colors';
        }
      }
      redraw();
    });

    const ro = new ResizeObserver(redraw);
    ro.observe(stage);
    redraw();
    return article;
  }

  async function openSecFile(filename, relativePath, rowEl) {
    if (rowEl) treeEl.querySelectorAll('.mob-file-row.active').forEach(r => r.classList.remove('active'));
    if (rowEl) rowEl.classList.add('active');
    const token = ++secMapToken;
    try {
      const prefix = relativePath ? `${relativePath}/` : '';
      const resp = await fetch(`${SEC_ROOT}${encPath(prefix)}${encPath(filename)}`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`couldn't load ${filename} (HTTP ${resp.status})`);
      const decoded = readSecTileData(await resp.arrayBuffer(), filename);
      try { await loadSecTileNameMes(); } catch (_) {}
      if (token !== secMapToken) return;
      gridEl.hidden = true; paginationEl.hidden = true; viewerEl.innerHTML = '';
      viewerEl.appendChild(renderSecViewer(decoded, relativePath));
      viewerEl.hidden = false;
      viewerEl.classList.add('revealed');
      saveDataExplorerState('sec', relativePath, secCurrentFolderName, filename);
      viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      gridEl.innerHTML = '';
      const p = document.createElement('p'); p.className = 'explorer-status err';
      p.textContent = err && err.message ? err.message : String(err);
      gridEl.appendChild(p); gridEl.hidden = false; viewerEl.hidden = true;
    }
  }

  function parseSecSectorPosition(filename) {
    const stem = String(filename || '').replace(/\.sec$/i, '').trim();
    if (!/^\d+$/.test(stem)) return null;
    try {
      const id = BigInt(stem);
      const mask = (1n << 26n) - 1n;
      return { id, x: Number(id & mask), y: Number((id >> 26n) & mask) };
    } catch (_) { return null; }
  }

  async function loadSecFolderSectors(relativePath, filenames, onProgress) {
    const results = [];
    const queue = filenames.map((filename, index) => ({ filename, index }));
    const workerCount = Math.min(4, Math.max(1, queue.length));
    let completed = 0;

    const loadOne = async item => {
      const { filename, index } = item;
      const position = parseSecSectorPosition(filename);
      let result;
      if (!position) {
        result = { filename, index, position: null, decoded: null, error: 'filename does not contain a numeric sector ID' };
      } else {
        try {
          const prefix = relativePath ? `${relativePath}/` : '';
          const resp = await fetch(`${SEC_ROOT}${encPath(prefix)}${encPath(filename)}`, { cache: 'no-store' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          result = { filename, index, position, decoded: readSecTileData(await resp.arrayBuffer(), filename), error: null };
        } catch (err) {
          result = { filename, index, position, decoded: null, error: err && err.message ? err.message : String(err) };
        }
      }
      results[index] = result;
      completed++;
      if (typeof onProgress === 'function') onProgress(completed, filenames.length, result);
    };

    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const item = queue[next++];
        await loadOne(item);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results.filter(item => item && item.position);
  }

  function renderSecFolderLoading(folderName, total) {
    const article = document.createElement('article');
    article.className = 'sec-viewer sec-folder-loading';
    article.innerHTML = `
      <div class="sec-viewer-head"><div>
        <h2 class="sec-viewer-title"></h2>
        <div class="sec-viewer-meta">Reading all SEC sectors in this folder…</div>
      </div></div>
      <section class="sec-map-card sec-loading-card">
        <div class="sec-loading-title">Loading map…</div>
        <div class="sec-loading-sector">Preparing sector 1 / ${total}</div>
        <div class="sec-loading-track"><div class="sec-loading-fill"></div></div>
        <div class="sec-loading-percent">0%</div>
      </section>`;
    article.querySelector('.sec-viewer-title').textContent = `Map · ${folderName}`;
    const sectorEl = article.querySelector('.sec-loading-sector');
    const fillEl = article.querySelector('.sec-loading-fill');
    const percentEl = article.querySelector('.sec-loading-percent');
    return { article, update(done, count, result) {
      const pct = count ? Math.round(done * 100 / count) : 100;
      const pos = result?.position;
      const label = pos ? `Sector ${pos.x}, ${pos.y}` : result?.filename || 'Unknown sector';
      sectorEl.textContent = `${label} · ${done} / ${count}${result?.error ? ` · ${result.error}` : ''}`;
      fillEl.style.width = `${pct}%`;
      percentEl.textContent = `${pct}%`;
    }};
  }

  const SEC_ISO_TILE_W = 78;
  const SEC_ISO_TILE_H = 40;
  const SEC_ISO_HALF_W = SEC_ISO_TILE_W / 2;
  const SEC_ISO_HALF_H = SEC_ISO_TILE_H / 2;

  function secIsoMetrics(bounds) {
    const cols = bounds.maxX - bounds.minX + 1;
    const rows = bounds.maxY - bounds.minY + 1;
    const worldW = cols * 64;
    const worldH = rows * 64;
    // World X increases leftward and world Y increases downward.  The center
    // of tile (0,0) is therefore at the top-right of the isometric diamond.
    const span = (worldW - 1) + (worldH - 1);
    return {
      worldW,
      worldH,
      width: span * (SEC_ISO_TILE_W / 2) + SEC_ISO_TILE_W,
      height: span * (SEC_ISO_TILE_H / 2) + SEC_ISO_TILE_H,
      originX: (worldW - 1) * SEC_ISO_HALF_W + SEC_ISO_HALF_W,
      originY: SEC_ISO_HALF_H
    };
  }

  function secIsoProject(localX, localY, metrics) {
    return {
      x: metrics.originX + (localY - localX) * SEC_ISO_HALF_W,
      y: metrics.originY + (localX + localY) * SEC_ISO_HALF_H
    };
  }

  function secIsoUnproject(screenX, screenY, metrics) {
    const dx = (screenX - metrics.originX) / SEC_ISO_HALF_W;
    const dy = (screenY - metrics.originY) / SEC_ISO_HALF_H;
    return {
      x: (dy - dx) / 2,
      y: (dy + dx) / 2
    };
  }

  async function loadMobsForSecMap(relativePath = '', manifestHint = null) {
    const diagnostics = {
      relativePath: String(relativePath || ''),
      manifestLoaded: false,
      manifestError: null,
      manifestMobFiles: 0,
      filesExamined: 0,
      fetchFailures: [],
      decodeFailures: [],
      locationFailures: [],
      loaded: 0,
      wallLoaded: 0,
      staticObjectCount: 0,
      staticObjectTypeCounts: {},
      staticObjectErrors: [],
      objectTypeCounts: {}
    };
    let manifest = manifestHint;
    if (!manifest) {
      try { manifest = await loadSecManifest(relativePath, secDisplayName(relativePath, relativePath ? '' : 'maps')); diagnostics.manifestLoaded = true; }
      catch (err) { diagnostics.manifestError = String(err?.message || err); const empty = []; empty.mobDiagnostics = diagnostics; return empty; }
    } else {
      diagnostics.manifestLoaded = true;
    }
    // Only use MOBs listed directly in the manifest for the map folder being
    // displayed. Child folders are loaded when the user opens those folders.
    const rawFiles = Array.isArray(manifest)
      ? manifest
      : (Array.isArray(manifest?.files) ? manifest.files : []);
    const files = rawFiles.map(x => typeof x === 'string' ? x : (x && (x.name || x.filename || x.file || x.path)))
      .filter(x => typeof x === 'string' && /\.mob$/i.test(x));
    diagnostics.manifestMobFiles = files.length;
    const prefix = String(relativePath || '').replace(/^\/+|\/+$/g, '');
    const points = [];
    const BATCH = 32;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      await Promise.all(batch.map(async name => {
        const path = /\//.test(name) ? name.replace(/^\/+/, '') : (prefix ? `${prefix}/${name}` : name);
        diagnostics.filesExamined++;
        try {
          const resp = await fetch(`${MOB_ROOT}${encPath(path)}`);
          if (!resp.ok) {
            diagnostics.fetchFailures.push({ file: path, status: resp.status, statusText: resp.statusText });
            return;
          }
          let mob;
          try {
            mob = decodeMobBuffer(await resp.arrayBuffer(), name.split('/').pop());
          } catch (err) {
            diagnostics.decodeFailures.push({ file: path, error: String(err?.message || err), stack: String(err?.stack || '') });
            return;
          }
          const typeKey = String(mob.objType);
          diagnostics.objectTypeCounts[typeKey] = (diagnostics.objectTypeCounts[typeKey] || 0) + 1;
          // Items carried by a critter or stored in a container have OF_INVENTORY
          // (0x1000) set in F_FLAGS; the game never places them in the world
          // (objlist_insert_internal() refuses them), so they must not be drawn.
          const mobFlagsField = mob.fields.find(f => f.field === 19);
          if (mobFlagsField && ((Number(mobFlagsField.value) >>> 0) & 0x1000)) {
            diagnostics.inventoryItemsSkipped = (diagnostics.inventoryItemsSkipped || 0) + 1;
            return;
          }
          const locField = mob.fields.find(f => f.field === 2);
          const loc = locField ? mobLocationInfo(locField.value) : null;
          if (!loc) {
            diagnostics.locationFailures.push({ file: path, objectType: mob.objType, locationRaw: locField?.value ?? null });
            return;
          }
          const aidField = mob.fields.find(f => f.field === 1);
          let artId = aidField ? protoCurrentAidArtId(aidField.value, mob.objType) : null;
          let inheritedAidRaw = null;
          let wallArt = null;
          if (mob.objType === 0 && aidField) {
            try { wallArt = await loadWallArtFromRaw(aidField.value); } catch (_) { wallArt = null; }
          }
          const nameField = mob.fields.find(f => f.field === 22);
          const mobName = nameField?.value != null && String(nameField.value).trim() ? String(nameField.value).trim() : (mob.filename || name.split('/').pop());
          if (artId === null) {
            try {
              const proto = await resolveMobPrototype(mob, window.__secMobProtoCache || (window.__secMobProtoCache = new Map()));
              const pf = proto.decodedProto?.fields?.find(f => f.field === 1);
              if (pf) {
                inheritedAidRaw = pf.value;
                artId = protoCurrentAidArtId(pf.value, mob.objType);
              }
            } catch (_) {}
          }
          const resolvedAidRaw = aidField?.value ?? inheritedAidRaw;
          const artObjType = protoArtObjectType(inheritedAidRaw ?? aidField?.value, mob.objType);
          const paletteIndex = artObjType === 3 && resolvedAidRaw != null
            ? (Number(resolvedAidRaw) >>> 4) & 3
            : null;
          const sceneryRotation = (artObjType === 3 || artObjType === 2 || artObjType === 1) && resolvedAidRaw != null ? aidRotation(resolvedAidRaw) : null;
          let artCanvas = null, artName = null, artFile = null, artNote = null, hotspotX = 0, hotspotY = 0;
          if (mob.objType === 0 && wallArt?.canvas) {
            artCanvas = wallArt.canvas; artName = wallArt.artName;
            hotspotX = wallArt.hotspotX || 0; hotspotY = wallArt.hotspotY || 0;
          } else if ((artId === null || artId === undefined) && (mob.objType === 15 || mob.objType === 16)) {
            // Critters have no .mes art table: the placed object's own packed id names the ART file.
            try {
              const art = await loadCritterMapArt(protoCritterAidInfo(aidField ? aidField.value : inheritedAidRaw, mob.objType));
              if (art?.canvas) { artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
            } catch (_) {}
          } else if (artId !== null && artId !== undefined) {
            try {
              const art = await loadMobMapArtShared(artId, artObjType, paletteIndex, sceneryRotation, resolvedAidRaw);
              if (art?.canvas) { artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
            } catch (_) {}
          }
          if (!window.__secMobProtoCache) window.__secMobProtoCache = new Map();
          const { offsetX, offsetY } = await secObjectPixelOffsets(mob, window.__secMobProtoCache);
          const objLight = await secObjectLightSources(mob, window.__secMobProtoCache);
          const wallField = mob.fields.find(f => f.field === 39);
          const currentAidRaw = aidField ? aidField.value : null;
          const locationRaw = locField ? locField.value : null;
          points.push({
            file: mob.filename || name.split('/').pop(), name: mobName,
            worldX: loc.worldX, worldY: loc.worldY,
            sectorX: loc.sectorX, sectorY: loc.sectorY, tileX: loc.tileX, tileY: loc.tileY,
            type: mob.objType, typeName: mobObjectTypeName(mob.objType), artId, artName, artCanvas,
            wallFlags: wallField ? (Number(wallField.value) >>> 0) : 0,
            wallDecode: wallArt?.wallDecode || null,
            portalRotation: artObjType === 1 ? sceneryRotation : null, artFile, artNote,
            currentAidRaw, locationRaw,
            objFlags: mobFlagsField ? (Number(mobFlagsField.value) >>> 0) : 0,
            sceneryFlags: (mob.fields.find(f => f.field === 69)?.value ?? 0) >>> 0,
            seq: points.length,
            // Keep the complete decoded field list for wall diagnostics. This
            // is intentionally attached only to wall MOBs to avoid bloating
            // the normal MOB overlay data.
            wallFields: mob.objType === 0 ? mob.fields.map(f => ({ field: f.field, value: f.value })) : null,
            hotspotX, hotspotY, offsetX, offsetY,
            lightSources: objLight.sources, nocturnal: objLight.nocturnal
          });
          diagnostics.loaded++;
          if (mob.objType === 0) diagnostics.wallLoaded++;
        } catch (err) {
          diagnostics.decodeFailures.push({ file: path, error: String(err?.message || err), stack: String(err?.stack || '') });
        }
      }));
    }
    points.mobDiagnostics = diagnostics;
    return points;
  }

  async function loadSecStaticObjectPoints(sectors, diagnostics) {
    const points = [];
    const protoCache = new Map();
    // Every object used to be loaded strictly one after another, each awaiting
    // its prototype, art, offsets and lights in turn. The work is independent
    // per object (and heavily de-duplicated by the caches), so run it in
    // parallel chunks and append the results in their original order.
    const CHUNK = 64;
    const processObject = async (sector, pos, obj, i) => {
        const objFlagsField = obj.fields?.find(f => f.field === 19);
        if (objFlagsField && ((Number(objFlagsField.value) >>> 0) & 0x1000)) {
          diagnostics.inventoryItemsSkipped = (diagnostics.inventoryItemsSkipped || 0) + 1;
          return null;
        }
        const locField = obj.fields?.find(f => f.field === 2);
        if (!locField) {
          diagnostics.locationFailures.push({ file: `${sector.filename}#object${i}`, objectType: obj.objType, locationRaw: null, source: 'SEC static object list' });
          return null;
        }
        let raw;
        try { raw = BigInt(locField.value); } catch (_) {
          diagnostics.locationFailures.push({ file: `${sector.filename}#object${i}`, objectType: obj.objType, locationRaw: locField.value, source: 'SEC static object list' });
          return null;
        }
        // objlist_load() in sector_object_list.c converts the stored location
        // to the sector-local tile using tile_id_from_loc(): low 6 bits are X,
        // bits 32..37 are Y. The object is then assigned the sector origin.
        const tileX = Number(raw & 63n);
        const tileY = Number((raw >> 32n) & 63n);
        const currentAidField = obj.fields?.find(f => f.field === 1);
        const wallField = obj.fields?.find(f => f.field === 39);
        let artId = currentAidField ? protoCurrentAidArtId(currentAidField.value, obj.objType) : null;
        let inheritedAidRaw = null;
        if (artId === null && obj.objType !== 0) {
          try {
            const proto = await resolveMobPrototype(obj, protoCache);
            const protoAid = proto.decodedProto?.fields?.find(f => f.field === 1);
            if (protoAid) {
              inheritedAidRaw = protoAid.value;
              artId = protoCurrentAidArtId(protoAid.value, obj.objType);
            }
          } catch (_) {}
        }
        const resolvedAidRaw = currentAidField?.value ?? inheritedAidRaw;
        const artObjType = protoArtObjectType(inheritedAidRaw ?? currentAidField?.value, obj.objType);
        const paletteIndex = artObjType === 3 && resolvedAidRaw != null
          ? (Number(resolvedAidRaw) >>> 4) & 3
          : null;
        const sceneryRotation = (artObjType === 3 || artObjType === 2 || artObjType === 1) && resolvedAidRaw != null ? aidRotation(resolvedAidRaw) : null;
        let artCanvas = null, artName = null, artFile = null, artNote = null, hotspotX = 0, hotspotY = 0, wallArt = null;
        if (obj.objType === 0 && currentAidField) {
          try { wallArt = await loadWallArtFromRaw(currentAidField.value); } catch (_) { wallArt = null; }
          if (wallArt?.canvas) {
            artCanvas = wallArt.canvas; artName = wallArt.artName;
            hotspotX = wallArt.hotspotX || 0; hotspotY = wallArt.hotspotY || 0;
          }
        } else if ((artId === null || artId === undefined) && (obj.objType === 15 || obj.objType === 16)) {
          try {
            const art = await loadCritterMapArt(protoCritterAidInfo(currentAidField ? currentAidField.value : inheritedAidRaw, obj.objType));
            if (art?.canvas) { artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
          } catch (_) {}
        } else if (artId !== null && artId !== undefined) {
          try {
            const art = await loadMobMapArtShared(artId, artObjType, paletteIndex, sceneryRotation, resolvedAidRaw);
            if (art?.canvas) { artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
          } catch (_) {}
        }
        const { offsetX, offsetY } = await secObjectPixelOffsets(obj, protoCache);
        const objLight = await secObjectLightSources(obj, protoCache);
        const nameField = obj.fields?.find(f => f.field === 22);
        const name = nameField?.value != null && String(nameField.value).trim() ? String(nameField.value).trim() : `${sector.filename}#object${i}`;
        const locationRaw = locField.value;
        const point = {
          file: `${sector.filename}#object${i}`, name,
          worldX: Number(pos.x) * 64 + tileX, worldY: Number(pos.y) * 64 + tileY,
          sectorX: Number(pos.x), sectorY: Number(pos.y), tileX, tileY,
          type: obj.objType, typeName: mobObjectTypeName(obj.objType), artId, artName, artCanvas,
          wallFlags: wallField ? (Number(wallField.value) >>> 0) : 0,
          wallDecode: wallArt?.wallDecode || null,
          portalRotation: artObjType === 1 ? sceneryRotation : null, artFile, artNote,
          currentAidRaw: currentAidField ? currentAidField.value : null,
          locationRaw,
          objFlags: objFlagsField ? (Number(objFlagsField.value) >>> 0) : 0,
          sceneryFlags: (obj.fields?.find(f => f.field === 69)?.value ?? 0) >>> 0,
          seq: i,
          wallFields: obj.objType === 0 ? obj.fields.map(f => ({ field: f.field, value: f.value })) : null,
          hotspotX, hotspotY, offsetX, offsetY,
          lightSources: objLight.sources, nocturnal: objLight.nocturnal,
          staticSecObject: true
        };
        diagnostics.staticObjectCount = (diagnostics.staticObjectCount || 0) + 1;
        const typeKey = String(obj.objType);
        diagnostics.staticObjectTypeCounts[typeKey] = (diagnostics.staticObjectTypeCounts[typeKey] || 0) + 1;
        if (obj.objType === 0) diagnostics.wallLoaded++;
        return point;
    };
    for (const sector of sectors || []) {
      if (sector?.decoded?.staticObjectError) {
        diagnostics.staticObjectErrors = diagnostics.staticObjectErrors || [];
        diagnostics.staticObjectErrors.push({ file: sector.filename, error: sector.decoded.staticObjectError });
      }
    }
    const jobs = [];
    for (const sector of sectors || []) {
      const objects = sector?.decoded?.staticObjects || [];
      const pos = sector?.position;
      if (!pos) continue;
      for (let i = 0; i < objects.length; i++) jobs.push([sector, pos, objects[i], i]);
    }
    for (let k = 0; k < jobs.length; k += CHUNK) {
      const results = await Promise.all(jobs.slice(k, k + CHUNK).map(j =>
        processObject(...j).catch(err => {
          diagnostics.decodeFailures.push({ file: `${j[0].filename}#object${j[3]}`, error: String(err?.message || err) });
          return null;
        })));
      for (const p of results) if (p) points.push(p);
    }
    return points;
  }

  // Wall ART is a slab whose base runs along one tile edge: 40px wide (half a
  // 78px tile) with the base sloping 2:1. Rather than trusting the ART hotspot
  // (which does not correspond to a tile vertex), the sprite is placed so the
  // left end of its base sits on the left end of the edge it belongs to. The
  // height of that point is read from the sprite itself: the lowest opaque
  // pixel of its left-most populated column, extrapolated to column 0.
  // `slope` is the base slope in the drawn (already mirrored) canvas.
  const secWallBaseCache = new WeakMap();
  function secWallBaseLeftY(canvas, slope) {
    const key = `${slope}`;
    let perCanvas = secWallBaseCache.get(canvas);
    if (perCanvas && perCanvas.has(key)) return perCanvas.get(key);
    let result = null;
    try {
      const w = canvas.width, h = canvas.height;
      const probe = Math.min(w, 8);
      const img = readCanvasPixels(canvas);
      if (!img) throw new Error('no pixels');
      const pix = img.data;
      // Base line (slope `slope`) estimated at x=0 from the lowest opaque
      // pixel near each end of the sprite. Walls end in solid posts, so the
      // ends are never doorway gaps. The smaller value is the line that
      // touches the base from above, which ignores any plinth step sticking
      // out below it -- so mirrored and unmirrored walls land at the same height.
      const estimate = (x0, fromRight) => {
        for (let i = 0; i < probe; i++) {
          const x = fromRight ? x0 + probe - 1 - i : x0 + i;
          for (let y = h - 1; y >= 0; y--) {
            if (pix[(y * w + x) * 4 + 3] > 0) return y - slope * x;
          }
        }
        return null;
      };
      const left = estimate(0, false);
      const right = w > probe ? estimate(w - probe, true) : left;
      const vals = [left, right].filter(v => v !== null);
      result = vals.length ? Math.min(...vals) : null;
    } catch (_) { result = null; }
    if (!perCanvas) { perCanvas = new Map(); secWallBaseCache.set(canvas, perCanvas); }
    perCanvas.set(key, result);
    return result;
  }

  // Some wall pieces (doorways, lintels, anything whose base is not a solid
  // 40px slab) have no usable base line to read from their pixels. The game
  // places every wall purely from its ART hotspot, so the hotspot is the
  // reliable signal once its meaning is known. That meaning is calibrated here
  // from ordinary 40px pieces, where the base-line rule is trustworthy:
  //   H = median( hotspotX , hotspotY - baseLineY )
  // kept separately for unmirrored / mirrored art. Any piece is then placed at
  //   tileCentre + edgeLeftEnd + H - hotspot
  // which reproduces the base-line placement for ordinary pieces.
  let secWallCalCache = { sig: null, cal: null };
  function secMedian(a) {
    const b = a.slice().sort((x, y) => x - y), n = b.length;
    return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
  }
  // Rotation that decides which tile edge a wall or portal stands on.
  function secEdgeRotation(p) {
    if (Number.isInteger(p?.wallDecode?.rotation)) return p.wallDecode.rotation & 7;
    if (Number.isInteger(p?.portalRotation)) return p.portalRotation & 7;
    return null;
  }

  function secWallCalibration(wallPoints) {
    const first = wallPoints[0], last = wallPoints[wallPoints.length - 1];
    const sig = `${wallPoints.length}|${first?.file}|${last?.file}`;
    if (secWallCalCache.sig === sig) return secWallCalCache.cal;
    const samples = [[], []];
    for (const w of wallPoints) {
      if (w.type !== 0) continue; // only real wall slabs calibrate the hotspot
      const c = w.artCanvas, rot = w.wallDecode?.rotation;
      if (!c || !Number.isInteger(rot) || c.width < 38 || c.width > 42) continue;
      const m = (rot & 2) ? 1 : 0;
      const by = secWallBaseLeftY(c, m ? -0.5 : 0.5);
      if (by === null) continue;
      samples[m].push({ x: Number(w.hotspotX) || 0, y: (Number(w.hotspotY) || 0) - by });
    }
    const cal = samples.map(list => {
      if (list.length < 3) return null;
      const mx = secMedian(list.map(v => v.x)), my = secMedian(list.map(v => v.y));
      const agree = list.filter(v => Math.abs(v.x - mx) <= 2 && Math.abs(v.y - my) <= 2).length;
      return agree / list.length >= 0.6 ? { x: mx, y: my, n: list.length, agree } : null;
    });
    secWallCalCache = { sig, cal };
    return cal;
  }

  // Left end of the tile edge a wall rotation sits on, relative to the tile
  // centre, in unzoomed iso pixels. Rotation/2: 0 = NE edge, 1 = SE, 2 = SW,
  // 3 = NW. NE/SW edges slope down-right (art as stored), SE/NW slope
  // up-right (art mirrored).
  function secWallEdgeLeftEnd(rotation) {
    switch (((rotation >> 1) & 3)) {
      case 0: return { dx: 0, dy: -SEC_ISO_HALF_H };                 // NE: top vertex
      case 1: return { dx: 0, dy: SEC_ISO_HALF_H };                  // SE: bottom vertex
      case 2: return { dx: -SEC_ISO_HALF_W, dy: 0 };                 // SW: left vertex
      default: return { dx: -SEC_ISO_HALF_W, dy: 0 };                // NW: left vertex
    }
  }

  // Draw order of placed objects, ported from the game.
  //  * game/object.c object_draw(): tiles are scanned row by row (world Y, then
  //    world X) and every object gets a running "order" number. Flat objects
  //    (OF_FLAT) use the 200000000 band, everything else (critters, scenery,
  //    items, walls, portals...) the 600000000 band, and the blits are sorted
  //    by that number. So walls, portals and other objects share ONE ordering
  //    instead of walls being painted over everything else.
  //  * game/sector_object_list.c sub_4F20A0(): objects sharing a tile are kept
  //    in a sorted list (flats first, a wall before a portal, then by their
  //    pixel offset; walls/portals use a fixed +19 / -20 key by rotation).
  const SEC_OF_FLAT = 0x00000004, SEC_OSCF_UNDER_ALL = 0x0200;
  function secTileOrderKey(o) {
    let offX, offY;
    if (o.type === 0 || o.type === 1) {
      const rot = secEdgeRotation(o) ?? 0;
      offX = 0; offY = (rot > 1 && rot < 6) ? 19 : -20;
    } else {
      offX = Number(o.offsetX) || 0; offY = Number(o.offsetY) || 0;
    }
    // sub_4B93F0 (C integer division truncates toward zero)
    const v1 = Math.trunc((offX - 40) / 2), v2 = 2 * Math.trunc(offY / 2);
    return { a: v2 - v1, b: v1 + v2 };
  }
  function secInsertInTile(list, o) {
    const isFlat = (o.objFlags & SEC_OF_FLAT) !== 0;
    const nk = secTileOrderKey(o);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i], curFlat = (cur.objFlags & SEC_OF_FLAT) !== 0;
      if (isFlat) {
        if (!curFlat) { list.splice(i, 0, o); return; }
        if (o.type === 3 && ((o.sceneryFlags & SEC_OSCF_UNDER_ALL) !== 0)) { list.splice(i, 0, o); return; }
      } else {
        if (o.type === 0 && cur.type === 1) { list.splice(i, 0, o); return; }
        if (o.type === 1 && cur.type === 0) { list.splice(i + 1, 0, o); return; }
      }
      if (!curFlat) {
        const ck = secTileOrderKey(cur);
        if (nk.b < ck.b || (nk.b === ck.b && nk.a < ck.a)) { list.splice(i, 0, o); return; }
      }
    }
    list.push(o);
  }
  function secSortObjectsLikeGame(objects) {
    const tiles = new Map();
    // Objects are inserted in file order, as objlist_load() does.
    const inFileOrder = objects.slice().sort((p, q) =>
      (p.seq ?? 0) - (q.seq ?? 0) || String(p.file).localeCompare(String(q.file)));
    for (const o of inFileOrder) {
      const key = o.worldY * 1048576 + o.worldX;
      let list = tiles.get(key);
      if (!list) { list = []; tiles.set(key, list); }
      secInsertInTile(list, o);
    }
    const keys = [...tiles.keys()].sort((a, b) => a - b); // world Y, then world X
    const flat = [], upright = [];
    for (const k of keys) for (const o of tiles.get(k)) ((o.objFlags & SEC_OF_FLAT) !== 0 ? flat : upright).push(o);
    return flat.concat(upright);
  }

  // Color mode marks wall placement with its tile edge; actual-tile mode uses
  // the wall ART selected from F_CURRENT_AID.
  function drawSecWallOverlay(ctx, wallPoints, bounds, mode, zoom, ox, oy, iso, calibrationPoints = null, lighting = null) {
    if (!wallPoints?.length) return;
    const mapWidthTiles = (bounds.maxX - bounds.minX + 1) * 64;
    const mapHeightTiles = (bounds.maxY - bounds.minY + 1) * 64;
    // Isometric painter's order: things further back (smaller x+y) first, so a
    // nearer wall overlaps the one behind it, as in the game.
    const depth = w => ((w.sectorX - bounds.minX) * 64 + w.tileX) + ((w.sectorY - bounds.minY) * 64 + w.tileY);
    // Objects sharing a tile are ordered like sub_4F20A0(): walls with rotation
    // 2..5 sit at +19 and the others at -20, smaller first, so the 2..5 wall is
    // drawn on top. Equal keys keep SEC file order (Array.sort is stable).
    const inTile = w => {
      const r = secEdgeRotation(w) ?? 0;
      return (r > 1 && r < 6) ? 1 : 0;
    };
    const wallCal = mode === 'art' ? secWallCalibration(calibrationPoints || wallPoints) : [null, null];
    wallPoints = wallPoints.slice().sort((a, b) => depth(a) - depth(b) || a.tileX - b.tileX || inTile(a) - inTile(b));
    for (const wall of wallPoints) {
      if (mode === 'art' && !wall.artCanvas) continue;
      const worldLocalX = (wall.sectorX - bounds.minX) * 64 + wall.tileX;
      const worldLocalY = (wall.sectorY - bounds.minY) * 64 + wall.tileY;
      const localX = mode === 'art' ? worldLocalX : (mapWidthTiles - 1 - worldLocalX);
      const localY = worldLocalY;
      if (localX < 0 || localY < 0 || localX >= mapWidthTiles || localY >= mapHeightTiles) continue;
      let px, py;
      if (mode === 'art') {
        const rotation = secEdgeRotation(wall) ?? 1;
        let anchorX = localX, anchorY = localY;
        if (rotation <= 1) { anchorX -= 0.5; anchorY += 0.5; }
        else if (rotation <= 5) { anchorX += 0.5; anchorY += 0.5; }
        else { anchorX += 0.5; anchorY -= 0.5; }
        const p = secIsoProject(anchorX, anchorY, iso);
        px = p.x * zoom + ox; py = p.y * zoom + oy;
      } else {
        px = localX * zoom + ox + zoom / 2;
        py = localY * zoom + oy + zoom / 2;
      }

      if (mode === 'color') {
        const tileLeft = localX * zoom + ox;
        const tileTop = localY * zoom + oy;
        const tileRight = tileLeft + zoom;
        const tileBottom = tileTop + zoom;
        const rotation = secEdgeRotation(wall) ?? 1;
        const edge = (Math.floor(rotation / 2) & 3);
        const inset = Math.min(zoom * 0.15, 2);
        const edges = [
          [tileRight - inset, tileTop + inset, tileRight - inset, tileBottom - inset],
          [tileLeft + inset, tileBottom - inset, tileRight - inset, tileBottom - inset],
          [tileLeft + inset, tileTop + inset, tileLeft + inset, tileBottom - inset],
          [tileLeft + inset, tileTop + inset, tileRight - inset, tileTop + inset]
        ];
        const [x1, y1, x2, y2] = edges[edge];
        ctx.save();
        ctx.lineCap = 'square';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = 'rgba(12, 10, 8, 0.95)';
        ctx.lineWidth = Math.max(3, Math.min(6, zoom * 0.42));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = '#f2d36b';
        ctx.lineWidth = Math.max(1.5, Math.min(3, zoom * 0.22));
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const c = wall.artCanvas;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      // The game blits walls/portals opaque. Only the runtime wall-fade around the
      // player (OWAF_TRANS_LEFT/RIGHT, object.c sub_442520) makes them translucent,
      // and a static map viewer has no player, so no alpha is applied here.
      const scale = zoom;
      let drawX = px - (Number(wall.hotspotX)||0) * scale;
      let drawY = py - (Number(wall.hotspotY)||0) * scale;
      let lightRuns = null, lightColour = null, lightResolved = false;
      // Edge-aligned placement (see secWallBaseLeftY / secWallCalibration).
      const edgeRot = secEdgeRotation(wall);
      if (edgeRot !== null) {
        const rot = edgeRot;
        const mirrored = (rot & 2) !== 0;
        const centre = secIsoProject(localX, localY, iso);
        const end = secWallEdgeLeftEnd(rot);
        const hotX = Number(wall.hotspotX) || 0, hotY = Number(wall.hotspotY) || 0;
        const baseY = wall.type === 0 ? secWallBaseLeftY(c, mirrored ? -0.5 : 0.5) : null; // a doorway has no usable base line
        const cal = wallCal[mirrored ? 1 : 0];
        let ux = null, uy = null, how = '';
        if (cal) {
          ux = centre.x + end.dx + cal.x - hotX;
          uy = centre.y + end.dy + cal.y - hotY;
          how = `hotspot-calibrated (H ${cal.x}, ${cal.y} from ${cal.agree}/${cal.n} pieces)`;
        } else if (baseY !== null) {
          ux = centre.x + end.dx;
          uy = centre.y + end.dy - baseY;
          how = 'base-line rule (no calibration available)';
        }
        if (ux !== null) {
          drawX = ux * scale + ox;
          drawY = uy * scale + oy;
          if (lighting && mode === 'art') {
            const offX = Number(wall.offsetX) || 0, offY = Number(wall.offsetY) || 0;
            lightResolved = true;
            if (wall.type === 0) {
              lightRuns = lighting.wallRuns(wall, rot, ux + offX, c.width, centre.x + end.dx + offX, centre.y + end.dy + offY, mirrored ? -0.5 : 0.5);
            } else {
              lightColour = lighting.portalColor(wall, rot, centre.x + offX, centre.y + offY);
            }
          }
          wall.placementNote = `${how}; canvas ${c.width}x${c.height}, hotspot ${hotX},${hotY}, ` +
            `pixel base Y ${baseY === null ? '?' : baseY}, implied H ${hotX}, ${baseY === null ? '?' : hotY - baseY}, offset ${wall.offsetX || 0},${wall.offsetY || 0}`;
        }
      }
      drawX += (Number(wall.offsetX) || 0) * scale;
      drawY += (Number(wall.offsetY) || 0) * scale;
      if (lightRuns) {
        // One tint per run of columns, like the game's per-column colour array.
        for (const run of lightRuns) {
          const src = lighting.sprite(c, run.rgb);
          ctx.drawImage(src, run.x0, 0, run.x1 - run.x0, c.height,
            drawX + run.x0 * scale, drawY, (run.x1 - run.x0) * scale, c.height * scale);
        }
      } else if (lighting && lightColour) {
        ctx.drawImage(lighting.sprite(c, lightColour), drawX, drawY, c.width * scale, c.height * scale);
      } else if (lighting && mode === 'art' && !lightResolved) {
        // Placement fell back to the hotspot: no edge geometry, so use the plain outdoor colour.
        ctx.drawImage(lighting.sprite(c, lighting.ambient.outdoor), drawX, drawY, c.width * scale, c.height * scale);
      } else {
        ctx.drawImage(c, drawX, drawY, c.width * scale, c.height * scale);
      }
      ctx.restore();
    }
  }

  function drawSecMobOverlay(ctx, mobPoints, bounds, mode, zoom, ox, oy, iso, showBounds = false, lighting = null) {
    if (!mobPoints?.length) return;
    for (const mob of mobPoints) {
      if (mob.type === 0) continue;
      const worldLocalX = (mob.sectorX - bounds.minX) * 64 + mob.tileX;
      const worldLocalY = (mob.sectorY - bounds.minY) * 64 + mob.tileY;
      const mapWidthTiles = (bounds.maxX - bounds.minX + 1) * 64;
      // Color mode uses a top-down canvas whose X axis is mirrored manually.
      // Isometric mode follows the game's renderer directly: X=0 is already
      // the top-right and increasing X moves left/down.
      const localX = mode === 'art' ? worldLocalX : (mapWidthTiles - 1 - worldLocalX);
      const localY = worldLocalY;
      if (localX < 0 || localY < 0 || localX >= (bounds.maxX - bounds.minX + 1) * 64 || localY >= (bounds.maxY - bounds.minY + 1) * 64) continue;
      let px, py;
      if (mode === 'art') {
        const p = secIsoProject(localX, localY, iso);
        px = (p.x + (Number(mob.offsetX) || 0)) * zoom + ox;
        py = (p.y + (Number(mob.offsetY) || 0)) * zoom + oy;
      } else {
        px = localX * zoom + ox + zoom / 2; py = localY * zoom + oy + zoom / 2;
      }
      const typeColor = mobMapTypeColor(mob.type);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      if (mob.artCanvas) {
        let dw, dh, left, top;
        if (mode === 'color') {
          // The color map is a one-tile-per-64x64-pixels representation.
          // Keep the entire rendered MOB strictly inside its own logical tile.
          // The clip is important because ART canvases can contain transparent
          // margins/offsets, and the outline must not spill into neighbours.
          const tileLeft = localX * zoom + ox;
          const tileTop = localY * zoom + oy;
          const tileSize = zoom;
          const maxW = Math.max(1, tileSize - 1);
          const maxH = Math.max(1, tileSize - 1);
          const fit = Math.min(maxW / Math.max(1, mob.artCanvas.width), maxH / Math.max(1, mob.artCanvas.height));
          dw = Math.max(1, mob.artCanvas.width * fit);
          dh = Math.max(1, mob.artCanvas.height * fit);
          left = tileLeft + (tileSize - dw) / 2;
          top = tileTop + (tileSize - dh) / 2;
          ctx.beginPath();
          ctx.rect(tileLeft, tileTop, tileSize, tileSize);
          ctx.clip();
        } else {
          dw = Math.max(1, mob.artCanvas.width * zoom);
          dh = Math.max(1, mob.artCanvas.height * zoom);
          const hotspotX = Number(mob.hotspotX) || 0;
          const hotspotY = Number(mob.hotspotY) || 0;
          left = px - hotspotX * zoom;
          top = py - hotspotY * zoom;
        }
        let artSrc = mob.artCanvas;
        if (lighting && mode === 'art') {
          const rgb = lighting.mobColor(mob, (px - ox) / zoom, (py - oy) / zoom);
          if (rgb) artSrc = lighting.sprite(artSrc, rgb);
        }
        ctx.drawImage(artSrc, left, top, dw, dh);
        if (showBounds) {
          ctx.strokeStyle = typeColor;
          ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * .18));
          ctx.strokeRect(left + .5, top + .5, Math.max(1, dw - 1), Math.max(1, dh - 1));
        }
      } else {
        const size = Math.max(7, Math.min(40, zoom));
        const left = px - size / 2, top = py - size / 2;
        ctx.fillStyle = typeColor;
        ctx.fillRect(left, top, size, size);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(9, size * .72)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', px, py + .5);
        if (showBounds) {
          ctx.strokeStyle = typeColor;
          ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * .18));
          ctx.strokeRect(left, top, size, size);
        }
      }
      ctx.restore();
    }
  }

  // ---- Lazy sector loading in "actual tiles" mode ------------------------------
  // A sector whose 4096 tiles are all blank (raw 0 or the BLK tile) has nothing to
  // draw, so it is detected up front and never shown. Every other sector starts as a
  // light-blue placeholder carrying its name; clicking it loads its tile art.
  const SEC_PLACEHOLDER_FILL = '#a9d8ff', SEC_PLACEHOLDER_EDGE = '#5aa9e6', SEC_PLACEHOLDER_TEXT = '#0b2f52';
  const secSectorKey = s => `${s.position.x},${s.position.y}`;
  function secDetectBlankSectors(sectors) {
    const blankRaw = new Map();   // raw tile value -> is blank? (names are looked up once per unique value)
    const isBlankRaw = raw => {
      if (raw === 0) return true;
      let b = blankRaw.get(raw);
      if (b === undefined) { b = String(secTileInfo(raw)?.name || '').trim().toUpperCase() === 'BLK'; blankRaw.set(raw, b); }
      return b;
    };
    const blank = new Set();
    for (const s of sectors) {
      const tiles = s.decoded?.tiles;
      if (!tiles) continue;
      let all = true;
      for (let i = 0; i < tiles.length; i++) if (!isBlankRaw(tiles[i] >>> 0)) { all = false; break; }
      if (all) blank.add(secSectorKey(s));
    }
    return blank;
  }
  // Corners of a sector's footprint in unzoomed iso space (a square in world space,
  // so a diamond on screen). Same tile origin as drawSecActualTiles.
  function secSectorDiamond(sector, bounds, iso) {
    const bx = (sector.position.x - bounds.minX) * 64, by = (sector.position.y - bounds.minY) * 64;
    return [
      secIsoProject(bx - .5, by - .5, iso), secIsoProject(bx + 63.5, by - .5, iso),
      secIsoProject(bx + 63.5, by + 63.5, iso), secIsoProject(bx - .5, by + 63.5, iso)
    ];
  }
  function secSectorLabel(sector) { return String(sector.filename || secSectorKey(sector)).replace(/\.sec$/i, ''); }
  function drawSecPlaceholders(ctx, sectors, bounds, iso, view, cssW, cssH) {
    const zoom = view.zoom, ox = view.offsetX, oy = view.offsetY;
    for (const sector of sectors) {
      if (!sector?.decoded || !sector.position) continue;
      const key = secSectorKey(sector);
      if (view.blankSectors?.has(key) || view.loadedSectors?.has(key)) continue;
      const pts = secSectorDiamond(sector, bounds, iso).map(p => ({ x: p.x * zoom + ox, y: p.y * zoom + oy }));
      const minPX = Math.min(...pts.map(p => p.x)), maxPX = Math.max(...pts.map(p => p.x));
      const minPY = Math.min(...pts.map(p => p.y)), maxPY = Math.max(...pts.map(p => p.y));
      if (maxPX < 0 || minPX > cssW || maxPY < 0 || minPY > cssH) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = SEC_PLACEHOLDER_FILL; ctx.fill();
      ctx.strokeStyle = SEC_PLACEHOLDER_EDGE; ctx.lineWidth = 1; ctx.stroke();
      const width = maxPX - minPX;
      if (width < 36) continue;
      const cx = (minPX + maxPX) / 2, cy = (minPY + maxPY) / 2;
      const size = Math.max(9, Math.min(26, width / 11));
      ctx.fillStyle = SEC_PLACEHOLDER_TEXT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
      const loading = view.loadingSectors?.has(key);
      ctx.fillText(secSectorLabel(sector), cx, loading ? cy - size * .7 : cy);
      if (loading) { ctx.font = `500 ${Math.max(8, size * .8)}px ui-monospace, Menlo, Consolas, monospace`; ctx.fillText('loading…', cx, cy + size * .7); }
    }
  }

  function drawSecFolderMap(canvas, sectors, bounds, selected, mode, artTiles, view, mobPoints = [], mapBackground = null, overlayVisibility = {}) {
    const sectorCols = bounds.maxX - bounds.minX + 1;
    const sectorRows = bounds.maxY - bounds.minY + 1;
    const mapW = sectorCols * 64;
    const mapH = sectorRows * 64;
    const iso = secIsoMetrics(bounds);
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(320, Math.floor(canvas.clientWidth || 760));
    const cssH = Math.max(260, Math.floor(canvas.clientHeight || 620));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = SEC_MAP_BACKGROUND; ctx.fillRect(0, 0, cssW, cssH);

    const zoom = Math.max(0.01, Math.min(32, view.zoom));
    const ox = view.offsetX, oy = view.offsetY;
    const sectorMap = view.sectorMap || new Map(sectors.map(s => [`${s.position.x},${s.position.y}`, s]));

    // Map.bmp is a sector-level image (one source pixel per 64x64 sector).
    // Draw it in grayscale first; SEC tiles and MOBs are drawn over it.
    if (mapBackground && mapBackground.complete && mapBackground.naturalWidth) {
      const bgLeft = (bounds.maxX - mapBackground.naturalWidth + 1) * 64;
      const bgTop = -bounds.minY * 64;
      const bgW = mapBackground.naturalWidth * 64;
      const bgH = mapBackground.naturalHeight * 64;
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mapBackground, bgLeft * zoom + ox, bgTop * zoom + oy, bgW * zoom, bgH * zoom);
      ctx.restore();
    }

    let lighting = null;
    const drawPlaceholders = () => drawSecPlaceholders(ctx, sectors, bounds, iso, view, cssW, cssH);
    if (mode === 'color') {
      // Keep the existing fast rectangular semantic-color representation.
      const worldLeft = Math.max(0, Math.floor((-ox) / zoom) - 1);
      const worldTop = Math.max(0, Math.floor((-oy) / zoom) - 1);
      const worldRight = Math.min(mapW - 1, Math.ceil((cssW - ox) / zoom) + 1);
      const worldBottom = Math.min(mapH - 1, Math.ceil((cssH - oy) / zoom) + 1);
      const firstSX = Math.max(bounds.minX, bounds.maxX - Math.floor(worldRight / 64));
      const lastSX = Math.min(bounds.maxX, bounds.maxX - Math.floor(worldLeft / 64));
      const firstSY = Math.max(bounds.minY, bounds.minY + Math.floor(worldTop / 64));
      const lastSY = Math.min(bounds.maxY, bounds.minY + Math.floor(worldBottom / 64));

      for (let sy = firstSY; sy <= lastSY; sy++) for (let sx = firstSX; sx <= lastSX; sx++) {
        const sector = sectorMap.get(`${sx},${sy}`);
        if (!sector?.decoded) continue;
        const baseX = (bounds.maxX - sx) * 64;
        const baseY = (sy - bounds.minY) * 64;
        const px0 = Math.floor(baseX * zoom + ox);
        const py0 = Math.floor(baseY * zoom + oy);
        const pw = 64 * zoom, ph = 64 * zoom;
        let cache = view.colorSectorCache.get(sector.filename);
        if (!cache) {
          cache = document.createElement('canvas'); cache.width = 64; cache.height = 64;
          const cctx = cache.getContext('2d', { alpha: false });
          const image = cctx.createImageData(64, 64);
          for (let i = 0; i < sector.decoded.tiles.length; i++) {
            const info = secTileInfo(sector.decoded.tiles[i] >>> 0);
            const m = String(secTileColor(info.artId)).match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            const off = i * 4;
            if (m) { image.data[off] = +m[1]; image.data[off+1] = +m[2]; image.data[off+2] = +m[3]; }
            image.data[off+3] = 255;
          }
          cctx.putImageData(image, 0, 0);
          view.colorSectorCache.set(sector.filename, cache);
        }
        ctx.save(); ctx.translate(px0 + pw, 0); ctx.scale(-1, 1); ctx.drawImage(cache, 0, py0, pw, ph); ctx.restore();
        if (zoom >= 1.5) {
          ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
          ctx.strokeRect(px0 + .5, py0 + .5, pw - 1, ph - 1);
        }
      }
    } else {
      // Actual tile mode uses the same renderer as the individual SEC viewer.
      // This keeps orientation, 78x40 placement, blank-tile handling and
      // viewport clipping identical in both views.
      const lightNow = view.light && view.light.enabled && view.light.table ? view.light.table[view.light.hour] : null;
      // Only sectors the user has loaded are drawn (and lit); the rest are placeholders.
      drawPlaceholders(); // below tiles; loaded sectors are skipped inside
      const allSectors = sectors;
      sectors = sectors.filter(s => view.loadedSectors?.has(secSectorKey(s)));
      if (view.loadedSectors) mobPoints = mobPoints.filter(m => view.loadedSectors.has(`${m.sectorX},${m.sectorY}`));
      if (lightNow) {
        const makeLayer = () => {
          const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
          const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.imageSmoothingEnabled = false;
          return x;
        };
        const tileLayer = makeLayer();
        drawSecActualTiles(tileLayer, sectors, bounds, artTiles, view);
        const lightModel = secPrepareLightModel(view, sectors, bounds, iso, lightNow, mobPoints, view.light.hour);
        lighting = secMakeLighting(view, bounds, iso, lightNow, lightModel);
        const mask = makeLayer();
        secDrawLightMask(mask, sectors, bounds, view, cssW, cssH, lightNow, lightModel);
        secTintLayer(tileLayer.canvas, mask.canvas);
        ctx.drawImage(tileLayer.canvas, 0, 0, cssW, cssH);
        view._makeLightLayer = makeLayer;
      } else {
        view._makeLightLayer = null;
        drawSecActualTiles(ctx, sectors, bounds, artTiles, view);
      }
    }

    const portalsOnEdges = m => m.type === 1 && mode === 'art' && !!m.artCanvas;
    const visibleMobs = mobPoints.filter(m => {
      if (m.type === 0) return false;
      if (portalsOnEdges(m)) return false;
      if (m.type === 2) return overlayVisibility.containers;
      if (m.type === 3) return overlayVisibility.scenery;
      return overlayVisibility.otherMobs;
    });
    // Objects (walls, critters, portals, scenery, ground items) are lit one by one:
    // ambient colour of the tile they stand on plus any light shining on them
    // (game/light.c sub_4DC210), so each sprite is tinted with its own colour.
    const objCtx = ctx;
    const allWalls = mobPoints.filter(m => m.type === 0);
    const edgeObjects = (overlayVisibility.walls ? allWalls : [])
      .concat(overlayVisibility.otherMobs ? mobPoints.filter(portalsOnEdges) : []);
    // One shared, game-ordered pass so nearer walls/objects cover farther ones
    // (and vice versa) instead of all walls being painted after every object.
    const edgeSet = new Set(edgeObjects);
    for (const o of secSortObjectsLikeGame(visibleMobs.concat(edgeObjects))) {
      if (edgeSet.has(o)) drawSecWallOverlay(objCtx, [o], bounds, mode, zoom, ox, oy, iso, allWalls, lighting);
      else drawSecMobOverlay(objCtx, [o], bounds, mode, zoom, ox, oy, iso, overlayVisibility.bounds, lighting);
    }

    if (selected) {
      const selectedWorldX = (selected.sectorX - bounds.minX) * 64 + selected.tileX;
      const selectedWorldY = (selected.sectorY - bounds.minY) * 64 + selected.tileY;
      const selectedMapWidthTiles = (bounds.maxX - bounds.minX + 1) * 64;
      const localX = mode === 'art' ? selectedWorldX : (selectedMapWidthTiles - 1 - selectedWorldX);
      const localY = selectedWorldY;
      if (mode === 'art') {
        const p = secIsoProject(localX, localY, iso);
        const px = p.x * zoom + ox, py = p.y * zoom + oy;
        ctx.strokeStyle = '#ffe066'; ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * .18));
        ctx.beginPath();
        ctx.moveTo(px, py - SEC_ISO_HALF_H * zoom);
        ctx.lineTo(px + SEC_ISO_HALF_W * zoom, py);
        ctx.lineTo(px, py + SEC_ISO_HALF_H * zoom);
        ctx.lineTo(px - SEC_ISO_HALF_W * zoom, py);
        ctx.closePath(); ctx.stroke();
      } else {
        const px = localX * zoom + ox, py = localY * zoom + oy;
        ctx.strokeStyle = '#ffe066'; ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * 0.18));
        ctx.strokeRect(px + .5, py + .5, Math.max(1, zoom - 1), Math.max(1, zoom - 1));
      }
    }
  }

  function secFolderLegendEntries(sectors) {
    const counts = new Map();
    for (const sector of sectors) if (sector.decoded) for (const raw of sector.decoded.tiles) {
      const info = secTileInfo(raw);
      const entry = counts.get(info.artId) || { artId: info.artId, name: info.name, count: 0, color: secTileColor(info.artId) };
      entry.count++; if (!entry.name && info.name) entry.name = info.name; counts.set(info.artId, entry);
    }
    return [...counts.values()].sort((a, b) => a.artId - b.artId);
  }

  // ---- Ambient lighting (Rules/Lighting Schemes.mes + mapinfo.txt) -------------
  // Ported from game/light_scheme.c and game/map.c: mapinfo.txt's `LightScheme:N`
  // names the map's default scheme; "Lighting Schemes.mes" maps N to a scheme file
  // (Rules/<name>.mes) holding 24 hourly entries "ro, go, bo, ri, gi, bi" (outdoor
  // then indoor RGB, 0-255, 255 = unchanged); empty entries are interpolated.
  // Per-sector light_scheme overrides are not decoded by this viewer.
  const LIGHT_RULES_ROOTS = [`${DATA_ROOT}rules/`, `${DATA_ROOT}Rules/`, `${DATA_ROOT}mes/`, `${DATA_ROOT}`];
  const lightRulesCache = new Map();
  async function fetchLightRulesFile(baseName) {
    if (lightRulesCache.has(baseName)) return lightRulesCache.get(baseName);
    const promise = (async () => {
      const names = [...new Set([`${baseName}.mes`, `${baseName.replace(/ /g, '_')}.mes`])];
      for (const root of LIGHT_RULES_ROOTS) for (const name of names) {
        try {
          const resp = await fetch(`${root}${encodeURIComponent(name)}`, { cache: 'no-store' });
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          return new TextDecoder('windows-1252').decode(buf);
        } catch (_) {}
      }
      return null;
    })();
    lightRulesCache.set(baseName, promise);
    return promise;
  }
  // Port of light_scheme_parse(), including its integer (truncating) interpolation.
  function parseLightSchemeText(text) {
    const entries = parseMesText(text);
    const colors = Array.from({ length: 24 }, () => ({ outdoor: [0, 0, 0], indoor: [0, 0, 0] }));
    let interpolate = false, prevIndex = 0;
    let outdoor = [0, 0, 0], indoor = [0, 0, 0], prevOutdoor = [0, 0, 0], prevIndoor = [0, 0, 0];
    for (let index = 0; index < 24; index++) {
      const str = entries.get(index);
      if (str != null && str.trim() !== '') {
        const v = str.split(',').map(x => parseInt(x, 10) || 0);
        outdoor = [v[0] || 0, v[1] || 0, v[2] || 0];
        indoor = [v[3] || 0, v[4] || 0, v[5] || 0];
        colors[index] = { outdoor: outdoor.slice(), indoor: indoor.slice() };
        if (interpolate) {
          const span = index - prevIndex;
          const so = outdoor.map((c, k) => Math.trunc((c - prevOutdoor[k]) / span));
          const si = indoor.map((c, k) => Math.trunc((c - prevIndoor[k]) / span));
          let o = prevOutdoor.slice(), i = prevIndoor.slice();
          for (let h = prevIndex; h < index; h++) {
            colors[h] = { outdoor: o.slice(), indoor: i.slice() };
            o = o.map((c, k) => c + so[k]);
            i = i.map((c, k) => c + si[k]);
          }
          interpolate = false;
        }
        prevIndex = index;
      } else {
        prevOutdoor = outdoor.slice();
        prevIndoor = indoor.slice();
        interpolate = true;
      }
    }
    return colors;
  }
  async function loadMapLightInfo(relativePath) {
    const base = `${SEC_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}`;
    let info = { lightScheme: 1, found: false };
    for (const fname of ['mapinfo.txt', 'MapInfo.txt', 'Mapinfo.txt']) {
      try {
        const resp = await fetch(`${base}${fname}`, { cache: 'no-store' });
        if (!resp.ok) continue;
        const text = await resp.text();
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^\s*LightScheme\s*:\s*(-?\d+)/i);
          if (m && Number(m[1]) > 0) info = { lightScheme: Number(m[1]), found: true };
        }
        info.found = true;
        break;
      } catch (_) {}
    }
    return info;
  }
  // Resolves the map's scheme to its 24-hour table (falling back to scheme 1 when
  // the scheme's own file is missing, and saying so in `note`).
  async function loadMapLighting(relativePath) {
    const info = await loadMapLightInfo(relativePath);
    const listText = await fetchLightRulesFile('Lighting Schemes');
    if (!listText) return { error: 'Lighting Schemes.mes not found (tried data/rules/, data/Rules/, data/mes/, data/)' };
    const list = parseMesText(listText);
    const tryScheme = async id => {
      const name = list.get(id);
      if (!name) return null;
      const text = await fetchLightRulesFile(name.trim());
      return text ? { id, name: name.trim(), table: parseLightSchemeText(text) } : null;
    };
    let result = await tryScheme(info.lightScheme), note = '';
    if (!result) {
      const wanted = list.get(info.lightScheme);
      result = await tryScheme(1);
      note = ` (${wanted ? `"${wanted.trim()}.mes"` : `scheme ${info.lightScheme}`} not found, showing the default scheme instead)`;
    }
    if (!result) return { error: 'No lighting scheme file could be loaded' };
    return { ...result, requested: info.lightScheme, mapinfoFound: info.found, note };
  }
  function secLightRgb(c) { return `rgb(${Math.max(0, Math.min(255, c[0]))},${Math.max(0, Math.min(255, c[1]))},${Math.max(0, Math.min(255, c[2]))})`; }
  // Multiplies a transparent-backed layer by a colour (or mask canvas), keeping its alpha.
  function secTintLayer(layerCanvas, fill) {
    const copy = document.createElement('canvas');
    copy.width = layerCanvas.width; copy.height = layerCanvas.height;
    copy.getContext('2d').drawImage(layerCanvas, 0, 0);
    const c = layerCanvas.getContext('2d');
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'multiply';
    if (typeof fill === 'string') { c.fillStyle = fill; c.fillRect(0, 0, layerCanvas.width, layerCanvas.height); }
    else c.drawImage(fill, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(copy, 0, 0);
    c.restore();
  }
  // game/light.c (TIG_ART_TYPE_FACADE case): facades are tinted exactly like tiles,
  // indoor colour when tig_art_tile_id_type_get(aid) == 0, outdoor otherwise. The
  // game reads that same type bit (bit 8) on a facade id, so facades must NOT be
  // forced to the outdoor colour.
  function secTileIsIndoor(raw) {
    raw = Number(raw) >>> 0;
    return raw !== 0 && ((raw >>> 8) & 1) === 0;
  }
  // Mask: outdoor colour everywhere, indoor colour on tiles whose art type is 0
  // (game/tile.c: `color = !tile_type ? indoor_color : outdoor_color`).
  function secDrawLightMask(mctx, sectors, bounds, view, cssW, cssH, light, model) {
    const iso = secIsoMetrics(bounds);
    const zoom = Math.max(0.01, Math.min(32, Number(view?.zoom) || 1));
    const ox = Number(view?.offsetX) || 0, oy = Number(view?.offsetY) || 0;
    mctx.fillStyle = secLightRgb(light.outdoor);
    mctx.fillRect(0, 0, cssW, cssH);
    mctx.fillStyle = secLightRgb(light.indoor);
    const hw = SEC_ISO_HALF_W * zoom + 0.5, hh = SEC_ISO_HALF_H * zoom + 0.5;
    mctx.beginPath();
    for (const sector of sectors || []) {
      if (!sector?.decoded || !sector.position) continue;
      const baseX = (sector.position.x - bounds.minX) * 64;
      const baseY = (sector.position.y - bounds.minY) * 64;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const raw = sector.decoded.tiles[y * 64 + x] >>> 0;
        if (!secTileIsIndoor(raw)) continue;
        const center = secIsoProject(baseX + x, baseY + y, iso);
        const px = center.x * zoom + ox, py = center.y * zoom + oy;
        if (px + hw < 0 || px - hw > cssW || py + hh < 0 || py - hh > cssH) continue;
        mctx.moveTo(px, py - hh); mctx.lineTo(px + hw, py); mctx.lineTo(px, py + hh); mctx.lineTo(px - hw, py); mctx.closePath();
      }
    }
    mctx.fill();
    secAddLightsToMask(mctx, model, zoom, ox, oy, cssW, cssH);
  }

  // ---- Sector lights -----------------------------------------------------------
  // Each sector light record names a light ART (art/light/<light.mes name>.art, a
  // radial sprite) at a tile + pixel offset. game/light.c adds the sprite, tinted
  // by the light's colour, to the scene (LF_DARK lights are subtracted instead).
  // LF_INDOOR / LF_OUTDOOR lights take the current ambient colour as their tint.
  // The art id's `num` is bits 19-27 (tig_art_num_get; same field as portals/eye candy).
  const SEC_LIGHT_ART_ROOT = `${DATA_ROOT}art/light/`;
  const LF_OFF = 0x1, LF_DARK = 0x2, LF_INDOOR = 0x8, LF_OUTDOOR = 0x10;
  const secLightArtCache = new Map();   // num -> { canvas, hotspotX, hotspotY } | null
  const secLightTintCache = new Map();  // `${num}|r,g,b` -> tinted canvas
  let secLightNamesPromise = null;
  function secLightNum(light) { return (light.artId >>> 19) & 0x1FF; }
  async function secLoadLightNames() {
    if (!secLightNamesPromise) {
      secLightNamesPromise = fetch(`${SEC_LIGHT_ART_ROOT}light.mes`, { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} fetching art/light/light.mes`); return r.arrayBuffer(); })
        .then(b => parseMesText(new TextDecoder('windows-1252').decode(b)))
        .catch(err => { secLightNamesPromise = null; throw err; });
    }
    return secLightNamesPromise;
  }
  // Loads the ART for every light in the given sectors; returns counts for the UI.
  async function ensureSecLightArt(sectors, objectPoints) {
    const stats = { total: 0, drawn: 0, dark: 0, off: 0, missingArt: 0, objectLights: 0 };
    let names;
    try { names = await secLoadLightNames(); } catch (err) { return { ...stats, error: String(err.message || err) }; }
    const wanted = new Set();
    for (const sector of sectors || []) for (const l of sector?.decoded?.lights || []) {
      stats.total++;
      if (l.flags & LF_OFF) { stats.off++; continue; }
      if (l.flags & LF_DARK) stats.dark++;
      wanted.add(secLightNum(l));
    }
    for (const m of objectPoints || []) for (const src of m.lightSources || []) wanted.add(secLightNum({ artId: src.aid }));
    await Promise.all([...wanted].filter(n => !secLightArtCache.has(n)).map(async num => {
      const name = names.get(num);
      let result = null;
      if (name) {
        for (const file of [`${name.trim()}.art`, `${name.trim().toLowerCase()}.art`]) {
          try {
            const resp = await fetch(`${SEC_LIGHT_ART_ROOT}${encodeURIComponent(file)}`, { cache: 'no-store' });
            if (!resp.ok) continue;
            const frames = await parseArtBuffer(await resp.arrayBuffer(), 1);
            if (frames[0]?.canvas) { result = { canvas: frames[0].canvas, hotspotX: Number(frames[0].hotspotX) || 0, hotspotY: Number(frames[0].hotspotY) || 0 }; break; }
          } catch (_) {}
        }
      }
      secLightArtCache.set(num, result);
    }));
    for (const sector of sectors || []) for (const l of sector?.decoded?.lights || []) {
      if (l.flags & LF_OFF) continue;
      if (secLightArtCache.get(secLightNum(l))) stats.drawn++; else stats.missingArt++;
    }
    for (const m of objectPoints || []) for (const src of m.lightSources || []) if (secLightArtCache.get(secLightNum({ artId: src.aid }))) stats.objectLights++;
    return stats;
  }
  function secTintedLightSprite(num, art, rgb) {
    if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) return art.canvas;
    const key = `${num}|${rgb[0]},${rgb[1]},${rgb[2]}`;
    let c = secLightTintCache.get(key);
    if (!c) {
      c = document.createElement('canvas'); c.width = art.canvas.width; c.height = art.canvas.height;
      c.getContext('2d').drawImage(art.canvas, 0, 0);
      secTintLayer(c, secLightRgb(rgb));
      secLightTintCache.set(key, c);
    }
    return c;
  }
  // ---- Light model (shared by tiles and objects) --------------------------------
  // game/light.c does not paint light sprites over the finished scene. Every light
  // sprite is accumulated into a "lighter" buffer (LF_DARK ones into a "darker"
  // buffer), and each tile/object is then drawn multiplied by
  //     colour = clamp(ambient + lighter - darker)
  // where `ambient` is the indoor or outdoor colour (light_render_internal,
  // sub_4DA360 for tiles, sub_4D89E0 / sub_4DC210 for objects). So lights brighten
  // the tiles AND every object standing in their glow, instead of sitting on top.
  const SEC_LIGHT_CELL = 128;
  function secLightSpriteData(art) {
    if (art.data === undefined) {
      art.data = readCanvasPixels(art.canvas);
    }
    return art.data;
  }
  // Builds (and caches on the view) the lit light list with a coarse lookup grid, then
  // refreshes each light's tint for the current ambient colours (LF_INDOOR / LF_OUTDOOR
  // lights take the ambient colour as their tint).
  function secPrepareLightModel(view, sectors, bounds, iso, ambient, objectPoints, hour) {
    const isDay = hour >= 6 && hour < 18;
    const sig = `${secLightArtCache.size}|${isDay}|${objectPoints ? objectPoints.length : 0}|${sectors.length}|${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY}`;
    let model = view._lightModel;
    if (!model || model.sig !== sig) {
      const list = [];
      for (const sector of sectors || []) for (const l of sector?.decoded?.lights || []) {
        if (l.flags & LF_OFF) continue;
        const num = secLightNum(l);
        const art = secLightArtCache.get(num);
        if (!art) continue;
        const data = secLightSpriteData(art);
        if (!data) continue;
        const p = secIsoProject(l.x - bounds.minX * 64, l.y - bounds.minY * 64, iso);
        list.push({
          flags: l.flags, r: l.r, g: l.g, b: l.b, num, art, data, dark: !!(l.flags & LF_DARK), gx: l.x, gy: l.y, rgb: [255, 255, 255],
          left: Math.round(p.x + l.offsetX - art.hotspotX), top: Math.round(p.y + l.offsetY - art.hotspotY),
          w: art.canvas.width, h: art.canvas.height
        });
      }
      // Lights carried by objects (lamps, torches, braziers, glowing critters...). They sit at
      // the object's tile + pixel offset. Nocturnal scenery (street lamps and the like) is only
      // lit at night on outdoor tiles, and always on indoor tiles (sector_light_list_fold()).
      for (const m of objectPoints || []) {
        if (!m.lightSources || !m.lightSources.length) continue;
        const wx = m.sectorX * 64 + m.tileX, wy = m.sectorY * 64 + m.tileY;
        let indoor = false;
        if (m.nocturnal) {
          const sec = view.sectorMap && view.sectorMap.get(`${m.sectorX},${m.sectorY}`);
          const raw = sec?.decoded ? (sec.decoded.tiles[(m.tileY & 63) * 64 + (m.tileX & 63)] >>> 0) : 0;
          indoor = secTileIsIndoor(raw);
          if (!indoor && isDay) continue;
        }
        const p = secIsoProject((m.sectorX - bounds.minX) * 64 + m.tileX, (m.sectorY - bounds.minY) * 64 + m.tileY, iso);
        for (const src of m.lightSources) {
          let flags = src.flags;
          if (m.nocturnal && ((m.objFlags | 0) & 0x2) !== 0) flags &= ~LF_OFF; // OF_OFF scenery is switched back on
          if (flags & LF_OFF) continue;
          const num = secLightNum({ artId: src.aid });
          const art = secLightArtCache.get(num);
          if (!art) continue;
          const data = secLightSpriteData(art);
          if (!data) continue;
          list.push({
            flags, r: src.r, g: src.g, b: src.b, num, art, data, dark: !!(flags & LF_DARK), gx: wx, gy: wy, rgb: [255, 255, 255],
            left: Math.round(p.x + (Number(m.offsetX) || 0) - art.hotspotX), top: Math.round(p.y + (Number(m.offsetY) || 0) - art.hotspotY),
            w: art.canvas.width, h: art.canvas.height
          });
        }
      }
      const grid = new Map();
      list.forEach((e, idx) => {
        for (let cy = Math.floor(e.top / SEC_LIGHT_CELL); cy <= Math.floor((e.top + e.h - 1) / SEC_LIGHT_CELL); cy++)
          for (let cx = Math.floor(e.left / SEC_LIGHT_CELL); cx <= Math.floor((e.left + e.w - 1) / SEC_LIGHT_CELL); cx++) {
            const key = `${cx},${cy}`;
            const bucket = grid.get(key);
            if (bucket) bucket.push(idx); else grid.set(key, [idx]);
          }
      });
      model = { sig, list, grid, hasDark: list.some(e => e.dark) };
      view._lightModel = model;
    }
    for (const e of model.list) {
      e.rgb = (e.flags & LF_INDOOR) ? ambient.indoor : (e.flags & LF_OUTDOOR) ? ambient.outdoor : [e.r, e.g, e.b];
    }
    return model;
  }
  // Port of sub_4D89E0(): starts from `base` and adds (or, for dark lights,
  // subtracts) the light sprite pixel found under the point (sx, sy), given in
  // unzoomed iso pixels. `accept(entry)` can veto lights (used for walls).
  function secSampleLights(model, sx, sy, base, accept) {
    let r = base[0], g = base[1], b = base[2];
    const bucket = model.grid.get(`${Math.floor(sx / SEC_LIGHT_CELL)},${Math.floor(sy / SEC_LIGHT_CELL)}`);
    if (!bucket) return [r, g, b];
    const fx = Math.floor(sx), fy = Math.floor(sy);
    for (const idx of bucket) {
      const e = model.list[idx];
      const px = fx - e.left, py = fy - e.top;
      if (px < 0 || py < 0 || px >= e.w || py >= e.h) continue;
      if (accept && !accept(e)) continue;
      const o = (py * e.w + px) * 4, d = e.data.data;
      if (d[o + 3] === 0) continue; // colour key: no light here
      const cr = Math.round(d[o] * e.rgb[0] / 255), cg = Math.round(d[o + 1] * e.rgb[1] / 255), cb = Math.round(d[o + 2] * e.rgb[2] / 255);
      if (e.dark) { r = Math.max(0, r - cr); g = Math.max(0, g - cg); b = Math.max(0, b - cb); }
      else { r = Math.min(255, r + cr); g = Math.min(255, g + cg); b = Math.min(255, b + cb); }
    }
    return [r, g, b];
  }
  // Adds every light sprite into the tile mask (ambient + lighter - darker). Canvas
  // has no subtract blend, so dark lights are applied as invert / add / invert.
  function secAddLightsToMask(mctx, model, zoom, ox, oy, cssW, cssH) {
    if (!model || !model.list.length) return;
    const paint = dark => {
      for (const e of model.list) {
        if (e.dark !== dark) continue;
        const left = e.left * zoom + ox, top = e.top * zoom + oy;
        const w = e.w * zoom, h = e.h * zoom;
        if (left + w < 0 || left > cssW || top + h < 0 || top > cssH) continue;
        mctx.drawImage(secTintedLightSprite(e.num, e.art, e.rgb), left, top, w, h);
      }
    };
    mctx.save();
    mctx.imageSmoothingEnabled = false;
    mctx.globalCompositeOperation = 'lighter';
    paint(false);
    if (model.hasDark) {
      mctx.globalCompositeOperation = 'difference'; mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, cssW, cssH);
      mctx.globalCompositeOperation = 'lighter';
      paint(true);
      mctx.globalCompositeOperation = 'difference'; mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, cssW, cssH);
    }
    mctx.restore();
  }

  // Per-object lighting for the object overlays. Each object is tinted by its own
  // colour like the game does (sub_4DC210): one colour sampled at the object's anchor
  // for ordinary objects and portals, one colour per pixel column along the base of a wall.
  const OF_DONTLIGHT = 0x00100000;
  // Tinted copies of object sprites, kept between frames (sprite -> colour -> canvas).
  let secObjTintCache = new WeakMap();
  let secObjTintCount = 0;
  function secMakeLighting(view, bounds, iso, ambient, model) {
    const sectorMap = view.sectorMap;
    const lighting = {
      ambient, model,
      // Tile type 0 is "indoor": such tiles (and objects standing on them) use the indoor colour.
      baseAt(wx, wy) {
        const sector = sectorMap && sectorMap.get(`${Math.floor(wx / 64)},${Math.floor(wy / 64)}`);
        const raw = sector?.decoded ? (sector.decoded.tiles[(wy & 63) * 64 + (wx & 63)] >>> 0) : 0;
        const indoor = secTileIsIndoor(raw);
        return indoor ? ambient.indoor : ambient.outdoor;
      },
      quantize(rgb, base) {
        if (rgb[0] === base[0] && rgb[1] === base[1] && rgb[2] === base[2]) return rgb;
        const q = v => Math.min(255, (v + 2) & ~3);
        return [q(rgb[0]), q(rgb[1]), q(rgb[2])];
      },
      sprite(canvas, rgb) {
        if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) return canvas;
        let per = secObjTintCache.get(canvas);
        if (!per) { per = new Map(); secObjTintCache.set(canvas, per); }
        const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        let t = per.get(key);
        if (!t) {
          // Bound memory: drop every tinted copy once there are too many.
          if (++secObjTintCount > 2000) { secObjTintCache = new WeakMap(); secObjTintCount = 0; per = new Map(); secObjTintCache.set(canvas, per); }
          t = document.createElement('canvas'); t.width = canvas.width; t.height = canvas.height;
          t.getContext('2d').drawImage(canvas, 0, 0);
          secTintLayer(t, secLightRgb(rgb));
          per.set(key, t);
        }
        return t;
      },
      // Single colour for an ordinary object whose anchor is (sx, sy) in unzoomed iso pixels.
      pointColor(wx, wy, sx, sy) {
        const base = lighting.baseAt(wx, wy);
        return lighting.quantize(secSampleLights(model, sx, sy, base), base);
      },
      mobColor(mob, sx, sy) {
        if (((mob.objFlags | 0) & OF_DONTLIGHT) !== 0) return null;
        return lighting.pointColor(mob.sectorX * 64 + mob.tileX, mob.sectorY * 64 + mob.tileY, sx, sy);
      },
      // Portals: fixed anchor, nudged onto the adjoining tile for rotations 3 and 5.
      portalColor(portal, edgeRot, centreX, centreY) {
        if (((portal.objFlags | 0) & OF_DONTLIGHT) !== 0) return null;
        let wx = portal.sectorX * 64 + portal.tileX, wy = portal.sectorY * 64 + portal.tileY;
        let rot = edgeRot; if ((rot & 1) === 0) rot++;
        let dx = -20, dy = -10, tx = 0, ty = 0;
        if (rot === 1) { dx = 20; }
        else if (rot === 3) { ty = 1; }
        else if (rot === 5) { dx = 20; tx = 1; }
        wx += tx; wy += ty;
        // centreX/Y is the portal tile's centre; shift by the adjoining tile if needed.
        const shift = secIsoProject(tx, ty, { originX: 0, originY: 0 });
        return lighting.pointColor(wx, wy, centreX + shift.x + dx, centreY + shift.y + dy);
      },
      // Colour per pixel column (every 4th column sampled) along a wall's base line.
      // Returns null when the wall is unlit, otherwise [{x0, x1, rgb}] runs.
      wallRuns(wall, edgeRot, spriteLeft, spriteWidth, edgeX0, edgeY0, slope) {
        if (((wall.objFlags | 0) & OF_DONTLIGHT) !== 0) return null;
        const wx = wall.sectorX * 64 + wall.tileX, wy = wall.sectorY * 64 + wall.tileY;
        const rot = edgeRot & ~1;
        // Walls facing rot 2 / 4 always take the outdoor colour as their base.
        const base = (rot === 2 || rot === 4) ? ambient.outdoor : lighting.baseAt(wx, wy);
        // Only lights on the inner side of the wall reach it (sub_4DC210).
        const accept = e => (rot === 0 && e.gx >= wx) || (rot === 2 && e.gy > wy) || (rot === 4 && e.gx > wx) || (rot === 6 && e.gy >= wy);
        const runs = [];
        const STEP = 4;
        for (let x = 0; x < spriteWidth; x += STEP) {
          const sx = spriteLeft + x + STEP / 2;
          const sy = edgeY0 + slope * (sx - edgeX0);
          const rgb = lighting.quantize(secSampleLights(model, sx, sy, base, accept), base);
          const last = runs[runs.length - 1];
          if (last && last.rgb[0] === rgb[0] && last.rgb[1] === rgb[1] && last.rgb[2] === rgb[2]) last.x1 = Math.min(spriteWidth, x + STEP);
          else runs.push({ x0: x, x1: Math.min(spriteWidth, x + STEP), rgb });
        }
        return runs;
      }
    };
    return lighting;
  }

  async function renderSecFolderMap(relativePath, folderName, sectors) {
    const valid = sectors.filter(s => s.decoded && s.position);
    if (!valid.length) return null;
    const minX = Math.min(...valid.map(s => s.position.x)), maxX = Math.max(...valid.map(s => s.position.x));
    const minY = Math.min(...valid.map(s => s.position.y)), maxY = Math.max(...valid.map(s => s.position.y));
    const bounds = { minX, maxX, minY, maxY };
    await loadSecTileNameMes();
    // MOBs are deliberately lazy-loaded. Loading every MOB while opening a
    // large SEC map is expensive, and at the initial overview zoom they are
    // not useful. They are loaded only once the map reaches 60% zoom.
    let mobPoints = [];
    let mobDiagnostics = null;
    let mobLoadStarted = false;
    let mobLoadPromise = null;
    let onMobPointsLoaded = null; // set by the lighting controls: object lights need their art
    const loadMobDataAtZoom = async () => {
      if (mobLoadStarted || mobLoadPromise) return mobLoadPromise;
      mobLoadStarted = true;
      mobLoadPromise = (async () => {
        try {
          // The .mob files and the sector-embedded static objects are independent,
          // so load them concurrently (they share the art/prototype caches) and
          // merge the static-object diagnostics afterwards.
          const staticDiag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
          const [loaded, staticPoints] = await Promise.all([
            loadMobsForSecMap(relativePath, secManifest),
            loadSecStaticObjectPoints(valid, staticDiag)
          ]);
          mobDiagnostics = loaded.mobDiagnostics || null;
          if (!mobDiagnostics) mobDiagnostics = { relativePath, manifestLoaded: true, manifestError: null, manifestMobFiles: 0, filesExamined: 0, fetchFailures: [], decodeFailures: [], locationFailures: [], loaded: 0, wallLoaded: 0, staticObjectCount: 0, staticObjectTypeCounts: {}, objectTypeCounts: {} };
          mobDiagnostics.decodeFailures = (mobDiagnostics.decodeFailures || []).concat(staticDiag.decodeFailures);
          mobDiagnostics.locationFailures = (mobDiagnostics.locationFailures || []).concat(staticDiag.locationFailures);
          mobDiagnostics.staticObjectCount = (mobDiagnostics.staticObjectCount || 0) + staticDiag.staticObjectCount;
          mobDiagnostics.wallLoaded = (mobDiagnostics.wallLoaded || 0) + staticDiag.wallLoaded;
          mobDiagnostics.staticObjectTypeCounts = mobDiagnostics.staticObjectTypeCounts || {};
          for (const [k, v] of Object.entries(staticDiag.staticObjectTypeCounts)) mobDiagnostics.staticObjectTypeCounts[k] = (mobDiagnostics.staticObjectTypeCounts[k] || 0) + v;
          if (staticDiag.staticObjectErrors) mobDiagnostics.staticObjectErrors = (mobDiagnostics.staticObjectErrors || []).concat(staticDiag.staticObjectErrors);
          if (staticDiag.inventoryItemsSkipped) mobDiagnostics.inventoryItemsSkipped = (mobDiagnostics.inventoryItemsSkipped || 0) + staticDiag.inventoryItemsSkipped;
          mobPoints = loaded.concat(staticPoints);
        } catch (err) {
          mobDiagnostics = { relativePath, manifestLoaded: false, manifestError: String(err?.message || err), manifestMobFiles: 0, filesExamined: 0, fetchFailures: [], decodeFailures: [], locationFailures: [], loaded: 0, wallLoaded: 0, staticObjectCount: 0, staticObjectTypeCounts: {}, objectTypeCounts: {} };
          mobPoints = [];
        }
        if (onMobPointsLoaded) { try { await onMobPointsLoaded(); } catch (_) {} }
        updateMobMapMeta();
        redraw();
        return mobPoints;
      })();
      return mobLoadPromise;
    };
    let mapBackground = null;
    try {
      const mapUrl = `${SEC_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}Map.bmp`;
      const resp = await fetch(mapUrl, { cache: 'no-store' });
      if (resp.ok) {
        const blob = await resp.blob(), objectUrl = URL.createObjectURL(blob), img = new Image();
        mapBackground = await new Promise(resolve => {
          img.onload = () => {
            try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0); const im = cx.getImageData(0, 0, c.width, c.height); for (let i=0;i<im.data.length;i+=4) { const g=Math.round(im.data[i]*.299+im.data[i+1]*.587+im.data[i+2]*.114); im.data[i]=im.data[i+1]=im.data[i+2]=g; } cx.putImageData(im,0,0); const gray = new Image(); gray.onload=()=>{ URL.revokeObjectURL(objectUrl); resolve(gray); }; gray.onerror=()=>{ URL.revokeObjectURL(objectUrl); resolve(null); }; gray.src=c.toDataURL(); } catch (_) { URL.revokeObjectURL(objectUrl); resolve(null); }
          };
          img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); }; img.src = objectUrl;
        });
      }
    } catch (_) {}

    const article = document.createElement('article'); article.className = 'sec-viewer sec-folder-viewer';
    const head = document.createElement('div'); head.className = 'sec-viewer-head';
    head.innerHTML = `<div><h2 class="sec-viewer-title"></h2><div class="sec-viewer-meta"></div></div>`;
    head.querySelector('.sec-viewer-title').textContent = `Map · ${folderName}`;
    const mapMeta = head.querySelector('.sec-viewer-meta');
    const updateMobMapMeta = () => {
      const mobMeta = mobDiagnostics
        ? `${mobPoints.length} MOB${mobPoints.length === 1 ? '' : 's'} · walls loaded: ${mobDiagnostics.wallLoaded ?? 0}`
        : `MOBs load at 60% zoom`;
      mapMeta.textContent = `${valid.length} sector${valid.length === 1 ? '' : 's'} · X ${minX}–${maxX} · Y ${minY}–${maxY} · ${mobMeta} · each sector 64 × 64 tiles`;
    };
    updateMobMapMeta();
    const showFiles = document.createElement('button'); showFiles.type = 'button'; showFiles.className = 'btn-back'; showFiles.textContent = 'Show SEC files';
    showFiles.addEventListener('click', () => { viewerEl.hidden = true; viewerEl.innerHTML = ''; gridEl.hidden = false; renderSecFolderGrid(secManifest, relativePath); });
    head.appendChild(showFiles); article.appendChild(head);

    const layout = document.createElement('div'); layout.className = 'sec-map-layout';
    const mapCard = document.createElement('section'); mapCard.className = 'sec-map-card';
    const toolbar = document.createElement('div'); toolbar.className = 'sec-map-toolbar';
    const status = document.createElement('span'); status.className = 'sec-viewer-meta'; status.textContent = 'Colors · wheel to zoom · drag to pan · click a tile to inspect'; toolbar.appendChild(status);
    const zoomOut = document.createElement('button'); zoomOut.type='button'; zoomOut.className='btn-back'; zoomOut.textContent='−'; zoomOut.title='Zoom out';
    const zoomLabel = document.createElement('span'); zoomLabel.className='sec-zoom-label';
    const zoomIn = document.createElement('button'); zoomIn.type='button'; zoomIn.className='btn-back'; zoomIn.textContent='+'; zoomIn.title='Zoom in';
    const zoomReset = document.createElement('button'); zoomReset.type='button'; zoomReset.className='btn-back'; zoomReset.textContent='Reset zoom';
    toolbar.append(zoomOut, zoomLabel, zoomIn, zoomReset);
    const modeBtn = document.createElement('button'); modeBtn.type = 'button'; modeBtn.className = 'btn-back sec-map-mode'; modeBtn.textContent = 'Show actual tiles'; toolbar.appendChild(modeBtn); mapCard.appendChild(toolbar);
    const overlayControls = document.createElement('div');
    overlayControls.className = 'sec-overlay-controls';
    overlayControls.setAttribute('role', 'group');
    overlayControls.setAttribute('aria-label', 'Map overlays');
    toolbar.appendChild(overlayControls);
    const overlayVisibility = { containers: false, walls: false, scenery: false, otherMobs: false, bounds: false };
    const addOverlayToggle = (key, label, title) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sec-overlay-toggle';
      button.textContent = label;
      button.title = title;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        overlayVisibility[key] = !overlayVisibility[key];
        button.setAttribute('aria-pressed', String(overlayVisibility[key]));
        button.classList.toggle('active', overlayVisibility[key]);
        redraw();
      });
      overlayControls.appendChild(button);
    };
    addOverlayToggle('containers', 'Containers', 'Show or hide containers');
    addOverlayToggle('walls', 'Walls', 'Show or hide walls');
    addOverlayToggle('scenery', 'Scenery', 'Show or hide scenery');
    addOverlayToggle('otherMobs', 'Other mobs', 'Show or hide all other MOBs');
    addOverlayToggle('bounds', 'Bounds', 'Show or hide square outlines around overlays');
    // Ambient lighting: hour slider driven by the map's mapinfo.txt LightScheme.
    const lightControls = document.createElement('div');
    lightControls.className = 'sec-overlay-controls sec-light-controls';
    lightControls.setAttribute('role', 'group');
    lightControls.setAttribute('aria-label', 'Ambient lighting');
    const lightToggle = document.createElement('button');
    lightToggle.type = 'button'; lightToggle.className = 'sec-overlay-toggle'; lightToggle.textContent = 'Lighting';
    lightToggle.title = "Apply the map's ambient lighting (Actual tiles mode)"; lightToggle.setAttribute('aria-pressed', 'false');
    const lightHour = document.createElement('input');
    lightHour.type = 'range'; lightHour.min = '0'; lightHour.max = '23'; lightHour.step = '1'; lightHour.value = '12';
    lightHour.title = 'Hour of day'; lightHour.disabled = true; lightHour.style.width = '110px';
    const lightLabel = document.createElement('span'); lightLabel.className = 'sec-viewer-meta'; lightLabel.textContent = '';
    lightControls.append(lightToggle, lightHour, lightLabel);
    toolbar.appendChild(lightControls);
    const lightState = { enabled: false, hour: 12, table: null };
    const hourText = h => `${String(h).padStart(2, '0')}:00`;
    let lightLoading = null;
    const refreshLightLabel = () => {
      if (!lightState.enabled) { lightLabel.textContent = ''; return; }
      if (lightState.error) { lightLabel.textContent = lightState.error; return; }
      if (!lightState.table) { lightLabel.textContent = 'loading…'; return; }
      const c = lightState.table[lightState.hour];
      lightLabel.textContent = `${hourText(lightState.hour)} · scheme ${lightState.schemeName}${lightState.note || ''} · out ${c.outdoor.join(',')} / in ${c.indoor.join(',')}${mode === 'art' ? '' : ' · shown in Actual tiles mode'}`
        + (lightState.disks ? (lightState.disks.error ? ` · light disks: ${lightState.disks.error}` : ` · ${lightState.disks.drawn}/${lightState.disks.total} sector lights${lightState.disks.objectLights ? ` + ${lightState.disks.objectLights} object lights` : (mobLoadStarted && !mobLoadPromiseDone ? '' : '')}${lightState.disks.dark ? ` (${lightState.disks.dark} dark)` : ''}${lightState.disks.missingArt ? ` (${lightState.disks.missingArt} missing art)` : ''}`) : '');
    };
    lightToggle.addEventListener('click', async () => {
      lightState.enabled = !lightState.enabled;
      lightToggle.setAttribute('aria-pressed', String(lightState.enabled));
      lightToggle.classList.toggle('active', lightState.enabled);
      lightHour.disabled = !lightState.enabled;
      if (lightState.enabled && !lightState.table && !lightLoading) {
        lightLoading = loadMapLighting(relativePath).then(res => {
          if (res.error) { lightState.error = res.error; return; }
          lightState.table = res.table; lightState.schemeName = `${res.requested} (${res.name})`; lightState.note = res.note || '';
          if (!res.mapinfoFound) lightState.note += ' · no mapinfo.txt, using default scheme';
          return ensureSecLightArt(valid, mobPoints).then(stats => { lightState.disks = stats; });
        }).catch(err => { lightState.error = String(err.message || err); }).finally(() => { lightLoading = null; refreshLightLabel(); redraw(); });
      }
      // Lamps, torches and other objects carry lights too, so their data must be loaded
      // even below the usual 60% zoom threshold.
      if (lightState.enabled && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
      refreshLightLabel(); redraw();
    });
    onMobPointsLoaded = async () => {
      if (!lightState.enabled || !lightState.table) return;
      lightState.disks = await ensureSecLightArt(valid, mobPoints);
      refreshLightLabel();
    };
    lightHour.addEventListener('input', () => { lightState.hour = Number(lightHour.value); refreshLightLabel(); redraw(); });
    const stage = document.createElement('div'); stage.className = 'sec-map-stage sec-folder-map-stage';
    const canvas = document.createElement('canvas'); const tip = document.createElement('div'); tip.className = 'sec-map-tooltip'; tip.hidden = true;
    stage.append(canvas, tip); mapCard.appendChild(stage);
    const hint = document.createElement('p'); hint.className = 'sec-map-hint'; hint.textContent = '0,0 is top-right · X increases leftward · Y increases downward. Use the mouse wheel or buttons to zoom; drag to pan.'; mapCard.appendChild(hint);

    const info = document.createElement('aside'); info.className = 'sec-tile-info';
    info.innerHTML = '<h3>Art IDs on map</h3><div class="sec-art-legend"></div><hr><h3>Selected tile</h3><div class="sec-info-row"><span>Sector X / Y</span><span>—</span></div><div class="sec-info-row"><span>Tile X / Y</span><span>—</span></div><div class="sec-info-row"><span>World X / Y</span><span>—</span></div><div class="sec-info-row"><span>Art ID</span><span>—</span></div><div class="sec-info-row"><span>Tile</span><span>—</span></div><div class="sec-info-row"><span>SEC file</span><span>—</span></div><div class="sec-info-row"><span>Hex</span><span>—</span></div><hr><h3>MOBs on tile</h3><div class="sec-mob-info">—</div><hr><h3>Walls on tile</h3><div class="sec-wall-info">—</div>';
    layout.append(mapCard, info); article.appendChild(layout);
    const legendEl = info.querySelector('.sec-art-legend');
    for (const entry of secFolderLegendEntries(valid)) {
      const row = document.createElement('div'); row.className = 'sec-art-legend-row';
      const swatch = document.createElement('span'); swatch.className = 'sec-art-legend-swatch'; swatch.style.background = entry.color;
      const label = document.createElement('span'); label.className = 'sec-art-legend-label'; label.textContent = `${entry.artId}${entry.name ? ` · ${entry.name}` : ''}`;
      const count = document.createElement('span'); count.className = 'sec-art-legend-count'; count.textContent = String(entry.count);
      row.append(swatch, label, count); legendEl.appendChild(row);
    }

    const mapW = (maxX - minX + 1) * 64, mapH = (maxY - minY + 1) * 64;
    const iso = secIsoMetrics(bounds);
    const sectorMap = new Map(valid.map(s => [`${s.position.x},${s.position.y}`, s]));
    const view = { zoom: 1, offsetX: 0, offsetY: 0, initialized: false, sectorMap, colorSectorCache: new Map(), light: lightState,
      blankSectors: null, loadedSectors: new Set(), loadingSectors: new Set() };
    let selected = null, mode = 'color', artTiles = new Map(), artLoadStarted = false, artLoadTimer = null;
    const infoRows = info.querySelectorAll('.sec-info-row span:last-child');
    const mobInfoEl = info.querySelector('.sec-mob-info');
    const wallInfoEl = info.querySelector('.sec-wall-info');
    const fitView = () => {
      const w = Math.max(320, stage.clientWidth || 760), h = Math.max(260, stage.clientHeight || 620);
      const fitColor = Math.min(w / mapW, h / mapH);
      const fitIso = Math.min(w / iso.width, h / iso.height);
      const fit = mode === 'art' ? fitIso : fitColor;
      view.zoom = Math.max(.01, Math.min(32, fit));
      const targetW = mode === 'art' ? iso.width : mapW;
      const targetH = mode === 'art' ? iso.height : mapH;
      view.offsetX = (w - targetW * view.zoom) / 2;
      view.offsetY = (h - targetH * view.zoom) / 2;
      view.initialized = true; redraw();
      if (view.zoom >= 0.6 && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    };
    const updateZoomLabel = () => { zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`; };
    const redraw = () => { updateZoomLabel(); drawSecFolderMap(canvas, valid, bounds, selected, mode, artTiles, view, mobPoints, mapBackground, overlayVisibility); };
    const zoomAt = (factor, cx, cy) => {
      const old = view.zoom, next = Math.max(.01, Math.min(32, old * factor));
      if (next === old) return;
      const wx = (cx - view.offsetX) / old, wy = (cy - view.offsetY) / old;
      view.zoom = next; view.offsetX = cx - wx * next; view.offsetY = cy - wy * next; redraw();
      if (view.zoom >= 0.6 && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
      if (mode === 'art') scheduleVisibleArtLoad();
    };
    const sectorAtPoint = event => {
      const r = canvas.getBoundingClientRect();
      const sx = (event.clientX - r.left - view.offsetX) / view.zoom;
      const sy = (event.clientY - r.top - view.offsetY) / view.zoom;
      if (mode === 'art') {
        const p = secIsoUnproject(sx, sy, iso);
        const worldTileX = Math.round(p.x), worldTileY = Math.round(p.y);
        if (worldTileX < 0 || worldTileY < 0 || worldTileX >= mapW || worldTileY >= mapH) return null;
        // In isometric mode the projected X coordinate already follows the
        // game's world convention: X=0 is top-right and X increases leftward.
        const originalX = worldTileX;
        return { sectorX: minX + Math.floor(originalX / 64), sectorY: minY + Math.floor(worldTileY / 64), tileX: originalX & 63, tileY: worldTileY & 63 };
      }
      if (sx < 0 || sy < 0 || sx >= mapW || sy >= mapH) return null;
      const worldTileX = Math.floor(sx), worldTileY = Math.floor(sy);
      const originalX = mapW - 1 - worldTileX;
      return { sectorX: minX + Math.floor(originalX / 64), sectorY: minY + Math.floor(worldTileY / 64), tileX: originalX & 63, tileY: worldTileY & 63 };
    };
    const findSector = (sx, sy) => sectorMap.get(`${sx},${sy}`);
    const updateInfo = p => {
      const sector = findSector(p.sectorX, p.sectorY); if (!sector?.decoded) return;
      const raw = sector.decoded.tiles[p.tileY * 64 + p.tileX] >>> 0, tile = secTileInfo(raw);
      infoRows[0].textContent = `${p.sectorX}, ${p.sectorY}`; infoRows[1].textContent = `${p.tileX}, ${p.tileY}`;
      infoRows[2].textContent = `${p.sectorX * 64 + p.tileX}, ${p.sectorY * 64 + p.tileY}`; infoRows[3].textContent = String(tile.artId);
      infoRows[4].textContent = tile.name || '—'; infoRows[5].textContent = sector.filename; infoRows[6].textContent = `0x${raw.toString(16).padStart(8, '0').toUpperCase()}`;
      const atTile = mobPoints.filter(m => m.sectorX === p.sectorX && m.sectorY === p.sectorY && m.tileX === p.tileX && m.tileY === p.tileY);
      mobInfoEl.innerHTML = '';
      if (!atTile.length) mobInfoEl.textContent = '—';
      else for (const mob of atTile) {
        const row = document.createElement('div'); row.className = 'sec-mob-info-row';
        row.textContent = `${mob.name || mob.file || 'Unknown MOB'} · Type ${mob.type} (${mob.typeName || 'unknown'}) · Art ID ${mob.artId != null ? mob.artId : ((mob.type === 15 || mob.type === 16) && protoCritterAidInfo(mob.currentAidRaw, mob.type) ? protoCritterAidInfo(mob.currentAidRaw, mob.type).text : '?')}` +
          (mob.artFile ? ` · ${mob.artFile}` : '') + (mob.artNote ? ` · ${mob.artNote}` : '');
        mobInfoEl.appendChild(row);
      }

      const walls = atTile.filter(m => m.type === 0);
      wallInfoEl.innerHTML = '';
      const d = mobDiagnostics;
      if (d) {
        const summary = document.createElement('div');
        summary.className = 'sec-mob-info-row';
        const counts = Object.entries(d.objectTypeCounts || {}).sort((a,b) => Number(a[0]) - Number(b[0])).map(([k,v]) => `${k}:${v}`).join(', ') || 'none';
        summary.innerHTML = `<strong>MOB loading diagnostics</strong><br>` +
          `Manifest: ${d.manifestLoaded ? 'loaded' : 'FAILED'} · MOB entries: ${d.manifestMobFiles ?? 0}<br>` +
          `Files examined: ${d.filesExamined ?? 0} · decoded objects: ${d.loaded ?? 0} · walls (type 0): ${d.wallLoaded ?? 0}<br>` +
          `Object types decoded: ${counts}<br>` +
          `SEC static objects: ${d.staticObjectCount ?? 0} · static walls (type 0): ${d.staticObjectTypeCounts?.['0'] ?? 0}<br>` +
          `Inventory items hidden (OF_INVENTORY): ${d.inventoryItemsSkipped ?? 0}<br>` +
          `Fetch failures: ${(d.fetchFailures || []).length} · decode failures: ${(d.decodeFailures || []).length} · location failures: ${(d.locationFailures || []).length}` +
          (d.manifestError ? `<br>Manifest error: ${String(d.manifestError)}` : '');
        wallInfoEl.appendChild(summary);
        if ((d.decodeFailures || []).length || (d.fetchFailures || []).length || (d.locationFailures || []).length || (d.staticObjectErrors || []).length) {
          const details = document.createElement('details');
          const summaryEl = document.createElement('summary'); summaryEl.textContent = 'MOB loading errors';
          const pre = document.createElement('pre');
          pre.textContent = [
            ...(d.fetchFailures || []).map(x => `FETCH FAILED: ${x.file} (${x.status} ${x.statusText || ''})`),
            ...(d.decodeFailures || []).map(x => `DECODE FAILED: ${x.file}\n${x.error}${x.stack ? `\n${x.stack}` : ''}`),
            ...(d.locationFailures || []).map(x => `LOCATION FAILED: ${x.file} · type=${x.objectType} · F_LOCATION=${x.locationRaw == null ? '—' : String(x.locationRaw)}`),
            ...(d.staticObjectErrors || []).map(x => `SEC STATIC OBJECTS FAILED: ${x.file}\n${x.error}`)
          ].join('\n\n') || '—';
          details.append(summaryEl, pre); wallInfoEl.appendChild(details);
        }
      }
      if (!walls.length) {
        const msg = document.createElement('div'); msg.className = 'sec-mob-info-row'; msg.textContent = 'No type-0 wall MOB was loaded at this exact tile.'; wallInfoEl.appendChild(msg);
      } else {
        for (const wall of walls) {
          const box = document.createElement('div');
          box.className = 'sec-mob-info-row';
          const fields = Array.isArray(wall.wallFields) ? wall.wallFields : [];
          const field = n => fields.find(f => f.field === n)?.value;
          const fmt = v => {
            if (v == null) return '—';
            if (typeof v === 'bigint') return v.toString();
            return String(v);
          };
          const aid = wall.currentAidRaw;
          const flags = Number(wall.wallFlags) >>> 0;
          box.innerHTML = `<strong>${wall.file || 'Unknown wall'}</strong><br>` +
            `Object type: ${wall.type} (${wall.typeName || 'WALL'})<br>` +
            `Sector: ${wall.sectorX}, ${wall.sectorY} · Tile: ${wall.tileX}, ${wall.tileY}<br>` +
            `World: ${wall.worldX}, ${wall.worldY}<br>` +
            `F_LOCATION (2): ${fmt(wall.locationRaw)}<br>` +
            `F_CURRENT_AID (1) raw: ${fmt(aid)}${aid != null ? ` · hex 0x${(Number(aid) >>> 0).toString(16).toUpperCase()}` : ''}<br>` +
            `F_WALL_FLAGS (39): ${flags} · hex 0x${flags.toString(16).padStart(8,'0').toUpperCase()}<br>` +
            `Decoded art ID: ${wall.artId == null ? 'wall-specific' : wall.artId}<br>` +
            `Wall ART: ${wall.artName || '—'}<br>` +
            `Wall AID decode: ${wall.wallDecode ? (wall.wallDecode.missing ? 'no matching .art found' : `num=${wall.wallDecode.num}, piece=${wall.wallDecode.piece}, variation=${wall.wallDecode.variation}, rotation=${wall.wallDecode.rotation}, piece name=${wall.wallDecode.pieceName ?? '?'}, palette=${wall.wallDecode.palette}, file=${wall.artName || wall.wallDecode.filename || '?'}, art direction=${wall.wallDecode.artDirection ?? '?'} (${wall.wallDecode.mappingNote || ''}), damage=0x${(wall.wallDecode.damage>>>0).toString(16).toUpperCase()}`) : 'not decoded'}<br>` +
            `Wall structure: ${wall.wallDecode?.structureNum ?? '?'} · interior ${wall.wallDecode?.interiorStem ?? '?'} · exterior ${wall.wallDecode?.exteriorStem ?? '?'} · used ${wall.wallDecode?.usedSide ?? '?'} (structure bits 20-27 = ${wall.wallDecode?.num ?? '?'})<br>` +
            `Placement: ${wall.placementNote || '—'}<br>` +
            `Field 3: ${fmt(field(3))} · Field 4: ${fmt(field(4))} · Field 5: ${fmt(field(5))}`;
          const details = document.createElement('details');
          const summary = document.createElement('summary'); summary.textContent = 'All decoded fields';
          const pre = document.createElement('pre'); pre.textContent = fields.map(f => `F_${f.field}: ${fmt(f.value)}`).join('\n') || '—';
          details.append(summary, pre);
          box.appendChild(details);
          wallInfoEl.appendChild(box);
        }
      }
      selected = p; redraw();
    };
    canvas.addEventListener('wheel', event => { event.preventDefault(); const r=canvas.getBoundingClientRect(); zoomAt(event.deltaY < 0 ? 1.18 : 1/1.18, event.clientX-r.left, event.clientY-r.top); }, {passive:false});
    let dragging=false, dragX=0, dragY=0;
    canvas.addEventListener('mousedown', e => { if (e.button !== 0) return; dragging=true; dragX=e.clientX; dragY=e.clientY; canvas.style.cursor='grabbing'; });
    window.addEventListener('mouseup', () => { dragging=false; canvas.style.cursor='crosshair'; });
    canvas.addEventListener('mousemove', event => {
      if (dragging) { view.offsetX += event.clientX-dragX; view.offsetY += event.clientY-dragY; dragX=event.clientX; dragY=event.clientY; redraw(); scheduleVisibleArtLoad(); return; }
      const p = sectorAtPoint(event), sector = p && findSector(p.sectorX, p.sectorY);
      if (!sector?.decoded) { tip.hidden=true; return; }
      if (mode === 'art' && !view.loadedSectors.has(secSectorKey(sector))) {
        canvas.style.cursor = view.blankSectors?.has(secSectorKey(sector)) ? 'crosshair' : 'pointer';
        if (view.blankSectors?.has(secSectorKey(sector))) { tip.hidden=true; return; }
        tip.hidden=false; tip.textContent=`Sector ${secSectorLabel(sector)} · click to load`;
        const sr0=stage.getBoundingClientRect(); tip.style.left=`${event.clientX-sr0.left}px`; tip.style.top=`${event.clientY-sr0.top}px`;
        return;
      }
      canvas.style.cursor = 'crosshair';
      const raw=sector.decoded.tiles[p.tileY*64+p.tileX]>>>0, tile=secTileInfo(raw);
      const loadedArt = artTiles.get(raw);
      tip.hidden=false; tip.textContent=`Sector ${p.sectorX},${p.sectorY} · Tile ${p.tileX},${p.tileY} · Art ID ${tile.artId}${tile.name?` · ${tile.name}`:''}${loadedArt?.facadeName?` · frame ${loadedArt.facadeFrame}`:''}`;
      const sr=stage.getBoundingClientRect(); tip.style.left=`${event.clientX-sr.left}px`; tip.style.top=`${event.clientY-sr.top}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden=true; });
    canvas.addEventListener('click', event => {
      if (Math.abs(event.clientX-dragX)+Math.abs(event.clientY-dragY)>6) return;
      const p=sectorAtPoint(event); if(!p) return;
      const sec=findSector(p.sectorX,p.sectorY); if(!sec?.decoded) return;
      if (mode === 'art' && !view.loadedSectors.has(secSectorKey(sec))) {
        if (!view.blankSectors?.has(secSectorKey(sec))) loadSectorTiles(sec);
        return;
      }
      updateInfo(p);
    });
    zoomOut.addEventListener('click',()=>zoomAt(1/1.4,stage.clientWidth/2,stage.clientHeight/2));
    zoomIn.addEventListener('click',()=>zoomAt(1.4,stage.clientWidth/2,stage.clientHeight/2));
    zoomReset.addEventListener('click',fitView);

    const scheduleVisibleArtLoad = () => {
      if (mode !== 'art' || !artLoadStarted) return;
      clearTimeout(artLoadTimer);
      artLoadTimer = setTimeout(() => { loadVisibleFolderTileArt().catch(() => {}); }, 80);
    };
    const sectorStatus = () => {
      const blank = view.blankSectors ? view.blankSectors.size : 0;
      status.textContent = `${valid.length - blank} sector${valid.length - blank === 1 ? '' : 's'} to load (${blank} blank hidden) · ${view.loadedSectors.size} loaded · click a blue sector to load it`;
    };
    // Resolves the art of every unique tile in one sector, then reveals it.
    const loadSectorTiles = async sector => {
      const key = secSectorKey(sector);
      if (view.loadedSectors.has(key) || view.loadingSectors.has(key)) return;
      view.loadingSectors.add(key); redraw();
      try {
        await loadSecTileManifest();
        const need = new Set();
        for (const t of sector.decoded.tiles) { const raw = t >>> 0; if (raw !== 0 && !artTiles.has(raw)) need.add(raw); }
        const results = await Promise.all([...need].map(async raw => ({ raw, art: await loadSecTileArt(secTileInfo(raw)) })));
        for (const { raw, art } of results) if (art) artTiles.set(raw, art);
        view.loadedSectors.add(key);
      } catch (err) {
        status.textContent = `Could not load sector ${secSectorLabel(sector)}: ${String(err?.message || err)}`;
      } finally {
        view.loadingSectors.delete(key);
        if (mode === 'art' && view.loadedSectors.has(key)) sectorStatus();
        redraw();
      }
    };
    modeBtn.addEventListener('click', async () => {
      mode=mode==='color'?'art':'color'; modeBtn.textContent=mode==='art'?'Show colors':'Show actual tiles';
      if (mode === 'art') {
        // Before anything is shown, find the sectors made only of blank tiles.
        if (!view.blankSectors) {
          modeBtn.disabled = true; status.textContent = 'Looking for blank sectors…';
          await new Promise(r => setTimeout(r, 0)); // let the status text paint
          try { view.blankSectors = secDetectBlankSectors(valid); }
          finally { modeBtn.disabled = false; }
        }
        artLoadStarted = true;
        sectorStatus();
      } else {
        status.textContent = 'Colors · wheel to zoom · drag to pan · click a tile to inspect';
      }
      fitView();
    });
    async function loadVisibleFolderTileArt(){
      const needed=new Set();
      const w=stage.clientWidth,h=stage.clientHeight;
      if (mode === 'art') {
        // Determine which tile centers can fall inside the viewport in
        // isometric coordinates.  Convert the four viewport corners back to
        // tile space, then add a generous margin for diamond edges.
        const corners = [
          secIsoUnproject((-view.offsetX) / view.zoom, (-view.offsetY) / view.zoom, iso),
          secIsoUnproject((w - view.offsetX) / view.zoom, (-view.offsetY) / view.zoom, iso),
          secIsoUnproject((-view.offsetX) / view.zoom, (h - view.offsetY) / view.zoom, iso),
          secIsoUnproject((w - view.offsetX) / view.zoom, (h - view.offsetY) / view.zoom, iso)
        ];
        const minXv=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.x)))-2);
        const maxXv=Math.min(mapW-1,Math.ceil(Math.max(...corners.map(p=>p.x)))+2);
        const minYv=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y)))-2);
        const maxYv=Math.min(mapH-1,Math.ceil(Math.max(...corners.map(p=>p.y)))+2);
        for(const s of valid){
          if (!view.loadedSectors.has(secSectorKey(s))) continue;
          const bx=(s.position.x-minX)*64, by=(s.position.y-minY)*64;
          const x0=Math.max(0,minXv-bx),x1=Math.min(63,maxXv-bx),y0=Math.max(0,minYv-by),y1=Math.min(63,maxYv-by);
          if(x0>x1||y0>y1) continue;
          for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
            const raw = s.decoded.tiles[y*64+x]>>>0;
            if (raw !== 0) needed.add(raw);
          }
        }
      }
      const arr=[...needed].filter(raw=>!artTiles.has(raw));
      if (!arr.length) return;

      // Pre-resolve every unique visible SEC tile before drawing. The ART-file
      // cache above collapses duplicate filenames, so each physical ART is
      // fetched and parsed at most once even when many tile IDs reference it.
      status.textContent=`Resolving ${arr.length} unique visible tiles…`;
      const results = await Promise.all(arr.map(async raw => {
        const art = await loadSecTileArt(secTileInfo(raw));
        return { raw, art };
      }));
      for (const { raw, art } of results) {
        if (art) artTiles.set(raw, art);
      }
      status.textContent=`${artTiles.size} tile art files loaded · zoom/pan to load more`;
      redraw();
    }

    const ro=new ResizeObserver(()=>{ if(!view.initialized) fitView(); else redraw(); }); ro.observe(stage);
    requestAnimationFrame(fitView);
    return article;
  }

  async function openSecFolder(relativePath, folderName) {
    treeEl.innerHTML = '<p class="mob-loading">Loading folder…</p>';
    breadcrumbEl.textContent = `/maps/${relativePath ? relativePath + '/' : ''}`;
    try {
      secCurrentPath = relativePath || '';
      secCurrentFolderName = secDisplayName(secCurrentPath, folderName);
      secManifest = await loadSecManifest(secCurrentPath, secCurrentFolderName);
      secFiles = extractSecManifestFiles(secManifest);
      saveDataExplorerState('sec', secCurrentPath, secCurrentFolderName, null);
      renderSecTree(secManifest, secCurrentPath, secCurrentFolderName);
      renderSecFolderGrid(secManifest, secCurrentPath);
      if (secFiles.length) {
        const loading = renderSecFolderLoading(secCurrentFolderName, secFiles.length);
        viewerEl.innerHTML = '';
        viewerEl.appendChild(loading.article);
        viewerEl.hidden = false;
        viewerEl.classList.add('revealed');
        gridEl.hidden = true;
        // Give the browser a chance to paint the loading UI before the first fetch.
        await new Promise(resolve => requestAnimationFrame(resolve));
        const sectors = await loadSecFolderSectors(secCurrentPath, secFiles, loading.update);
        const folderMap = await renderSecFolderMap(secCurrentPath, secCurrentFolderName, sectors);
        if (folderMap) {
          viewerEl.innerHTML = '';
          viewerEl.appendChild(folderMap);
          viewerEl.hidden = false;
          viewerEl.classList.add('revealed');
          gridEl.hidden = true;
        } else {
          gridEl.hidden = false; viewerEl.hidden = true; viewerEl.innerHTML = '';
        }
      } else {
        gridEl.hidden = false; viewerEl.hidden = true; viewerEl.innerHTML = '';
      }
    } catch (err) {
      treeEl.innerHTML = '';
      const p = document.createElement('p'); p.className = 'explorer-status err';
      p.textContent = err && err.message ? err.message : String(err);
      treeEl.appendChild(p);
      gridEl.innerHTML = `<p class="explorer-status err"></p>`;
      gridEl.querySelector('p').textContent = p.textContent;
    }
  }

  async function enterSecExplorer(restoreState = false) {
    leaveExplorerHome();
    explorerHome.hidden = true;
    document.querySelector('.explorer').hidden = false;
    if (manualLoadEl) manualLoadEl.hidden = true;
    if (logEl) logEl.hidden = true;
    if (footerNoteEl) footerNoteEl.hidden = false;
    explorerMode = 'sec';
    syncSidebarLaunchButtons();
    artExplorerControls.hidden = true;
    if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = true;
    if (searchInputEl) searchInputEl.value = '';
    if (searchClearBtnEl) searchClearBtnEl.hidden = true;
    paginationEl.hidden = true;
    viewerEl.hidden = true;
    viewerEl.innerHTML = '';
    const saved = restoreState ? loadDataExplorerState() : null;
    const savedPath = saved?.mode === 'sec' ? (saved.path || '') : '';
    const savedName = savedPath
      ? (saved?.folderName || savedPath.split('/').pop())
      : 'maps';
    const savedFile = saved?.mode === 'sec' ? saved.file : null;
    breadcrumbEl.textContent = `/maps/${savedPath ? savedPath + '/' : ''}`;
    treeEl.innerHTML = '<p class="mob-loading">Loading /maps/ manifest…</p>';
    gridEl.innerHTML = '';
    gridEl.hidden = false;
    try {
      secCurrentPath = savedPath; secCurrentFolderName = savedName;
      secManifest = await loadSecManifest(savedPath, savedName);
      secFiles = extractSecManifestFiles(secManifest);
      renderSecTree(secManifest, savedPath, savedName);
      renderSecFolderGrid(secManifest, savedPath);
      if (savedFile && secFiles.includes(savedFile)) await openSecFile(savedFile, savedPath, null);
      else if (savedPath) await openSecFolder(savedPath, savedName);
    } catch (err) {
      treeEl.innerHTML = '';
      const p = document.createElement('p'); p.className = 'explorer-status err';
      p.textContent = err && err.message ? err.message : String(err);
      treeEl.appendChild(p);
      gridEl.innerHTML = '<p class="explorer-status err"></p>';
      gridEl.querySelector('p').textContent = p.textContent;
    }
  }

  function manifestUrl(relativePath, folderName) {
    const prefix = relativePath ? `${ART_ROOT}${encPath(relativePath)}/` : ART_ROOT;
    const manifestFolder = folderName || relativePath.split('/').pop() || ROOT_FOLDER_NAME;
    return `${prefix}${encodeURIComponent(manifestFolder)}_manifest.json`;
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
  const artPreviewCache = new Map();
  const pendingPreviewLoaders = new WeakMap();
  const artPreviewObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        artPreviewObserver.unobserve(entry.target);
        const load = pendingPreviewLoaders.get(entry.target);
        pendingPreviewLoaders.delete(entry.target);
        if (load) load();
      }
    }, { rootMargin: '240px' })
    : null;

  function deferArtPreview(element, load) {
    pendingPreviewLoaders.set(element, load);
    if (artPreviewObserver) artPreviewObserver.observe(element);
    else load();
  }

  async function loadArtPreview(relativePath, filename) {
    const prefix = relativePath ? `${relativePath}/` : '';
    const url = `${ART_ROOT}${encPath(prefix)}${encPath(filename)}`;
    if (artPreviewCache.has(url)) return artPreviewCache.get(url);

    const previewPromise = (async () => {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const frames = await parseArtBuffer(await response.arrayBuffer(), 1);
      const frame = frames[0];
      if (!frame) return null;

      const size = 96;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const scale = Math.min(1, size / frame.width, size / frame.height);
      const width = Math.max(1, Math.round(frame.width * scale));
      const height = Math.max(1, Math.round(frame.height * scale));
      canvas.getContext('2d').drawImage(frame.canvas, (size - width) / 2, (size - height) / 2, width, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return blob ? URL.createObjectURL(blob) : null;
    })().catch(() => null);
    artPreviewCache.set(url, previewPromise);
    return previewPromise;
  }

  function attachArtPreview(container, relativePath, filename) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    container.appendChild(image);
    deferArtPreview(container, async () => {
      const url = await loadArtPreview(relativePath, filename);
      if (!container.isConnected) return;
      if (url) {
        image.src = url;
      } else {
        container.classList.add('missing');
        container.textContent = '🖼';
      }
    });
  }

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
        folderName: (folderName && folderName !== '..') ? folderName : (mode === 'pro' ? 'proto' : 'maps'),
        file: file || null,
      }));
    } catch (_) {}
  }

  function loadDataExplorerState() {
    try {
      const raw = localStorage.getItem(DATA_EXPLORER_STATE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || (state.mode !== 'pro' && state.mode !== 'mob' && state.mode !== 'sec')) return null;
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
    const prefix = relPath ? `${relPath}/` : '';
    const artUrl = `${ART_ROOT}${encPath(prefix)}${encPath(filename)}`;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item';

    const thumb = document.createElement('span');
    thumb.className = 'explorer-thumb';
    attachArtPreview(thumb, relPath, filename);
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

    deferArtPreview(thumb, async () => {
      const arts = await findFirstArtFiles(fullPath, sf.folder_name, 4);
      if (!arts.length || !thumb.isConnected) return;
      thumb.innerHTML = '';
      thumb.classList.add('has-mosaic');
      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('span');
        cell.className = 'mosaic-cell';
        if (arts[i]) {
          attachArtPreview(cell, arts[i].relativePath, arts[i].filename);
        } else {
          cell.classList.add('empty');
        }
        thumb.appendChild(cell);
      }
    });
  }

  async function findFirstArtFiles(relativePath, folderName, limit) {
    const arts = [];
    const visited = new Set();
    const MAX_FETCHES = 40;
    let fetches = 0;

    async function walk(relPath, fName) {
      if (arts.length >= limit || fetches >= MAX_FETCHES) return;
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
      for (const f of files) {
        if (arts.length >= limit) return;
        arts.push({ filename: f, relativePath: relPath });
      }
      if (arts.length >= limit) return;

      const subfolders = manifest.subfolders || {};
      const keys = Object.keys(subfolders).sort();
      for (const key of keys) {
        if (arts.length >= limit || fetches >= MAX_FETCHES) return;
        const sf = subfolders[key];
        if (!sf || typeof sf !== 'object' || !sf.folder_name) continue;
        await walk(joinPath(relPath, sf.relative_path), sf.folder_name);
      }
    }

    await walk(relativePath, folderName);
    return arts.slice(0, limit);
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
    // Check candidates in small parallel batches; results are still appended in
    // manifest order so the list looks the same as the sequential version.
    const BATCH = 8;
    for (let i = 0; i < candidates.length; i += BATCH) {
      if (results.length >= limit) return;
      const batch = candidates.slice(i, i + BATCH);
      const ok = await Promise.all(batch.map(f => protoFileMatchesType(f, relativePath)));
      for (let k = 0; k < batch.length; k++) {
        if (results.length >= limit) return;
        if (ok[k]) results.push({ filename: batch[k], relPath: relativePath, folderName });
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
    const artUrl = `${ART_ROOT}${encPath(folderPrefix)}${encPath(target.file)}`;
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
  } else {
    const savedDataState = loadDataExplorerState();
    if (savedDataState?.mode === 'sec') enterSecExplorer(true);
    else if (savedDataState?.mode === 'pro') enterProtoExplorer(true);
    else if (savedDataState?.mode === 'mob') enterMobExplorer(true);
  }

  // The last .SEC/.PRO/.MOB location is restored on a normal page reload.


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

  // ---- Text table search (/data/semes/, /data/dlg/, /data/mes/, /data/oemes/, /data/Rules/) ----
  //
  // Each root folder carries a "<foldername>_manifest.json" with optional
  // subfolders, like the ART/PRO/MOB explorers above. This walks every listed file across all
  // five roots and applies the same matching + {dialog} cleanup rules as
  // research.py: an exact, case-sensitive substring match against each raw
  // line, with empty/numeric/duplicate-per-file {tokens} stripped out.

  const TEXT_TABLE_ROOTS = [
    { key: 'semes', root: `${DATA_ROOT}semes/`, folderName: 'semes' },
    { key: 'dlg', root: `${DATA_ROOT}dlg/`, folderName: 'dlg' },
    { key: 'mes', root: `${DATA_ROOT}mes/`, folderName: 'mes' },
    { key: 'oemes', root: `${DATA_ROOT}oemes/`, folderName: 'oemes' },
    { key: 'rules', root: `${DATA_ROOT}Rules/`, folderName: 'Rules' },
  ];

  const TEXT_SEARCH_MATCH_LIMIT = 2000;
  const TEXT_SEARCH_CONCURRENCY = 8;

  const textTableManifestCache = new Map(); // "root::relativePath" -> parsed manifest json
  let textTableFileIndexPromise = null;

  function textTableManifestUrls(root, relativePath, folderName) {
    const prefix = relativePath ? `${root}${encPath(relativePath)}/` : root;
    const rootFolder = root.slice(DATA_ROOT.length).replace(/\/$/, '');
    const manifestFolder = folderName || relativePath.split('/').pop() || rootFolder;
    return `${prefix}${encodeURIComponent(manifestFolder)}_manifest.json`;
  }

  async function loadTextTableManifest(root, relativePath, folderName) {
    const cacheKey = `${root}::${relativePath}`;
    if (textTableManifestCache.has(cacheKey)) return textTableManifestCache.get(cacheKey);
    const url = textTableManifestUrls(root, relativePath, folderName);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const data = await resp.json();
    textTableManifestCache.set(cacheKey, data);
    return data;
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
    tsStatusEl.textContent = `Searching for "${query}" in /data/semes/, /data/dlg/, /data/mes/, /data/oemes/ and /data/Rules/…`;
    tsResultsEl.textContent = '';

    try {
      const index = await buildTextTableFileIndex();
      textTableFileIndexCache.clear();
      for (const entry of index.files) textTableFileIndexCache.set(entry.filePath, entry);
      const folderGroups = new Map(); // folderDisplay -> Map(filePath -> [{lineNum, text}])
      const readErrors = index.errors.slice();
      let matchCount = 0;
      let capped = false;

      await poolRun(index.files, TEXT_SEARCH_CONCURRENCY, async (entry) => {
        if (capped) return;
        let text;
        try {
          const resp = await fetch(`${entry.root}${entry.relPath ? encPath(entry.relPath) + '/' : ''}${encPath(entry.filename)}`);
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

  function escapeHtml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderTextTableResults(query, folderGroups, errors, capped) {
    const folders = Array.from(folderGroups.keys()).sort((a, b) => a.localeCompare(b));
    let totalFiles = 0, totalMatches = 0;
    tsResultsEl.innerHTML = '';
    if (!folders.length) {
      tsResultsEl.innerHTML = '<div class="ts-empty-results">No matches found.</div>';
    } else {
      for (const folder of folders) {
        const folderEl = document.createElement('section');
        folderEl.className = 'ts-result-folder';
        const title = document.createElement('div'); title.className = 'ts-result-folder-title'; title.textContent = `📁 FOLDER: ${folder}`; folderEl.appendChild(title);
        const filesMap = folderGroups.get(folder);
        for (const filePath of Array.from(filesMap.keys()).sort((a,b)=>a.localeCompare(b))) {
          totalFiles++;
          const fileEl = document.createElement('div'); fileEl.className = 'ts-result-file';
          const fileBtn = document.createElement('button'); fileBtn.type='button'; fileBtn.className='ts-result-filename'; fileBtn.textContent=filePath; fileBtn.title=`Open ${filePath}`;
          const matches=filesMap.get(filePath); fileBtn.addEventListener('click',()=>openTextTableSource(filePath,matches[0].lineNum,query)); fileEl.appendChild(fileBtn);
          for (const m of matches) {
            totalMatches++;
            const b=document.createElement('button'); b.type='button'; b.className='ts-result-match'; b.title=`Open ${filePath} at line ${m.lineNum}`;
            b.innerHTML=`<span class="ts-result-line-number">Line ${m.lineNum}</span><span class="ts-result-line-text">${escapeHtml(m.text)}</span>`;
            b.addEventListener('click',()=>openTextTableSource(filePath,m.lineNum,query)); fileEl.appendChild(b);
          }
          folderEl.appendChild(fileEl);
        }
        tsResultsEl.appendChild(folderEl);
      }
      if (capped) { const cap=document.createElement('div'); cap.className='ts-results-cap'; cap.textContent=`… output capped at ${TEXT_SEARCH_MATCH_LIMIT} matches — refine your search for more.`; tsResultsEl.appendChild(cap); }
    }
    const summary=folders.length ? `${totalMatches} match${totalMatches===1?'':'es'} in ${totalFiles} file${totalFiles===1?'':'s'} across ${folders.length} folder${folders.length===1?'':'s'} for "${query}"${capped?' (capped)':''}` : `No matches for "${query}".`;
    tsStatusEl.textContent=errors.length ? `${summary} — ${errors.length} file${errors.length===1?'':'s'} couldn't be read.` : summary;
  }

  async function openTextTableSource(filePath, lineNumber, query) {
    if (!tsSourcePaneEl) return;
    tsSourcePaneEl.hidden=false; tsSourceTitleEl.textContent=filePath; tsSourceMatchEl.textContent=`Line ${lineNumber}`; tsSourceScrollEl.innerHTML='<div class="ts-source-loading">Loading file…</div>';
    const entry=textTableFileIndexCache.get(filePath);
    if (!entry) { tsSourceScrollEl.innerHTML='<div class="ts-source-error">Could not locate this file in the text-table index.</div>'; return; }
    try {
      const resp=await fetch(`${entry.root}${entry.relPath ? encPath(entry.relPath)+'/' : ''}${encPath(entry.filename)}`); if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const rawLines=(await resp.text()).split(/\r\n|\r|\n/); const frag=document.createDocumentFragment();
      rawLines.forEach((line,i)=>{ const row=document.createElement('div'); row.className='ts-source-line'; const n=document.createElement('span'); n.className='ts-source-line-number'; n.textContent=String(i+1); const t=document.createElement('span'); t.className='ts-source-line-text'; t.textContent=line||' '; if(i+1===lineNumber) row.classList.add('is-match'); row.append(n,t); frag.appendChild(row); });
      tsSourceScrollEl.innerHTML=''; tsSourceScrollEl.appendChild(frag);
      requestAnimationFrame(()=>{ const target=tsSourceScrollEl.querySelector('.is-match'); if(target) target.scrollIntoView({block:'center',behavior:'auto'}); });
    } catch(err) { tsSourceScrollEl.innerHTML=`<div class="ts-source-error">Couldn't read ${escapeHtml(filePath)}: ${escapeHtml(err && err.message ? err.message : err)}</div>`; }
  }

  const textTableSearchBtnEl = document.getElementById('textTableSearchBtn');
  const textSearchOverlayEl = document.getElementById('textSearchOverlay');
  const tsCloseBtnEl = document.getElementById('tsClose');
  const tsInputEl = document.getElementById('tsInput');
  const tsSearchBtnEl = document.getElementById('tsSearchBtn');
  const tsStatusEl = document.getElementById('tsStatus');
  const tsResultsEl = document.getElementById('tsResults');
  const tsSourcePaneEl = document.getElementById('tsSourcePane');
  const tsSourceTitleEl = document.getElementById('tsSourceTitle');
  const tsSourceMatchEl = document.getElementById('tsSourceMatch');
  const tsSourceScrollEl = document.getElementById('tsSourceScroll');
  const tsSourceCloseBtnEl = document.getElementById('tsSourceClose');
  const textTableFileIndexCache = new Map();

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
  tsSourceCloseBtnEl.addEventListener('click', () => { tsSourcePaneEl.hidden = true; });
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
