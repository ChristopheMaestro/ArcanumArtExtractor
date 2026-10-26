// Wall ART lookup and loading.

import { flipCanvasHorizontally } from './art-frames.js';
import { ART_TYPE, artType } from '../core/art-id.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { frameCanvasForPalette } from '../art/art-export.js';
import { ART_ROOT } from '../core/config.js';
import { artNameIndex } from '../core/file-index.js';
import { fetchText, memoAsync } from '../core/text-io.js';
import { parseMesText } from '../core/mes-parser.js';
import { encPath } from '../core/util.js';

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
export const WALL_PIECES = [
  'bse','lfc','bse','bcl','bcr','tcl','tcr','uec','lec',
  'w3l','w3a','w3r','w4l','w4a','w4b','w4r',
  'w5l','w5a','w5b','w5c','w5r',
  'd3l','d3a','d3r','d4l','d4a','d4b','d4r',
  'd6l','d6a','d6b','d6c','d6d','d6r',
  'p3l','p3a','p3r','p4l','p4a','p4b','p4r',
  'p5l','p5a','p5b','p5c','p5r'
];
const WALL_DAMAGE_SUFFIX = ['U','L','R'];
let wallNameTable = null;        // [{ name }]  (position == a_name wall_file_names index)
let wallStructureTable = null;   // [{ interior, exterior, interiorParam, exteriorParam, flags }]
const wallFileCache = new Map();

function wallMesEntries(text, maxKeyExclusive = Infinity) {
  const out = [];
  for (const [key, value] of parseMesText(text)) {
    if (key < 0 || key >= maxKeyExclusive) continue;
    out.push([key, String(value)]);
  }
  out.sort((x, y) => x[0] - y[0]);
  return out;
}

export const loadWallNameTable = memoAsync(async () => {
  const text = await fetchText(`${ART_ROOT}wall/wallname.mes`);
  return (wallNameTable = wallMesEntries(text).map(([, v]) => ({ name: v.trim().slice(0, 3) })));
});

function wallNameIndex(name) {
  const want = String(name).toLowerCase();
  return wallNameTable.findIndex(e => e.name.toLowerCase() === want);
}

export const loadWallStructureTable = memoAsync(async () => {
  const [text] = await Promise.all([fetchText(`${ART_ROOT}wall/structure.mes`), loadWallNameTable()]);
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
});

// The exact-case names of the .art files in art/portal and art/wall (js/index/files/file_index_art.json).
export const loadPortalManifest = artNameIndex('art/portal');
const loadWallManifest = artNameIndex('art/wall');

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
export function decodeWallArtId(rawValue) {
  const raw = Number(rawValue) >>> 0;
  if (artType(raw) !== ART_TYPE.WALL) return null;
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
export function loadWallArtFromRaw(rawValue) {
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
    hotspotX = canvas.width - hotspotX;
    canvas = flipCanvasHorizontally(canvas);
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
