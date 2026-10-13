// .mes name tables and art folders for prototypes.

import { DATA_ROOT, PORTAL_ART_ROOT } from '../core/config.js';
import { memoAsync, mesTable } from '../core/text-io.js';

// Arcanum's .mes files are brace-delimited number -> string tables.
// F_DESCRIPTION stores the numeric key into text/mes/description.mes.
const DESCRIPTION_MES_URL = `${DATA_ROOT}mes/description.mes`;
const ITEM_INVEN_MES_URL = `${DATA_ROOT}art/item/item_inven.mes`;
const ITEM_GROUND_MES_URL = `${DATA_ROOT}art/item/item_ground.mes`;
const ITEM_PAPER_MES_URL = `${DATA_ROOT}art/item/item_paper.mes`;
const ITEM_ART_ROOT = `${DATA_ROOT}art/item/`;
// Containers use a completely separate name table and art folder from items
// (see game/name.c's TIG_ART_TYPE_CONTAINER case) -- a container's art id is
// NOT an item id and must never be looked up in item_inven.mes.
const CONTAINER_MES_URL = `${DATA_ROOT}art/container/container.mes`;
const CONTAINER_ART_ROOT = `${DATA_ROOT}art/container/`;
// Portals use their own MES table and ART folder. Windows are stored in
// portal.mes at key (portal number + 1001), as implemented by a_name.c.
const PORTAL_MES_URL = `${DATA_ROOT}art/portal/portal.mes`;

const SCENERY_MES_URL = `${DATA_ROOT}art/scenery/scenery.mes`;
const SCENERY_ART_ROOT = `${DATA_ROOT}art/scenery/`;
// Eye-Candy ARTs are a separate TIG ART type. Trap prototypes store an
// eye-candy AID with type=2 (UNDERLAY), which the game names as <name>_U.art.
const EYE_CANDY_MES_URL = `${DATA_ROOT}art/eye_candy/eye_candy.mes`;
const EYE_CANDY_ART_ROOT = `${DATA_ROOT}art/eye_candy/`;

export const PROTO_ART_TYPE_EYE_CANDY = 18;

// Keys from 30000 up live in the module's own mes/gamedesc.mes (game/description.c: description_get): the
// names of the special NPCs and items, e.g. 30037 = Gilbert Bates. One table holds both.
const GAME_DESCRIPTION_MES_URL = `${DATA_ROOT}mes/gamedesc.mes`;
const descriptionTable = memoAsync(async () => {
  const map = new Map(await mesTable(DESCRIPTION_MES_URL)());
  try { for (const [k, v] of await mesTable(GAME_DESCRIPTION_MES_URL)()) if (k >= 30000) map.set(k, v); }
  catch (_) { /* no module descriptions */ }
  return map;
});

const tables = {
  description: descriptionTable,
  itemInven: mesTable(ITEM_INVEN_MES_URL),
  itemGround: mesTable(ITEM_GROUND_MES_URL),
  itemPaper: mesTable(ITEM_PAPER_MES_URL),
  container: mesTable(CONTAINER_MES_URL),
  portal: mesTable(PORTAL_MES_URL),
  scenery: mesTable(SCENERY_MES_URL),
  eyeCandy: mesTable(EYE_CANDY_MES_URL),
};

export const loadDescriptionMes = tables.description;
export const loadItemInvenMes = tables.itemInven;
export const loadItemGroundMes = tables.itemGround;
export const loadItemPaperMes = tables.itemPaper;
export const loadContainerMes = tables.container;
export const loadPortalMes = tables.portal;
export const loadSceneryMes = tables.scenery;

export function protoDescriptionInfo(value) {
  const id = Number(value);
  if (!Number.isFinite(id)) return null;
  const map = tables.description.peek();
  if (!map) return { id, text: null, loading: true };
  return { id, text: map.get(id) ?? null, loading: false };
}

// "Gilbert Bates (30037)" for an F_DESCRIPTION value once the table is loaded, else null.
export function descriptionLabel(value) {
  const info = protoDescriptionInfo(value);
  return info && info.text !== null ? `${info.text} (${info.id})` : null;
}

// Which name table and art folder apply to a given object type. Containers are
// their own TIG art category (see game/name.c) and must never share the item
// lookup -- this is the single place that decides, so every caller (the PRO
// viewer, the map, file-card thumbnails) agrees.
const ITEM_PAPER_FIELDS = new Set([95, 113, 151]);
function protoArtKind(objectType, fieldNumber) {
  if (objectType === 1) return { table: tables.portal, root: PORTAL_ART_ROOT };
  if (objectType === PROTO_ART_TYPE_EYE_CANDY) return { table: tables.eyeCandy, root: EYE_CANDY_ART_ROOT };
  if (objectType === 2) return { table: tables.container, root: CONTAINER_ART_ROOT };
  if (objectType === 3) return { table: tables.scenery, root: SCENERY_ART_ROOT };
  if (ITEM_PAPER_FIELDS.has(fieldNumber)) return { table: tables.itemPaper, root: ITEM_ART_ROOT };
  if (fieldNumber === 1) return { table: tables.itemGround, root: ITEM_ART_ROOT };
  return { table: tables.itemInven, root: ITEM_ART_ROOT };
}
export const protoArtMesMap = (objectType, fieldNumber) => protoArtKind(objectType, fieldNumber).table.peek();
export const protoArtRoot = objectType => protoArtKind(objectType).root;
export const ensureProtoArtMesLoaded = (objectType, fieldNumber) => protoArtKind(objectType, fieldNumber).table();
