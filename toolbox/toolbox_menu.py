#!/usr/bin/env python3
"""Command-line menu for the scripts in toolbox/. Started by toolbox.bat."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

TOOLBOX = Path(__file__).resolve().parent
ROOT = TOOLBOX.parent
WIDTH = 78

# ---- terminal: colours and box drawing --------------------------------------------------------------
os.system('')                       # switches the Windows console to ANSI escape handling
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding='utf-8')
    except Exception:
        pass
USE_COLOR = sys.stdout.isatty() and 'NO_COLOR' not in os.environ


def c(code: str, text: str) -> str:
    return f'\033[{code}m{text}\033[0m' if USE_COLOR else text


gold = lambda t: c('38;5;179', t)
dim = lambda t: c('38;5;245', t)
green = lambda t: c('38;5;114', t)
red = lambda t: c('38;5;167', t)
bold = lambda t: c('1', t)
blue = lambda t: c('38;5;110', t)


def visible_len(s: str) -> int:
    n, skip = 0, False
    for ch in s:
        if ch == '\033':
            skip = True
        elif skip:
            skip = ch != 'm'
        else:
            n += 1
    return n


def row(text: str = '') -> str:
    return gold('│') + ' ' + text + ' ' * max(0, WIDTH - 4 - visible_len(text)) + ' ' + gold('│')


def rule(left: str, right: str, fill: str = '─') -> str:
    return gold(left + fill * (WIDTH - 2) + right)


def clear():
    os.system('cls' if os.name == 'nt' else 'clear')


def ask(prompt: str) -> str:
    try:
        return input(prompt).strip().lstrip('﻿')
    except (EOFError, KeyboardInterrupt):
        print()
        return 'q'


# ---- tools --------------------------------------------------------------------------------------------
def has(*modules: str) -> list[str]:
    """The modules out of `modules` that are not installed."""
    return [m for m in modules if importlib.util.find_spec(m) is None]


def choose(question: str, options: list[tuple[str, str]], default: str) -> str:
    """Single-key style question: options = [(key, label)], returns the chosen key."""
    shown = '  '.join((bold(gold(k.upper())) if k == default else gold(k.upper())) + dim(' ' + label) for k, label in options)
    while True:
        a = ask(f'  {question}  {shown}  {dim("[Enter = " + default.upper() + "]")} ').lower()
        if not a:
            return default
        if a in ('q', 'quit'):
            return 'q'
        for k, _ in options:
            if a == k:
                return k


def args_sector_maps():
    scope = choose('Which map folders?', [('a', 'all'), ('s', 'pick from a list')], 'a')
    if scope == 'q':
        return None
    roofs = choose('Roofs?', [('o', 'off (interiors visible)'), ('n', 'on'), ('b', 'both')], 'o')
    if roofs == 'q':
        return None
    args = ['--roofs', {'o': 'off', 'n': 'on', 'b': 'both'}[roofs]]
    if scope == 'a':
        args += ['--folders', 'all']
    return args


def args_validate_sec():
    exports = sorted((Path.home() / 'Downloads').glob('*_sec.zip'), key=lambda p: p.stat().st_mtime, reverse=True)
    default = str(exports[0]) if exports else ''
    hint = f' {dim("[Enter = " + exports[0].name + "]")}' if exports else ''
    a = ask(f'  .sec file, folder or exported .zip?{hint} ').strip('"')
    if a == 'q' or not (a or default):
        return None
    return [a or default]


def args_confirm(question):
    def inner():
        return [] if choose(question, [('y', 'yes'), ('n', 'no')], 'y') == 'y' else None
    return inner


TOOLS = [
    {
        'name': 'Export sector maps',
        'tagline': 'every .sec of a map folder as a transparent PNG, with objects',
        'detail': ['One PNG per sector in export/maps/<map>/. Draws tiles, walls, scenery, containers, critters',
                   'and (optionally) roofs, like the asset browser does.'],
        'script': 'export_sec_maps.py', 'needs': ['playwright'], 'ask': args_sector_maps,
    },
    {
        'name': 'Build file indexes',
        'tagline': 'data/file_index_<ext>.json: the folder trees the Files tool reads',
        'detail': ['Rescans data/ and rewrites one file_index_<ext>.json per kind of file (art, pro, sec, mob, dlg, mes,',
                   'scr, bmp). Run it after adding, renaming or removing files in data/.'],
        'script': 'file_index.py', 'needs': [], 'ask': args_confirm('Rewrite the file indexes under data/?'),
    },
    {
        'name': 'Build .ART thumbnail sheets',
        'tagline': 'js/art/art-thumbs/: the .ART grid\'s thumbnails, one picture per page of 50',
        'detail': ['Draws every .art file\'s thumbnail with the viewer\'s own code (a headless browser) into sheets, so',
                   'the online grid loads one picture per page instead of 50 .art files. Takes a few minutes.',
                   'Run it after adding, renaming, removing or changing .art files (after file_index.py).'],
        'script': 'build_art_thumbs.py', 'needs': ['playwright', 'PIL'], 'ask': args_confirm('Rewrite js/art/art-thumbs/?'),
    },
    {
        'name': 'Check exported .sec files',
        'tagline': 'will the game load them? (locations, object order, wall ids, ...)',
        'detail': ['Reads .sec files, a folder or an exported *_sec.zip the way the game does and lists what it would',
                   'trip over: objects or lights outside their sector, objects out of the engine\'s order, wall and',
                   'portal ids whose mirror bits disagree with the rotation, unknown prototypes, broken sections.'],
        'script': 'validate_sec.py', 'needs': [], 'ask': args_validate_sec,
    },
    {
        'name': 'Index how the game places objects',
        'tagline': 'js/editor/sec-game-protos.js: the prototype and flags of each wall, door, window, scenery art',
        'detail': ['Reads every shipped sector. The editor places a new object with the prototype and the fields (blocking,',
                   'no auto-animate, jammed window, light...) the game\'s own objects of that art have. Only needed when',
                   'the maps change.'],
        'script': 'extract_game_protos.py', 'needs': [], 'ask': args_confirm('Rewrite js/editor/sec-game-protos.js?'),
    },
    {
        'name': 'List MOB art ids',
        'tagline': 'every .mob and its resolved art (prototype included) as a CSV',
        'detail': ['Reads data/maps and data/proto and writes toolbox/extract.csv.'],
        'script': 'extract_mob_prototypes.py', 'needs': [], 'ask': args_confirm('Write toolbox/extract.csv now?'),
    },
    {
        'name': 'Regenerate the SCR schema',
        'tagline': 'js/scr/scr-schema.js, generated from the game sources',
        'detail': ['Reads "toolbox/Arcanum CE sources/game/script.{h,c}". Only needed when those change.'],
        'script': 'gen_scr_schema.py', 'needs': [], 'ask': args_confirm('Regenerate js/scr/scr-schema.js?'),
    },
    {
        'name': 'Index the global flags',
        'tagline': 'data/scr/global_flags.json: who sets, clears and tests each flag',
        'detail': ['Scans data/scr, data/dlg, WMap_Rnd.mes and MainMenu.mes. The .SCR viewer uses it to explain',
                   'global flags. Run it after changing scripts or dialogues.'],
        'script': 'gen_global_flags.py', 'needs': [], 'ask': args_confirm('Rewrite data/scr/global_flags.json?'),
    },
    {
        'name': 'Index the local flags',
        'tagline': 'data/scr/local_flags.json: where each script is attached, what starts its flags',
        'detail': ['Reads every .mob, .pro and .sec with the viewer\'s own decoders (a headless browser) to find where',
                   'each script is attached and which attachments start with local flags set, plus the scripts that',
                   'turn into others. Takes ~2-3 minutes. Run it after changing objects or scripts.'],
        'script': 'gen_local_flags.py', 'needs': ['playwright'], 'ask': args_confirm('Rewrite data/scr/local_flags.json?'),
    },
]


# ---- screens ------------------------------------------------------------------------------------------
def banner():
    print(rule('┌', '┐'))
    print(row())
    print(row(bold(gold('A R C A N U M   A R T   E X T R A C T O R')).center(WIDTH - 4 + (len(bold(gold(''))) if USE_COLOR else 0))))
    print(row(dim('T O O L B O X').center(WIDTH - 4 + (len(dim('')) if USE_COLOR else 0))))
    print(row())
    print(rule('├', '┤'))


def main_menu() -> str:
    clear()
    banner()
    print(row())
    for i, tool in enumerate(TOOLS, 1):
        missing = has(*tool['needs'])
        badge = red('  ✗ needs ' + ', '.join(missing)) if missing else ''
        print(row(f'{bold(gold(f"[{i}]"))} {bold(tool["name"])}{badge}'))
        print(row(f'    {dim(tool["tagline"])}'))
        print(row())
    print(rule('├', '┤'))
    print(row(f'{bold(gold("[Q]"))} Quit' + dim(f'          project: {ROOT.name}')))
    print(rule('└', '┘'))
    print()
    return ask(gold('  Choose a tool ▸ ')).lower()


def run_tool(tool: dict):
    clear()
    banner()
    print(row())
    print(row(bold(tool['name'])))
    for line in tool['detail']:
        print(row(dim(line)))
    print(row())
    print(rule('└', '┘'))
    print()
    missing = has(*tool['needs'])
    if missing:
        pip = {'PIL': 'pillow'}
        pkgs = ' '.join(pip.get(m, m) for m in missing)
        print(red(f'  Missing Python package(s): {", ".join(missing)}'))
        print(f'  Install with:  {gold("pip install " + pkgs)}')
        if 'playwright' in missing:
            print(f'  then:          {gold("playwright install chromium")}')
        print()
        ask(dim('  Press Enter to go back '))
        return
    args = tool['ask']()
    if args is None:
        return
    print()
    print(dim('  ' + '─' * (WIDTH - 4)))
    cmd = [sys.executable, str(TOOLBOX / tool['script']), *args]
    print(dim('  $ ' + ' '.join(Path(p).name if i == 1 else p for i, p in enumerate(cmd[1:], 1))))
    print()
    try:
        code = subprocess.run(cmd, cwd=ROOT).returncode
    except KeyboardInterrupt:
        code = 130
        print()
    print()
    print(dim('  ' + '─' * (WIDTH - 4)))
    print('  ' + (green('✓ Finished.') if code == 0 else red(f'✗ Stopped with exit code {code}.')))
    print()
    ask(dim('  Press Enter to return to the menu '))


def main():
    while True:
        a = main_menu()
        if a in ('q', 'quit', 'exit'):
            clear()
            return 0
        if a.isdigit() and 1 <= int(a) <= len(TOOLS):
            run_tool(TOOLS[int(a) - 1])


if __name__ == '__main__':
    raise SystemExit(main())
