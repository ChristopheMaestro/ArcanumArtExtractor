// .MOB file viewer.

import { gridEl, paginationEl, viewerEl } from '../core/dom.js';
import { escapeHtml } from '../core/util.js';
import { mobCurrentAidText, mobFieldValueText, mobHex, mobLocationInfo, mobOidText } from './mob-decoder.js';
import { backButton } from '../explorer/nav-history.js';
import { mobObjectTypeName } from './mob-schema.js';
import { descriptionLabel } from '../proto/proto-mes.js';

export function renderMobViewer(decoded) {
  gridEl.hidden = true;
  paginationEl.hidden = true;
  viewerEl.innerHTML = '';
  viewerEl.hidden = false;
  viewerEl.classList.add('revealed');

  const article = document.createElement('article');
  article.className = 'mob-viewer';

  const backBar = document.createElement('div');
  backBar.className = 'viewer-backbar';
  backBar.appendChild(backButton());
  article.appendChild(backBar);

  const header = document.createElement('div');
  header.className = 'file-group-header';
  header.innerHTML = `<h2>${escapeHtml(decoded.filename)}</h2><span class="meta">${decoded.fields.length} overridden field${decoded.fields.length === 1 ? '' : 's'}</span>`;
  article.appendChild(header);

  // The game's info box for the object (filled in once the prototype is known), and the jump buttons.
  const cardHost = document.createElement('div');
  cardHost.className = 'mob-card-host';
  article.appendChild(cardHost);
  const actions = document.createElement('div');
  actions.className = 'mob-side-actions';
  article.appendChild(actions);

  const summary = document.createElement('div');
  summary.className = 'mob-summary';
  const locField = decoded.fields.find(f => f.field === 2);
  const loc = locField ? mobLocationInfo(locField.value) : null;
  summary.innerHTML = `
      <div><span>Size</span><strong>${decoded.size} bytes</strong></div>
      <div><span>Version</span><strong>${decoded.version}</strong></div>
      <div><span>Object type</span><strong>${mobObjectTypeName(decoded.objType)} (${decoded.objType})</strong></div>
      <div><span>NUM_FIELDS</span><strong>${decoded.numFields}</strong></div>
      <div><span>Set bits</span><strong>${decoded.actualSet}</strong></div>
      ${loc ? `<div><span>World X / Y</span><strong>${loc.worldX} / ${loc.worldY}</strong></div><div><span>Sector X / Y</span><strong>${loc.sectorX} / ${loc.sectorY}</strong></div><div><span>Tile X / Y</span><strong>${loc.tileX} / ${loc.tileY}</strong></div>` : ''}
    `;
  article.appendChild(summary);

  const ids = document.createElement('div');
  ids.className = 'mob-ids';
  ids.innerHTML = `
      <div><b>Prototype OID</b><pre>${mobOidText(decoded.protoOid)}</pre></div>
      <div><b>Object OID</b><pre>${mobOidText(decoded.objectOid)}</pre></div>
      <div><b>FIELD_48</b><pre>${decoded.bitmap.map(x => `0x${x.toString(16).padStart(8,'0').toUpperCase()}`).join(' ')}</pre></div>
    `;
  article.appendChild(ids);

  // Filled in asynchronously by loadMobFromServer once the linked prototype
  // (if any) has been resolved — see resolveMobPrototype/renderMobPrototypeInfo.
  const protoSection = document.createElement('div');
  protoSection.className = 'mob-proto-section';
  const resolving = document.createElement('p');
  resolving.className = 'explorer-status';
  resolving.textContent = 'Resolving prototype…';
  protoSection.appendChild(resolving);
  article.appendChild(protoSection);

  const title = document.createElement('h3');
  title.className = 'mob-section-title';
  title.textContent = 'Serialized / overridden fields';
  article.appendChild(title);

  const table = document.createElement('div');
  table.className = 'mob-field-table';
  const head = document.createElement('div');
  head.className = 'mob-field-row mob-field-head';
  ['Field', 'Type', 'Offset', 'Size', 'Value', 'Raw'].forEach(t => {
    const c = document.createElement('div'); c.textContent = t; head.appendChild(c);
  });
  table.appendChild(head);
  for (const f of decoded.fields) {
    const row = document.createElement('div');
    row.className = 'mob-field-row';
    const c1 = document.createElement('div');
    c1.innerHTML = `<strong>${f.name}</strong><small>#${f.field} · change[${f.change_idx}] bit ${f.bit}</small>`;
    const c2 = document.createElement('div'); c2.textContent = f.od;
    const c3 = document.createElement('div'); c3.textContent = `0x${f.offset.toString(16).toUpperCase().padStart(4,'0')}`;
    const c4 = document.createElement('div'); c4.textContent = String(f.size);
    const c5 = document.createElement('div');
    c5.className = 'mob-value';
    c5.textContent = f.field === 1 ? mobCurrentAidText(f.value, decoded.objType)
      : (f.field === 23 && descriptionLabel(f.value)) || mobFieldValueText(f.field, f.value);
    const c6 = document.createElement('div'); c6.className = 'mob-raw'; c6.textContent = f.raw;
    [c1, c2, c3, c4, c5, c6].forEach(c => row.appendChild(c));
    table.appendChild(row);
  }
  article.appendChild(table);

  const tail = document.createElement('div');
  tail.className = 'mob-tail';
  tail.textContent = decoded.trailing.length
    ? `Trailing bytes: ${decoded.trailing.length}\n${mobHex(decoded.trailing)}`
    : `End offset: 0x${decoded.endOffset.toString(16).toUpperCase()} · no trailing bytes`;
  article.appendChild(tail);

  viewerEl.appendChild(article);
  viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return { protoSection, summary, cardHost, actions };
}
