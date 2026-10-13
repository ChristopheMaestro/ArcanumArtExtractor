// What a .mob shows once its prototype is known: the Art ID, the game's info box for the object, and the
// buttons that jump elsewhere (the map at the object's tile, each script attached to it).

import { buildItemCard, cardIconSource } from '../proto/item-card.js';
import { ART_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { leaveDataExplorer } from '../explorer/data-explorer.js';
import { openDeepLink } from '../art/art-explorer.js';
import { resolveCritterArt } from '../objects/critter-art.js';
import { openScrByNumber, scrFileForNumber } from '../scr/scr-explorer.js';
import { openSecAtTile } from '../sec/sec-explorer.js';
import { mobCurrentAidText, mobLocationInfo } from './mob-decoder.js';
import { mobState } from './mob-explorer.js';
import { protoArtRoot, protoDescriptionInfo } from '../proto/proto-mes.js';
import { F_DESCRIPTION, mobCreatureRace, splitRaceType } from './mob-identity.js';

import { openProtoFile } from '../proto/proto-explorer.js';
import { loadCritterAidArt, loadProtoCurrentAidArt, protoArtObjectType, protoCritterAidInfo } from '../proto/critter-aid.js';
import { resolveProtoFileCardArts } from '../proto/proto-card-art.js';

const F_CURRENT_AID = 1, F_LOCATION = 2, F_SCRIPTS_IDX = 32;

// The object as the game sees it: the prototype's fields, each overridden by the .mob's own.
export function effectiveMob(decoded, proto) {
  const fields = new Map();
  for (const f of proto?.decodedProto?.fields || []) fields.set(f.field, f);
  for (const f of decoded.fields) fields.set(f.field, f);
  return { objType: decoded.objType, filename: decoded.filename, protoNumber: proto?.protoNumber ?? null, fields: [...fields.values()] };
}

// The script attachments (F_SCRIPTS_IDX): the prototype's, with the .mob's own taking the place of the same slot.
function scriptAttachments(decoded, proto) {
  const slots = new Map();
  for (const source of [proto?.decodedProto?.fields, decoded.fields]) {
    const f = source?.find(x => x.field === F_SCRIPTS_IDX);
    for (const e of f?.value?.elements || []) if (e.value && e.value.script_num) slots.set(e.index, e.value);
  }
  return [...slots.values()];
}

function button(text, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mob-action-btn';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// Name / Race / Type of an NPC at the top of the summary. A special NPC (Gilbert Bates) has a name of its own
// in F_DESCRIPTION; the prototype's generic name ("Human Beggar") then only gives its type.
function addCreatureRows(decoded, proto, eff, summary) {
  const nameOf = fields => { const f = fields?.find(x => x.field === F_DESCRIPTION); return f ? protoDescriptionInfo(f.value).text : null; };
  const own = nameOf(decoded.fields), generic = nameOf(proto?.decodedProto?.fields);
  const name = own || generic || '';
  const identity = mobCreatureRace(eff.fields, decoded.objType);
  let race = '', type = '';
  if (own && own !== generic) {
    const split = splitRaceType(generic || '');
    type = split.race ? split.type : '';
    race = identity?.race || '';
  } else {
    const split = splitRaceType(name);
    race = split.race || identity?.race || '';
    type = split.race ? split.type : '';
  }
  const rows = [['Name', name], ['Race', race ? `${race}${identity && identity.race === race && !splitRaceType(name).race ? ` (from ${identity.source})` : ''}` : ''], ['Type', type]];
  for (const [label, text] of rows.reverse()) {
    if (!text) continue;
    const row = document.createElement('div');
    row.className = 'mob-art-id';
    row.innerHTML = '<span></span><strong></strong>';
    row.firstChild.textContent = label;
    row.lastChild.textContent = text;
    summary.prepend(row);
  }
}

// The picture the Art ID stands for, drawn with the palette and frame it names. Resolves to a canvas or null.
async function buildArtPreview(eff) {
  const aid = eff.fields.find(f => f.field === F_CURRENT_AID);
  if (!aid) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'mob-card-art-canvas';
  const critter = protoCritterAidInfo(aid.value, eff.objType);
  // maxSide 1: the loaders never shrink, and only scale up what is smaller than maxSide, so this keeps the real size.
  if (critter?.filename) {
    if (!(await loadCritterAidArt(critter, canvas, 1))) return null;
    canvas.artUrl = (await resolveCritterArt(critter))?.url || null;
    return canvas;
  }
  const resolved = await resolveProtoFileCardArts({ objType: eff.objType, fields: eff.fields });
  if (!resolved || resolved.artId === null) return null;
  const names = [resolved.currentArtName, resolved.inventoryArtName].filter(Boolean);
  const artType = protoArtObjectType(aid.value, eff.objType);
  for (const name of names) {
    if (!(await loadProtoCurrentAidArt(resolved.artId, name, canvas, artType, aid.value))) continue;
    // that loader enlarges small art to ~92 px: redraw the frame at its real size
    const frame = canvas.nativeFrame;
    if (frame) {
      canvas.width = frame.width; canvas.height = frame.height;
      canvas.style.width = canvas.style.height = '';
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(frame, 0, 0);
    }
    // the ART file it came from (a portal's name carries a trailing number; eye candy's file name is completed by the loader)
    const file = name.replace(/^.*[\/]/, '').replace(/^(.*?\.art)(?:\s+\d+)?$/i, '$1');
    canvas.artUrl = artType === 18 ? null : `${protoArtRoot(artType)}${encPath(file)}`;
    return canvas;
  }
  return null;
}

// Opens an ART file (a data/art/... url) in the ART explorer.
async function openArtUrl(url) {
  const rel = decodeURIComponent(url).slice(ART_ROOT.length);
  const cut = rel.lastIndexOf('/');
  const folder = rel.slice(0, cut), file = rel.slice(cut + 1);
  leaveDataExplorer(true);
  await openDeepLink({ folder, folderName: folder.split('/').pop() || 'art', file });
}

// parts: { summary, cardHost, actions, filename, relativePath }
export async function renderMobExtras(decoded, proto, parts) {
  const eff = effectiveMob(decoded, proto);
  const field = n => eff.fields.find(f => f.field === n);

  const aid = field(F_CURRENT_AID);
  if (aid && parts.summary) {
    const row = document.createElement('div');
    row.className = 'mob-art-id';
    row.innerHTML = '<span>Art ID</span><strong></strong>';
    row.querySelector('strong').textContent = mobCurrentAidText(aid.value, decoded.objType);
    parts.summary.prepend(row);
  }

  if (parts.summary && (decoded.objType === 15 || decoded.objType === 16)) addCreatureRows(decoded, proto, eff, parts.summary);

  // Left to right: the art of the Art ID (palette and frame, real size, centred in a 96 x 96 box), the game's info box.
  // The info box shows the portrait itself when the game would (item-card.js).
  parts.cardHost.classList.add('mob-card-row');
  const artSlot = document.createElement('div');
  artSlot.className = 'mob-card-art';
  artSlot.hidden = true;
  parts.cardHost.appendChild(artSlot);
  const artBtn = button('🖼️ Art ID', 'The ART file this object is drawn with', () => {});
  const cardBtn = button('🖼️ Info-box art', 'The picture of the info box', () => {});
  artBtn.disabled = cardBtn.disabled = true;
  artBtn.hidden = cardBtn.hidden = true;
  buildArtPreview(eff).then(c => {
    if (!c) return;
    artSlot.appendChild(c); artSlot.hidden = false;
    if (!c.artUrl) return;
    const file = decodeURIComponent(c.artUrl.split('/').pop());
    artBtn.textContent = `🖼️ Art ID · ${file}`; artBtn.title = `Open ${file} in the ART explorer`;
    artBtn.onclick = () => openArtUrl(c.artUrl);
    artBtn.disabled = artBtn.hidden = false;
  }).catch(() => {});
  cardIconSource(eff).then(src => {
    if (!src) return;
    cardBtn.textContent = `🖼️ Info-box art · ${src.file}`;
    cardBtn.title = src.kind === 'interface' ? `Open ${src.file} (art/interface) in the ART explorer` : `Open the portrait ${src.file} in a new tab`;
    cardBtn.onclick = () => (src.kind === 'interface' ? openArtUrl(src.url) : window.open(src.url, '_blank'));
    cardBtn.disabled = cardBtn.hidden = false;
  }).catch(() => {});
  buildItemCard(eff).then(card => {
    if (!card) return;
    parts.cardHost.appendChild(card);
    // the art box is as high as the info box (and as wide, so it stays square), whatever size that is shown at
    const fit = () => { const h = card.offsetHeight; if (h) parts.cardHost.style.setProperty('--card-h', `${h}px`); };
    fit();
    if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(card);
  }).catch(() => {});

  // Where this file is: the map folder.
  const { path, folderName } = mobState();

  if (proto?.entry) {
    parts.actions.appendChild(button('📄 See .pro', `Open ${proto.entry.filename} in the .PRO explorer`, () =>
      openProtoFile(proto.entry.filename, proto.entry.relPath)));
  }

  const loc = mobLocationInfo(field(F_LOCATION)?.value);
  const here = button('🗺️ See .sec', loc ? `Show the map of ${path || 'maps'} at sector ${loc.sectorX}, ${loc.sectorY} · tile ${loc.tileX}, ${loc.tileY}` : 'This object has no location', () =>
    openSecAtTile(path, folderName, loc, parts.filename));
  here.disabled = !loc;
  parts.actions.appendChild(here);
  parts.actions.append(artBtn, cardBtn);

  const scripts = scriptAttachments(decoded, proto);
  if (scripts.length) {
    const rule = document.createElement('hr');
    rule.className = 'mob-actions-rule';
    parts.actions.appendChild(rule);
  }
  for (const s of scripts) {
    const file = await scrFileForNumber(s.script_num).catch(() => null);
    const point = String(s.script_attachment || '').replace(/^SAP_/, '').replace(/_/g, ' ').toLowerCase();
    const b = button(`📜 ${file || `script ${s.script_num}`} · ${point}`, file ? `Open script ${s.script_num} (${point})` : `Script ${s.script_num} has no .scr file`, () =>
      openScrByNumber(s.script_num));
    b.disabled = !file;
    parts.actions.appendChild(b);
  }
}
