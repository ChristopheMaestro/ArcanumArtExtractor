#!/usr/bin/env python3
"""
Generates art-thumbs/: the thumbnails of the .ART grid as sheets, so the asset browser loads one picture
per page of 50 instead of the 50 .art files (online that was ~50 requests and up to ~4 MB per page).

    art-thumbs/index.json               what the sheets hold (see js/art/art-thumb-sheets.js)
    art-thumbs/<folder>/<k>.webp        the folder's .art files k*50 .. k*50+49 (English name order), 10 per row
    art-thumbs/<folder>/folders.webp    the 4-picture previews of the folder's sub-folder cards

The thumbnails are drawn by the viewer's own code (js/art/art-preview.js renderArtThumb, a headless browser),
so they are the pixels the grid would draw from the .art files. Needs Playwright and Pillow:

    python toolbox/build_art_thumbs.py

Run it again after adding, renaming, removing or changing .art files (and after Jsoner.py). A folder whose
files no longer match its sheets falls back to loading the .art files, so stale sheets are slow, not wrong
- except for a changed picture under the same name, which keeps its old thumbnail until this runs.
"""

import base64
import http.server
import io
import json
import shutil
import socketserver
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'art-thumbs'

try:
    from playwright.sync_api import sync_playwright
    from PIL import Image
except ImportError:
    print('ERROR: needs Playwright and Pillow: pip install playwright pillow && playwright install chromium', file=sys.stderr)
    raise SystemExit(2)

CELL, COLS, PER_SHEET = 96, 10, 50


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html'}

    def log_message(self, *args):
        pass


def start_server():
    def factory(*args, **kwargs):
        return Handler(*args, directory=str(ROOT), **kwargs)
    socketserver.ThreadingTCPServer.request_queue_size = 512   # 50 fetches at once overflow the default 5
    server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), factory)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# Every folder of data/art as the grid sees it: its .art files in grid order and its sub-folder cards.
WALK_JS = """
async () => {
  const ex = await import('/js/art/art-explorer.js');
  const { joinPath } = await import('/js/core/manifest.js');
  const out = [], seen = new Set();
  const walk = async (rel, name) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const m = await ex.loadManifest(rel, name);
    const files = (m.files || []).filter(f => /\\.art$/i.test(f)).sort((a, b) => a.localeCompare(b));
    const sub = m.subfolders || {};
    const subs = Object.keys(sub).sort().map(k => sub[k]).filter(sf => sf && typeof sf === 'object' && sf.folder_name)
      .map(sf => ({ full: joinPath(rel, sf.relative_path), name: sf.folder_name }));
    out.push({ rel, name, files, subs });
    for (const s of subs) await walk(s.full, s.name);
  };
  await walk('', ex.ROOT_FOLDER_NAME);
  return out;
}
"""

# Shared by both kinds of sheet: draw the thumbnails of `arts` ({ rel, file }) into cells, 10 per row.
DRAW_JS = """
const drawSheet = async (arts, CELL, COLS) => {
  const pv = await import('/js/art/art-preview.js');
  const { ART_ROOT } = await import('/js/core/config.js');
  const { encPath } = await import('/js/core/util.js');
  const sheet = document.createElement('canvas');
  sheet.width = COLS * CELL;
  sheet.height = Math.max(1, Math.ceil(arts.length / COLS)) * CELL;
  const g = sheet.getContext('2d');
  const missing = [];
  await Promise.all(arts.map(async (a, i) => {
    // a failed download is retried, then stops the run: only a file without a picture is "missing"
    const url = `${ART_ROOT}${a.rel ? `${encPath(a.rel)}/` : ''}${encPath(a.file)}`;
    let buf = null;
    for (let attempt = 0; !buf; attempt++) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        buf = await r.arrayBuffer();
      } catch (err) {
        if (attempt >= 3) throw new Error(`couldn't read ${url}: ${err.message}`);
        await new Promise(res => setTimeout(res, 200));
      }
    }
    let thumb = null;
    try { thumb = await pv.renderArtThumb(buf); } catch (_) {}
    if (thumb) g.drawImage(thumb, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    else missing.push(i);
  }));
  return { png: sheet.toDataURL('image/png'), missing: missing.sort((a, b) => a - b) };
};
"""

