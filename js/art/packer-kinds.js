// .ART Packer: what a file is made for. Each purpose fixes the layout the game expects
// (directions, hotspot meaning) and the defaults that go with it.

import { SEC_ISO_HALF_H, SEC_ISO_HALF_W } from '../sec/sec-iso.js';

// Wall art is one picture; the game mirrors it for the edges facing the other way.
export const PACKER_EDGES = [
  { key: 'ne', label: 'NE edge (top right)', rotation: 0 },
  { key: 'se', label: 'SE edge (bottom right, mirrored)', rotation: 2 },
  { key: 'sw', label: 'SW edge (bottom left)', rotation: 4 },
  { key: 'nw', label: 'NW edge (top left, mirrored)', rotation: 6 },
];

// activities: variants of one purpose that change the header (flags, speed) and which columns
// the frame list shows. Flag 0x2 is what the game's walking critter art carries and its standing art does not.
export const PACKER_KINDS = {
  object: {
    label: 'Map object',
    blurb: 'An item, container, scenery, portal or effect seen from one side: a single picture, or an animation that plays in a loop.',
    directions: 1, guide: 'object', multiFrame: true,
    activities: { still: { label: 'Picture or animation', flags: 0, fps: 8 } },
    hotspotHelp: 'The red cross is the centre of the tile the object stands on. Put the base of the object on it.',
    hotspot: (w, h) => [w >> 1, h - 1],
    folders: 'art/item, art/scenery, art/container, art/portal, art/eye_candy',
  },
  creature: {
    label: 'Creature, NPC or 8-view object',
    blurb: 'Eight directions (0 = facing up the screen, then clockwise), the same number of frames in each. Standing, walking, attacking… each is its own file.',
    directions: 8, guide: 'object', multiFrame: true,
    activities: {
      stand: { label: 'Standing / other action', flags: 0, fps: 8 },
      walk: { label: 'Walking (moves the critter each frame)', flags: 2, fps: 17, movement: true },
    },
    hotspotHelp: 'The red cross is the centre of the tile. Put the creature\'s feet on it, the same way in every frame.',
    hotspot: (w, h) => [w >> 1, h - 1],
    folders: 'art/critter, art/monster, art/unique_npc',
  },
  wall: {
    label: 'Wall piece',
    blurb: 'One picture of a wall, drawn for the NE/SW edges; the game mirrors it for the other two.',
    directions: 1, guide: 'wall', multiFrame: false,
    activities: { still: { label: 'Wall', flags: 0, fps: 8 } },
    hotspotHelp: 'The red cross is where the game anchors the wall: the wall must run along the highlighted tile edge.',
    // Same relation as the game\'s walls: the last column, a little above the bottom of the picture.
    hotspot: (w, h) => [Math.max(0, w - 1), Math.max(0, h - 29)],
    folders: 'art/wall',
  },
  tile: {
    label: 'Floor tile',
    blurb: 'A flat diamond that fills one tile, 78 × 40 px; pixels outside the diamond are transparent.',
    directions: 1, guide: 'tile', multiFrame: false, size: [78, 40],
    activities: { still: { label: 'Tile', flags: 0, fps: 8 } },
    hotspotHelp: 'Floor tiles are placed by the game itself, so the game\'s own value is used. The tile should fit the grey diamond.',
    hotspot: (w, h) => [w >> 1, h - 1],
    folders: 'art/tile',
  },
  ui: {
    label: 'Interface or inventory image',
    blurb: 'A picture or animation that is not placed on the map: icons, buttons, portraits.',
    directions: 1, guide: 'none', multiFrame: true,
    activities: { still: { label: 'Picture or animation', flags: 0, fps: 8 } },
    hotspotHelp: 'The hotspot of these pictures does not matter on the map; the top-left corner is the usual choice.',
    hotspot: () => [0, 0],
    folders: 'art/interface',
  },
};

const ROT_STEP = [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1]];

// A walking critter moves one tile per walk cycle; the art says how far each frame carries it, in
// screen pixels. Direction d is facing rotation d, so the cycle covers that rotation's tile step
// (location_rot), split over the frames so that the pieces add up exactly.
export function walkStride(direction, framesPerDirection) {
  const [tx, ty] = ROT_STEP[direction & 7];
  const sx = (ty - tx) * SEC_ISO_HALF_W, sy = (tx + ty) * SEC_ISO_HALF_H;
  const out = [];
  let px = 0, py = 0;
  for (let i = 0; i < framesPerDirection; i++) {
    const nx = Math.round(sx * (i + 1) / framesPerDirection), ny = Math.round(sy * (i + 1) / framesPerDirection);
    out.push({ x: nx - px, y: ny - py });
    px = nx; py = ny;
  }
  return out;
}
