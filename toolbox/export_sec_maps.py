#!/usr/bin/env python3
"""Batch-export every .sec under data/maps/ to PNG using the project's renderer.

This intentionally does NOT load the application's main.js.  The SEC renderer
has a few UI-only dependencies in the normal application graph; loading main.js
therefore initializes hex/text/GIF UI widgets that do not exist in a batch
export.  Instead, this script serves a small headless module graph containing
only the SEC renderer and the data/art/prototype modules it actually needs.

Usage:
    python export_sec_maps.py
    python export_sec_maps.py --headed
    python export_sec_maps.py --project-root C:\\path\\to\\ArcanumArtExtractor
"""
from __future__ import annotations

import argparse
import base64
import http.server
import json
from pathlib import Path
import re
import socketserver
import sys
import threading
import time
from typing import Any

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
except ImportError:
    print("ERROR: Playwright is required: pip install playwright", file=sys.stderr)
    print("Then: playwright install chromium", file=sys.stderr)
    raise SystemExit(2)


HTML = r'''<!doctype html>
<html><head><meta charset="utf-8"><title>Arcanum SEC batch exporter</title></head>
<body><script type="module">
(async () => {
  try {
    const [{ readSecTileData }, { loadMobsForSecMap, loadSecStaticObjectPoints }, tiles, folderMap, iso, roofsModule, terrainModule] = await Promise.all([
      import('/js/sec/sec-parser.js'),
      import('/js/sec/sec-object-points.js'),
      import('/js/sec/sec-tile-art.js'),
      import('/js/sec/sec-folder-map.js'),
      import('/js/sec/sec-iso.js'),
      import('/js/sec/sec-roofs.js'),
      import('/js/sec/sec-terrain.js')
    ]);

    const tileArtCache = new Map();
    const roofArtStore = new Map();

    function parseSectorPosition(filename) {
      const stem = String(filename || '').replace(/\.sec$/i, '').trim();
      if (!/^\d+$/.test(stem)) return null;
      try {
        const id = BigInt(stem);
        const mask = (1n << 26n) - 1n;
        return { x: Number(id & mask), y: Number((id >> 26n) & mask) };
      } catch (_) { return null; }
    }

    async function loadTileArtForSector(decoded, secPath) {
      await tiles.loadSecTileNameMes();
      await tiles.loadSecTileManifest();
      const uniqueRaw = [...new Set(Array.from(decoded.tiles, v => Number(v) >>> 0))];
      const missing = [];
      await Promise.all(uniqueRaw.map(async raw => {
        if (tileArtCache.has(raw)) return;
        const info = tiles.secTileInfo(raw);
        try {
          const art = await tiles.loadSecTileArt(info);
          if (art) tileArtCache.set(raw, art);
          else missing.push({ raw, tile: info });
        } catch (err) {
          missing.push({ raw, tile: info, error: String(err?.message || err) });
        }
      }));
      for (const m of missing) {
        // BLK/empty is deliberately not an error.
        if (String(m.tile?.name || '').trim().toUpperCase() !== 'BLK') {
          console.warn('[SEC EXPORT] Tile ART could not be loaded', { sec: secPath, ...m });
        }
      }
      return missing;
    }

    function warnObject(secPath, p, reason) {
      console.warn('[SEC EXPORT] Object could not be loaded', {
        sec: secPath,
        object: p?.file ?? '(unknown)',
        name: p?.name ?? null,
        type: p?.type ?? null,
        typeName: p?.typeName ?? null,
        artId: p?.artId ?? null,
        currentAidRaw: p?.currentAidRaw ?? null,
        reason
      });
    }

    const backgroundCache = new Map();
    const folderMobCache = new Map();
    async function loadFolderMapBackground(relativePath) {
      const key = String(relativePath || '');
      if (backgroundCache.has(key)) return backgroundCache.get(key);
      const promise = (async () => {
        try {
          const url = '/data/maps/' + (key ? key.split('/').map(encodeURIComponent).join('/') + '/' : '') + 'Map.png';      // (the game's Map.bmp as a lossless PNG)
          const resp = await fetch(url, { cache: 'no-store' });
          if (!resp.ok) return null;
          const blob = await resp.blob();
          const objectUrl = URL.createObjectURL(blob);
          try {
            const img = new Image();
            await new Promise((resolve, reject) => {
              img.onload = resolve; img.onerror = reject; img.src = objectUrl;
            });
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const cx = c.getContext('2d', { willReadFrequently: true });
            cx.drawImage(img, 0, 0);
            const im = cx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < im.data.length; i += 4) {
              const g = Math.round(im.data[i] * .299 + im.data[i + 1] * .587 + im.data[i + 2] * .114);
              im.data[i] = im.data[i + 1] = im.data[i + 2] = g;
            }
            cx.putImageData(im, 0, 0);
            const gray = new Image();
            await new Promise((resolve, reject) => {
              gray.onload = resolve; gray.onerror = reject; gray.src = c.toDataURL();
            });
            return gray;
          } finally { URL.revokeObjectURL(objectUrl); }
        } catch (_) { return null; }
      })();
      backgroundCache.set(key, promise);
      return promise;
    }

    async function exportOne(job) {
      const relativePath = String(job.relativePath || '').replace(/^\/+|\/+$/g, '');
      const filename = String(job.filename);
      const secPath = relativePath ? `${relativePath}/${filename}` : filename;
      const url = '/data/maps/' + secPath.split('/').map(encodeURIComponent).join('/');
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${secPath}`);

      const decoded = readSecTileData(await resp.arrayBuffer(), filename);
      const position = parseSectorPosition(filename);
      if (!position) throw new Error(`SEC filename is not a numeric sector ID: ${secPath}`);
      return renderSector(job, decoded, filename, position, secPath);
    }

    // A terrain template (data/terrain/<folder>/<n>.sec), drawn as the sector at 0,0: its objects sit
    // at sector-local tiles, so one picture serves every world sector that uses the template.
    async function exportTemplate(job) {
      const secPath = `${job.folder}/${job.file}.sec`;
      const url = '/data/terrain/' + secPath.split('/').map(encodeURIComponent).join('/');
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} loading terrain/${secPath}`);
      const decoded = readSecTileData(await resp.arrayBuffer(), secPath);
      return renderSector({ ...job, mobSources: [] }, decoded, `${job.file}.sec`, { x: 0, y: 0 }, `terrain/${secPath}`);
    }

    // What the engine puts on every world sector without a .sec of its own: a grid of template
    // numbers (0 = none) for the cells of `b`, plus the template list. Needs the terrain.tdf of the map.
    async function terrainGrid(relativePath, b) {
      const t = await terrainModule.loadTerrainMap(relativePath);
      if (!t) return null;
      const W = b.maxX - b.minX + 1, H = b.maxY - b.minY + 1;
      const ids = new Uint16Array(W * H);
      const templates = [], index = new Map();
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const info = t.describe(b.minX + x, b.minY + y);
          if (!info?.template) continue;
          let i = index.get(info.template.path);
          if (i === undefined) {
            i = templates.push({ folder: info.template.folder, file: info.template.file, path: info.template.path, label: info.label }) - 1;
            index.set(info.template.path, i);
          }
          ids[y * W + x] = i + 1;
        }
      }
      const bytes = new Uint8Array(ids.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { W, H, templates, grid: btoa(bin) };
    }

    async function renderSector(job, decoded, filename, position, secPath) {
      if (!decoded?.tiles || decoded.tiles.length !== 4096) {
        throw new Error(`SEC ${secPath}: expected 4096 tile values`);
      }

      // A completely zero-valued SEC is the game's unused/blank sector: all
      // 4096 entries are BLK. Do not render or export it. Zero is only treated
      // as blank when the ENTIRE sector is zero; raw 0 is a legitimate tile in
      // mixed-content sectors.
      if (tiles.secSectorAllZero(decoded)) {
        return { blank: true, width: 0, height: 0, objects: 0, mobObjects: 0, staticObjects: 0 };
      }

      const sector = { filename, index: 0, position, decoded, error: null };
      const bounds = { minX: position.x, maxX: position.x, minY: position.y, maxY: position.y };
      await loadTileArtForSector(decoded, secPath);

      const staticDiag = {
        decodeFailures: [], locationFailures: [], staticObjectCount: 0,
        staticObjectTypeCounts: {}, wallLoaded: 0
      };

      let mobPoints = [];
      let mobDiagnostics = null;

      try {
        // Load MOBs from the SEC's own folder. For nested SECs, also load the
        // top-level map folder, because MOBs may live there instead.
        const mobSources = Array.isArray(job.mobSources) ? job.mobSources : [];
        const sourcePromises = mobSources.map(source => {
          const mobRelativePath = String(source.relativePath || '').replace(/^\/+|\/+$/g, '');
          // relativeNames: file names like "Town/123.mob" are relative to this folder, not the maps root.
          const manifestHint = { files: Array.isArray(source.files) ? source.files : [], relativeNames: !!source.relativeNames };
          let promise = folderMobCache.get(mobRelativePath);
          if (!promise) {
            promise = loadMobsForSecMap(mobRelativePath, manifestHint);
            folderMobCache.set(mobRelativePath, promise);
          }
          return promise;
        });
        const [loadedSources, staticPoints] = await Promise.all([
          Promise.all(sourcePromises),
          loadSecStaticObjectPoints([sector], staticDiag)
        ]);

        const allMobs = [];
        const seenMobFiles = new Set();
        for (const sourceMobs of loadedSources) {
          if (sourceMobs?.mobDiagnostics) {
            mobDiagnostics = mobDiagnostics || { fetchFailures: [], decodeFailures: [], locationFailures: [] };
            mobDiagnostics.fetchFailures.push(...(sourceMobs.mobDiagnostics.fetchFailures || []));
            mobDiagnostics.decodeFailures.push(...(sourceMobs.mobDiagnostics.decodeFailures || []));
            mobDiagnostics.locationFailures.push(...(sourceMobs.mobDiagnostics.locationFailures || []));
          }
          for (const mob of sourceMobs || []) {
            const key = String(mob?.file || '');
            if (key && seenMobFiles.has(key)) continue;
            if (key) seenMobFiles.add(key);
            allMobs.push(mob);
          }
        }

        const matchingMobs = allMobs.filter(p => p && p.sectorX === position.x && p.sectorY === position.y);
        // Sprites reach across sector borders (tall walls, big scenery, critters on the edge), so the
        // objects standing in the 8 neighbouring sectors are drawn too; only their overhang shows.
        const neighbourMobs = allMobs.filter(p => p && !(p.sectorX === position.x && p.sectorY === position.y)
          && Math.abs(p.sectorX - position.x) <= 1 && Math.abs(p.sectorY - position.y) <= 1);
        mobPoints = matchingMobs.concat(neighbourMobs, staticPoints || []);

        for (const p of matchingMobs) {
          if (!p.artCanvas && p.type !== 17) warnObject(secPath, p, 'MOB decoded successfully but its map artwork could not be resolved');
        }
        if (mobDiagnostics) {
          for (const x of mobDiagnostics.fetchFailures || []) console.warn('[SEC EXPORT] MOB file could not be loaded', { sec: secPath, ...x });
          for (const x of mobDiagnostics.decodeFailures || []) console.warn('[SEC EXPORT] MOB could not be decoded', { sec: secPath, ...x });
          for (const x of mobDiagnostics.locationFailures || []) console.warn('[SEC EXPORT] MOB has no usable location', { sec: secPath, ...x });
        }
        for (const x of staticDiag.decodeFailures || []) console.warn('[SEC EXPORT] SEC object could not be decoded', { sec: secPath, ...x });
        for (const x of staticDiag.locationFailures || []) console.warn('[SEC EXPORT] SEC object has no usable location', { sec: secPath, ...x });
        for (const x of staticDiag.staticObjectErrors || []) console.warn('[SEC EXPORT] SEC static-object list could not be loaded', { sec: secPath, ...x });
      } catch (err) {
        console.warn('[SEC EXPORT] Object loading failed', { sec: secPath, error: String(err?.message || err), stack: String(err?.stack || '') });
      }

      const iso = isoModule.secIsoMetrics(bounds);
      // Optional empty margin so sprites reaching over the sector's border are not cut off.
      const pad = job.pad || { l: 0, t: 0, r: 0, b: 0 };
      const cssW = Math.max(1, Math.ceil(iso.width)) + pad.l + pad.r;
      const cssH = Math.max(1, Math.ceil(iso.height)) + pad.t + pad.b;
      const canvas = document.createElement('canvas');
      const key = `${position.x},${position.y}`;
      const view = {
        zoom: 1, offsetX: pad.l, offsetY: pad.t,
        loadedSectors: new Set([key]),
        sectorMap: new Map([[key, sector]]),
        colorSectorCache: new Map(),
        roofArt: roofArtStore,
        light: null
      };
      if (job.roofs) {
        try {
          const r = await roofsModule.loadSecRoofsForSectors([sector], roofArtStore);
          if (r.missing) console.warn('[SEC EXPORT] Roof art could not be resolved', { sec: secPath, missing: r.missing, requested: r.requested });
        } catch (err) {
          console.warn('[SEC EXPORT] Roofs could not be loaded', { sec: secPath, error: String(err?.message || err) });
        }
      }
      // Batch exports are always transparent. Do not load or draw Map.png.
      const mapBackground = null;

      folderMap.drawSecFolderMap(
        canvas, [sector], bounds, null, 'art', tileArtCache, view,
        mobPoints, mapBackground,
        { containers: true, walls: true, scenery: true, otherMobs: true, roofs: !!job.roofs, bounds: false },
        { cssW, cssH, dpr: 1 }
      );

      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: cssW, height: cssH,
        objects: mobPoints.length,
        mobObjects: mobPoints.filter(p => !p.staticSecObject).length,
        staticObjects: mobPoints.filter(p => p.staticSecObject).length
      };
    }

    const isoModule = iso;
    window.__secBatch = { exportOne, exportTemplate, terrainGrid };
    window.__secBatchError = null;
    console.log('[SEC EXPORT] Headless SEC renderer initialized');
  } catch (err) {
    window.__secBatchError = { message: String(err?.message || err), stack: String(err?.stack || '') };
    console.error('[SEC EXPORT] Headless renderer initialization failed', err);
  }
})();
</script></body></html>'''


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serve the real project, with a handful of headless-only module overrides."""
    def __init__(self, *args, directory=None, overrides=None, **kwargs):
        self.overrides = overrides or {}
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in self.overrides:
            body, content_type = self.overrides[path]
            data = body.encode('utf-8') if isinstance(body, str) else body
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def log_message(self, fmt: str, *args: Any) -> None:
        pass


def start_server(project: Path, overrides: dict[str, tuple[str, str]]):
    def factory(*args, **kwargs):
        return Handler(*args, directory=str(project), overrides=overrides, **kwargs)
    server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), factory)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def build_headless_overrides(project: Path, proto_index: dict[str, str]):
    js = project / 'js'

    # The original sec-map-view module contains UI/editor code and imports core/dom.
    # We only need drawSecActualTiles. Extract that exact renderer function from the
    # project's source so its tile placement stays tied to the real implementation.
    src = (js / 'sec' / 'sec-map-view.js').read_text(encoding='utf-8')
    start = src.index('export function drawSecActualTiles')
    end = src.find('\n}\n', start)           # the function's closing brace (what follows, e.g. the sec-aliases loader, needs imports the headless copy lacks)
    end = end + 3 if end >= 0 else end
    if end < 0:
        raise RuntimeError('Could not isolate drawSecActualTiles from sec-map-view.js')
    draw_fn = src[start:end]
    sec_map_headless = '''// Generated headless SEC map renderer. UI/editor code intentionally omitted.\n'''
    sec_map_headless += "import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, SEC_ISO_TILE_H, SEC_ISO_TILE_W, secIsoMetrics, secIsoProject } from './sec-iso.js';\n"
    sec_map_headless += "import { secSectorAllZero, secTileInfo } from './sec-tile-art.js';\n"
    sec_map_headless += "export const SEC_MAP_BACKGROUND = '#000000';\n"
    sec_map_headless += draw_fn + '\n'

    # The normal folder renderer deliberately uses an opaque canvas and paints
    # SEC_MAP_BACKGROUND first. Batch PNGs must remain transparent, including
    # unused/BLK areas, so override only those two renderer details while keeping
    # the rest of the project's folder renderer unchanged.
    sec_folder_map = (js / 'sec' / 'sec-folder-map.js').read_text(encoding='utf-8')
    sec_folder_map, n_alpha = re.subn(
        r"canvas\.getContext\('2d', \{ alpha: false \}\)",
        "canvas.getContext('2d', { alpha: true })", sec_folder_map, count=1)
    sec_folder_map, n_fill = re.subn(
        r"^[ \t]*ctx\.fillStyle = SEC_MAP_BACKGROUND; ctx\.fillRect\(0, 0, cssW, cssH\);[ \t]*\r?\n",
        "", sec_folder_map, count=1, flags=re.M)
    if not (n_alpha and n_fill):
        print('WARNING: could not make the folder renderer transparent; PNGs will have a black background',
              file=sys.stderr)

    # sec-mob-overlay imports mob-map.js only for its type-color helper. That module
    # imports the entire interactive MOB explorer, so replace that one dependency.
    mob_overlay = (js / 'sec' / 'sec-mob-overlay.js').read_text(encoding='utf-8')
    mob_overlay = mob_overlay.replace(
        "import { mobMapTypeColor } from '../mob/mob-map.js';",
        "function mobMapTypeColor(type) { return `hsl(${(type * 47) % 360}, 70%, 60%)`; }"
    )

    # proto-explorer is UI-heavy, but proto-decoder only needs its cache.
    proto_explorer_stub = "export const protoDecodedCache = new Map();\n"

    # sec-object-points only needs these two functions from sec-explorer, not its UI.
    sec_explorer_stub = r'''
export function secDisplayName(path, fallback) {
  return (fallback && fallback !== '..') ? fallback : (String(path || '').split('/').filter(Boolean).pop() || 'maps');
}
export async function loadSecManifest() { return { files: [] }; }
'''

    # The normal proto-resolution module imports proto-explorer and therefore drags
    # the complete prototype UI into the graph. This version keeps exactly the
    # object-ID/prototype resolution behavior needed by SEC object rendering, but
    # obtains the already-scanned numeric prototype index from Python.
    proto_index_json = json.dumps(proto_index, separators=(',', ':'))
    proto_resolution_stub = f'''
import {{ PRO_ROOT }} from '../core/config.js';
import {{ encPath }} from '../core/util.js';
import {{ decodeProtoBuffer }} from './proto-decoder.js';

const protoIndex = {proto_index_json};
const sharedProtoResolveCache = new Map();

export function mobOidTypeAndNumber(bytes) {{
  if (!bytes || bytes.length !== 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {{ type: view.getInt16(0, true), number: view.getUint32(8, true) }};
}}

export function getProtoNumberIndex() {{
  const out = new Map();
  for (const [k, v] of Object.entries(protoIndex)) out.set(Number(k), {{ relPath: '', filename: v }});
  return Promise.resolve(out);
}}

export async function resolveMobPrototype(decoded, cache) {{
  const info = mobOidTypeAndNumber(decoded?.protoOid);
  if (!info || info.type !== 1) return {{ protoNumber: null, entry: null, decodedProto: null, error: null }};
  cache = cache || sharedProtoResolveCache;
  if (cache.has(info.number)) return cache.get(info.number);
  const pending = (async () => {{
    const filename = protoIndex[String(info.number)];
    if (!filename) return {{ protoNumber: info.number, entry: null, decodedProto: null, error: `#${{info.number}} not found under /proto/` }};
    try {{
      const url = `${{PRO_ROOT}}${{encPath(filename)}}`;
      const resp = await fetch(url, {{ cache: 'no-store' }});
      if (!resp.ok) throw new Error(`HTTP ${{resp.status}} fetching ${{url}}`);
      const decodedProto = decodeProtoBuffer(await resp.arrayBuffer(), filename);
      return {{ protoNumber: info.number, entry: {{ relPath: '', filename }}, decodedProto, error: null }};
    }} catch (err) {{
      return {{ protoNumber: info.number, entry: null, decodedProto: null, error: String(err?.message || err) }};
    }}
  }})();
  cache.set(info.number, pending);
  const result = await pending;
  if (result.error) cache.delete(info.number);
  return result;
}}
'''

    # core/util.js imports core/log.js -> core/dom.js. Nothing in the headless graph
    # needs the UI saveFile/log behavior, so provide the same pure helpers without
    # the DOM dependency.
    util_stub = r'''
export function encPath(p) {
  return String(p ?? '').split('/').map(encodeURIComponent).join('/');
}
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function saveFile() { throw new Error('saveFile is unavailable in headless SEC export'); }
export function onVersionChange(reset) { return reset; }      // (the headless page never switches version)
export function versionChanged() {}
'''

    return {
        '/__sec_batch__.html': (HTML, 'text/html; charset=utf-8'),
        '/js/sec/sec-map-view.js': (sec_map_headless, 'text/javascript; charset=utf-8'),
        '/js/sec/sec-folder-map.js': (sec_folder_map, 'text/javascript; charset=utf-8'),
        '/js/sec/sec-mob-overlay.js': (mob_overlay, 'text/javascript; charset=utf-8'),
        '/js/proto/proto-explorer.js': (proto_explorer_stub, 'text/javascript; charset=utf-8'),
        '/js/proto/proto-resolution.js': (proto_resolution_stub, 'text/javascript; charset=utf-8'),
        '/js/sec/sec-explorer.js': (sec_explorer_stub, 'text/javascript; charset=utf-8'),
        '/js/core/util.js': (util_stub, 'text/javascript; charset=utf-8'),
    }


def find_sec_files(root: Path):
    return sorted((p for p in root.rglob('*') if p.is_file() and p.suffix.lower() == '.sec'), key=lambda p: str(p.relative_to(root)).lower())


def find_proto_index(proto_root: Path):
    """Mirror the project's numeric .pro lookup: first file wins for each number."""
    index: dict[str, str] = {}
    if not proto_root.is_dir():
        return index
    for p in sorted(proto_root.rglob('*.pro'), key=lambda x: str(x.relative_to(proto_root)).lower()):
        m = re.match(r'^(\d+)\s*-\s*', p.name)
        # File names are zero-padded ("003044 - Container.pro"); the JS side looks numbers up unpadded.
        key = str(int(m.group(1))) if m else None
        if key is not None and key not in index:
            index[key] = p.relative_to(proto_root).as_posix()
    return index


