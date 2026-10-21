// .PRO viewer.

import { gridEl, paginationEl, viewerEl } from '../core/dom.js';
import { escapeHtml } from '../core/util.js';
import {
  mobCurrentAidText,
  mobFieldValueText,
  mobHex,
  mobOidText,
  mobValueText,
} from '../mob/mob-decoder.js';
import { mobObjectTypeName } from '../mob/mob-schema.js';
import { blitScaleFactor } from '../objects/object-fields.js';
import {
  loadCritterAidArt,
  loadProtoCurrentAidArt,
  protoArtObjectType,
  protoCritterAidInfo,
  protoCurrentAidArtId,
} from './critter-aid.js';
import { buildItemCard } from './item-card.js';
import { backButton } from '../explorer/nav-history.js';
import { ensureProtoArtMesLoaded, protoArtMesMap, protoDescriptionInfo } from './proto-mes.js';

export function renderProtoViewer(decoded) {
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
  header.innerHTML = `<h2>${escapeHtml(decoded.filename)}</h2><span class="meta">${decoded.fields.length} serialized fields</span>`;
  article.appendChild(header);

  // Every one of these fields is populated by the game's own tig_art_*_id_create()
  // for this object's type (see obj.c), so they all share one decode: the raw
  // 32-bit value goes through protoCurrentAidArtId() the same way regardless of
  // which field it came from. F_CURRENT_AID and F_ITEM_INV_AID used to be treated
  // differently — the latter as a raw, un-decoded .mes lookup — which was both
  // inconsistent and, since a packed art id is nothing like a small sequential
  // .mes key, effectively never resolved anything. A field decoding to null here
  // just means this object type's layout isn't confirmed yet, not that the field
  // is absent.
  function decodeProtoArt(rawValue, fieldNumber) {
    const artId = protoCurrentAidArtId(rawValue, decoded.objType);
    const mesMap = protoArtMesMap(protoArtObjectType(rawValue, decoded.objType), fieldNumber);
    const artName = artId !== null && mesMap ? (mesMap.get(artId) ?? null) : null;
    return { artId, artName };
  }

  function renderProtoArtField(label, fieldNumber, { evenIfAbsent = false } = {}) {
    const field = decoded.fields.find(f => f.field === fieldNumber);
    if (!field && !evenIfAbsent) return;
    const { artId, artName } = decodeProtoArt(field ? field.value : undefined, fieldNumber);

    const art = document.createElement('div');
    art.className = 'proto-current-aid-art';

    const preview = document.createElement('div');
    preview.className = 'proto-current-aid-preview';
    const canvas = document.createElement('canvas');
    canvas.className = 'proto-current-aid-canvas';
    preview.appendChild(canvas);

    const meta = document.createElement('div');
    meta.className = 'proto-current-aid-meta';
    const labelEl = document.createElement('span');
    labelEl.className = 'proto-current-aid-label';
    labelEl.textContent = label;
    const nameEl = document.createElement('strong');
    if (artId !== null) {
      nameEl.textContent = artName || `Art ID ${artId}`;
    } else if (decoded.objType === 0) {
      // A wall's F_CURRENT_AID on the .pro is only ever the seed value for a
      // brand-new, unplaced wall (see obj.c's default wall creation). The moment
      // it's placed next to other walls the game overwrites it per-tile with a
      // computed piece/rotation/variation based on adjacency (see wall.c,
      // sub_4E2C50 and friends) — so there is no single "correct" art for a
      // wall prototype in isolation, and this isn't a decode failure.
      nameEl.textContent = 'Not applicable — wall art is computed per-tile from map adjacency, not stored on the prototype (see game/wall.c)';
    } else if (protoCritterAidInfo(field ? field.value : null, decoded.objType)) {
      const protoScale = blitScaleFactor(decoded.fields?.find(f => f.field === 12)?.value);
      nameEl.textContent = `Critter art ID ${protoCritterAidInfo(field.value, decoded.objType).text}` +
        (protoScale && protoScale !== 1 ? ` \u00b7 size ${Math.round(protoScale * 100)}%` : '');
    } else {
      nameEl.textContent = decoded.objType === 17
        ? 'No trap art \u2014 F_CURRENT_AID is not an eye-candy id (placeholder, ignored)'
        : 'Art ID unavailable';
    }
    meta.append(labelEl, nameEl);

    if (fieldNumber === 1) {
      const descriptionField = decoded.fields.find(f => f.field === 23);
      const descriptionInfo = descriptionField ? protoDescriptionInfo(descriptionField.value) : null;
      const descLabel = document.createElement('span');
      descLabel.className = 'proto-current-aid-label';
      descLabel.textContent = 'F_DESCRIPTION';
      const descEl = document.createElement('div');
      descEl.className = 'proto-current-aid-description';
      if (descriptionInfo && descriptionInfo.text != null) {
        descEl.textContent = `${descriptionInfo.text} (${descriptionInfo.id})`;
      } else if (descriptionInfo && descriptionInfo.loading) {
        descEl.textContent = `${mobValueText(descriptionField.value)} (loading description.mes…)`;
      } else if (descriptionInfo) {
        descEl.textContent = `${mobValueText(descriptionField.value)} (not found in description.mes)`;
      } else {
        descEl.textContent = 'Not present';
      }
      meta.append(descLabel, descEl);
    }

    art.append(preview, meta);

    // The MES tables are loaded asynchronously.  In particular, eye_candy.mes
    // is not necessarily loaded yet when a .PRO viewer is opened.  Do not let
    // that race leave the panel stuck at just "Art ID NNN"; load the relevant
    // table here and then resolve the filename and ART bitmap.
    if (artId === null) {
      const critterInfo = protoCritterAidInfo(field ? field.value : null, decoded.objType);
      if (critterInfo && critterInfo.filename) loadCritterAidArt(critterInfo, canvas);
    }
    if (artId !== null) {
      const effectiveArtType = protoArtObjectType(field ? field.value : null, decoded.objType);
      const loadAndRender = async () => {
        try {
          const map = await ensureProtoArtMesLoaded(effectiveArtType, fieldNumber);
          const resolvedName = map?.get(artId) ?? null;
          if (!resolvedName) return;
          nameEl.textContent = resolvedName;
          await loadProtoCurrentAidArt(artId, resolvedName, canvas, effectiveArtType, field ? field.value : null);
        } catch (_) {
          // Keep the already-visible Art ID when the MES/ART asset is unavailable.
        }
      };
      // If the map was already loaded this remains effectively synchronous;
      // otherwise the async path fills the preview as soon as the MES is ready.
      art.loaded = artName
        ? loadProtoCurrentAidArt(artId, artName, canvas, effectiveArtType, field ? field.value : null)
        : loadAndRender();
      art.iconCanvas = canvas;
    }
    return art;
  }

  // Field 1 renders whenever it or F_DESCRIPTION is present, even if F_CURRENT_AID
  // itself is missing, so the description still shows; the rest only render when present.
  // Each field looks up its own art in its own table (see protoArtMesMap) and all of them
  // are laid out side by side in one row so they're easy to compare at a glance.
  const hasCurrentAidOrDescription = decoded.fields.some(f => f.field === 1 || f.field === 23);
  const aidPanels = [];
  // A wall has no art id of its own (its art is computed per tile from the map), so no empty
  // preview is shown for it.
  if (hasCurrentAidOrDescription && decoded.objType !== 0) aidPanels.push(renderProtoArtField('Current art (F_CURRENT_AID)', 1, { evenIfAbsent: true }));
  const invPanel = renderProtoArtField('Inventory icon (F_ITEM_INV_AID)', 93);
  aidPanels.push(invPanel);
  aidPanels.push(renderProtoArtField('Use icon (F_ITEM_USE_AID_FRAGMENT)', 95));
  let paperPanel = null;
  if (decoded.objType === 5) paperPanel = renderProtoArtField('Paper doll (F_WEAPON_PAPER_DOLL_AID)', 113);
  if (decoded.objType === 7) paperPanel = renderProtoArtField('Paper doll (F_ARMOR_PAPER_DOLL_AID)', 151);
  aidPanels.push(paperPanel);
  const aidPanelsPresent = aidPanels.filter(Boolean);
  if (aidPanelsPresent.length) {
    const aidRow = document.createElement('div');
    aidRow.className = 'proto-aid-row';
    aidRow.append(...aidPanelsPresent);
    article.appendChild(aidRow);
  }

  // Items: the info box the game shows when an item is examined, below the art ids.
  if (decoded.objType >= 5 && decoded.objType <= 14) {
    const cardHost = document.createElement('div');
    article.appendChild(cardHost);
    buildItemCard(decoded)
      .then(card => cardHost.appendChild(card))
      .catch(() => {});
  }

  const summary = document.createElement('div');
  summary.className = 'mob-summary';
  summary.innerHTML = `
      <div><span>Size</span><strong>${decoded.size} bytes</strong></div>
      <div><span>Version</span><strong>${decoded.version}</strong></div>
      <div><span>Object type</span><strong>${mobObjectTypeName(decoded.objType)} (${decoded.objType})</strong></div>
      <div><span>Available fields</span><strong>${decoded.actualAvailable}</strong></div>
      <div><span>Serialized fields</span><strong>${decoded.fields.length}</strong></div>
    `;
  article.appendChild(summary);

  const ids = document.createElement('div');
  ids.className = 'mob-ids';
  ids.innerHTML = `
      <div><b>Prototype OID</b><pre>${mobOidText(decoded.protoOid)}</pre></div>
      <div><b>Object OID</b><pre>${mobOidText(decoded.objectOid)}</pre></div>
      <div><b>Available mask</b><pre>${decoded.bitmap.map(x => `0x${x.toString(16).padStart(8,'0').toUpperCase()}`).join(' ')}</pre></div>
    `;
  article.appendChild(ids);

  const title = document.createElement('h3');
  title.className = 'mob-section-title';
  title.textContent = 'Prototype fields';
  article.appendChild(title);

  const table = document.createElement('div');
  table.className = 'mob-field-table proto-field-table';
  const head = document.createElement('div');
  head.className = 'mob-field-row mob-field-head';
  ['Field','Available','Type','Offset','Size','Value','Raw'].forEach(t => {
    const c = document.createElement('div'); c.textContent = t; head.appendChild(c);
  });
  table.appendChild(head);

  for (const f of decoded.fields) {
    const row = document.createElement('div');
    row.className = 'mob-field-row';
    const c1 = document.createElement('div');
    c1.innerHTML = `<strong>${f.name}</strong><small>#${f.field} · change[${f.change_idx}] bit ${f.bit}</small>`;
    if (f.field === 23) {
      const source = document.createElement('small');
      source.className = 'proto-description-source';
      source.textContent = 'From description.mes';
      c1.appendChild(source);
    }
    const c2 = document.createElement('div');
    c2.textContent = f.available ? 'Yes' : 'No';
    if (f.available) c2.classList.add('proto-available');
    const c3 = document.createElement('div'); c3.textContent = f.od;
    const c4 = document.createElement('div'); c4.textContent = `0x${f.offset.toString(16).toUpperCase().padStart(4,'0')}`;
    const c5 = document.createElement('div'); c5.textContent = String(f.size);
    const c6 = document.createElement('div');
    c6.className = 'mob-value';
    if (f.field === 23) {
      const info = protoDescriptionInfo(f.value);
      if (info && info.text !== null) {
        c6.textContent = `${info.text} (${info.id})`;
      } else if (info && info.loading) {
        c6.textContent = `${mobValueText(f.value)} (loading description.mes…)`;
      } else if (info) {
        c6.textContent = `${mobValueText(f.value)} (not found in description.mes)`;
      } else {
        c6.textContent = mobValueText(f.value);
      }
    } else if (f.field === 1) {
      c6.textContent = mobCurrentAidText(f.value, decoded.objType);
    } else if ((f.field === 89 || f.field === 91) && Number(f.value) === -1) {
      // data-formats.md: shipped .pro files store weight/worth as a -1 sentinel;
      // the real number is filled in at runtime from internal default tables,
      // not read from the file. Flag it so -1 doesn't look like real data.
      c6.textContent = `${mobValueText(f.value)} (sentinel — game computes default at runtime)`;
    } else {
      c6.textContent = mobFieldValueText(f.field, f.value);
    }
    const c7 = document.createElement('div'); c7.className = 'mob-raw'; c7.textContent = f.raw;
    [c1,c2,c3,c4,c5,c6,c7].forEach(c => row.appendChild(c));
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
}
