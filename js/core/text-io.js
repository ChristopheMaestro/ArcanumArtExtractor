// Shared loading helpers: text decoding, fetch, memoized async loaders, .mes tables.

import { parseMesText } from './mes-parser.js';
import { onVersionChange } from './util.js';

// Arcanum's text files are Windows-1252; latin1 is the fallback decoder.
export function decodeText(buf) {
  try { return new TextDecoder('windows-1252').decode(buf); }
  catch (_) { return new TextDecoder('latin1').decode(buf); }
}

// The code page a file is really in, told by its content (the same rule as sniff_codec in toolbox/extract_mob_prototypes.py): valid UTF-8 with
// accents -> utf-8; high bytes mostly in runs of 3+ (Cyrillic words) -> windows-1251; else the game's windows-1252. For reading only (search,
// preview): the editors keep writing windows-1252.
export function sniffCodepage(bytes) {
  let high = 0, inRun = 0, runTotal = 0;
  for (let i = 0; i <= bytes.length; i++) {
    const b = i < bytes.length ? bytes[i] : 0;
    if (b >= 0x80 && b !== 0xA7) high++;      // (the "§§§" banners of the sound lists are not text)
    if (b >= 0xC0 || b === 0xA8 || b === 0xB8) { inRun++; continue; }    // (cp1251 letter bytes only)
    if (inRun >= 3) runTotal += inRun;
    inRun = 0;
  }
  if (!high) return 'windows-1252';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return 'utf-8'; } catch (_) { /* not UTF-8 */ }
  return runTotal >= 0.6 * high ? 'windows-1251' : 'windows-1252';
}

export function decodeTextSniffed(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try { return new TextDecoder(sniffCodepage(bytes)).decode(bytes); }
  catch (_) { return decodeText(buf); }
}

export async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.arrayBuffer();
}

export async function fetchText(url) {
  return decodeTextSniffed(await fetchBuffer(url));
}

// Wrap an async loader so it runs once; concurrent callers share the promise
// and a failure clears it so the next call retries. `.peek()` returns the
// loaded value synchronously (or null before the first success).
export function memoAsync(fn) {
  let value = null, loaded = false, pending = null;
  const load = () => {
    if (loaded) return Promise.resolve(value);
    if (pending) return pending;
    pending = Promise.resolve().then(fn)
      .then(v => { value = v; loaded = true; return v; })
      .catch(err => { pending = null; throw err; });
    return pending;
  };
  load.peek = () => (loaded ? value : null);
  onVersionChange(() => { value = null; loaded = false; pending = null; });      // (read again after the Atlas switches version)
  return load;
}

// A cached .mes table: `load()` -> Promise<Map<number,string>>, `peek()` -> Map|null.
export function mesTable(url) {
  return memoAsync(async () => parseMesText(await fetchText(url)));
}

// Message for any thrown value.
export function errText(err) {
  return err && err.message ? err.message : String(err);
}
