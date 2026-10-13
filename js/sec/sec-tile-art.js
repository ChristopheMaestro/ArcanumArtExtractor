// SEC tile, facade and art-id lookup and loading.

import { ART_TYPE, artType } from '../core/art-id.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { frameCanvasForPalette } from '../art/art-export.js';
import { DATA_ROOT } from '../core/config.js';
import { artNameIndex } from '../core/manifest.js';
import { parseMesNameList } from '../core/mes-parser.js';
import { fetchText, memoAsync } from '../core/text-io.js';
import { encPath } from '../core/util.js';
import { flipCanvasHorizontally } from '../objects/art-frames.js';

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
let secFacadeNameMap = null;
export const secFacadeFileCache = new Map();
export const secFacadeFileMissing = new Set();

const SEC_TILE_MANIFEST_URL = `${DATA_ROOT}art/tile/tile_manifest.json`;
const SEC_TILE_A3_CODES = '06b489237ea5dc10';
const SEC_TILE_A3_SET = [0, 1, 8, 3, 4, 5, 6, 7, 8, 3, 10, 11, 6, 7, 14, 15];
const SEC_TILE_A3_UNSET = [0, 1, 2, 9, 4, 5, 12, 13, 2, 9, 10, 11, 12, 13, 14, 15];
export let secTileNameMesMap = null;
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
export const loadSecFacadeNames = memoAsync(async () => (secFacadeNameMap = parseMesNameList(await fetchText(SEC_FACADE_NAME_MES_URL))));

// TIG art IDs store the art type in the high nibble.  The object-art
// values already decoded elsewhere in this viewer confirm the same layout:
// for example 0x61003A09 is an ITEM art ID (type 6).  Facade is type 11.
// Do NOT try facade filenames for ordinary tile IDs: doing so can turn a
// missing tile into an unrelated, but valid-looking, facade.
const SEC_FACADE_ARTID_BASE = 10000;

// Facade TIG art ID layout (verified against the facade IDs stored in the
// Iron Clan HQ sectors):
//   bit  0       walkable
//   bits 1-10    frame (index of this cell inside the facade's ART file)
//   bits 17-24   facade number, low 8 bits
//   bit  27      facade number, bit 8
// The number is split around other fields, so it is NOT simply the low 9 bits
// of the ID. Reading (raw & 0x1FF) returned the walkable/frame bits instead,
// which is why unrelated facades were being picked.
export function secFacadeNumber(raw) {
  const v = Number(raw) >>> 0;
  return ((v >>> 17) & 0xFF) | ((v >>> 19) & 0x100);
}

export function secFacadeFrame(raw) {
  return (Number(raw) >>> 1) & 0x3FF;
}

export function secFacadeWalkable(raw) {
  return (Number(raw) >>> 0) & 1;
}

export async function loadSecFacadeArt(raw) {
  if (artType(raw) !== ART_TYPE.FACADE) return null;

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

export const loadSecTileNameMes = memoAsync(async () => (secTileNameMesMap = parseSecTileNameMes(await fetchText(SEC_TILE_NAME_MES_URL))));

export const loadSecTileManifest = artNameIndex(SEC_TILE_MANIFEST_URL);

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

// A raw tile value of 0 is a real tile (indoor non-flippable tile 300, a3=0,
// a4=0 -> e.g. Dn1bse0a.ART); it is only "empty" when the WHOLE sector is
// zero (an unused sector). Skipping every 0 left holes in sectors that use
// the a4=0 variant alongside the other orientations.
export function secSectorAllZero(decoded) {
  if (!decoded?.tiles) return true;
  if (decoded.__allZero === undefined) {
    let all = true;
    for (let i = 0; i < decoded.tiles.length; i++) if ((decoded.tiles[i] >>> 0) !== 0) { all = false; break; }
    decoded.__allZero = all;
  }
  return decoded.__allZero;
}

export function secTileInfo(raw) {
  if (artType(raw) === ART_TYPE.FACADE) {
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

export function secTileArtFilename(tile) {
  // This mirrors a_name.c::build_tile_file_name() exactly.
  const e1 = secTileNameMesMap?.get(tile.artId);
  const num2Id = (tile.type === 1
    ? (tile.flippable2 ? 0 : 100)
    : (tile.flippable2 ? 200 : 300)) + tile.num2;
  const e2 = secTileNameMesMap?.get(num2Id);
  const name1 = e1?.name || `tile${tile.artId}`;
  const name2 = e2?.name || name1;
  const candidates = [];
  const add = value => {
    if (value && !candidates.some(c => c.toLowerCase() === value.toLowerCase())) candidates.push(value);
  };
  const code = a3 => SEC_TILE_A3_CODES[Math.max(0, Math.min(15, a3 | 0))];
  const letter = Math.max(0, Math.min(15, tile.a4 | 0));
  const a4Char = String.fromCharCode(97 + (letter >= 8 ? letter - 8 : letter));
  const suffix = (name, a3) => `${name}bse${code(a3)}${a4Char}.art`;

  // sub_4EB7D0(): position of a name among the OUTDOOR tile names only (flippable
  // 0-99 first, then non-flippable 100-199); -1 for indoor / unknown names. Which
  // of the two names comes first in a transition file name depends on it.
  const outdoorIndex = name => {
    const want = String(name).toLowerCase();
    let flippable = 0;
    while (secTileNameMesMap?.has(flippable)) flippable++;
    for (let i = 0; i < flippable; i++) if (secTileNameMesMap.get(i).name.toLowerCase() === want) return i;
    for (let i = 0; secTileNameMesMap?.has(100 + i); i++) if (secTileNameMesMap.get(100 + i).name.toLowerCase() === want) return flippable + i;
    return -1;
  };

  // a_name.c::build_tile_file_name()
  if (tile.a4 >= 0) {
    if (tile.a3 === 15 || name1.toLowerCase() === name2.toLowerCase()) {
      add(suffix(name1, tile.a3));
    } else if (tile.a3 === 0) {
      add(suffix(name2, 0));
    } else {
      const v1 = outdoorIndex(name1);
      const v2 = v1 < 0 ? -1 : outdoorIndex(name2);
      if (v1 < 0) add(suffix(name1, tile.a3));
      else if (v2 < 0) add(suffix(name2, 15 - tile.a3));
      else if (v1 < v2) add(`${name1}${name2}${code(tile.a3)}${a4Char}.art`);
      else add(`${name2}${name1}${code(15 - tile.a3)}${a4Char}.art`);
    }
  }

  // Do not fall back to a bare <name>.art here. The game constructs exactly
  // one tile filename from the packed tile ID; choosing another valid ART
  // file can make a SEC tile look plausible while actually being wrong.
  return candidates;
}

export function secTileColor(artId) {
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

export async function loadSecTileArt(tile) {
  // A facade ID must never go through the ordinary-tile path: decoding it as a
  // tile produces a bogus tile number, and if a tile ART with that name exists
  // it would be drawn instead of the facade. Resolve facades first.
  if (artType(tile?.raw) === ART_TYPE.FACADE) {
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

    let rendered = frameCanvasForPalette(frame, palette, 0);
    // Bit 0 of the packed tile ID is the horizontal-flip flag: the ART file is
    // named from the stored a3/a4, and the tile is then drawn mirrored. Every
    // mis-rotated tile in the test sector had this bit set.
    if ((tile.raw & 1) && rendered) rendered = flipCanvasHorizontally(rendered);
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