def map_folder_for_sec(sec: Path, maps_root: Path) -> Path:
    """Return the map folder directly under /maps/ that owns this SEC.

    For /maps/Foo/a.sec and /maps/Foo/sub/a.sec, MOBs are looked up in
    /maps/Foo, matching the game's folder-level map object layout.
    """
    rel = sec.relative_to(maps_root)
    if len(rel.parts) <= 1:
        return maps_root
    return maps_root / rel.parts[0]


def folder_relative_path(folder: Path, maps_root: Path) -> str:
    rel = folder.relative_to(maps_root)
    return '' if rel == Path('.') else rel.as_posix()


def folder_mobs(folder: Path):
    return sorted(p.name for p in folder.glob('*') if p.is_file() and p.suffix.lower() == '.mob')


def data_url_to_png(data_url: str, output: Path):
    prefix = 'data:image/png;base64,'
    if not data_url.startswith(prefix):
        raise ValueError('renderer did not return a PNG data URL')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(data_url[len(prefix):]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument('--headed', action='store_true')
    ap.add_argument('--slow-mo', type=int, default=0)
    ap.add_argument('--folders', default=None,
                    help='folder numbers to export, e.g. "6,8-9", or "all"; skips the prompt')
    ap.add_argument('--roofs', choices=('off', 'on', 'both'), default='off',
                    help='off (default): interiors visible; on: roofs drawn; both: also write <id>_roofs.png')
    args = ap.parse_args()

    project = args.project_root.resolve()
    maps_root = project / 'data' / 'maps'
    export_root = project / 'export' / 'maps'
    if not maps_root.is_dir(): raise SystemExit(f'ERROR: {maps_root} does not exist')
    if not (project / 'js').is_dir(): raise SystemExit(f'ERROR: {project / "js"} does not exist')

    all_sec_files = find_sec_files(maps_root)
    print(f'Found {len(all_sec_files)} .sec file(s) under {maps_root}')
    if not all_sec_files:
        return 0

    # Selection is by map folder, not individual SEC. A SEC in a subfolder is
    # still part of the top-level map folder immediately below /maps/.
    folders: dict[Path, list[Path]] = {}
    for sec in all_sec_files:
        folder = map_folder_for_sec(sec, maps_root)
        folders.setdefault(folder, []).append(sec)
    folder_items = sorted(folders.items(), key=lambda kv: folder_relative_path(kv[0], maps_root).lower())

    print('\nAvailable map folders:')
    for i, (folder, secs) in enumerate(folder_items, 1):
        label = folder_relative_path(folder, maps_root) or '(maps root)'
        print(f'  {i:>3}. {label}  ({len(secs)} .sec file(s))')
    print('')

    def parse_selection(raw: str):
        if not raw.strip():
            return set(range(1, len(folder_items) + 1))
        selected = set()
        for token in raw.replace(' ', '').split(','):
            if not token:
                continue
            if '-' in token:
                a, b = token.split('-', 1)
                if not a.isdigit() or not b.isdigit():
                    raise ValueError(f'Invalid range: {token}')
                lo, hi = int(a), int(b)
                if lo > hi:
                    lo, hi = hi, lo
                selected.update(range(lo, hi + 1))
            elif token.isdigit():
                selected.add(int(token))
            else:
                raise ValueError(f'Invalid selection: {token}')
        bad = sorted(n for n in selected if n < 1 or n > len(folder_items))
        if bad:
            raise ValueError('Folder number(s) out of range: ' + ', '.join(map(str, bad)))
        return selected

    while True:
        try:
            if args.folders is not None:
                raw_selection = '' if args.folders.strip().lower() == 'all' else args.folders
            else:
                raw_selection = input('Enter folder number(s) to export, or press Enter for all: ').lstrip('﻿')
            selected_numbers = parse_selection(raw_selection)
            break
        except ValueError as exc:
            if args.folders is not None:
                raise SystemExit(f'ERROR: invalid --folders value: {exc}')
            print(f'Invalid selection: {exc}')

    selected_folders = [folder_items[i - 1] for i in sorted(selected_numbers)]
    sec_files = [sec for folder, secs in selected_folders for sec in secs]
    print(f'\nSelected {len(selected_folders)} folder(s), {len(sec_files)} .sec file(s).')
    print(f'Exporting to {export_root}\n')

    proto_index = find_proto_index(project / 'data' / 'proto')
    print(f'Indexed {len(proto_index)} numbered .pro file(s) for headless prototype resolution')

    overrides = build_headless_overrides(project, proto_index)
    server = start_server(project, overrides)
    base_url = f'http://127.0.0.1:{server.server_address[1]}'

    failures = 0
    blank_skipped = 0
    export_errors: list[str] = []
    current_sec = None
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed, slow_mo=args.slow_mo)
            page = browser.new_page(viewport={'width': 1280, 'height': 900}, device_scale_factor=1)

            def handle_console(msg):
                # The existing browser renderer probes multiple candidate asset URLs.
                # Chromium reports every missing candidate as a generic console error,
                # even when the renderer is expected to try the next candidate.
                # Do not print those expected 404 probes; keep all project-generated
                # warnings/errors visible.
                text = msg.text or ''
                normalized = text.strip().lower()
                if msg.type == 'error' and (
                    'failed to load resource: the server responded with a status of 404' in normalized
                    or 'failed to load resource: the server responded with a status of 404 (file not found)' in normalized
                ):
                    return
                if msg.type in ('warning', 'error'):
                    line = f'{current_sec or "(initialization)"}: CONSOLE {msg.type.upper()}: {msg.text}'
                    print('  ' + line)
                    export_errors.append(line)

            page.on('console', handle_console)
            def handle_pageerror(exc):
                line = f'{current_sec or "(initialization)"}: PAGE ERROR: {exc}'
                print('  ' + line, file=sys.stderr)
                export_errors.append(line)
            page.on('pageerror', handle_pageerror)
            def handle_requestfailed(req):
                if req.failure and '404' not in str(req.failure):
                    line = f'{current_sec or "(initialization)"}: REQUEST FAILED: {req.url} :: {req.failure}'
                    print('  ' + line, file=sys.stderr)
                    export_errors.append(line)
            page.on('requestfailed', handle_requestfailed)

            page.goto(base_url + '/__sec_batch__.html', wait_until='domcontentloaded')
            try:
                page.wait_for_function('() => !!window.__secBatch || !!window.__secBatchError', timeout=60000)
            except PlaywrightTimeoutError:
                raise RuntimeError('Headless SEC renderer did not initialize within 60 seconds')
            init_error = page.evaluate('() => window.__secBatchError')
            if init_error:
                raise RuntimeError('Headless SEC renderer initialization failed:\n' + init_error.get('message', 'Unknown') + '\n\n' + init_error.get('stack', ''))

            print('Headless SEC renderer initialized successfully.\n')
            total = len(sec_files)
            mob_lists: dict[Path, list[str]] = {}       # each folder's .mob files, listed once, not once per sector
            def mobs_of(folder: Path) -> list[str]:
                if folder not in mob_lists:
                    mob_lists[folder] = folder_mobs(folder)
                return mob_lists[folder]
            for n, sec in enumerate(sec_files, 1):
                rel = sec.relative_to(maps_root)
                relative_path = rel.parent.as_posix() if rel.parent != Path('.') else ''
                sec_folder = sec.parent
                parent_map_folder = map_folder_for_sec(sec, maps_root)
                mob_folders = [sec_folder]
                if sec_folder != parent_map_folder:
                    mob_folders.append(parent_map_folder)
                mob_sources = [
                    {'relativePath': folder_relative_path(mf, maps_root), 'files': mobs_of(mf)}
                    for mf in mob_folders
                ]
                output = export_root / rel.with_suffix('.png')
                current_sec = rel.as_posix()
                print(f'[{n}/{total}] {rel.as_posix()} ...', end='', flush=True)
                started = time.perf_counter()
                try:
                    result = None
                    for with_roofs in ([False, True] if args.roofs == 'both' else [args.roofs == 'on']):
                        result = page.evaluate(
                            '''(job) => window.__secBatch.exportOne(job)''',
                            {'relativePath': relative_path, 'filename': rel.name, 'mobSources': mob_sources, 'roofs': with_roofs},
                        )
                        if result.get('blank'):
                            break
                        out = output.with_name(output.stem + '_roofs.png') if (with_roofs and args.roofs == 'both') else output
                        data_url_to_png(result['dataUrl'], out)
                    if result.get('blank'):
                        blank_skipped += 1
                        print(' SKIP  blank sector (4096 BLK tiles)')
                        continue
                    elapsed = time.perf_counter() - started
                    print(f" OK  {result['width']}x{result['height']}  objects={result['objects']}  ({elapsed:.1f}s)")
                except Exception as exc:
                    failures += 1
                    line = f'{current_sec}: EXPORT FAILED: {exc}'
                    export_errors.append(line)
                    print(f' FAILED: {exc}')
            browser.close()
    finally:
        server.shutdown(); server.server_close()

    export_root.mkdir(parents=True, exist_ok=True)
    error_file = export_root / 'error.txt'
    # De-duplicate repeated console diagnostics while preserving encounter order.
    unique_errors = list(dict.fromkeys(export_errors))
    if unique_errors:
        error_file.write_text('\n'.join(unique_errors) + '\n', encoding='utf-8')
    else:
        error_file.write_text('No errors encountered while exporting.\n', encoding='utf-8')

    print(f'\nFinished. PNGs are in: {export_root}')
    print(f'Skipped {blank_skipped} completely blank SEC file(s).')
    print(f'Errors/warnings recorded in: {error_file}')
    if failures:
        print(f'{failures} SEC file(s) failed to export.')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
