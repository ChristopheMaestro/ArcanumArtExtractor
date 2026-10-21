// How the Atlas draws a map's ground, walls and scenery: in the browser, from one small file per sector
// (<stem>.atlassec: the list of pictures to draw + the light) and shared art shards (art<k>.webp + art.json).
// Built by toolbox/atlas/live/live_pack.py. world-atlas.js asks this module for a sector's picture at the size the zoom needs and
// draws it where it drew its own picture; everything else (tiles at a distance, people, containers, pins) is unchanged.
// A sector is drawn in a pool of web workers (at most half the cores, 1 to 3) at 1/16, 1/4, 1/2 or full size, blurriest first.
(function () {
  const DIRS = {};                                                      // the maps that have live files: key -> folder (atlas/live-maps.json, written by live_pack.py)
  const registry = fetch(new URL('atlas/live-maps.json', document.baseURI)).then(r => r.ok ? r.json() : {}).then(j => Object.assign(DIRS, j)).catch(() => {});
  const ALIAS = {};                                                     // .atlassec files moved to atlas/temp as copies: path -> path of the identical one kept (toolbox/atlas/dedupe_atlassec.py)
  const aliasesReady = fetch(new URL('atlas/atlassec-aliases.json', document.baseURI)).then(r => r.ok ? r.json() : {}).then(j => Object.assign(ALIAS, j)).catch(() => {});
  const SC = { 2: 1 / 16, 1: 1 / 4, 0.5: 1 / 2, 0: 1 };               // a level -> its scale
  // the sizes to try for a wanted level: that size, then finer ones (nearest first), then coarser ones
  const PREF = Object.fromEntries(Object.keys(SC).map(l => { const all = [1, 0.5, 0.25, 1 / 16], wi = all.indexOf(SC[l]); return [l, [all[wi], ...all.slice(0, wi).reverse(), ...all.slice(wi + 1)]]; }));
  const FINE_BUDGET = 128e6 / 4;                                       // pixels of 1/4 or finer pictures kept (128 MB decoded)
  const MAXRUN = 6;

  // ---------------------------------------------------------------- the worker: replays a sector's draw list
  // .atlassec = u32 header length | header JSON {n: [counts of phases 0..3], ex: [[op index, w, h]...], z: bytes, l: bytes} | deflated op planes
  // (art id u16 plane, then x and y as int16 deltas of position * 2, in drawing order) | deflated light planes (172 x 94 x 3 gains in 1/64 steps,
  // one per 32 px block). Phases: 0 the neighbours' band tiles (clipped to the diamond), 1 the sector's tiles, 2 objects, 3 glows.
  function sectorWorker() {
    let bms = null, rects = null;
    const inflate = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const W = 5504, H = 3008, PADL = 192, PADT = 384, BS = 32;
    const TS = 1024;
    const RF = { willReadFrequently: true };                             // every canvas here is read back (getImageData): kept in memory instead of the GPU, where each read stalls on the GPU the page draws with
    // scs: the sizes wanted, rendered smallest first from one replay of the ground; emit(sc, bitmap, ops, ms) is called as each is done
    async function render(buf, scs, emit, off) {
      const t0 = performance.now(), dv = new DataView(buf), hl = dv.getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
      const ops = await inflate(new Uint8Array(buf, 4 + hl, head.z)), light = await inflate(new Uint8Array(buf, 4 + hl + head.z, head.l));
      const N = head.n[0] + head.n[1] + head.n[2] + head.n[3];
      let art = new Uint16Array(ops.buffer.slice(0, N * 2));
      if (off) art = Uint32Array.from(art, v => v + off);                // (a template drawn from the world's art: its ids come after the map's own in rects)
      await need(art);
      const dxs = new Int16Array(ops.buffer.slice(N * 2, N * 4)), dys = new Int16Array(ops.buffer.slice(N * 4, N * 6));
      const X = new Float64Array(N), Y = new Float64Array(N); let ax = 0, ay = 0;
      for (let i = 0; i < N; i++) { ax += dxs[i]; ay += dys[i]; X[i] = ax / 2; Y[i] = ay / 2; }
      const ex = new Map(head.ex.map(e => [e[0], e]));
      const run = (g, a, b) => { for (let i = a; i < b; i++) { const r = rects[art[i]], e = ex.get(i); g.drawImage(bms.get(art[i]), X[i], Y[i], e ? e[1] : r[2], e ? e[2] : r[3]); } };
      // the light: gains, smoothly enlarged to the picture
      const cols = W / BS, rows = Math.floor(H / BS), n = cols * rows, lc = new OffscreenCanvas(cols, rows), lx = lc.getContext('2d', RF), im = lx.createImageData(cols, rows);
      for (let i = 0; i < n; i++) { im.data[i * 4] = light[i]; im.data[i * 4 + 1] = light[n + i]; im.data[i * 4 + 2] = light[2 * n + i]; im.data[i * 4 + 3] = 255; }
      lx.putImageData(im, 0, 0);
      const n0 = head.n[0], n1 = n0 + head.n[1], n2 = n1 + head.n[2];
      // the ground is drawn at full size once and then reduced for each size: drawing each tile already reduced leaves a faint dark lattice along the tile edges
      const gg0 = new OffscreenCanvas(W, H).getContext('2d', RF);
      gg0.imageSmoothingEnabled = false;
      // the black base stays a little inside the diamond: under the clip's half-covered edge it would darken the band tiles there (a dark seam between sectors)
      gg0.fillStyle = '#000'; gg0.beginPath(); gg0.moveTo(PADL + 2560, PADT + 4); gg0.lineTo(PADL + 5112, PADT + 1280); gg0.lineTo(PADL + 2560, PADT + 2556); gg0.lineTo(PADL + 8, PADT + 1280); gg0.closePath(); gg0.fill();
      gg0.save(); gg0.beginPath(); gg0.moveTo(PADL + 2560, PADT - 3); gg0.lineTo(PADL + 5126, PADT + 1280); gg0.lineTo(PADL + 2560, PADT + 2563); gg0.lineTo(PADL - 6, PADT + 1280); gg0.closePath(); gg0.clip();
      run(gg0, 0, n0); gg0.restore();
      run(gg0, n0, n1);
      for (const sc of [...scs].sort((a, b) => a - b)) {      // (the full size last: it goes on drawing over the ground itself)
        const cw = Math.round(W * sc), ch = Math.round(H * sc);
        const layer = () => { const c = new OffscreenCanvas(cw, ch), g = c.getContext('2d', RF); g.setTransform(cw / W, 0, 0, ch / H, 0, 0); g.imageSmoothingEnabled = sc < 1; g.imageSmoothingQuality = 'medium'; return g; };
        const gx = new OffscreenCanvas(cw, ch), gg = gx.getContext('2d', RF); gg.imageSmoothingEnabled = true; gg.drawImage(lc, 0, 0, cols * BS * sc, rows * BS * sc);
        const gd = gg.getImageData(0, 0, cw, ch).data;
        const g = sc < 1 ? layer() : gg0;
        if (sc < 1) { g.imageSmoothingQuality = 'high'; g.drawImage(gg0.canvas, 0, 0, W, H); g.imageSmoothingQuality = 'medium'; }
        // where the band has no tile the ground is black: cleared just outside the diamond where the LIT colour is near black (the Atlas's cutBand), scaled
        { const img = g.getImageData(0, 0, cw, ch), d = img.data, cx = (PADL + 2560) * sc, cy = (PADT + 1280) * sc, k = 6 * Math.hypot(2560, 1280) / (2560 * 1280);
          for (let py = Math.max(0, Math.floor((PADT - 8) * sc)); py < Math.min(ch, Math.ceil((PADT + 2568) * sc)); py++) {
            const ry = Math.abs(py + 0.5 - cy) / (1280 * sc), a0 = Math.max(0, (1 - ry) * 2560 * sc - 1), a1 = (1 + k - ry) * 2560 * sc + 1;
            for (const side of [-1, 1]) for (let dx = Math.floor(a0); dx <= Math.ceil(a1); dx++) {
              const px = Math.floor(cx + side * dx); if (px < 0 || px >= cw) continue;
              const exv = Math.abs(px + 0.5 - cx) / (2560 * sc) + ry; if (exv <= 1 || exv > 1 + k) continue;
              const i = (py * cw + px) * 4;
              if (d[i + 3] && Math.max((d[i] * gd[i]) >> 6, (d[i + 1] * gd[i + 1]) >> 6, (d[i + 2] * gd[i + 2]) >> 6) <= 24) d[i + 3] = 0;
            }
          }
          if (head.xb) {                                     // a transition template: no tiles give its band, so the edge is stretched outwards (the Atlas builder's extendBand)
            const src = new Uint8ClampedArray(d), inside = 1 - 3 * Math.hypot(2560, 1280) / (2560 * 1280);
            for (let py = Math.max(0, Math.floor((PADT - 8) * sc)); py < Math.min(ch, Math.ceil((PADT + 2568) * sc)); py++) {
              const ry = Math.abs(py + 0.5 - cy) / (1280 * sc);
              for (let px = Math.max(0, Math.floor((PADL - 8) * sc)); px < Math.min(cw, Math.ceil((PADL + 5128) * sc)); px++) {
                const exv = Math.abs(px + 0.5 - cx) / (2560 * sc) + ry; if (exv <= 1 || exv > 1 + k) continue;
                const i = (py * cw + px) * 4; if (d[i + 3] === 255) continue;
                const f = inside / exv, sx = Math.floor(cx + (px + 0.5 - cx) * f), sy = Math.floor(cy + (py + 0.5 - cy) * f);
                if (sx < 0 || sx >= cw || sy < 0 || sy >= ch) continue;
                const j = (sy * cw + sx) * 4; if (src[j + 3] !== 255) continue;
                d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; d[i + 3] = 255;
              }
            }
          }
          if (sc < 1) {                                      // reduced: the diamond's edge pixels are part transparent, and two neighbours' half-covered edges over black leave a dark seam; the band holds the neighbour's own tiles, so opaque is right
            for (let py = Math.max(0, Math.floor((PADT - 8) * sc)); py < Math.min(ch, Math.ceil((PADT + 2568) * sc)); py++) {
              const ry = Math.abs(py + 0.5 - cy) / (1280 * sc);
              for (let px = Math.max(0, Math.floor((PADL - 8) * sc)); px < Math.min(cw, Math.ceil((PADL + 5128) * sc)); px++) {
                const i = (py * cw + px) * 4, al = d[i + 3]; if (!al || al === 255) continue;
                if (Math.abs(px + 0.5 - cx) / (2560 * sc) + ry <= 1 + k) d[i + 3] = 255;
              }
            }
          }
          g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(img, 0, 0); g.setTransform(cw / W, 0, 0, ch / H, 0, 0); }
        run(g, n1, n2);
        let img = null;                                      // the glows and the light are done on one read of the picture
        if (N > n2) {                                     // glows: drawn on their own layer, then added
          const gl = layer(); run(gl, n2, N);
          img = g.getImageData(0, 0, cw, ch); const b = gl.getImageData(0, 0, cw, ch), d = img.data, s = b.data;
          for (let i = 0; i < d.length; i += 4) {
            if (!s[i + 3]) continue;
            const m = Math.max(s[i], s[i + 1], s[i + 2]); if (!m) continue;
            const A = d[i + 3] / 255, ao = Math.max(A, m / 255);
            for (let q = 0; q < 3; q++) d[i + q] = Math.min(255, (d[i + q] * A + s[i + q]) / ao);
            d[i + 3] = Math.round(ao * 255);
          }
        }
        const t2 = performance.now();
        if (!img) img = g.getImageData(0, 0, cw, ch);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          const r = (d[i] * gd[i]) >> 6, gr = (d[i + 1] * gd[i + 1]) >> 6, b = (d[i + 2] * gd[i + 2]) >> 6;
          d[i] = r > 255 ? 255 : r; d[i + 1] = gr > 255 ? 255 : gr; d[i + 2] = b > 255 ? 255 : b;
        }
        g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(img, 0, 0);
        if (sc < 0.5) { emit(sc, g.canvas.transferToImageBitmap(), null, N, performance.now() - t0, t2 - t0); continue; }
        // the big sizes go out in tiles (TS px square, 1 px more right and below so the scaled tiles overlap instead of leaving a seam; the empty ones left out): the page uploads
        // each to the GPU on its first draw, and one picture of 66 MB held it for a long time; tiles are taken one a frame
        const tl = [];
        for (let y = 0; y < ch; y += TS) for (let x = 0; x < cw; x += TS) {
          const w = Math.min(TS + 1, cw - x), h = Math.min(TS + 1, ch - y); let any = false;
          for (let yy = y; yy < y + h && !any; yy++) for (let xx = x, i = (yy * cw + x) * 4 + 3; xx < x + w; xx++, i += 4) if (d[i]) { any = true; break; }
          if (any) tl.push([x, y, w, h]);
        }
        if (!tl.length) tl.push([0, 0, Math.min(TS + 1, cw), Math.min(TS + 1, ch)]);
        const bs = await Promise.all(tl.map(([x, y, w, h]) => createImageBitmap(g.canvas, x, y, w, h)));
        tl.forEach((t, k) => emit(sc, bs[k], [...t, tl.length, cw, ch], N, performance.now() - t0, t2 - t0));
      }
    }
    // pictures are asked from the main thread (it holds the one decoded atlas) only when a sector needs them, and kept least recently used
    const pend = new Map(); let reqNo = 0, active = 0;
    const MAXB = 1500;
    async function need(ids) {
      const miss = [...new Set(ids)].filter(i => !bms.has(i));
      if (miss.length) {
        const rid = ++reqNo, got = await new Promise(res => { pend.set(rid, res); self.postMessage({ need: miss, rid }); });
        miss.forEach((m, k) => bms.set(m, got[k]));
      }
      for (const i of new Set(ids)) { const b = bms.get(i); bms.delete(i); bms.set(i, b); }
    }
    self.onmessage = async ({ data }) => {
      try {
        if (data.give) { pend.get(data.give)(data.bms); pend.delete(data.give); return; }
        if (data.init) { rects = data.rects; bms = new Map(); self.postMessage({ id: data.id, ok: 1 }); return; }
        if (data.addrects) { rects = rects.concat(data.addrects); self.postMessage({ id: data.id, ok: 1 }); return; }
        active++;
        try {
          await render(data.buf, data.scs, (sc, bm, tile, ops, ms, draw) => self.postMessage({ id: data.id, sc, bm, tile, ops, ms, draw }, [bm]), data.off);
          self.postMessage({ id: data.id, done: 1 });
        } finally {
          if (!--active) for (const [k, b] of bms) { if (bms.size <= MAXB) break; b.close(); bms.delete(k); }
        }
      } catch (e) { self.postMessage({ id: data.id, error: String(e && e.stack || e) }); }
    };
  }


  // env: { view, size() -> [cw, ch, dpr], schedule() }; the folder of the map's live files
  function create(key, env) {
    const dir = new URL(DIRS[key], document.baseURI).href;
    const cache = new Map(), running = new Map(), failed = new Set(), bad = new Set(), landing = [], seen = new Map();
    let frameNo = 0, want = 2, disposed = false, pool = null, waitFor = new Map(), msgId = 0, workerUrl = null;
    let last = '', lastMove = 0, rough = false, timer = 0;

    const getFile = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); };
    let has = null;                                          // the stems that have a file (art.json lists them; until it is read, every sector is tried)
    const meta = getFile(dir + 'art.json').then(b => { const j = JSON.parse(new TextDecoder().decode(b)); has = new Set(j.s); allRects = j.r; env.schedule(); return j; });
    meta.catch(() => {});
    // Terrain templates (atlas/terrain/, tpl_* stems) were built with the world's art ids: a map that does not list a template in its own art.json
    // (every map but the world) draws it from the world's shards. The world's rects follow the map's own in allRects (shard keys 'w<k>'), ids shifted by off.
    const worldDir = DIRS.World && new URL(DIRS.World, document.baseURI).href;
    let allRects = [], wHas = null, wmeta = null, off = 0, worldReady = null;
    const worldMeta = () => wmeta || (wmeta = getFile(worldDir + 'art.json').then(b => { const j = JSON.parse(new TextDecoder().decode(b)); wHas = new Set(j.s); env.schedule(); return j; }));
    const viaWorld = stem => stem.startsWith('tpl_') && !!worldDir && dir !== worldDir && !!has && !has.has(stem);
    // the art is in shards (art<k>.webp, shard 0 = the common pictures), each decoded once when a sector needs a picture in it; the regional ones
    // are dropped least recently used first, so a view of one area holds a few of them instead of the whole world's art
    const shards = new Map(); let shardTick = 0;
    const MAXSH = 7;
    function shard(k) {
      let s = shards.get(k);
      if (!s) {
        s = { p: getFile(typeof k === 'string' ? `${worldDir}art${k.slice(1)}.webp` : `${dir}art${k}.webp`).then(b => createImageBitmap(new Blob([b]))), last: 0, busy: 0 };
        s.p.catch(() => shards.get(k) === s && shards.delete(k));
        shards.set(k, s);
      }
      s.last = ++shardTick;
      return s;
    }
    async function cut(ids, rects) {
      const ks = [...new Set(ids.map(i => rects[i][4]))], ss = ks.map(k => { const s = shard(k); s.busy++; return s; });
      try {
        const bm = new Map(await Promise.all(ss.map(async (s, j) => [ks[j], await s.p])));
        return await Promise.all(ids.map(i => { const r = rects[i]; return createImageBitmap(bm.get(r[4]), r[0], r[1], r[2], r[3]); }));
      } finally {
        ss.forEach(s => s.busy--);
        const old = [...shards].filter(([k, s]) => k && !s.busy).sort((a, b) => a[1].last - b[1].last);
        for (let n = [...shards.keys()].filter(k => k).length; n > MAXSH && old.length; n--) { const [k, s] = old.shift(); shards.delete(k); s.p.then(b => b.close(), () => {}); }
      }
    }
    function workers() {
      return pool || (pool = (async () => {
        const rects = (await meta).r;
        await shard(0).p;                                              // (the pictures most sectors use: always there)
        workerUrl = URL.createObjectURL(new Blob([`(${sectorWorker})()`], { type: 'text/javascript' }));
        const ws = Array.from({ length: Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2))) }, () => {
          const w = new Worker(workerUrl); w.busy = 0;
          w.onmessage = ({ data }) => {
            if (data.need) {                                           // each picture is its own bitmap: drawn scaled down they filter like separate images (no bleed from the atlas neighbours)
              if (disposed) return;
              cut(data.need, allRects).then(b => w.postMessage({ give: data.rid, bms: b }, b), e => console.warn('live: art', e));
              return;
            }
            const p = waitFor.get(data.id);
            if (data.bm) { p.each(data.sc, data.bm, data.tile); return; }        // one size of a sector done; more may follow
            waitFor.delete(data.id); w.busy--; data.error ? p.reject(new Error(data.error)) : p.resolve(data);
          };
          return w;
        });
        await Promise.all(ws.map(w => new Promise((resolve, reject) => { const id = ++msgId; waitFor.set(id, { resolve, reject }); w.busy++; w.postMessage({ id, init: 1, rects }); })));
        return ws;
      })());
    }
    // renders the sizes scs of a sector from one read of its file; each(sc, bitmap) is called as every size is done
    async function renderSector(stem, scs, each) {
      await aliasesReady;
      let url = (stem.startsWith('tpl_') && DIRS['@terrain'] ? new URL(DIRS['@terrain'], document.baseURI).href : dir) + stem + '.atlassec';     // (a terrain template's file is in atlas/terrain/, its art in the map's shards)
      const root = new URL('./', document.baseURI).href, kept = url.startsWith(root) && ALIAS[decodeURI(url.slice(root.length))];     // a copy moved to atlas/temp: the kept identical file
      if (kept) url = root + kept;
      const ws = await workers(), buf = await getFile(url);
      const o = viaWorld(stem) ? await worldRects(ws) : 0;
      const w = ws.reduce((a, b) => b.busy < a.busy ? b : a);
      await new Promise((resolve, reject) => { const id = ++msgId; waitFor.set(id, { resolve, reject, each }); w.busy++; w.postMessage({ id, buf, scs, off: o }, [buf]); });
    }
    // gives the workers (once) the world's picture rects after the map's own, returns the shift of the world's ids
    function worldRects(ws) {
      return worldReady || (worldReady = (async () => {
        const wr = (await worldMeta()).r.map(r => [r[0], r[1], r[2], r[3], 'w' + r[4]]);
        off = allRects.length;
        await Promise.all(ws.map(w => new Promise((resolve, reject) => { const id = ++msgId; waitFor.set(id, { resolve, reject }); w.busy++; w.postMessage({ id, addrects: wr }); })));
        allRects = allRects.concat(wr);
        return off;
      })());
    }

    // the cache: 1/16 pictures stay, finer ones are dropped least recently used first
    let fineTot = 0;                                         // pixels of the finer pictures in the cache
    // a picture is one bitmap or, for the big sizes, tiles t = [x, y, w, h, count, picture w, picture h] that land one at a time; the picture
    // is whole when its count is there (until then the tiles that are there are drawn over a smaller size)
    function put(k, bm, fine, t) {
      let e = cache.get(k);
      if (!e) cache.set(k, e = { tiles: [], total: t ? t[4] : 1, cw: t ? t[5] : bm.width, ch: t ? t[6] : bm.height, px: 0, last: frameNo, fine });
      e.tiles.push(t ? { bm, x: t[0], y: t[1], w: t[2], h: t[3] } : { bm, x: 0, y: 0, w: bm.width, h: bm.height });
      const px = bm.width * bm.height; e.px += px;
      if (!fine) return;
      fineTot += px;
      if (fineTot <= FINE_BUDGET) return;
      for (const [kk, o] of [...cache].filter(([, o]) => o.fine && o.tiles.length >= o.total && o.last < frameNo - 1).sort((a, b) => a[1].last - b[1].last)) {
        if (fineTot <= FINE_BUDGET * 0.8) break;
        fineTot -= o.px; cache.delete(kk); o.tiles.forEach(x => x.bm.close());
      }
    }
    const whole = e => e.tiles.length >= e.total;

    // jobs: the sectors in view, the blurry 1/16 first; then, for a sector that has it, everything else the zoom wants (1/4 on the way for a finer one)
    // in one job (the file is read and the ground drawn once); nearest the middle first
    let nrun = 0;
    const thumbs = new Set();
    function pump() {
      if (disposed) return;
      const jobs = [], wanted = [...new Set([SC[1], SC[want]])].filter(s => s !== SC[2] && (want < 1 || s === SC[want]));
      for (const stem of thumbs) {      // the 1/16 pictures the map's tiles ask for (thumb), for sectors not in view
        const k16 = `${stem}:${SC[2]}`;
        if (cache.has(k16) || running.has(k16) || failed.has(k16)) thumbs.delete(stem);
        else if (!seen.has(stem)) jobs.push({ stem, scs: [SC[2]], cls: 0, d: 0 });
      }
      for (const [stem, d] of seen) {
        const k16 = `${stem}:${SC[2]}`;
        if (!cache.has(k16)) { if (!running.has(k16) && !failed.has(k16)) jobs.push({ stem, scs: [SC[2]], cls: 0, d }); continue; }
        const scs = wanted.filter(s => { const k = `${stem}:${s}`; return !(cache.has(k) || running.has(k) || failed.has(k)); });
        if (scs.length) jobs.push({ stem, scs, cls: want >= 1 || scs.includes(SC[1]) ? 1 : 3, d });
      }
      for (const j of jobs.sort((a, b) => a.cls - b.cls || a.d - b.d)) {
        if (nrun >= MAXRUN) break;
        nrun++; for (const s of j.scs) running.set(`${j.stem}:${s}`, j.cls);
        const landed = [];
        renderSector(j.stem, j.scs, (sc, bm, t) => {
          if (sc < 0.25) { put(`${j.stem}:${sc}`, bm, false, t); landed.push(Promise.resolve()); env.schedule(); return; }      // (the small ones are put at once: the map's tiles may be drawn with no sector frame to land them)
          landed.push(new Promise(res => landing.push(() => { if (disposed) bm.close(); else put(`${j.stem}:${sc}`, bm, sc >= 0.25, t); res(); })));
          env.schedule();
        })
          .then(() => Promise.all(landed), e => { for (const s of j.scs) { const k = `${j.stem}:${s}`, o = cache.get(k); failed.add(k); if (o && !whole(o)) { cache.delete(k); o.tiles.forEach(t => t.bm.close()); } } bad.add(j.stem); console.warn('live: ' + j.stem, e); })
          .finally(() => { nrun--; for (const s of j.scs) running.delete(`${j.stem}:${s}`); pump(); env.schedule(); });
        env.schedule();
      }
    }

    return {
      // does this sector have live files (a failed one is drawn the usual way)
      ok: stem => {
        if (bad.has(stem)) return false;
        if (stem.startsWith('tpl_') && dir !== worldDir) {         // a template: the map's own art if it lists it, else the world's
          if (!has) return false;
          if (has.has(stem)) return true;
          if (!worldDir) return false;
          if (!wHas) { worldMeta().catch(() => {}); return false; }
          return wHas.has(stem);
        }
        return !has || has.has(stem);
      },
      // is a picture of this sector ready to draw (the average-colour stand-in under it is then not wanted: it would show through the band the picture leaves clear)
      ready: stem => [1, 0.5, 0.25, 1 / 16].some(s => { const e = cache.get(`${stem}:${s}`); return e && whole(e); }),
      // the 1/16 picture of a sector (an ImageBitmap) for the map's tiles, or null while it is made (it is asked for)
      thumb(stem) {
        const k = `${stem}:${SC[2]}`, e = cache.get(k);
        if (e && whole(e)) { e.last = frameNo; return e.tiles[0].bm; }
        if (!disposed && !failed.has(k) && !running.has(k) && !thumbs.has(stem)) { thumbs.add(stem); pump(); }
        return null;
      },
      // before and after the sectors of a frame: lvl is the level the zoom wants (2, 1, 0.5, 0)
      begin(lvl) {
        frameNo++; seen.clear(); want = lvl;
        const v = env.view, now = performance.now(), sig = `${v.z}|${v.ox}|${v.oy}`;
        if (sig !== last) { last = sig; lastMove = now; }
        rough = now - lastMove < 200;                          // while the view moves, pictures are shrunk with the cheap filter; once, with the good one, when it stops
        if (landing.length) { landing.shift()(); if (landing.length) env.schedule(); }
        if (rough) { clearTimeout(timer); timer = setTimeout(env.schedule, 220); }
        return rough;
      },
      end() { pump(); },
      // draws the sector (false: nothing ready yet): the wanted size, else a finer one, else a coarser one
      draw(ctx, stem, dx, dy, dw, dh, d) {
        seen.set(stem, d);
        const tiles = (e, kx, ky) => { for (const t of e.tiles) ctx.drawImage(t.bm, dx + t.x * kx, dy + t.y * ky, t.w * kx, t.h * ky); };
        let part = null;                                     // (a size with only some of its tiles in: they go over the next size down)
        for (const s of PREF[want]) {
          const e = cache.get(`${stem}:${s}`); if (!e) continue;
          e.last = frameNo;
          if (!whole(e)) { part = part || e; continue; }
          tiles(e, dw / e.cw, dh / e.ch);
          if (part) tiles(part, dw / part.cw, dh / part.ch);
          return true;
        }
        if (part) { tiles(part, dw / part.cw, dh / part.ch); return true; }
        return false;
      },
      dispose() {
        disposed = true; clearTimeout(timer);
        for (const e of cache.values()) e.tiles.forEach(t => t.bm.close());
        cache.clear(); fineTot = 0; landing.length = 0; seen.clear(); thumbs.clear();
        if (pool) pool.then(ws => { ws.forEach(w => w.terminate()); }).catch(() => {});
        for (const s of shards.values()) s.p.then(b => b.close(), () => {});
        shards.clear();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
      },
    };
  }

  window.ArcanumLive = { has: key => !!DIRS[key], create, ready: registry };
})();
