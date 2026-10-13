// TIG art ids: the art type lives in the top nibble (bits 28-31); the rest of
// the layout depends on the type and is decoded by the module that owns it.

export const ART_TYPE = {
  TILE: 0,
  WALL: 1,
  CRITTER: 2,
  PORTAL: 3,
  SCENERY: 4,
  ITEM: 6,
  CONTAINER: 7,
  ROOF: 10,
  FACADE: 11,
  MONSTER: 0xC,
  UNIQUE_NPC: 0xD,
  EYE_CANDY: 0xE,
};

export const ART_ID_INVALID = 0xFFFFFFFF; // TIG_ART_ID_INVALID: "no art"

export const artType = raw => (Number(raw) >>> 28) & 0xF;