FOLDER_JS = """
async ({ rel, files: gridFiles, CELL, COLS, PER_SHEET }) => {
  """ + DRAW_JS + """
  const ts = await import('/js/art/art-thumb-sheets.js');
  const files = ts.sheetOrder(gridFiles);
  const sheets = [], missing = [];
  for (let k = 0; k * PER_SHEET < files.length; k++) {
    const chunk = files.slice(k * PER_SHEET, (k + 1) * PER_SHEET).map(file => ({ rel, file }));
    const s = await drawSheet(chunk, CELL, COLS);
    sheets.push(s.png);
    missing.push(...s.missing.map(i => i + k * PER_SHEET));
  }
  return { sheets, missing, hash: ts.fileListHash(files) };
}
"""

PREVIEW_JS = """
async ({ subs, CELL, COLS }) => {
  """ + DRAW_JS + """
  const ex = await import('/js/art/art-explorer.js');
  const arts = [], cards = {};
  for (const s of subs) {
    const first = await ex.findFirstArtFiles(s.full, s.name, 4);
    cards[s.full] = first.map(a => { arts.push({ rel: a.relativePath, file: a.filename }); return arts.length - 1; });
  }
  const sheet = await drawSheet(arts, CELL, COLS);
  const gone = new Set(sheet.missing);
  for (const k of Object.keys(cards)) cards[k] = cards[k].map(c => (gone.has(c) ? null : c));
  return { png: sheet.png, rows: Math.max(1, Math.ceil(arts.length / COLS)), cards, cells: arts.length };
}
"""


def save_webp(data_url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.open(io.BytesIO(base64.b64decode(data_url.split(',', 1)[1])))
    # lossless; quality/method are only how hard it tries (the strongest takes ~12 s a sheet for ~2 % less)
    im.save(path, 'WEBP', lossless=True, quality=75, method=4)
    return path.stat().st_size


def main():
    t0 = time.time()
    server = start_server()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    index = {'source': 'toolbox/build_art_thumbs.py', 'cell': CELL, 'cols': COLS, 'perSheet': PER_SHEET,
             'folders': {}, 'previews': {}}
    if OUT.exists():
        shutil.rmtree(OUT)
    sheet_count = file_count = missing_count = 0
    saves = []      # WebP encoding runs alongside the browser drawing the next folder
    pool = ThreadPoolExecutor()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(locale='en-US')
        page.goto(base + '/asset-browser.html', wait_until='domcontentloaded')
        page.wait_for_timeout(1500)
        folders = page.evaluate(WALK_JS)
        for i, f in enumerate(folders, 1):
            rel = f['rel']
            where = OUT / rel if rel else OUT
            if f['files']:
                r = page.evaluate(FOLDER_JS, {'rel': rel, 'files': f['files'], 'CELL': CELL, 'COLS': COLS, 'PER_SHEET': PER_SHEET})
                for k, png in enumerate(r['sheets']):
                    saves.append(pool.submit(save_webp, png, where / f'{k}.webp'))
                sheet_count += len(r['sheets'])
                file_count += len(f['files'])
                missing_count += len(r['missing'])
                index['folders'][rel] = {'count': len(f['files']), 'hash': r['hash'], 'missing': r['missing']}
                print(f"  [{i}/{len(folders)}] {rel or '/'}: {len(f['files'])} files, {len(r['sheets'])} sheets"
                      + (f", {len(r['missing'])} without a picture" if r['missing'] else ''), flush=True)
            elif f['subs']:
                # a folder without .art files shows its sub-folders as cards with a 4-picture preview
                r = page.evaluate(PREVIEW_JS, {'subs': f['subs'], 'CELL': CELL, 'COLS': COLS})
                if r['cells']:
                    saves.append(pool.submit(save_webp, r['png'], where / 'folders.webp'))
                    sheet_count += 1
                index['previews'][rel] = {'rows': r['rows'], 'cards': r['cards']}
                print(f"  [{i}/{len(folders)}] {rel or '/'}: previews of {len(f['subs'])} sub-folders", flush=True)
        browser.close()
    server.shutdown()
    total_bytes = sum(s.result() for s in saves)
    pool.shutdown()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'index.json').write_text(json.dumps(index, separators=(',', ':')), encoding='utf-8')
    print(f'Wrote {OUT.relative_to(ROOT)}/: {sheet_count} sheets for {file_count} .art files'
          f' ({missing_count} without a picture), {total_bytes / 1048576:.1f} MB, in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
