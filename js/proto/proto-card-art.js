// Art icon for .PRO file cards.

import {
  loadCritterAidArt,
  loadProtoCurrentAidArt,
  protoArtObjectType,
  protoCritterAidInfo,
  protoCurrentAidArtId,
} from './critter-aid.js';

import { decodeProtoForSearch } from './proto-decoder.js';

import { ensureProtoArtMesLoaded } from './proto-mes.js';

export async function applyProtoCurrentArtToFileCard(card, filename, relativePath = '') {
  if (!card?._iconThumb) return;
  try {
    const decoded = await decodeProtoForSearch(filename, relativePath);
    const aidField = decoded.fields.find(f => f.field === 1);
    const critterInfo = protoCritterAidInfo(aidField ? aidField.value : null, decoded.objType);
    if (critterInfo && critterInfo.filename) {
      const critterCanvas = document.createElement('canvas');
      critterCanvas.className = 'proto-file-art-icon';
      critterCanvas.width = 48;
      critterCanvas.height = 48;
      card._iconThumb.replaceChildren(critterCanvas);
      if (!(await loadCritterAidArt(critterInfo, critterCanvas, 48))) card._iconThumb.innerHTML = '<span class="folder-glyph">🧬</span>';
      return;
    }
    const resolved = await resolveProtoFileCardArts(decoded);
    if (!resolved || resolved.artId === null) return;
    const candidates = [resolved.inventoryArtName, resolved.currentArtName]
      .filter((name, index, names) => name && names.findIndex(item => item?.toLowerCase() === name.toLowerCase()) === index);
    if (!candidates.length) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'proto-file-art-icon';
    canvas.width = 48;
    canvas.height = 48;
    card._iconThumb.replaceChildren(canvas);
    for (const artName of candidates) {
      if (await loadProtoCurrentAidArt(resolved.artId, artName, canvas, protoArtObjectType(aidField?.value, decoded.objType), aidField?.value)) return;
    }
    card._iconThumb.innerHTML = '<span class="folder-glyph">🧬</span>';
  } catch (_) {
    // Keep the normal prototype icon when the prototype or its art cannot be resolved.
  }
}

export async function resolveProtoFileCardArts(decoded) {
  const field = decoded.fields.find(f => f.field === 1);
  if (!field) return null;
  const artId = protoCurrentAidArtId(field.value, decoded.objType);
  if (artId === null) return { artId, inventoryArtName: null, currentArtName: null };

  let inventoryArtName = null;
  let currentArtName = null;
  if (decoded.objType !== 1 && decoded.objType !== 2 && decoded.objType !== 3) {
    try {
      const inventoryMap = await ensureProtoArtMesLoaded(decoded.objType, 0);
      inventoryArtName = inventoryMap.get(artId) ?? null;
    } catch (_) {}
  }
  try {
    const currentMap = await ensureProtoArtMesLoaded(protoArtObjectType(field.value, decoded.objType), 1);
    currentArtName = currentMap.get(artId) ?? null;
  } catch (_) {}
  return { artId, inventoryArtName, currentArtName };
}
