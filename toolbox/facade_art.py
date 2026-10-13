"""Shared helpers for the facade tools: facade names, ART decoding (direction 0) and the seam test between two cells."""
from __future__ import annotations
import re, struct
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FACADE_DIR = ROOT / 'data' / 'art' / 'facade'

# Tile neighbours (dx, dy) -> where the neighbour's picture lands relative to ours, in pixels.
# Facades are laid out with screen x = dy - dx, screen y = dx + dy, one step being 40 x 20 pixels.
NEIGHBOURS = [(1, 0), (-1, 0), (0, 1), (0, -1)]


def screen(dx: int, dy: int) -> tuple[int, int]:
    return (dy - dx) * 40, (dx + dy) * 20


def facade_names() -> dict[int, str]:
    names = {}
    for line in (FACADE_DIR / 'facadename.mes').read_text(encoding='latin1').splitlines():
        m = re.match(r'\{(\d+)\}\{(.*)\}', line.strip())
        if m:
            names[int(m.group(1))] = m.group(2)
    return names


def _rle(chunk: bytes, total: int) -> bytearray:
    out = bytearray(total)
    p = o = 0
    while p < len(chunk) and o < total:
        c = chunk[p]; p += 1; n = c & 0x7F
        if not c & 0x80:
            e = min(total, o + n); out[o:e] = bytes([chunk[p]]) * (e - o); p += 1; o = e
        else:
            k = min(n, total - o, len(chunk) - p); out[o:o + k] = chunk[p:p + k]; p += n; o += k
    return out


class Cell:
    __slots__ = ('rgb', 'mask', 'hx', 'hy')

    def __init__(self, rgb, mask, hx, hy):
        self.rgb, self.mask, self.hx, self.hy = rgb, mask, hx, hy


def load_cells(name: str) -> dict[int, Cell]:
    """Frame index -> Cell, for the first direction of FACADE_DIR/<name>.ART."""
    path = next((p for p in FACADE_DIR.glob('*.ART') if p.stem.lower() == name.lower()), None)
    if path is None:
        return {}
    b = path.read_bytes()
    h = struct.unpack_from('<33I', b, 0)
    npal = max(1, sum(1 for i in range(3, 7) if h[i]))
    fpd = h[8]
    total = (8 if (h[0] & 1) == 0 else 1) * fpd
    pal = np.array([(b[0x84 + i * 4 + 2], b[0x84 + i * 4 + 1], b[0x84 + i * 4]) for i in range(256)], dtype=np.int16)
    off = 0x84 + npal * 1024
    infos = []
    for _ in range(total):
        infos.append(struct.unpack_from('<IIIiiii', b, off)); off += 28
    cells = {}
    for i, (w, hh, size, hx, hy, _mx, _my) in enumerate(infos):
        if w == 0 or hh == 0:
            continue
        chunk = b[off:off + size]; off += size
        if i >= fpd:
            continue
        idx = np.frombuffer(bytes(chunk) if w * hh == len(chunk) else bytes(_rle(chunk, w * hh)), dtype=np.uint8).reshape(hh, w)
        cells[i] = Cell(pal[idx], idx != 0, hx, hy)
    return cells


def seam(a: Cell, b: Cell, dx: int, dy: int) -> tuple[float, int]:
    """Mean colour difference across the border between cell `a` and cell `b` standing at (dx, dy) from it, and the
    number of touching pixel pairs. A correct neighbour continues the picture, so the difference is small."""
    sx, sy = screen(dx, dy)
    # canvas coordinates of each cell's top-left corner, hotspot at the origin
    ax, ay = -a.hx, -a.hy
    bx, by = sx - b.hx, sy - b.hy
    x0, y0 = min(ax, bx) - 2, min(ay, by) - 2
    x1 = max(ax + a.mask.shape[1], bx + b.mask.shape[1]) + 2
    y1 = max(ay + a.mask.shape[0], by + b.mask.shape[0]) + 2
    W, H = x1 - x0, y1 - y0
    ma = np.zeros((H, W), bool); mb = np.zeros((H, W), bool)
    ca = np.zeros((H, W, 3), np.int16); cb = np.zeros((H, W, 3), np.int16)
    ya, xa = ay - y0, ax - x0
    ma[ya:ya + a.mask.shape[0], xa:xa + a.mask.shape[1]] = a.mask; ca[ya:ya + a.mask.shape[0], xa:xa + a.mask.shape[1]] = a.rgb
    yb, xb = by - y0, bx - x0
    mb[yb:yb + b.mask.shape[0], xb:xb + b.mask.shape[1]] = b.mask; cb[yb:yb + b.mask.shape[0], xb:xb + b.mask.shape[1]] = b.rgb
    solo_a, solo_b = ma & ~mb, mb & ~ma
    tot, n = 0.0, 0
    for sh in ((0, 1), (1, 0)):
        for sign in (1, -1):
            oy, ox = sh[0] * sign, sh[1] * sign
            sa = np.roll(solo_a, (oy, ox), (0, 1))          # a's pixels moved one step
            hit = sa & solo_b
            if hit.any():
                shifted = np.roll(ca, (oy, ox), (0, 1))
                tot += float(np.abs(shifted[hit] - cb[hit]).sum()); n += int(hit.sum()) * 3
    return (tot / n if n else 255.0), n
