// Shared loading helpers: text decoding, fetch, memoized async loaders, .mes tables.

import { parseMesText } from './mes-parser.js';
import { onVersionChange } from './util.js';

// Arcanum's text files are Windows-1252; latin1 is the fallback decoder.
export function decodeText(buf) {
  try { return new TextDecoder('windows-1252').decode(buf); }
  catch (_) { return new TextDecoder('latin1').decode(buf); }
}

export async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.arrayBuffer();
}

export async function fetchText(url) {
  return decodeText(await fetchBuffer(url));
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
