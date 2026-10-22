// The Workshop's palettes: tiles, facades, textures (walls and portals), prototypes, mobs and scenery, with the search and thumbnails of each
import { secFolderLegendEntries } from '../sec/sec-folder-map.js';
import { loadSecFacadeArt, loadSecFacadeNames, secTileInfo, secTileNameMesMap } from '../sec/sec-tile-art.js';
import { ART_TYPE, artType } from '../core/art-id.js';
import { protoArtObjectType, protoCritterAidInfo, protoCurrentAidArtId } from '../proto/critter-aid.js';
import { SEC_MOB_KINDS, secFacadeFile, secGameProtoForKey, secMakeFacadeRaw, secProtoCatalog, secStartProtoScan, secWallAid } from './sec-writer.js';
import { errText } from '../core/text-io.js';
import { decodeWallArtId, loadWallArtFromRaw, loadWallNameTable, loadWallStructureTable } from '../objects/wall-art.js';
import { loadMobMapArtShared } from '../objects/map-art-loader.js';
import { aidRotation } from '../objects/art-frames.js';
import { loadPortalMes, loadSceneryMes } from '../proto/proto-mes.js';
import { escapeHtml } from '../core/util.js';
import { mobOidTypeAndNumber } from '../proto/proto-resolution.js';
import { loadCritterMapArt, resolveCritterArt } from '../objects/critter-art.js';
import { mobObjectTypeName } from '../mob/mob-schema.js';
import { SEC_FACADE_GROUPS } from './sec-facade-groups.js';
import { SEC_FACADE_LAYOUTS } from './sec-facade-layouts.js';

