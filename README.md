# Arcanum Art Extractor

A browser tool for the files of *Arcanum: Of Steamworks and Magick Obscura*, in three parts that share one page:

- **Atlas** – the world of Arcanum as a map you can zoom into: every town, dungeon and module, its people, containers, items, quests, dialogs, signs, areas and routes, with the game's own music. Mods (Arcanum CE Restored, Carcanum, Forgotten Places, Russian mod, Terra Incognita, ReBulid) are shown as a version of the same Atlas.
- **Files** (the Asset Browser) – opens the game's own formats: `.ART` (with a packer to make new ones), `.PRO`, `.MOB`, `.SEC` maps, `.DLG`, `.MES`, `.SCR`, with decoders, hex view and search.
- **Workshop** – the map editor (`.sec`, `.mob`, map info export), plus the tools for NPCs, containers, ground items, dialogs and quests, and the placeholder-house generator.

## Run it

1. Install Python 3 (no packages needed to browse).
2. Put the game's files under `data/` (see below).
3. Double-click `start.bat`. It starts a local server (`toolbox/serve.py`) and opens the browser. Close its window to stop.

Views: `index.html` (Atlas), `index.html?view=browser` (Files / Workshop). Add `&perf` for a frame-time readout.
Links to a place on the map look like `#m=<map>.<x>.<y>.<zoom>.<options>.<panel>` (base 36).

## Folders

| Folder | What is in it |
| --- | --- |
| `data/` | The game's files (art, maps, protos, scripts, dialogs, text, sound), mods under `data/mods/`, modules under `data/modules/`. The Atlas reads these directly; never copy them elsewhere. |
| `atlas/` | Pictures the Atlas draws (sector pictures, glows, library, per-mod folders). Generated. |
| `js/` | The application, see [js/README.md](js/README.md). `js/atlas/data/` is generated. |
| `tests/` | Browser checks, see below. |
| `translator/` | Translation helper and its data. |
| `vendor/` | Third-party libraries and fonts (so the page works offline). |
| `toolbox/` | Python generators (not in git): the Atlas pipeline in `toolbox/atlas/`, file indexes, schema generators. |
| `.claude/skills/` | Procedures for Claude Code: run-tests, post-build, add-version, check-in-browser. |

## Tests

```
pip install playwright
playwright install chromium
python tests/run_tests.py
```

Runs the real `js/` modules in headless Chromium: the pages load without errors, the Atlas switches version without a reload, an untouched `.sec` is written back byte for byte, an edited tile changes only that tile, and sample `.mob` / `.scr` / `.art` files decode completely. `python tests/run_tests.py sec` runs a subset.

## Rules that keep the data sound

- **A mod is the base game plus every layer of the mod.** Build a version with `toolbox/atlas/run_mod.py <key>` (or `run_version.py` for the data files alone).
- **Generated files say so.** The first line of each file in `js/atlas/data/` names its generator; re-run it instead of editing by hand.
- **Store every sector once.** After a build, new `.sec` files are checked against the hash list and copies move to `data/temp` (never read by the app) with an alias entry (`dedupe_sectors.py`). Pictures are `.atlassec` / `.atlasmob` files plus art shards shared through `atlas/world` and `atlas/graphics/art-shards`.
- **`.sec` exports must match the engine.** Absolute locations, the engine's object order and the wall mirror bits matter; the round-trip test guards this.
- **Mind the disk.** Long jobs refuse to start under 5 GB free (`toolbox/atlas/disk_guard.py`, `ARCANUM_MIN_FREE_GB` to change); `py disk_guard.py --purge all` empties the scratch folders.
- **Look in the browser before and after a visual change.**

## Licence

See [LICENSE](LICENSE). Game files remain the property of their owners and are not part of this repository's licence.
