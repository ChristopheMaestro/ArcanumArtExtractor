// The icon of a .MOB file card: the picture of the object's info box (its portrait, or the race / monster /
// item icon the game draws there), instead of the 📦. Cards are filled in as they scroll into view, a few at a
// time, since each one means reading the .mob and its prototype.

import { MOB_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { cardIconSource, loadCardIcon } from '../proto/item-card.js';
import { loadDescriptionMes } from '../proto/proto-mes.js';
import { resolveMobPrototype } from '../proto/proto-resolution.js';
import { decodeMobBuffer } from './mob-decoder.js';
import { effectiveMob } from './mob-extras.js';

const MAX_PARALLEL = 4;
const queue = [];
let running = 0;
let generation = 0;   // a new folder grid drops what was still waiting for the previous one

async function fill(card, filename, relativePath) {
  const resp = await fetch(`${MOB_ROOT}${relativePath ? `${encPath(relativePath)}/` : ''}${encPath(filename)}`);
  if (!resp.ok) return;
  const decoded = decodeMobBuffer(await resp.arrayBuffer(), filename);
  await loadDescriptionMes().catch(() => null);
  const proto = await resolveMobPrototype(decoded);
  const source = await cardIconSource(effectiveMob(decoded, proto));
  const icon = await loadCardIcon(source);
  if (!icon || !card.isConnected) return;
  const shown = icon instanceof HTMLCanvasElement ? icon : (() => { const c = document.createElement('canvas'); c.width = icon.naturalWidth; c.height = icon.naturalHeight; c.getContext('2d').drawImage(icon, 0, 0); return c; })();
  shown.className = 'mob-file-art-icon';
  shown.title = source.kind === 'portrait' ? `portrait ${source.file}` : `${source.file} (info-box icon)`;
  card._iconThumb.replaceChildren(shown);
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (job.generation !== generation) continue;
    running++;
    fill(job.card, job.filename, job.relativePath).catch(() => {}).finally(() => { running--; pump(); });
  }
}

const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    const job = e.target._mobIconJob;
    if (job) { queue.push(job); pump(); }
  }
}, { rootMargin: '200px' }) : null;

// Call for every file card of a folder grid; `startMobCardIcons()` first, when the grid is rebuilt.
export function startMobCardIcons() { generation++; queue.length = 0; }
export function applyMobCardIcon(card, filename, relativePath = '') {
  if (!card?._iconThumb) return;
  card._mobIconJob = { card, filename, relativePath, generation };
  if (observer) observer.observe(card);
}
