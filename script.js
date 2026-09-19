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

  const DEFAULT_TRANSPARENT_COLOR = [0, 0, 255];

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
    return parseArtBuffer(await file.arrayBuffer());
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

    let pictureCount, frameCount;
    if (head[0] === 0 || head[0] === 2) {
      pictureCount = 8;
      frameCount = head[8];
    } else {
      pictureCount = head[8];
      frameCount = 1;
    }
    const totalImages = pictureCount * frameCount;
    if (!Number.isFinite(totalImages) || totalImages < 0 || totalImages > 20000) {
      throw new Error('unsupported or corrupt header (implausible frame count)');
    }

    let offset = 0x84;
    const paletteBytesNeeded = paletteCount * 1024;
    if (offset + paletteBytesNeeded > buf.byteLength) {
      throw new Error('file is truncated before its palette data');
    }

    let activePalette = null;
    for (let p = 0; p < paletteCount; p++) {
      const palBytes = bytes.subarray(offset, offset + 1024);
      offset += 1024;
      if (p === 0) {
        const tuples = new Array(256);
        for (let i = 0; i < 256; i++) {
          const b = palBytes[i * 4];
          const g = palBytes[i * 4 + 1];
          const r = palBytes[i * 4 + 2];
          tuples[i] = [r, g, b];
        }
        activePalette = tuples;
      }
    }

    const infoBytesNeeded = totalImages * 28;
    if (offset + infoBytesNeeded > buf.byteLength) {
      throw new Error('file is truncated before its frame headers');
    }

    const imageInfos = new Array(totalImages);
    for (let i = 0; i < totalImages; i++) {
      const width = view.getUint32(offset, true);
      const height = view.getUint32(offset + 4, true);
      const size = view.getUint32(offset + 8, true);
      const left = view.getInt32(offset + 12, true);
      const top = view.getInt32(offset + 16, true);
      offset += 28;
      imageInfos[i] = { width, height, size, left, top };
    }

    const frames = [];
    for (let idx = 0; idx < imageInfos.length; idx++) {
      const { width: w, height: h, size: compressedSize } = imageInfos[idx];
      if (w === 0 || h === 0) continue;

      if (offset + compressedSize > buf.byteLength) {
        throw new Error(`frame ${idx} pixel data runs past the end of the file`);
      }
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
        width: w,
        height: h,
        canvas,
        totalImages,
        embeddedLeft: imageInfos[idx].left,
        embeddedTop: imageInfos[idx].top,
        indices: finalIndices,
        palette: activePalette,
      };
      composeFrameCanvasInPlace(frame, DEFAULT_TRANSPARENT_COLOR);
      frames.push(frame);
    }

    return frames;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
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
      const blob = await entry.blobPromise;
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

  function setPicking(group, article, bgBtn, on) {
    group.picking = on;
    article.classList.toggle('picking-bg', on);
    bgBtn.textContent = on ? 'Click a pixel in a frame…' : 'Remove background';
    bgBtn.classList.toggle('active', on);
  }

  function renderFileGroup(baseName, frames, shareInfo) {
    const group = { baseName, frames: [], sourceFrames: frames, gif: null, picking: false, transparentColor: DEFAULT_TRANSPARENT_COLOR };

    const article = document.createElement('article');
    article.className = 'file-group';

    const header = document.createElement('div');
    header.className = 'file-group-header';
    header.innerHTML = `
      <h2>${baseName}.art</h2>
      <span class="meta">${frames.length} frame${frames.length === 1 ? '' : 's'}</span>
      <span class="bg-status" hidden><span class="bg-swatch"></span><button class="bg-reset" type="button">Reset</button></span>
      <button class="btn-bg">Remove background</button>
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
        const blob = await entry.blobPromise;
        await saveFile(filename, blob);
        btn.disabled = false;
      });
      caption.appendChild(dims);
      caption.appendChild(btn);
      card.appendChild(caption);

      grid.appendChild(card);
    }

    article.appendChild(grid);

    const bgBtn = header.querySelector('.btn-bg');
    const bgStatus = header.querySelector('.bg-status');
    const bgSwatch = header.querySelector('.bg-swatch');
    const bgReset = header.querySelector('.bg-reset');

    bgBtn.addEventListener('click', () => {
      setPicking(group, article, bgBtn, !group.picking);
    });

    grid.addEventListener('click', (e) => {
      if (!group.picking) return;
      const canvas = e.target.closest('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((e.clientX - rect.left) * scaleX)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((e.clientY - rect.top) * scaleY)));
      const [r, g, b] = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      applyTransparencyKey(group, [r, g, b]);
      setPicking(group, article, bgBtn, false);
      bgSwatch.style.background = rgbToHex([r, g, b]);
      bgStatus.hidden = false;
      log(`${baseName}: removed background color ${rgbToHex([r, g, b])}`, 'ok');
    });

    bgReset.addEventListener('click', () => {
      applyTransparencyKey(group, DEFAULT_TRANSPARENT_COLOR);
      bgStatus.hidden = true;
    });

    header.querySelector('.btn-zip').addEventListener('click', (e) => {
      e.target.disabled = true;
      downloadGroupZip(group).finally(() => { e.target.disabled = false; });
    });

    header.querySelector('.btn-gif').addEventListener('click', () => openGifBuilder(group));

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
        const frames = await parseArtFile(file);
        if (frames.length === 0) {
          log(`${file.name}: header parsed but no drawable frames were found`, 'err');
          continue;
        }
        log(`${file.name}: extracted ${frames.length} frame${frames.length === 1 ? '' : 's'}`, 'ok');
        renderFileGroup(baseName, frames);
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

  function openGifBuilder(group) {
    if (!group.gif) {
      group.gif = {
        frames: group.sourceFrames.map(f => ({
          ref: f,
          offsetX: 0,
          offsetY: 0,
          duration: 100,
          include: true,
        })),
        currentIndex: 0,
        onionMode: 'adjacent',
        onionOpacity: 0.35,
        loop: true,
        zoom: 1,
      };
      initZoom(group.gif);
    }
    activeGroup = group.gif;
    activeGroupRef = group;

    document.getElementById('gbTitle').textContent = `Build GIF — ${group.baseName}.art`;
    document.getElementById('gbOnionMode').value = activeGroup.onionMode;
    document.getElementById('gbOnionOpacity').value = activeGroup.onionOpacity;
    document.getElementById('gbLoop').checked = activeGroup.loop;
    document.getElementById('gbResult').classList.remove('show');
    document.getElementById('gbProgress').classList.remove('active');
    document.getElementById('gbOverlay').classList.add('open');
    redrawStage();
  }

  function closeGifBuilder() {
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
      document.getElementById('gbDownload').onclick = () => saveFile(`${group.baseName}.gif`, blob);
      log(`${group.baseName}: compiled a ${included.length}-frame GIF`, 'ok');
    } catch (err) {
      log(`GIF compile failed: ${err && err.message ? err.message : err}`, 'err');
    } finally {
      compileBtn.disabled = false;
      progress.classList.remove('active');
    }
  }

  setupStageDrag();

  document.getElementById('gbClose').addEventListener('click', closeGifBuilder);
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
    current.offsetX = current.ref.embeddedLeft || 0;
    current.offsetY = current.ref.embeddedTop || 0;
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
  let filesOffset = 0;

  const paginationEl = document.getElementById('explorerPagination');
  const paginationStatusEl = document.getElementById('explorerPaginationStatus');
  const nextBtn = document.getElementById('explorerLoadMoreBtn');
  const backBtn = document.getElementById('explorerBackBtn');
  const pageSizeSelect = document.getElementById('explorerPageSize');

  function effectivePageSize() {
    return pageSize === 'all' ? (folderFiles.length || 1) : pageSize;
  }

  function renderGrid(manifest, relativePath, folderName) {
    folderFiles = (manifest.files || [])
      .filter(f => /\.art$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    folderRelPath = relativePath;
    currentFolderName = folderName;
    filesOffset = 0;
    breadcrumbEl.textContent = `/${relativePath}`.replace(/\/+/g, '/') || '/';
    renderFilePage();
  }

  function renderFilePage() {
    gridEl.innerHTML = '';

    if (folderFiles.length === 0) {
      const p = document.createElement('p');
      p.className = 'explorer-status';
      p.textContent = 'No .ART files in this folder.';
      gridEl.appendChild(p);
      paginationEl.hidden = true;
      return;
    }

    const pageFiles = folderFiles.slice(filesOffset, filesOffset + effectivePageSize());
    for (const filename of pageFiles) {
      const baseName = filename.replace(/\.art$/i, '');
      const folderPrefix = folderRelPath ? `${folderRelPath}/` : '';
      const artUrl = `${ART_ROOT}${folderPrefix}${filename}`;
      const thumbUrl = `${THUMB_ROOT}${folderPrefix}${baseName}.gif`;

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

      card.addEventListener('click', () => loadArtFromServer(artUrl, filename));
      gridEl.appendChild(card);
    }

    updatePaginationBar();
  }

  function updatePaginationBar() {
    if (folderFiles.length <= PAGE_SIZE_OPTIONS[0]) {
      paginationEl.hidden = true;
      return;
    }
    const size = effectivePageSize();
    const shownEnd = Math.min(filesOffset + size, folderFiles.length);
    paginationStatusEl.textContent = `Showing ${filesOffset + 1}–${shownEnd} of ${folderFiles.length}`;
    backBtn.disabled = filesOffset === 0;
    nextBtn.disabled = shownEnd >= folderFiles.length;
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
      });
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

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleFiles(e.target.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragging');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
})();
