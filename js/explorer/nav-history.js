// "Back" for every viewer: one rule, no special cases.
//
// The places the user has been to are kept in a list, in order. A place is what the app already
// saves as "where I am": the category (art, pro, mob…), its folder, the open file, and the search
// whose results are on screen. Whatever opens a place (a folder, a file, a search, a link from one
// category to another) records it through visit(); Back drops the current place and opens the one
// before it again. So Back returns to the results of a search, to the .mob that linked to an .art,
// to the previous script… without the viewer knowing where it was reached from.
//
// A category registers how to open its places (registerPlaceOpener). A viewer with a state of its
// own (the sector map's zoom and selection) can hand it over with attachView() to get it back.

const MAX_PLACES = 80;
const places = [];            // the last one is on screen: { mode, path, folderName, file, query, … }
const openers = new Map();    // category -> async place => void
let restoring = false;        // Back is reopening a place: what that does is not a new visit
let scaffolding = null;       // { mode, path }: the folder a file is about to be opened from, not a place of its own
let liveView = null;          // { place, capture, restore } of the viewer on screen

const keyOf = p => [p.mode, p.path || '', p.file || '', p.query || ''].join('\u0000');

export function registerPlaceOpener(mode, open) { openers.set(mode, open); }

// An explorer that is about to open a file at once (a jump, "Continue") opens its folder first to
// fill the tree: that folder was never shown, so it is not kept as a place.
export function scaffold(mode, path) { scaffolding = { mode, path: path || '' }; }

// Records the place now on screen. The same place again (a page turned, a refresh) only updates it.
export function visit(place) {
  if (restoring) return;
  const folderOnly = !place.file && !place.query;
  const skip = scaffolding && folderOnly && scaffolding.mode === place.mode && scaffolding.path === (place.path || '');
  scaffolding = null;
  if (skip) return;
  const top = places[places.length - 1];
  if (top && keyOf(top) === keyOf(place)) { Object.assign(top, place); return; }
  captureView(top);
  places.push({ ...place });
  if (places.length > MAX_PLACES) places.shift();
}

// A viewer that has a state to give back: capture() when the user leaves it, restore(state) when Back returns.
// `mode` and `path` say which place it shows, so a viewer built for another place is ignored.
export function attachView({ mode, path, capture, restore }) {
  const place = places[places.length - 1];
  if (!place || place.mode !== mode || (place.path || '') !== (path || '')) return;
  liveView = { place, capture, restore };
}
function captureView(place) {
  if (!place || !liveView || liveView.place !== place) return;
  try { place.viewState = liveView.capture(); } catch (_) { place.viewState = null; }
  liveView = null;
}

function describe(p) {
  if (p.mode === 'home') return 'the home page';
  const category = `.${p.mode.toUpperCase()}`;
  if (p.query) return `the ${category} search results for “${p.query}”`;
  if (p.file) return p.file;
  return `${category} ${p.folderName || p.path || ''}`.trim();
}
export function backTitle() {
  const prev = places[places.length - 2];
  return prev ? `Back to ${describe(prev)}` : 'Back to the folder';
}

let going = false;
export async function goBack() {
  if (going) return;
  going = true;
  try {
    const current = places.pop();
    let target = places[places.length - 1];
    // Nothing before it (a page opened on this file), or only the home page: the folder the file is in.
    if (current && current.file && (!target || target.mode === 'home')) {
      target = { ...current, file: null, query: '', viewState: null };
      places.push(target);
    }
    if (!target) { if (current) places.push(current); return; }
    restoring = true;
    try { await openers.get(target.mode)?.(target); } finally { restoring = false; scaffolding = null; }
    const state = target.viewState;
    if (state && liveView && liveView.place === target) {
      target.viewState = null;
      await liveView.restore(state);
    }
  } catch (err) {
    console.error('Back:', err);
  } finally {
    going = false;
  }
}

// A viewer with no back bar of its own (the sector map, which is also its folder) gets one when the
// user came to it from another file or category, so there is a way back.
export function mountBackBar(container) {
  const here = places[places.length - 1], before = places[places.length - 2];
  if (!here || !before || before.mode === 'home' || (before.mode === here.mode && (before.path || '') === (here.path || ''))) return;
  const bar = document.createElement('div');
  bar.className = 'viewer-backbar';
  bar.appendChild(backButton());
  container.prepend(bar);
}

// The button every viewer shows at the top.
export function backButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-back';
  button.textContent = '← Back';
  const retitle = () => { button.title = backTitle(); };
  retitle();
  button.addEventListener('pointerenter', retitle);
  button.addEventListener('focus', retitle);
  button.addEventListener('click', goBack);
  return button;
}
