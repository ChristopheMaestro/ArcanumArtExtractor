// Tool pages: a tool (the .ART Packer, the new world) that takes the whole window instead of a pop-up, in the
// Asset Browser's own three columns: its options in the left side bar, its work in the centre, its result and
// actions in the right side bar. A tool registers the elements of each column once; the page opens by putting
// a class on <body> (ws-tool, ws-tool-<name>), which hides the file list / viewer / details and shows the panes.
// Other code can ask for a page with  document.dispatchEvent(new CustomEvent('toolpage', { detail: name | 'close' })).

const pages = new Map();
let current = null;

const css = `
.tool-pane { display: none; }
body.ws-tool .side-left > :not(.tool-pane), body.ws-tool .side-right > :not(.tool-pane), body.ws-tool .stage > :not(.tool-pane) { display: none !important; }
.side-left > .tool-pane { position: absolute; inset: 0; width: var(--tool-left-w, 380px); flex-direction: column; }
.side-right > .tool-pane { flex: 1 1 auto; min-height: 0; width: 100%; min-width: 240px; flex-direction: column; }
.stage > .tool-pane { flex: 1 1 auto; min-height: 0; flex-direction: column; gap: 14px; }
.tool-pane-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.tool-pane-body > * { flex: none; }
.tool-back { flex: none; margin: 0; padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-2); color: var(--ink-muted); font: 500 10px/1.2 var(--font-mono); cursor: pointer; }
.tool-back:hover, .tool-back:focus-visible { border-color: var(--brass); color: var(--ink); }
body.ws-tool #atlasEdge { display: none; }
.ws-tool .packer-step h3 { font-size: 13px; }
.ws-tool .stage { padding: 16px 20px 20px; }
.ws-tool .packer-kinds { grid-template-columns: 1fr; }
.tool-export { margin-left: auto; white-space: nowrap; }
.ws-tool .packer-frame-item { flex-wrap: wrap; }
.ws-tool .packer-frame-info { flex: 1 1 120px; }
`;
let styled = false;

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

// name, title (the left bar's heading), width of the left bar (px),
// left / main / right: the elements of each column. They are moved here, so their ids and listeners keep working.
export function registerToolPage(name, { title, leftWidth = 380, rightWidth = 320, left = [], main = [], right = [], rightTitle = 'Result', rightAction = null }) {
  if (pages.has(name)) return;
  if (!styled) { document.head.insertAdjacentHTML('beforeend', `<style id="toolPagesCss">${css}</style>`); styled = true; }
  const mk = (host, col) => { const p = el('div', 'tool-pane'); p.dataset.page = name; p.dataset.col = col; host.appendChild(p); return p; };
  const pl = mk(document.getElementById('sideLeft'), 'left'), pm = mk(document.getElementById('stage'), 'main'), pr = mk(document.getElementById('sideRight'), 'right');
  const head = (text, back) => {
    const h = el('div', 'side-head'), t = el('span', 'side-title');
    t.textContent = text; h.appendChild(t);
    if (!back && rightAction) h.appendChild(rightAction);
    if (back) { const b = el('button', 'tool-back'); b.type = 'button'; b.textContent = '◀ Back'; b.title = 'Back to the maps'; b.addEventListener('click', closeToolPage); h.appendChild(b); }
    return h;
  };
  const fill = (pane, items, title, back) => {
    if (title) pane.appendChild(head(title, back));
    const body = el('div', 'tool-pane-body');
    for (const e of items) body.appendChild(e);
    pane.appendChild(body);
  };
  fill(pl, left, title, true);
  fill(pr, right, rightTitle, false);
  pm.appendChild(el('div', 'tool-pane-body'));
  for (const e of main) pm.firstChild.appendChild(e);
  pages.set(name, { name, leftWidth, rightWidth, panes: [pl, pm, pr] });
  const sheet = document.getElementById('toolPagesCss');
  sheet.textContent += `
body.ws-tool-${name} { --side-left-w: ${leftWidth}px; --side-right-w: ${rightWidth}px; --tool-left-w: ${leftWidth}px; }
body.ws-tool-${name} .tool-pane[data-page="${name}"] { display: flex; }`;
}

export function openToolPage(name) {
  if (!pages.has(name)) return false;
  if (current) document.body.classList.remove(`ws-tool-${current}`);
  current = name;
  document.body.classList.add('ws-tool', `ws-tool-${name}`);
  document.dispatchEvent(new CustomEvent('toolpageopen', { detail: name }));
  return true;
}

export function closeToolPage() {
  if (!current) return;
  document.body.classList.remove('ws-tool', `ws-tool-${current}`);
  const was = current;
  current = null;
  document.dispatchEvent(new CustomEvent('toolpageclose', { detail: was }));
}

document.addEventListener('toolpage', e => { if (e.detail === 'close') closeToolPage(); else openToolPage(e.detail); });
// going to another kind of file / the maps leaves the tool
document.addEventListener('explorermodechange', closeToolPage);
