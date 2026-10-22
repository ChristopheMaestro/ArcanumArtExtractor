// The scrollbar of the game (ui/scrollbar_ui.c), for the Atlas's lists and panels.
//   * the position is a whole number of lines: an arrow moves 1 line, a click in the trough above / below the thumb 5 lines
//     (a page), a turn of the mouse wheel 3 lines, and dragging the thumb moves it a line at a time
//   * the thumb is one line of the track long (the track divided by the number of positions), 12 px at the least - it does not
//     show how much of the list is in view - and at the last position it rests against the lower arrow
//   * the bar is 11 px wide with an arrow at either end
// window.gameScroll(doc) gives another page (Files: the Asset Browser in its frame) the same bars, see dressPage below.
(function () {
  const LINE = 28, PAGE = 5, WHEEL = 3, ARROW = 13, MIN_THUMB = 12;
  const SCROLLERS = '.loclist, .tree, .qlist, .igrid, .lib-list, .dlg, #labelPanel, .side-right';

  // el: the scrolling element. Inside the Atlas the bar sits in el's parent (made relative). On a page that is not ours
  // (`page` given) nothing of its layout is touched: the bar is a fixed element next to el, laid over el's right edge, and
  // the page's own watcher moves it (page.place).
  function attach(el, page) {
    const doc = el.ownerDocument, win = doc.defaultView;
    const host = el.parentElement;
    if (!host) return null;
    if (!page && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    el.classList.add('gs-scroller');
    const bar = doc.createElement('div');
    bar.className = 'gsb'; bar.hidden = true;
    bar.innerHTML = '<button type="button" class="gs-up" tabindex="-1" aria-label="Up">▲</button><div class="gs-track"><i class="gs-thumb"></i></div><button type="button" class="gs-down" tabindex="-1" aria-label="Down">▼</button>';
    if (page) { bar.style.position = 'fixed'; el.after(bar); } else host.appendChild(bar);
    const up = bar.firstChild, track = bar.children[1], thumb = track.firstChild, down = bar.lastChild;

    const max = () => Math.max(0, Math.ceil((el.scrollHeight - el.clientHeight) / LINE));
    const value = () => Math.min(max(), Math.round(el.scrollTop / LINE));
    const unit = () => track.clientHeight / (max() + 1);              // the track divided by the positions
    const thumbH = () => Math.max(MIN_THUMB, Math.floor(unit()));
    const set = v => { v = Math.max(0, Math.min(max(), v)); el.scrollTop = v >= max() ? el.scrollHeight : v * LINE; };

    function place() {
      const shown = el.isConnected && el.offsetParent !== null && max() > 0;
      bar.hidden = !shown;
      if (!shown) return;
      const er = el.getBoundingClientRect();
      if (page) {
        // the part of el its scrolling ancestors leave in view: the rest of the bar is cut away
        let top = er.top, bottom = er.bottom;
        for (let a = el.parentElement; a && a !== doc.body; a = a.parentElement) {
          if (win.getComputedStyle(a).overflowY === 'visible') continue;
          const ar = a.getBoundingClientRect(); top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom);
        }
        if (bottom - top < ARROW * 2) { bar.hidden = true; return; }
        bar.style.left = er.right - el.clientLeft - 11 + 'px'; bar.style.top = er.top + 'px'; bar.style.height = er.height + 'px';
        // a transformed ancestor makes "fixed" relative to itself: correct by what the bar really got
        const br = bar.getBoundingClientRect(), dx = er.right - el.clientLeft - 11 - br.left, dy = er.top - br.top;
        if (Math.abs(dx) > .5 || Math.abs(dy) > .5) { bar.style.left = parseFloat(bar.style.left) + dx + 'px'; bar.style.top = parseFloat(bar.style.top) + dy + 'px'; }
        bar.style.clipPath = top > er.top || bottom < er.bottom ? `inset(${top - er.top}px 0 ${er.bottom - bottom}px 0)` : '';
      } else {
        const hr = host.getBoundingClientRect();
        bar.style.top = er.top - hr.top - host.clientTop + 'px';
        bar.style.height = er.height + 'px';
        bar.style.left = er.right - hr.left - host.clientLeft - 11 + 'px';
      }
      draw();
    }
    function draw(dy) {
      const h = thumbH(), room = track.clientHeight - h;
      let top = value() >= max() ? room : Math.min(room, unit() * value());
      if (dy != null) top = Math.max(0, Math.min(room, dy));
      thumb.style.height = h + 'px'; thumb.style.top = top + 'px';
    }

    up.onclick = () => set(value() - 1);
    down.onclick = () => set(value() + 1);
    // a click in the trough pages; on the thumb it starts a drag
    track.addEventListener('pointerdown', e => {
      const t = thumb.getBoundingClientRect();
      if (e.clientY < t.top) return set(value() - PAGE);
      if (e.clientY > t.bottom) return set(value() + PAGE);
      const base = e.clientY - t.top, start = track.getBoundingClientRect().top;
      track.setPointerCapture(e.pointerId); bar.classList.add('drag');
      const move = m => {
        const dy = m.clientY - start - base;
        set(Math.round(dy / unit())); draw(dy);
      }, end = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', end); track.removeEventListener('pointercancel', end); bar.classList.remove('drag'); draw(); };
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
      e.preventDefault();
    });
    // a notch of the wheel (100) is 3 lines; a wheel something inside already used (a map's zoom) is left alone
    let wheel = 0;
    el.addEventListener('wheel', e => {
      if (e.defaultPrevented || e.ctrlKey || e.shiftKey || !max() || el.scrollHeight - el.clientHeight < 1) return;
      const v = value(), atEnd = (e.deltaY < 0 && v <= 0) || (e.deltaY > 0 && v >= max());
      if (atEnd) { wheel = 0; return; }                       // let an outer list take it
      e.preventDefault();
      wheel += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const notches = Math.trunc(wheel / 100);
      if (notches) { wheel -= notches * 100; set(v + notches * WHEEL); }
    }, { passive: false });

    el.addEventListener('scroll', () => { if (!bar.hidden && !bar.classList.contains('drag')) draw(); }, { passive: true });
    if (page) { new win.ResizeObserver(page.place).observe(el); return { el, bar, place }; }
    new ResizeObserver(place).observe(el);
    new MutationObserver(place).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    window.addEventListener('resize', place);
    place();
    return { el, bar, place };
  }

  // the listed boxes get the bar inside the page's layout; any other scrolling box of the page (lists and panels that come and go) is found like on another page
  // (the Atlas's bars are styled by its own sheet, css/atlas.css, or by an inline <style>: either has a `.gsb {` rule)
  const hasBarCss = () => [...document.styleSheets].some(sh => { try { return [...sh.cssRules].some(r => /\.gsb\b/.test(r.selectorText || '')); } catch (_) { return false; } });
  function start() { document.querySelectorAll(SCROLLERS).forEach(el => attach(el)); dressPage(document, hasBarCss()); }
  const startWhenReady = () => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();   // (called below, once PAGE_CSS exists)

  // ---- another page (the Asset Browser in Files) -------------------------------------------------------------------------
  // Its scrolling boxes come and go as files open, so they are found from its style sheets: every rule that lets a box scroll
  // (overflow auto / scroll), plus boxes its scripts give an overflow. The bars keep the game's look in the page's own colours
  // left aside (fixed values). Its horizontal scrollbars stay, in the same dress.
  const PAGE_CSS = `
.gs-scroller::-webkit-scrollbar { width: 0; height: 11px; }
.gs-scroller::-webkit-scrollbar-track { background: #0d0b08; }
.gs-scroller::-webkit-scrollbar-thumb { background: linear-gradient(#6d5632, #ffd700 45%, #6d5632); border-left: 2px solid #ffe066; border-right: 3px solid #3a2f20; }
.gs-scroller::-webkit-scrollbar-corner { background: #0d0b08; }
@supports not selector(::-webkit-scrollbar) { .gs-scroller { scrollbar-width: none; } }
.gsb { position: fixed; z-index: 20; width: 11px; min-width: 0 !important; box-sizing: border-box; display: flex; flex-direction: column; background: #0d0b08; border-left: 1px solid #4a3e2e; user-select: none; }
.gsb[hidden] { display: none; }
.gsb button { flex: none; position: relative; height: 13px; min-height: 0; padding: 0; margin: 0; border: 0; border-radius: 0; background: #2a2218; color: transparent; font-size: 0; box-shadow: none; cursor: pointer; }
.gsb button::after { content: ""; position: absolute; left: 50%; top: 50%; margin: -2px 0 0 -3px; border: 3px solid transparent; }
.gsb .gs-up::after { border-bottom: 4px solid #ffd700; border-top: 0; }
.gsb .gs-down::after { border-top: 4px solid #ffd700; border-bottom: 0; }
.gsb button:hover { background: #3a2f20; }
.gs-track { position: relative; flex: 1; min-height: 0; cursor: default; touch-action: none; }
.gs-thumb { position: absolute; left: 0; right: 0; background: linear-gradient(90deg, #6d5632, #ffd700 45%, #6d5632); border-top: 2px solid #ffe066; border-bottom: 3px solid #3a2f20; box-sizing: border-box; }
.gsb.drag .gs-thumb { filter: brightness(1.25); }`;
  startWhenReady();

  function scrollingSelectors(doc) {
    const out = new Set(['[style*="overflow"]']);
    const walk = rules => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }          // @media, @supports
        if (!r.selectorText || !r.style) continue;
        if (/auto|scroll/.test(r.style.overflowY)) for (const s of r.selectorText.split(',')) {
          const clean = s.replace(/::?(hover|focus(-visible|-within)?|active|-webkit-[\w-]+|before|after)\b/g, '').trim();
          if (clean) out.add(clean);
        }
      }
    };
    for (const sh of doc.styleSheets) { try { walk(sh.cssRules); } catch (_) {} }   // other sites' sheets (fonts) cannot be read
    return [...out];
  }

  function dressPage(doc, ownCss) {      // ownCss: the page has the bars' style sheet already (the Atlas)
    if (!doc || doc.__gameScroll) return;
    const win = doc.defaultView;
    if (!ownCss) doc.head.insertAdjacentHTML('beforeend', `<style id="gameScrollCss">${PAGE_CSS}</style>`);
    let selectors = null;
    const bars = new Map();                            // scrolling box -> its bar
    let queued = false;
    const page = { place: () => queue() };
    function find() {
      if (!selectors) selectors = scrollingSelectors(doc);
      for (const s of selectors) {
        let list; try { list = doc.querySelectorAll(s); } catch (_) { continue; }
        for (const el of list) {
          if (bars.has(el) || el === doc.body || el === doc.documentElement || el.closest('.gsb') || el.classList.contains('gs-scroller') || el.matches('.welcome')) continue;   // .welcome: no bar at all
          if (!/auto|scroll/.test(win.getComputedStyle(el).overflowY)) continue;
          const b = attach(el, page); if (b) bars.set(el, b);
        }
      }
    }
    function run() {
      queued = false;
      find();
      for (const [el, b] of bars) {
        if (!el.isConnected) { b.bar.remove(); bars.delete(el); continue; }
        if (b.bar.previousElementSibling !== el) el.after(b.bar);          // the page rebuilt what was around it
        b.place();
      }
    }
    function queue() { if (!queued) { queued = true; win.requestAnimationFrame(run); } }
    // the bars' own changes do not count
    const ours = n => n.nodeType === 1 && !!n.closest('.gsb');
    new win.MutationObserver(ms => {
      if (ms.some(m => m.type === 'attributes' ? !ours(m.target) : ![...m.addedNodes, ...m.removedNodes].every(ours))) queue();
    })
      .observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    doc.addEventListener('scroll', queue, { capture: true, passive: true });  // a box inside another one moves with it
    for (const t of ['transitionend', 'animationend']) doc.addEventListener(t, queue, true);
    win.addEventListener('resize', queue);
    doc.__gameScroll = true;
    queue();
  }
  window.gameScroll = dressPage;
})();
