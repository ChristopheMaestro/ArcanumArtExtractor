"""
The pictures the game shows for a person or a container, in one sheet: atlas/portraits.png + js/atlas/data/portraits.js.

  * portraits: data/portrait/gameport.mes numbers (1000 and up) -> data/portrait/<name>.bmp, 64 x 64. An NPC's number is
    its field 231 (OBJ_F_CRITTER_PORTRAIT); build_npcs.py / build_submaps.py put it in their rows. Only the portraits named
    NPC* are kept: the game shows the others for the player and their followers only (js/proto/item-card.js), so anyone
    else gets the icon of their race.
  * icons: what the game shows when it examines something without a portrait (ui/intgame.c intgame_examine_portrait):
    undead / monster / animal / mechanical, else the icon of the race; a container shows the picture of its kind, picked
    by its basic prototype (proto - 20: junk pile, safe, rubbish bin, body, the three altars, plant; build_items.py writes it
    as the container's kind), else a chest.
  * the pictures of the filter buttons under the world map (FILTER_ICONS).
    Numbers are art/interface/interface.mes entries.
Re-run rather than edit:  py build_portraits.py
"""
import json
import re
import sys

from PIL import Image

import arcanum_objects as ao

DATA_JS = ao.PROJECT / 'js' / 'atlas' / 'data'
OUT_PNG = ao.PROJECT / 'atlas' / 'portraits.png'
OUT_JS = DATA_JS / 'portraits.js'
CELL = 64

# intgame.c: intgame_race_icons (race stat order of build_demographics.RACES), then the critter kinds
RACE_ICONS = [375, 378, 376, 377, 379, 380, 381, 382, 376, 382, 381]
KIND_ICONS = {'undead': 384, 'monster': 383, 'animal': 385, 'mechanical': 434}
# kind of container (build_items.BOX_KINDS, from the basic prototype) -> interface art
CONTAINER_ICONS = {'junk': 832, 'safe': 834, 'bin': 835, 'body': 833, 'altar-good': 837, 'altar-neutral': 838, 'altar-evil': 839,
                   'plant': 836}
CHEST_ICON = 435
COMBAT_ICON = 799                                  # CombatIcon.ART: the random encounters of the world map
# the filter buttons under the world map (world-atlas.html data-icon) -> interface art
FILTER_ICONS = {'chest': 435, 'people': 375, 'creature': 385, 'off': 601, 'way': 436, 'item': 832, 'sign': 443,
                'enc': 799, 'check': 823}      # chest, human, paw, pocket watch, door, junk pile, question mark, combat, tick


def main():
    names = ao.mes(ao.DATA / 'portrait' / 'gameport.mes')
    interface = ao.mes(ao.DATA / 'art' / 'interface' / 'interface.mes')
    pics = []                                      # (key, PIL image)
    for num, name in sorted(names.items()):
        if not re.match(r'NPC', name.strip(), re.I):       # as the game's info box: the other portraits are for the player and followers
            continue
        p =ao.DATA / 'portrait' / (name.strip() + '.bmp')
        if p.exists():
            pics.append((str(num), Image.open(p).convert('RGBA')))
    nport = len(pics)
    for num in sorted(set(RACE_ICONS) | set(KIND_ICONS.values()) | set(CONTAINER_ICONS.values()) | set(FILTER_ICONS.values())
                      | {CHEST_ICON, COMBAT_ICON}):
        fn = (interface.get(num) or '').split('//')[0].strip()
        path = next((q for q in (ao.DATA / 'art' / 'interface').glob('*') if q.name.lower() == fn.lower()), None)
        fr = ao.art_first_frame(path) if path else None
        if fr:
            w, h, rgba = fr
            pics.append(('i' + str(num), Image.frombytes('RGBA', (w, h), rgba)))
        else:
            print('  missing interface art', num, fn)

    cols = 16
    sheet = Image.new('RGBA', (cols * CELL, (len(pics) + cols - 1) // cols * CELL), (0, 0, 0, 0))
    at, box = {}, {}
    for k, (key, im) in enumerate(pics):
        if im.width > CELL or im.height > CELL:
            im.thumbnail((CELL, CELL), Image.NEAREST)
        x, y = k % cols * CELL, k // cols * CELL
        px, py = x + (CELL - im.width) // 2, y + (CELL - im.height) // 2
        sheet.paste(im, (px, py))
        at[key] = [x, y]
        box[key] = [px, py, im.width, im.height]
    sheet.quantize(256, method=Image.Quantize.FASTOCTREE).save(OUT_PNG, optimize=True)     # the pictures are 256-colour art

    data = {'source': 'toolbox/atlas/build_portraits.py', 'sheet': 'atlas/portraits.png', 'cell': CELL, 'size': list(sheet.size),
            'note': 'at[n] = [x, y] in the sheet: n = portrait number (NPC field 231), "i<n>" = interface art n. '
                    'raceIcons[race], kindIcons[kind name], containerIcons[container kind of items.js] give the icon key. '
                    'filterIcons[button] = [x, y, w, h]: the picture itself (not its cell) of a world-map filter button.',
            'at': at,
            'raceIcons': ['i%d' % n for n in RACE_ICONS],
            'kindIcons': {k: 'i%d' % n for k, n in KIND_ICONS.items()},
            'containerIcons': {k: 'i%d' % n for k, n in CONTAINER_ICONS.items()},
            'chestIcon': 'i%d' % CHEST_ICON, 'combatIcon': 'i%d' % COMBAT_ICON,
            'filterIcons': {k: box['i%d' % n] for k, n in FILTER_ICONS.items() if 'i%d' % n in box}}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_portraits.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumPortraits = ' + json.dumps(data, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'Wrote {OUT_PNG.name} ({OUT_PNG.stat().st_size // 1024} KB, {nport} portraits + {len(pics) - nport} icons) and {OUT_JS.name}')


if __name__ == '__main__':
    sys.exit(main())