export function createPalettes(env) {
  const { PROTO_TYPE, drawThumb, edit, firstVariant, inferFacadeLayout, markActiveTile, mk, pk, scheduleCursor, selectPaletteTile, status, ui, valid } = env;

  // Tile palette: every tile listed in tilename.mes
  let paletteBuilt = false, usedArtIds = new Map(), thumbObserver = null;
  const applyPaletteFilter = () => {
    const qs = ui.search.value.trim().toLowerCase(), cat = ui.category.value, used = ui.usedOnly.checked;
    for (const el of ui.list.children) {
      const id = Number(el.dataset.art);
      const ok = (cat === 'all' || Math.floor(id / 100) === Number(cat))
        && (!used || usedArtIds.has(id))
        && (!qs || el.dataset.search.includes(qs));
      el.hidden = !ok;
    }
  };
  const buildPalette = () => {
    usedArtIds = new Map(secFolderLegendEntries(valid).map(e => [e.artId, e.count]));
    if (paletteBuilt) { prioritizeList(ui.list, usedArtIds, 'art'); applyPaletteFilter(); return; }
    paletteBuilt = true;
    ui.list.innerHTML = '';
    const entries = [...(secTileNameMesMap || new Map()).entries()].sort((a, b) => a[0] - b[0]);
    thumbObserver = new IntersectionObserver(items => {
      for (const it of items) {
        if (!it.isIntersecting) continue;
        const el = it.target; thumbObserver.unobserve(el);
        const cv = el.querySelector('canvas');
        firstVariant(Number(el.dataset.art)).then(v => { if (!drawThumb(cv, v?.art)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
      }
    }, { root: ui.list, rootMargin: '120px' });
    for (const [artId, entry] of entries) {
      if (artId % 100 > 63) continue; // the packed tile id only has 6 bits per tile number
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sec-edit-tile';
      btn.dataset.art = String(artId);
      btn.dataset.search = `${artId} ${entry.name} ${entry.comment || ''}`.toLowerCase();
      btn.title = `#${artId} ${entry.name}${entry.comment ? ` — ${entry.comment}` : ''}`;
      const cv = document.createElement('canvas'); cv.width = 80; cv.height = 40;
      const label = document.createElement('span'); label.textContent = `${artId} · ${entry.name || '?'}`;
      btn.append(cv, label);
      btn.addEventListener('click', () => selectPaletteTile(artId, entry.name));
      ui.list.appendChild(btn);
      thumbObserver.observe(btn);
    }
    prioritizeList(ui.list, usedArtIds, 'art');
    markActiveTile(); applyPaletteFilter();
  };
  ui.search.addEventListener('input', applyPaletteFilter);
  ui.category.addEventListener('change', applyPaletteFilter);
  ui.usedOnly.addEventListener('change', applyPaletteFilter);

  // generic helpers for the other palettes
  const makePaletteButton = (id, search, title, label) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sec-edit-tile';
    btn.dataset.id = String(id); btn.dataset.search = search.toLowerCase(); btn.title = title;
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 40;
    const span = document.createElement('span'); span.textContent = label;
    btn.append(cv, span);
    return btn;
  };
  const filterPane = P => {
    const qs = P.search.value.trim().toLowerCase();
    // facades: with "Whole structure" a group is listed once (its first part, found by the names of all its parts)
    const grouped = P === pk.facade && P.whole.checked;
    for (const el of P.list.children) {
      const hay = grouped && el.dataset.searchAll ? el.dataset.searchAll : el.dataset.search;
      el.hidden = (grouped && !!el.dataset.member) || (!!qs && !hay.includes(qs));
    }
  };
  // Whatever is already used on this map is listed first (most frequent first), then everything else in numeric order.
  const prioritizeList = (list, counts, attr) => {
    const kids = [...list.children];
    if (!kids.length) return;
    const idOf = el => Number(el.dataset[attr]), cnt = el => counts.get(idOf(el)) || 0;
    kids.sort((a, b) => (cnt(b) - cnt(a)) || (idOf(a) - idOf(b)));
    const frag = document.createDocumentFragment();
    for (const el of kids) { const n = cnt(el); el.classList.toggle('on-map', n > 0); frag.appendChild(el); }
    list.appendChild(frag);
    const act = list.querySelector('.sec-edit-tile.active');
    if (act) act.scrollIntoView({ block: 'nearest' }); else list.scrollTop = 0;
  };
  const countBy = (arr, keyFn) => { const m = new Map(); for (const p of arr) { const k = keyFn(p); if (k != null) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const usageFor = kind => {
    if (kind === 'facade') {
      const m = new Map();
      for (const s of valid) {
        const t = s.decoded.tiles;
        for (let i = 0; i < t.length; i++) {
          const raw = t[i] >>> 0; if (!artType(raw)) continue;
          const info = secTileInfo(raw);
          if (info.isFacade) m.set(info.facadeNum, (m.get(info.facadeNum) || 0) + 1);
        }
      }
      return m;
    }
    if (kind === 'scenery') return countBy(env.mobPoints.filter(p => p.type === 3), p => p.currentAidRaw != null ? protoCurrentAidArtId(Number(p.currentAidRaw) >>> 0, 3) : null);
    const type = PROTO_TYPE[kind];
    return countBy(env.mobPoints.filter(p => p.type === type), p => { const aid = p.currentAidRaw != null ? Number(p.currentAidRaw) >>> 0 : (env.protoItemFor(p)?.aid ?? null); return aid == null ? null : TEX[kind].keyOfAid(aid); });
  };
  const prioritizeKind = kind => {
    if (kind === 'tile') prioritizeList(ui.list, usedArtIds, 'art');
    else if (pk[kind]) prioritizeList(pk[kind].list, usageFor(kind), 'id');
  };
  const markActivePane = (kind, id) => {
    const P = pk[kind];
    P.list.querySelectorAll('.sec-edit-tile.active').forEach(el => el.classList.remove('active'));
    if (id != null) P.list.querySelector(`.sec-edit-tile[data-id="${id}"]`)?.classList.add('active');
  };
  const makeThumbObserver = (P, draw) => new IntersectionObserver(items => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      const el = it.target; P.obs.unobserve(el);
      draw(el, el.querySelector('canvas'));
    }
  }, { root: P.list, rootMargin: '120px' });

  // Facade palette (facadename.mes)
  // facade number -> its group (sec-facade-groups.js): { nums: every part, rep: the one listed for it }
  const facadeGroupOf = new Map();
  for (const g of SEC_FACADE_GROUPS) {
    const nums = []; for (let i = 0; i < g.length; i += 3) nums.push(g[i]);
    const grp = { nums, rep: Math.min(...nums) };
    for (const n of nums) facadeGroupOf.set(n, grp);
  }
  // the list entry to highlight: a part of a group that is listed once is shown by its first part
  const markActiveFacade = num => markActivePane('facade', num != null && pk.facade.whole.checked ? (facadeGroupOf.get(num)?.rep ?? num) : num);
  const facadeThumbCache = new Map();
  const facadeThumbArt = async num => {
    if (facadeThumbCache.has(num)) return facadeThumbCache.get(num);
    const file = await secFacadeFile(num);
    let art = null;
    if (file) {
      const f0 = file.frames.filter(f => f.direction === 0).sort((a, b) => a.index - b.index)[0];
      if (f0) art = await loadSecFacadeArt(secMakeFacadeRaw(num, f0.index, 1, 0));
    }
    facadeThumbCache.set(num, art);
    return art;
  };
  const selectFacade = async (num, name) => {
    const P = pk.facade;
    P.meta.textContent = 'loading cells…';
    const file = await secFacadeFile(num);
    if (!file) { P.meta.textContent = 'ART file not found'; edit.sel.facade = null; return; }
    const idxs = file.frames.filter(f => f.direction === 0).map(f => f.index).sort((a, b) => a - b);
    if (!idxs.length) { P.meta.textContent = 'no cells'; edit.sel.facade = null; return; }
    const lay = inferFacadeLayout(num, idxs);
    const table = SEC_FACADE_LAYOUTS[num];
    let offsets = null;
    if (table) {
      offsets = new Map();
      for (let i = 0; i < table.cells.length; i += 3) offsets.set(table.cells[i], [table.cells[i + 1], table.cells[i + 2]]);
      if (!idxs.every(fr => offsets.has(fr))) offsets = null;
    }
    const artByFrame = new Map();
    await Promise.all(idxs.map(async fr => { const a = await loadSecFacadeArt(secMakeFacadeRaw(num, fr, lay.walkable, lay.keep)); if (a) artByFrame.set(fr, a); }));
    // the other parts of the thing this facade belongs to (sec-facade-groups.js), where the game puts them
    const group = SEC_FACADE_GROUPS.find(g => { for (let i = 0; i < g.length; i += 3) if (g[i] === num) return true; return false; });
    const parts = [];
    if (group) {
      let at = [0, 0];
      for (let i = 0; i < group.length; i += 3) if (group[i] === num) at = [group[i + 1], group[i + 2]];
      for (let i = 0; i < group.length; i += 3) {
        const pn = group[i], pt = SEC_FACADE_LAYOUTS[pn];
        if (pn === num || !pt) continue;
        const partOffsets = new Map();
        for (let k = 0; k < pt.cells.length; k += 3) partOffsets.set(pt.cells[k], [pt.cells[k + 1], pt.cells[k + 2]]);
        const partArt = new Map();
        await Promise.all([...partOffsets.keys()].map(async fr => { const a = await loadSecFacadeArt(secMakeFacadeRaw(pn, fr, lay.walkable, lay.keep)); if (a) partArt.set(fr, a); }));
        parts.push({ num: pn, dx: group[i + 1] - at[0], dy: group[i + 2] - at[1], offsets: partOffsets, artByFrame: partArt });
      }
    }
    edit.sel.facade = { num, name, idxs, artByFrame, offsets, parts, whole: parts.length > 0 && P.whole.checked, cols: lay.cols, colVec: lay.colVec, rowVec: lay.rowVec, keep: lay.keep, walkable: lay.walkable };
    P.cols.value = String(lay.cols); P.walk.checked = !!lay.walkable; P.swap.checked = false;
    for (const el of [P.cols, P.swap]) { const lab = el.closest('label'); if (lab) lab.hidden = !!offsets; }
    const how = !offsets ? (lay.known ? 'taken from this map' : 'guessed: adjust Columns / Swap axes')
      : table.src === 's' ? 'guessed from the pictures\' borders' : 'from the game\'s maps';
    P.meta.textContent = `${idxs.length} cell${idxs.length === 1 ? '' : 's'} · layout ${how}${parts.length ? ` · part of a ${parts.length + 1}-part structure${P.whole.checked ? ' (all stamped)' : ''}` : ''}`;
    markActiveFacade(num);
    status.textContent = `Facade #${num} ${name} · click to stamp it`;
    scheduleCursor();
  };
  pk.facade.cols.addEventListener('change', () => { const s = edit.sel.facade; if (s) { s.cols = Math.max(1, Number(pk.facade.cols.value) || 1); scheduleCursor(); } });
  pk.facade.walk.addEventListener('change', () => { const s = edit.sel.facade; if (s) s.walkable = pk.facade.walk.checked ? 1 : 0; });
  pk.facade.swap.addEventListener('change', () => { const s = edit.sel.facade; if (s) { [s.colVec, s.rowVec] = [s.rowVec, s.colVec]; scheduleCursor(); } });
  pk.facade.whole.addEventListener('change', () => {
    const s = edit.sel.facade;
    if (s) { s.whole = s.parts.length > 0 && pk.facade.whole.checked; scheduleCursor(); }
    filterPane(pk.facade); markActiveFacade(s?.num);
    pk.facade.list.querySelector('.sec-edit-tile.active')?.scrollIntoView({ block: 'nearest' });
  });
  pk.facade.search.addEventListener('input', () => filterPane(pk.facade));
  const buildFacadePalette = async () => {
    const P = pk.facade;
    if (P.built) return;
    P.built = true;
    P.status.textContent = 'Loading facade list…';
    let names;
    try { names = await loadSecFacadeNames(); }
    catch (err) { P.built = false; P.status.textContent = `Could not load facadename.mes: ${errText(err)}`; return; }
    P.obs = makeThumbObserver(P, (el, cv) => {
      facadeThumbArt(Number(el.dataset.id)).then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    let count = 0;
    names.forEach((name, num) => {
      if (!name) return;
      count++;
      const grp = facadeGroupOf.get(num), first = grp && grp.rep === num;
      const label = first ? `${num} · ${name} (+${grp.nums.length - 1})` : `${num} · ${name}`;
      const btn = makePaletteButton(num, `${num} ${name}`, first ? `#${num} ${name}\nWhole structure: ${grp.nums.map(n => names[n]).join(', ')}` : `#${num} ${name}`, label);
      if (first) btn.dataset.searchAll = grp.nums.map(n => `${n} ${names[n]}`).join(' ').toLowerCase();
      else if (grp) btn.dataset.member = '1';
      btn.addEventListener('click', () => selectFacade(num, name));
      P.list.appendChild(btn); P.obs.observe(btn);
    });
    P.status.textContent = '';
    filterPane(P);
    markActiveFacade(edit.sel.facade?.num);
    prioritizeKind('facade');
  };

  // Scenery / wall / portal palettes (prototypes, found by scanning /proto/ once)
  const protoThumbArt = async item => {
    if (item.objType === 0) return loadWallArtFromRaw(secWallAid(item.aid, edit.commonPiece ?? 0, 0, 0));
    const artId = protoCurrentAidArtId(item.aid, item.objType);
    if (artId == null) return null;
    const artObjType = protoArtObjectType(item.aid, item.objType);
    const pal = artObjType === 3 ? (item.aid >>> 4) & 3 : null;
    return loadMobMapArtShared(artId, artObjType, pal, aidRotation(item.aid), item.aid);
  };
  // Wall and portal palettes list the TEXTURES that go onto the prototypes, like the scenery palette does:
  //   wall   : one entry per wall structure (structure.mes; its interior / exterior wallname stems)
  //   portal : one entry per portal.mes key (doors at n, windows at n + 1001)
  // A texture that already has a prototype is placed with it; any other one is placed as an instance of the
  // "base prototype" with the art id overridden (an object's F_CURRENT_AID wins over its prototype's).
  const TEX = {
    wall: {
      keyOfAid: aid => decodeWallArtId(aid)?.num ?? null,
      aidOf: (key, base) => (((((base ?? (1 << 28)) >>> 0) & ~(0xFF << 20)) | (key << 20)) >>> 0),
      entries: async () => {
        const [structs, names] = await Promise.all([loadWallStructureTable(), loadWallNameTable()]);
        const out = [];
        structs.forEach((st, num) => {
          if (num > 255) return;
          const a = names[st.interior]?.name || '', b = names[st.exterior]?.name || '';
          if (!a && !b) return;
          out.push({ key: num, label: a && b && a.toLowerCase() !== b.toLowerCase() ? `${a} / ${b}` : (a || b), search: `${a} ${b}` });
        });
        return out;
      }
    },
    portal: {
      keyOfAid: aid => (artType(aid) === ART_TYPE.PORTAL ? protoCurrentAidArtId(aid, 1) : null),
      aidOf: (key, base) => {
        const win = key >= 1001, num = win ? key - 1001 : key;
        return ((((base ?? 0) >>> 0) & ~((0x1FF << 19) | (1 << 10)) & 0x0FFFFFFF) | (3 << 28) | (num << 19) | (win ? 0 : (1 << 10))) >>> 0;
      },
      entries: async () => {
        const mes = await loadPortalMes(), out = [];
        for (const [k, text] of [...mes.entries()].sort((a, b) => a[0] - b[0])) {
          const m = String(text).trim().match(/^(.*?)\.art\b/i); if (!m) continue;
          const win = k >= 1001, num = win ? k - 1001 : k;
          if (k < 0 || num > 0x1FF) continue;
          out.push({ key: k, label: `${m[1].replace(/^.*[\\/]/, '')}${win ? ' (window)' : ''}`, search: win ? 'window' : 'door' });
        }
        return out;
      }
    }
  };
  const texExact = { wall: new Map(), portal: new Map() };   // texture key -> prototype that already uses it
  const texLabelMap = {};
  const textureLabel = async (kind, key) => {
    if (kind === 'scenery') {
      try { const t = (await loadSceneryMes()).get(key); if (t != null) return String(t).trim().replace(/\.art\b.*$/i, ''); } catch (_) {}
      return String(key);
    }
    if (!texLabelMap[kind]) { try { texLabelMap[kind] = new Map((await TEX[kind].entries()).map(e => [e.key, e.label])); } catch (_) { return String(key); } }
    return texLabelMap[kind].get(key) ?? String(key);
  };
  const syncSelectedTexture = kind => {
    const P = pk[kind], sel = edit.sel[kind]; if (!sel) return;
    const items = secProtoCatalog.byType[PROTO_TYPE[kind]], exact = texExact[kind].get(sel.artKey);
    // the one picked off the map, else the one the game places this art with, else its own, else the base prototype
    const gameNum = secGameProtoForKey(PROTO_TYPE[kind], sel.artKey)?.num;
    let proto = sel.prefer != null ? items.find(i => i.num === sel.prefer) : null;
    const game = !proto && gameNum != null ? items.find(i => i.num === gameNum) || null : null;
    if (!proto) proto = game || exact || items.find(i => String(i.num) === P.base.value) || null;
    sel.num = proto ? proto.num : null;
    sel.exact = !!proto && TEX[kind].keyOfAid(proto.aid) === sel.artKey;
    sel.aid = TEX[kind].aidOf(sel.artKey, proto ? proto.aid : null);
    P.meta.textContent = !proto ? 'waiting for the prototype scan…'
      : proto === game ? `prototype #${proto.num}, as the game places this ${kind}`
      : sel.exact ? `own prototype #${proto.num}` : `no prototype of its own · uses base prototype #${proto.num}`;
  };
  const refreshTextureBase = kind => {
    const P = pk[kind], T = TEX[kind], items = secProtoCatalog.byType[PROTO_TYPE[kind]], exact = texExact[kind];
    exact.clear();
    for (const it of items) { const k = T.keyOfAid(it.aid); if (k != null && !exact.has(k)) exact.set(k, it); }
    if (P.base.options.length !== items.length || !P.base.value) {
      const cur = P.base.value;
      P.base.innerHTML = items.length ? items.map(i => `<option value="${i.num}">#${i.num} · ${escapeHtml(i.label)}</option>`).join('') : '<option value="">(scanning prototypes…)</option>';
      if (cur && items.some(i => String(i.num) === cur)) P.base.value = cur;
      else if (items.length) {
        const use = new Map();    // prefer the prototype this map already uses most
        for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === PROTO_TYPE[kind]) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) use.set(n, (use.get(n) || 0) + 1); }
        let best = items[0].num, bn = -1;
        for (const it of items) { const n = use.get(it.num) || 0; if (n > bn) { bn = n; best = it.num; } }
        P.base.value = String(best);
      }
    }
    for (const el of P.list.children) {          // the search also finds a texture by the name of its prototype
      const it = exact.get(Number(el.dataset.id));
      el.dataset.search = `${el.dataset.baseSearch || ''}${it ? ` ${it.num} ${it.label}` : ''}`.toLowerCase();
    }
    syncSelectedTexture(kind);
  };
  const selectTexture = (kind, key, label, prefer = null) => {
    edit.sel[kind] = { num: null, label, aid: TEX[kind].aidOf(key, null), objType: PROTO_TYPE[kind], artKey: key, prefer };
    syncSelectedTexture(kind);
    markActivePane(kind, key);
    scheduleCursor();
  };
  for (const kind of ['wall', 'portal']) {
    // (a base prototype picked by hand is used even where the game has its own for that art)
    pk[kind].base.addEventListener('change', () => { const s = edit.sel[kind]; if (s) s.prefer = Number(pk[kind].base.value) || null; syncSelectedTexture(kind); });
    secProtoCatalog.listeners.push(() => { if (pk[kind].built) refreshTextureBase(kind); });
  }
  const buildTexturePalette = async kind => {
    const P = pk[kind], T = TEX[kind];
    refreshTextureBase(kind);
    if (P.built) return;
    P.built = true;
    P.status.textContent = `Loading ${kind} textures…`;
    let entries;
    try { entries = await T.entries(); }
    catch (err) { P.built = false; P.status.textContent = `Could not load the ${kind} texture list: ${errText(err)}`; return; }
    texLabelMap[kind] = new Map(entries.map(e => [e.key, e.label]));
    P.obs = makeThumbObserver(P, (el, cv) => {
      protoThumbArt({ objType: PROTO_TYPE[kind], aid: T.aidOf(Number(el.dataset.id), null) })
        .then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    for (const e of entries) {
      const btn = makePaletteButton(e.key, `${e.key} ${e.label} ${e.search || ''}`, `#${e.key} ${e.label}`, `${e.key} · ${e.label}`);
      btn.dataset.baseSearch = btn.dataset.search;
      btn.addEventListener('click', () => selectTexture(kind, e.key, e.label));
      P.list.appendChild(btn); P.obs.observe(btn);
    }
    P.status.textContent = '';
    refreshTextureBase(kind);
    filterPane(P); markActivePane(kind, edit.sel[kind]?.artKey);
    prioritizeKind(kind);
  };
  const buildProtoPalette = kind => {
    const P = pk[kind];
    secStartProtoScan();
    if (kind === 'scenery') { buildSceneryPalette().then(() => prioritizeKind('scenery')); return; }
    buildTexturePalette(kind);
  };

  // Palettes of the .mob tools (ground items, NPCs, containers): every prototype of the kind, named as the game names
  // it (description.mes), the ones this map already uses first. A prototype is what the new object is an instance of.
  const mobCatalog = kind => SEC_MOB_KINDS[kind].types.flatMap(t => secProtoCatalog.byType[t] || []).sort((a, b) => a.num - b.num);
  const mobThumbArt = async item => {
    if (item.aid == null) return null;
    if (item.objType === 16) return loadCritterMapArt(protoCritterAidInfo(item.aid, 16));
    return protoThumbArt(item);
  };
  const filterMob = kind => {
    const P = mk[kind], qs = P.search.value.trim().toLowerCase(), cat = P.category ? P.category.value : 'all';
    for (const el of P.list.children) el.hidden = (cat !== 'all' && el.dataset.type !== cat) || (!!qs && !el.dataset.search.includes(qs));
  };
  const prioritizeMob = kind => {
    const types = SEC_MOB_KINDS[kind].types;
    prioritizeList(mk[kind].list, countBy(env.mobPoints.filter(p => types.includes(p.type)), p => p.protoNum), 'id');
  };
  // The outfit list for the NPC picked: only the outfits that have art for its body are open to choose (a monster or a
  // unique NPC has none to change, so the whole list is shut), and the choice goes back to the prototype's when its
  // outfit has no art here.
  const syncOutfits = it => {
    const sel = mk.npcs.outfit, critter = it.aid != null && (it.aid >>> 28) === 2;
    sel.disabled = !critter;
    if (!critter) { sel.value = 'proto'; return; }
    for (const o of sel.options) {
      if (o.value === 'proto') continue;
      const aid = (((it.aid & ~((0xF << 20) | (1 << 19))) | (Number(o.value) << 20)) >>> 0);
      o.disabled = true;
      resolveCritterArt(protoCritterAidInfo(aid, 16)).then(res => {
        if (edit.sel.npcs?.num !== it.num) return;           // another NPC was picked since
        o.disabled = !res;
        if (!res && sel.value === o.value) { sel.value = 'proto'; scheduleCursor(); }
      }, () => {});
    }
  };
  const selectMob = (kind, it) => {
    const P = mk[kind];
    edit.sel[kind] = { num: it.num, label: it.label, objType: it.objType, aid: it.aid, npcFlags: it.npcFlags || 0, qty: it.qty ?? null };
    if (P.qtyRow) {           // gold and ammo come in piles: the quantity box starts at the prototype's (gold: 100, one coin is no pile)
      P.qtyRow.hidden = it.qty == null;
      if (it.qty != null) P.qty.value = String(it.objType === 8 ? Math.max(it.qty, 100) : it.qty);
    }
    if (P.outfit) syncOutfits(it);
    P.list.querySelectorAll('.sec-edit-tile.active').forEach(el => el.classList.remove('active'));
    P.list.querySelector(`.sec-edit-tile[data-id="${it.num}"]`)?.classList.add('active');
    P.meta.textContent = `Prototype #${it.num} · ${it.label}${it.fileLabel && it.fileLabel !== it.label ? ` (${it.fileLabel})` : ''} · click a tile to place it`;
    scheduleCursor();
  };
  const buildMobPalette = kind => {
    const P = mk[kind];
    secStartProtoScan();
    if (!secProtoCatalog.done) {         // the catalog listener calls this again as the scan goes on
      P.status.textContent = secProtoCatalog.error ? `Could not scan the prototypes: ${secProtoCatalog.error}` : `Scanning prototypes… ${secProtoCatalog.scanned} / ${secProtoCatalog.total || '?'}`;
      return;
    }
    P.status.textContent = '';
    if (P.built) { prioritizeMob(kind); return; }
    P.built = true;
    const items = mobCatalog(kind), byNum = new Map(items.map(it => [it.num, it]));
    P.obs = makeThumbObserver(P, (el, cv) => {
      mobThumbArt(byNum.get(Number(el.dataset.id))).then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    for (const it of items) {
      const btn = makePaletteButton(it.num, `${it.num} ${it.label} ${it.fileLabel} ${mobObjectTypeName(it.objType)}`, `#${it.num} ${it.label} (${it.fileLabel})`, `${it.num} · ${it.label}`);
      btn.dataset.type = String(it.objType);
      btn.addEventListener('click', () => selectMob(kind, it));
      P.list.appendChild(btn); P.obs.observe(btn);
    }
    if (!items.length) P.status.textContent = 'No prototype of this kind was found.';
    filterMob(kind); prioritizeMob(kind);
    if (edit.sel[kind]) P.list.querySelector(`.sec-edit-tile[data-id="${edit.sel[kind].num}"]`)?.classList.add('active');
  };
  for (const kind of Object.keys(SEC_MOB_KINDS)) {
    mk[kind].search.addEventListener('input', () => filterMob(kind));
    mk[kind].category?.addEventListener('change', () => filterMob(kind));
    mk[kind].drop?.addEventListener('change', scheduleCursor);
    mk[kind].outfit?.addEventListener('change', scheduleCursor);
    secProtoCatalog.listeners.push(() => { if (edit.on && edit.tool === kind) buildMobPalette(kind); });
  }

  // Scenery palette: every entry of scenery.mes (key = 1000 * type + num). Only a few dozen scenery
  // prototypes exist, so an entry without its own prototype is placed as an instance of the chosen
  // "base prototype" with the art id overridden (an object's F_CURRENT_AID wins over its prototype's).
  const sceneryAidOf = key => ((4 << 28) | ((key % 1000) << 19) | (Math.floor(key / 1000) << 6)) >>> 0;
  const exactSceneryProto = new Map();       // art key -> prototype that already uses that art
  const syncSelectedScenery = () => {
    const P = pk.scenery, sel = edit.sel.scenery;
    if (!sel) return;
    // the prototype the game places this art with (or uses for its type of scenery), else its own, else the base one
    // (a base prototype picked by hand wins)
    const gameNum = sel.byHand ? null : secGameProtoForKey(3, sel.artKey)?.num;
    const game = gameNum != null ? secProtoCatalog.byType[3].find(i => i.num === gameNum) || null : null;
    const exact = sel.byHand ? null : exactSceneryProto.get(sel.artKey);
    sel.num = game ? game.num : exact ? exact.num : (Number(P.base.value) || null);
    sel.exact = !!exact && sel.num === exact.num;
    P.meta.textContent = sel.num == null ? 'waiting for the prototype scan…'
      : game ? `prototype #${game.num} (${game.label}), as the game places this art`
      : exact ? `own prototype #${exact.num}` : `no prototype of its own · uses base prototype #${sel.num}`;
  };
  const refreshSceneryBase = () => {
    const P = pk.scenery, items = secProtoCatalog.byType[3];
    exactSceneryProto.clear();
    for (const it of items) { const k = protoCurrentAidArtId(it.aid, 3); if (k != null && !exactSceneryProto.has(k)) exactSceneryProto.set(k, it); }
    if (P.base.options.length !== items.length || !P.base.value) {
      const cur = P.base.value;
      P.base.innerHTML = items.length ? items.map(i => `<option value="${i.num}">#${i.num} · ${escapeHtml(i.label)}</option>`).join('') : '<option value="">(scanning prototypes…)</option>';
      if (cur && items.some(i => String(i.num) === cur)) P.base.value = cur;
      else if (items.length) {
        const use = new Map();    // prefer the scenery prototype this map already uses most
        for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === 3) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) use.set(n, (use.get(n) || 0) + 1); }
        let best = items[0].num, bn = -1;
        for (const it of items) { const n = use.get(it.num) || 0; if (n > bn) { bn = n; best = it.num; } }
        P.base.value = String(best);
      }
    }
    syncSelectedScenery();
  };
  pk.scenery.base.addEventListener('change', () => { if (edit.sel.scenery) edit.sel.scenery.byHand = true; syncSelectedScenery(); });
  secProtoCatalog.listeners.push(() => { if (pk.scenery.built) refreshSceneryBase(); });
  const selectScenery = (key, label) => {
    const P = pk.scenery;
    edit.sel.scenery = { num: null, label, aid: sceneryAidOf(key), objType: 3, artKey: key };
    syncSelectedScenery();
    markActivePane('scenery', key);
    status.textContent = `Scenery: #${key} ${label}`;
    scheduleCursor();
  };
  const buildSceneryPalette = async () => {
    const P = pk.scenery;
    refreshSceneryBase();
    if (P.built) return;
    P.built = true;
    P.status.textContent = 'Loading scenery.mes…';
    let mes;
    try { mes = await loadSceneryMes(); }
    catch (err) { P.built = false; P.status.textContent = `Could not load scenery.mes: ${errText(err)}`; return; }
    const entries = [...mes.entries()].filter(([k]) => k >= 0 && k % 1000 <= 255 && Math.floor(k / 1000) <= 31).sort((a, b) => a[0] - b[0]);
    P.obs = makeThumbObserver(P, (el, cv) => {
      const key = Number(el.dataset.id);
      protoThumbArt({ objType: 3, aid: sceneryAidOf(key) }).then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    for (const [key, text] of entries) {
      const label = String(text).trim().replace(/\.art\b.*$/i, '');
      const btn = makePaletteButton(key, `${key} ${label}`, `#${key} ${label}`, `${key} · ${label}`);
      btn.addEventListener('click', () => selectScenery(key, label));
      P.list.appendChild(btn); P.obs.observe(btn);
    }
    P.status.textContent = '';
    filterPane(P); markActivePane('scenery', edit.sel.scenery?.artKey);
    prioritizeKind('scenery');
  };

  return { applyPaletteFilter, buildPalette, filterPane, prioritizeKind, selectFacade, buildFacadePalette, protoThumbArt, TEX, textureLabel, selectTexture, buildProtoPalette, mobCatalog, selectMob, buildMobPalette, sceneryAidOf, selectScenery };
}
