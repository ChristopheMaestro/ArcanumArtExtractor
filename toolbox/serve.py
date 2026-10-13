#!/usr/bin/env python3
"""Serve the asset browser on http://localhost so any browser can open it normally.

The app is made of ES modules and fetches its manifests and data files. Browsers refuse both from a
file:// page, which is why it used to need a browser started in a special mode. Over http://localhost
nothing special is needed.

    python serve.py              serve on port 8000 (or the next free one) and open the browser
    python serve.py --no-open    do not open the browser
    python serve.py --port 9000
"""
from __future__ import annotations

import argparse
import http.server
import socketserver
import webbrowser
from pathlib import Path


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain through the registry, which makes browsers refuse modules.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
        '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')   # the data folders change while you work
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()

    root = args.project_root.resolve()
    if not (root / 'index.html').is_file():
        raise SystemExit(f'ERROR: no index.html in {root}')

    def factory(*a, **kw):
        return Handler(*a, directory=str(root), **kw)

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = Server(('127.0.0.1', port), factory)
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit(f'ERROR: ports {args.port}-{args.port + 19} are all in use')

    url = f'http://localhost:{server.server_address[1]}/'
    print(f'Asset browser running at {url}\nLeave this window open; press Ctrl+C to stop.')
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
