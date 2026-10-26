// How the Atlas draws a map's ground, walls and scenery: in the browser, from one small file per sector
// (<stem>.atlassec: the list of pictures to draw + the light) and shared art shards (art<k>.webp + art.json).
// Built by toolbox/atlas/live/live_pack.py. world-atlas.js asks this module for a sector's picture at the size the zoom needs and
// draws it where it drew its own picture; everything else (tiles at a distance, people, containers, pins) is unchanged.
// A map's people, creatures, items, containers and doors (the O layer; F: the people the game keeps switched off) are in <stem>.atlasmob files, one per sector that
// has any (live_objects.py; art.json "o" / "f" list them): drawn from 1/4 size as pictures of their own, with their own light, and never aliased with another sector.
// A sector is drawn in a pool of web workers (at most half the cores, 1 to 3) at 1/16, 1/4, 1/2 or full size, blurriest first.
(function () {
  const DIRS = {};                                                      // the maps that have live files: key -> folder (atlas/live-maps.json, written by live_pack.py)
  const registry = fetch(new URL('atlas/live-maps.json', document.baseURI)).then(r => r.ok ? r.json() : {}).then(j => Object.assign(DIRS, j)).catch(() => {});
  const ALIAS = {};                                                     // .atlassec files moved to atlas/temp as copies: path -> path of the identical one kept (toolbox/atlas/dedupe_atlassec.py)
  const aliasesReady = fetch(new URL('atlas/atlassec-aliases.json', document.baseURI)).then(r => r.ok ? r.json() : {}).then(j => Object.assign(ALIAS, j)).catch(() => {});
  const SC = { 2: 1 / 16, 1: 1 / 4, 0.5: 1 / 2, 0: 1 };               // a level -> its scale
  // the sizes to try for a wanted level: that size, then finer ones (nearest first), then coarser ones
  const PREF = Object.fromEntries(Object.keys(SC).map(l => { const all = [1, 0.5, 0.25, 1 / 16], wi = all.indexOf(SC[l]); return [l, [all[wi], ...all.slice(0, wi).reverse(), ...all.slice(wi + 1)]]; }));
  const FINE_BUDGET = 96e6 / 4;                                        // pixels of 1/4 or finer pictures kept (96 MB decoded): the tiles nearest the screen
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
      const t0 =performance.now(), dv = new DataView(buf), hl = dv.getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
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
    // an .atlasmob: the objects layers of one sector (O: people, creatures, items, containers, doors; F: the people and creatures the game keeps switched off), compiled
    // by toolbox/atlas/live/live_objects.py: u32 header length | header JSON {n: [O solid, O glows, F solid, F glows], ex, z, lo, lf} | deflated op planes (as the
    // .atlassec's) | the O layer's light planes (lo bytes) | the F layer's (lf). Each layer is lit with its own gains (fitted from lit and unlit renders of the layer, so a
    // creature in a dark room keeps the light the game gave it) and sent as a picture of its own, from 1/4 size: they show from 20 % zoom.
    async function renderMob(buf, scs, emit, off) {
      const dv = new DataView(buf), hl = dv.getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
      const ops = await inflate(new Uint8Array(buf, 4 + hl, head.z));
      let at = 4 + hl + head.z;
      const planes = {};
      if (head.lo) { planes.O = await inflate(new Uint8Array(buf, at, head.lo)); at += head.lo; }
      if (head.lf) { planes.F = await inflate(new Uint8Array(buf, at, head.lf)); at += head.lf; }
      const N = head.n[0] + head.n[1] + head.n[2] + head.n[3];
      let art = new Uint16Array(ops.buffer.slice(0, N * 2));
      if (off) art = Uint32Array.from(art, v => v + off);
      await need(art);
      const dxs = new Int16Array(ops.buffer.slice(N * 2, N * 4)), dys = new Int16Array(ops.buffer.slice(N * 4, N * 6));
      const X = new Float64Array(N), Y = new Float64Array(N); let ax = 0, ay = 0;
      for (let i = 0; i < N; i++) { ax += dxs[i]; ay += dys[i]; X[i] = ax / 2; Y[i] = ay / 2; }
      const ex = new Map(head.ex.map(e => [e[0], e]));
      const sz = i => { const r = rects[art[i]], e = ex.get(i); return [e ? e[1] : r[2], e ? e[2] : r[3]]; };
      const run = (g, a, b) => { for (let i = a; i < b; i++) { const [w, h] = sz(i); g.drawImage(bms.get(art[i]), X[i], Y[i], w, h); } };
      const cols = W / BS, rows = Math.floor(H / BS), n = cols * rows;
      const gainsOf = pl => {
        if (!pl) return null;
        const c = new OffscreenCanvas(cols, rows), x = c.getContext('2d', RF), m = x.createImageData(cols, rows);
        for (let i = 0; i < n; i++) { m.data[i * 4] = pl[i]; m.data[i * 4 + 1] = pl[n + i]; m.data[i * 4 + 2] = pl[2 * n + i]; m.data[i * 4 + 3] = 255; }
        x.putImageData(m, 0, 0);
        return c;
      };
      const lcs = { O: gainsOf(planes.O), F: gainsOf(planes.F) };
      const o1 = head.n[0] + head.n[1], o2 = o1 + head.n[2];
      const layers = [['O', 0, head.n[0], o1], ['F', o1, o2, N]].filter(l => l[3] > l[1]);
      for (const sc of [...scs].filter(s => s >= 0.25).sort((a, b) => a - b)) {
        const cw = Math.round(W * sc), ch = Math.round(H * sc);
        for (const [lay, a, b, c] of layers) {
          // A layer is a few sprites: everything below is done on the box they cover (at this size, 2 px around, inside the picture), not on a whole 5504 x 3008 picture.
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let i = a; i < c; i++) { const [w, h] = sz(i); x0 = Math.min(x0, X[i]); y0 = Math.min(y0, Y[i]); x1 = Math.max(x1, X[i] + w); y1 = Math.max(y1, Y[i] + h); }
          const bx = Math.max(0, Math.floor(x0 * sc) - 2), by = Math.max(0, Math.floor(y0 * sc) - 2);
          const bw = Math.min(cw, Math.ceil(x1 * sc) + 2) - bx, bh = Math.min(ch, Math.ceil(y1 * sc) + 2) - by;
          if (bw <= 0 || bh <= 0) continue;
          const layer = () => { const cv = new OffscreenCanvas(bw, bh), g = cv.getContext('2d', RF); g.setTransform(sc, 0, 0, sc, -bx, -by); g.imageSmoothingEnabled = sc < 1; g.imageSmoothingQuality = 'medium'; return g; };
          const lo = layer(); run(lo, a, b);
          let oi;
          if (c > b) {                                                  // glows: on a layer of their own, then added (as the ground's)
            const gl = layer(); run(gl, b, c);
            oi = lo.getImageData(0, 0, bw, bh); const gb = gl.getImageData(0, 0, bw, bh), od = oi.data, os = gb.data;
            for (let i = 0; i < od.length; i += 4) {
              if (!os[i + 3]) continue;
              const m = Math.max(os[i], os[i + 1], os[i + 2]); if (!m) continue;
              const A = od[i + 3] / 255, ao = Math.max(A, m / 255);
              for (let q = 0; q < 3; q++) od[i + q] = Math.min(255, (od[i + q] * A + os[i + q]) / ao);
              od[i + 3] = Math.round(ao * 255);
            }
          } else oi = lo.getImageData(0, 0, bw, bh);
          const od = oi.data;
          if (lcs[lay]) {                                               // the layer's own light (none fitted: drawn as it is): the gains of this box only, enlarged smoothly as the ground's are
            const gg = new OffscreenCanvas(bw, bh).getContext('2d', RF); gg.imageSmoothingEnabled = true;
            gg.drawImage(lcs[lay], bx / (BS * sc), by / (BS * sc), bw / (BS * sc), bh / (BS * sc), 0, 0, bw, bh);
            const gd = gg.getImageData(0, 0, bw, bh).data;
            for (let i = 0; i < od.length; i += 4) {
              if (!od[i + 3]) continue;
              const r = (od[i] * gd[i]) >> 6, gr = (od[i + 1] * gd[i + 1]) >> 6, bl = (od[i + 2] * gd[i + 2]) >> 6;
              od[i] = r > 255 ? 255 : r; od[i + 1] = gr > 255 ? 255 : gr; od[i + 2] = bl > 255 ? 255 : bl;
            }
          }
          lo.setTransform(1, 0, 0, 1, 0, 0); lo.putImageData(oi, 0, 0);
          // sent as tiles of the picture (x, y, w, h, count, picture w, picture h), here at the box's place: the page draws them where they belong and the rest is clear
          const ot = [];
          for (let y = 0; y < bh; y += TS) for (let x = 0; x < bw; x += TS) {
            const w = Math.min(TS + 1, bw - x), h = Math.min(TS + 1, bh - y); let any = false;
            for (let yy = y; yy < y + h && !any; yy++) for (let xx = x, i = (yy * bw + x) * 4 + 3; xx < x + w; xx++, i += 4) if (od[i]) { any = true; break; }
            if (any) ot.push([x, y, w, h]);
          }
          if (!ot.length) ot.push([0, 0, Math.min(TS + 1, bw), Math.min(TS + 1, bh)]);
          const obs = await Promise.all(ot.map(([x, y, w, h]) => createImageBitmap(lo.canvas, x, y, w, h)));
          ot.forEach((t, k) => emit(sc, obs[k], [bx + t[0], by + t[1], t[2], t[3], ot.length, cw, ch], N, 0, 0, lay));
        }
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
          await (data.mob ? renderMob : render)(data.buf, data.scs, (sc, bm, tile, ops, ms, draw, lay) => self.postMessage({ id: data.id, sc, bm, tile, ops, ms, draw, lay }, [bm]), data.off);
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
    const fineBudget = env.fine || FINE_BUDGET;                          // (the Layers panel runs several instances at once: each gets less)
    let frameNo = 0, want = 2, disposed = false, pool = null, waitFor = new Map(), msgId = 0, workerUrl = null;
    let last = '', lastMove = 0, rough = false, timer = 0;

    const getFile = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); };
    let has = null;                                          // the stems that have a file (art.json lists them; until it is read, every sector is tried)
    const lays = { O: null, F: null };                       // the stems that have an objects layer inside their file (art.json "o" / "f"; absent: the map's O / F are still the old pictures)
    let extras = [];                                         // sectors that have objects layers but no ground file (no .sec under them): [[sector x, sector y, stem]...] (art.json "m")
    const seenMob = new Map();                               // the sectors whose objects layers were drawn this frame (a sector in `extras` has no ground to be `seen` by)
    const meta = getFile(dir + 'art.json').then(b => { const j = JSON.parse(new TextDecoder().decode(b)); has = new Set(j.s); allRects = j.r; if (j.o) { lays.O = new Set(j.o); lays.F = new Set(j.f || []); } extras = j.m || []; env.schedule(); return j; });
    meta.catch(() => {});
    // Terrain templates (atlas/terrain/, tpl_* stems) were built with the world's art ids: a map that does not list a template in its own art.json
    // (every map but the world) draws it from the world's shards. The world's rects follow the map's own in allRects (shard keys 'w<k>'), ids shifted by off.
    const worldDir = DIRS.World && new URL(DIRS.World, document.baseURI).href, poolDir = worldDir && new URL('../graphics/art-shards/', worldDir).href;      // (rect shard keys "w<k>" = the world's art<k>.webp, "p<k>" = atlas/graphics/art-shards/art<k>.webp: the pictures several maps share that the world does not have)
    let allRects = [], wHas = null, wmeta = null, off = 0, worldReady = null;
    const worldMeta = () => wmeta || (wmeta = getFile(worldDir + 'art.json').then(b => { const j = JSON.parse(new TextDecoder().decode(b)); wHas = new Set(j.s); env.schedule(); return j; }));
    const viaWorld = stem => stem.startsWith('tpl_') && !!worldDir && dir !== worldDir && !!has && !has.has(stem) && !(window.AtlasData && window.AtlasData.standalone);
    // the art is in shards (art<k>.webp, shard 0 = the common pictures), each decoded once when a sector needs a picture in it; the regional ones
    // are dropped least recently used first, so a view of one area holds a few of them instead of the whole world's art
    const shards = new Map(); let shardTick = 0;
    const SHARD_PX = 25e6;                                             // decoded pixels the regional shards may hold together (7 shards of 12 MB, or 60 of 1.5 MB)
    function shard(k) {
      let s = shards.get(k);
      if (!s) {
        s = { p: getFile(typeof k === 'string' ? `${k[0] === 'p' ? poolDir : worldDir}art${k.slice(1)}.webp` : `${dir}art${k}.webp`).then(async b => { const bm = await createImageBitmap(new Blob([b])); s.px = bm.width * bm.height; return bm; }), last: 0, busy: 0, px: 0 };
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
        const old = [...shards].filter(([k, s]) => k && k !== 'w0' && !s.busy).sort((a, b) => a[1].last - b[1].last);
        for (let px = [...shards].reduce((a, [k, s]) => a + (k && k !== 'w0' ? s.px : 0), 0); px > SHARD_PX && old.length;) { const [k, s] = old.shift(); px -= s.px; shards.delete(k); s.p.then(b => b.close(), () => {}); }
      }
    }
    function workers() {
      return pool || (pool = (async () => {
        const rects = (await meta).r;
        const first = rects.some(r => r[4] === 0) ? 0 : rects.some(r => r[4] === 'w0') ? 'w0' : null;
        if (first !== null) await shard(first).p;                      // (the pictures most sectors use: always there; a pooled map's own art may have no shard 0, the base world's is then the one)
        workerUrl = URL.createObjectURL(new Blob([`(${sectorWorker})()`], { type: 'text/javascript' }));
        const ws = Array.from({ length: Math.max(1, Math.min(env.workers || 3, Math.floor((navigator.hardwareConcurrency || 4) / 2))) }, () => {
          const w = new Worker(workerUrl); w.busy = 0;
          w.onmessage = ({ data }) => {
            if (data.need) {                                           // each picture is its own bitmap: drawn scaled down they filter like separate images (no bleed from the atlas neighbours)
              if (disposed) return;
              cut(data.need, allRects).then(b => w.postMessage({ give: data.rid, bms: b }, b), e => console.warn('live: art', e));
              return;
            }
            const p = waitFor.get(data.id);
            if (data.bm) { p.each(data.sc, data.bm, data.tile, data.lay); return; }        // one size of a sector done (lay: of its objects layer, 'O' / 'F'); more may follow
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
      let url = (stem.startsWith('tpl_') && DIRS['@terrain'] && !(window.AtlasData && window.AtlasData.standalone) ? new URL(DIRS['@terrain'], document.baseURI).href : dir) + stem + '.atlassec';     // (a terrain template's file is in atlas/terrain/, its art in the map's shards; a standalone version has its own, in the map's folder)
      const root = new URL('./', document.baseURI).href, kept = url.startsWith(root) && ALIAS[decodeURI(url.slice(root.length))];     // a copy moved to atlas/temp: the kept identical file
      if (kept) url = root + kept;
      const ws = await workers(), buf = await getFile(url);
      const o = viaWorld(stem) ? await worldRects(ws) : 0;
      const w = ws.reduce((a, b) => b.busy < a.busy ? b : a);
      await new Promise((resolve, reject) => { const id = ++msgId; waitFor.set(id, { resolve, reject, each }); w.busy++; w.postMessage({ id, buf, scs, off: o }, [buf]); });
    }
    // the objects layers of a sector from its .atlasmob (not aliased: it holds this map's own people, which another map's sector with the same ground may not have)
    async function renderMob(stem, scs, each) {
      const ws = await workers(), buf = await getFile(dir + stem + '.atlasmob');
      const w = ws.reduce((a, b) => b.busy < a.busy ? b : a);
      await new Promise((resolve, reject) => { const id = ++msgId; waitFor.set(id, { resolve, reject, each }); w.busy++; w.postMessage({ id, buf, scs, mob: 1 }, [buf]); });
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
    // The finer pictures are kept by distance from the screen: over the budget, the tile farthest from the view goes first (the sectors around the one on
    // show, and theirs, stay as long as there is room). A tile let go leaves a hole (bm null) in its picture; when the hole comes into view the picture is made
    // again and only the holes are filled.
    const sectorAt = new Map();                              // stem -> [x, y, w, h] of its picture in world units, from the last time it was drawn
    let port = [1200, 800];                                  // the canvas, in CSS px, of the last draw
    const gap = (a0, a1, b0, b1) => Math.max(a0 - b1, b0 - a1, 0);
    function away(stem, t, e) {                              // distance of a tile (or the whole picture, t null) from the screen, in px
      const r = sectorAt.get(stem); if (!r) return Infinity;
      const v = env.view, z = v.z;
      const x0 = v.ox + z * (r[0] + (t ? t.x / e.cw : 0) * r[2]), y0 = v.oy + z * (r[1] + (t ? t.y / e.ch : 0) * r[3]);
      const x1 = x0 + z * r[2] * (t ? t.w / e.cw : 1), y1 = y0 + z * r[3] * (t ? t.h / e.ch : 1);
      return Math.max(gap(x0, x1, 0, port[0]), gap(y0, y1, 0, port[1]));
    }
    function put(k, bm, fine, t) {
      let e = cache.get(k);
      if (!e) cache.set(k, e = { tiles: [], total: t ? t[4] : 1, cw: t ? t[5] : bm.width, ch: t ? t[6] : bm.height, px: 0, last: frameNo, fine, holes: 0, refill: false });
      const px = bm.width * bm.height;
      if (e.refill) {                                        // the picture made again: its holes are filled, the tiles it still has are not doubled
        const h = t && e.tiles.find(x => !x.bm && x.x === t[0] && x.y === t[1]);
        (e.got ||= new Set()).add(t ? t[0] + ',' + t[1] : '0,0');
        if (h) { h.bm = bm; e.holes--; e.px += px; if (fine) fineTot += px; } else bm.close();
        if (fine) trim();
        return;
      }
      e.tiles.push(t ? { bm, x: t[0], y: t[1], w: t[2], h: t[3] } : { bm, x: 0, y: 0, w: bm.width, h: bm.height });
      e.px += px;
      if (!fine) return;
      fineTot += px;
      trim();
    }
    function trim() {
      if (fineTot <= fineBudget) return;
      const stemOf = k => k.slice(0, k.indexOf(':'));
      const units = [];                                      // [distance, last, entry, tile or null (the whole picture: an objects layer)]
      for (const [k, o] of cache) {
        if (!o.fine || o.tiles.length < o.total || o.refill) continue;      // (a picture being made again keeps what it has)
        if (k.split(':').length > 2) { if (o.last < frameNo - 1) units.push([away(stemOf(k), null, o), o.last, o, null, k]); continue; }
        const s = stemOf(k), sc = +k.split(':')[1], stale = sc !== SC[want] && !(want < 1 && sc === SC[1]) ? 1e9 : 0;      // (a size the zoom no longer asks for goes before any tile of the one it does)
        if (stale) { const w = cache.get(`${s}:${SC[want]}`); if (!w || !whole(w) || w.vis) continue; }      // (until the size the zoom wants is there, the one it replaces is what shows)
        for (const x of o.tiles) if (x.bm) units.push([stale ? stale + frameNo - o.last : away(s, x, o), o.last, o, x, k]);
      }
      units.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      for (const [d, , o, x, k] of units) {
        if (fineTot <= fineBudget * 0.85 || d === 0) break;  // (what is on screen stays, whatever the budget)
        if (!x) { if (cache.get(k) !== o) continue; fineTot -= o.px; cache.delete(k); o.tiles.forEach(y => y.bm && y.bm.close()); continue; }
        if (cache.get(k) !== o) continue;
        const px = x.bm.width * x.bm.height; x.bm.close(); x.bm = null; o.holes++; o.px -= px; fineTot -= px;
        if (o.holes >= o.tiles.length && !o.refill) cache.delete(k);       // nothing left of it
      }
    }
    const whole = e => e.tiles.length >= e.total;
    // a hole of this picture that the screen shows (then it counts as partial: drawn over the next size down, and asked for again)
    const holed = (e, dx, dy, kx, ky) => {
      if (!e.holes) return false;
      for (const t of e.tiles) if (!t.bm) { const x = dx + t.x * kx, y = dy + t.y * ky; if (x < port[0] && y < port[1] && x + t.w * kx > 0 && y + t.h * ky > 0) return true; }
      return false;
    };

    // jobs: the sectors in view, the blurry 1/16 first; then, for a sector that has it, everything else the zoom wants (1/4 on the way for a finer one)
    // in one job (the file is read and the ground drawn once); nearest the middle first
    let nrun = 0, nmob = 0;
    const OBJECTS_FROM_Z = 0.2, MAXMOB = 3;                    // (world-atlas.js draws the objects layers from this zoom)
    const mobRunning = new Set(), mobFailed = new Set(), mobEmpty = new Set();
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
        const scs = wanted.filter(s => { const k = `${stem}:${s}`, e = cache.get(k); return !((e && !(e.vis && !e.refill)) || running.has(k) || failed.has(k)); });      // (a picture with a hole on screen is made again)
        if (scs.length) jobs.push({ stem, scs, cls: want >= 1 || scs.includes(SC[1]) ? 1 : 3, d });
      }
      for (const j of jobs.sort((a, b) => a.cls - b.cls || a.d - b.d)) {
        if (nrun >= MAXRUN) break;
        nrun++; for (const s of j.scs) { running.set(`${j.stem}:${s}`, j.cls); const o = cache.get(`${j.stem}:${s}`); if (o) o.refill = true; }
        const landed = [];
        const each = (sc, bm, t, lay) => {
          const key = `${j.stem}:${sc}${lay ? ':' + lay : ''}`;                  // (an objects layer has a key of its own: <stem>:<size>:O / :F)
          if (sc < 0.25) { put(key, bm, false, t); landed.push(Promise.resolve()); env.schedule(); return; }      // (the small ones are put at once: the map's tiles may be drawn with no sector frame to land them)
          landed.push(new Promise(res => landing.push(() => { if (disposed) bm.close(); else put(key, bm, sc >= 0.25, t); res(); })));
          env.schedule();
        };
        renderSector(j.stem, j.scs, each)
          .then(() => Promise.all(landed), e => { for (const s of j.scs) { const k = `${j.stem}:${s}`, o = cache.get(k); failed.add(k); if (o && !whole(o)) { cache.delete(k); o.tiles.forEach(t => t.bm && t.bm.close()); } } bad.add(j.stem); console.warn('live: ' + j.stem, e); })
          .finally(() => {
            nrun--;
            for (const s of j.scs) {
              const k = `${j.stem}:${s}`, o = cache.get(k); running.delete(k);
              if (o && o.refill) {
                o.refill = false;
                if (!failed.has(k) && o.got) {                // a hole the new picture has no tile for was empty; one it had a tile for, let go again since, stays a hole
                  o.tiles = o.tiles.filter(x => x.bm || o.got.has(x.x + ',' + x.y)); o.total = o.tiles.length; o.holes = o.tiles.filter(x => !x.bm).length;
                }
                o.got = null; o.vis = false;
              }
            }
            pump(); env.schedule();
          });
        env.schedule();
      }
      // The objects layers (.atlasmob) of the sectors in view: only where the page draws them (from 20 % zoom), a job of their own per sector (not tied to the ground's: a slow
      // one must not hold the ground job's slot or its place in the landing queue), at most MAXMOB at once, and their small bitmaps are put at once.
      if (lays.O && env.view.z >= OBJECTS_FROM_Z) {
        const sizes = wanted.filter(s => s >= 0.25);
        for (const stem of [...seen.keys(), ...seenMob.keys()]) {
          if (nmob >= MAXMOB) break;
          const kinds = ['O', 'F'].filter(l => lays[l] && lays[l].has(stem));
          if (!kinds.length) continue;
          const miss = sizes.filter(s => { const k = `${stem}:${s}`; return !mobRunning.has(k) && !mobFailed.has(k) && kinds.some(l => !cache.has(`${k}:${l}`) && !mobEmpty.has(`${k}:${l}`)); });
          if (!miss.length) continue;
          nmob++; for (const s of miss) mobRunning.add(`${stem}:${s}`);
          renderMob(stem, miss, (sc, bm, t, lay) => {
            if (disposed) { bm.close(); return; }
            put(`${stem}:${sc}:${lay}`, bm, true, t); env.schedule();
          }).then(() => { for (const s of miss) for (const l of kinds) if (!cache.has(`${stem}:${s}:${l}`)) mobEmpty.add(`${stem}:${s}:${l}`); },
            e => { for (const s of miss) mobFailed.add(`${stem}:${s}`); console.warn('live: objects of ' + stem, e); })
            .finally(() => { nmob--; for (const s of miss) mobRunning.delete(`${stem}:${s}`); pump(); env.schedule(); });
        }
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
      ready: stem => [1, 0.5, 0.25, 1 / 16].some(s => { const e = cache.get(`${stem}:${s}`); return e && whole(e) && !e.vis; }),
      // the 1/16 picture of a sector (an ImageBitmap) for the map's tiles, or null while it is made (it is asked for)
      thumb(stem) {
        const k = `${stem}:${SC[2]}`, e = cache.get(k);
        if (e && whole(e)) { e.last = frameNo; return e.tiles[0].bm; }
        if (!disposed && !failed.has(k) && !running.has(k) && !thumbs.has(stem)) { thumbs.add(stem); pump(); }
        return null;
      },
      // before and after the sectors of a frame: lvl is the level the zoom wants (2, 1, 0.5, 0)
      begin(lvl) {
        frameNo++; seen.clear(); seenMob.clear(); want = lvl;
        const v = env.view, now = performance.now(), sig = `${v.z}|${v.ox}|${v.oy}`;
        if (sig !== last) { last = sig; lastMove = now; }
        rough = now - lastMove < 200;                          // while the view moves, pictures are shrunk with the cheap filter; once, with the good one, when it stops
        if (landing.length) { landing.shift()(); if (landing.length) env.schedule(); }
        if (rough) { clearTimeout(timer); timer = setTimeout(env.schedule, 220); }
        return rough;
      },
      end() { pump(); },
      // the objects layers inside the sector files: does this map have them, and does this sector have the layer lay ('O': people, creatures, items, containers, doors;
      // 'F': the people and creatures switched off)
      hasObjects: () => !!lays.O,
      extras: () => extras,
      hasLayer: (stem, lay) => !!lays[lay] && lays[lay].has(stem),
      // draws that layer of the sector where draw() drew its ground (the wanted size, else a finer, else a coarser one; none under 1/4)
      drawLayer(ctx, stem, dx, dy, dw, dh, lay) {
        seenMob.set(stem, 1);                                // (asks for the layer's job: a sector with no ground file is never `seen` by draw())
        let part = null;
        const tiles = (e, kx, ky) => { for (const t of e.tiles) ctx.drawImage(t.bm, dx + t.x * kx, dy + t.y * ky, t.w * kx, t.h * ky); };
        for (const s of PREF[want]) {
          if (s < 0.25) break;
          const e = cache.get(`${stem}:${s}:${lay}`); if (!e) continue;
          e.last = frameNo;
          if (!whole(e)) { part = part || e; continue; }
          tiles(e, dw / e.cw, dh / e.ch);
          if (part) tiles(part, dw / part.cw, dh / part.ch);
          return true;
        }
        if (part) { tiles(part, dw / part.cw, dh / part.ch); return true; }
        return false;
      },
      // draws the sector (false: nothing ready yet): the wanted size, else a finer one, else a coarser one
      draw(ctx, stem, dx, dy, dw, dh, d) {
        seen.set(stem, d);
        const v = env.view, a = ctx.getTransform().a || 1;
        port = [ctx.canvas.width / a, ctx.canvas.height / a];
        sectorAt.set(stem, [(dx - v.ox) / v.z, (dy - v.oy) / v.z, dw / v.z, dh / v.z]);
        const tiles = (e, kx, ky) => { for (const t of e.tiles) if (t.bm) ctx.drawImage(t.bm, dx + t.x * kx, dy + t.y * ky, t.w * kx, t.h * ky); };
        let part = null;                                     // (a size with only some of its tiles in: they go over the next size down)
        for (const s of PREF[want]) {
          const e = cache.get(`${stem}:${s}`); if (!e) continue;
          e.last = frameNo;
          e.vis = e.holes > 0 && holed(e, dx, dy, dw / e.cw, dh / e.ch);
          if (!whole(e) || e.vis) { part = part || e; continue; }
          tiles(e, dw / e.cw, dh / e.ch);
          if (part) tiles(part, dw / part.cw, dh / part.ch);
          return true;
        }
        if (part) { tiles(part, dw / part.cw, dh / part.ch); return true; }
        return false;
      },
      dispose() {
        disposed = true; clearTimeout(timer);
        for (const e of cache.values()) e.tiles.forEach(t => t.bm && t.bm.close());
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
