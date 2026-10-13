// Whole-folder SEC map viewer (renderSecFolderMap) and its editor.

import { ART_TYPE, artType } from '../core/art-id.js';
import { errText, mesTable } from '../core/text-io.js';
import { exportCanvasPng } from '../art/art-export.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { DATA_ROOT, SEC_ROOT } from '../core/config.js';
import { breadcrumbEl } from '../core/dom.js';
import { encPath } from '../core/util.js';
import { mobObjectTypeName } from '../mob/mob-schema.js';
import { aidRotation } from '../objects/art-frames.js';
import { loadMobMapArtShared } from '../objects/map-art-loader.js';
import { loadCritterMapArt, resolveCritterArt } from '../objects/critter-art.js';
import {
  decodeWallArtId,
  loadWallArtFromRaw,
  loadWallNameTable,
  loadWallStructureTable,
  WALL_PIECES,
} from '../objects/wall-art.js';
import { protoArtObjectType, protoCritterAidInfo, protoCurrentAidArtId } from '../proto/critter-aid.js';
import { loadPortalMes, loadSceneryMes } from '../proto/proto-mes.js';
import { mobOidTypeAndNumber } from '../proto/proto-resolution.js';
import { secManifest } from '../sec/sec-explorer.js';
import { drawSecFolderMap, secFolderLegendEntries } from '../sec/sec-folder-map.js';
import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, secIsoMetrics, secIsoProject, secIsoUnproject } from '../sec/sec-iso.js';
import { SEC_FACADE_GROUPS } from './sec-facade-groups.js';
import { SEC_FACADE_LAYOUTS } from './sec-facade-layouts.js';
import { ensureSecLightArt, loadMapLighting } from '../sec/sec-lighting.js';
import { planHouse, houseFloorTile, roofTakesShapes, roofForWallStyle, HOUSE_STYLES, HOUSE_KIND_LIST, styleForKind } from './sec-house-plan.js';
import { drawSecMobOverlay, secObjectAnim, secToggleAction } from '../sec/sec-mob-overlay.js';
import { buildSecNav } from '../sec/sec-nav.js';
import { PATH_CELL, PATH_TIME_LIMIT_MS, planVillagePaths } from './sec-village-paths.js';

const PATH_MAX_CELLS = 1500 * 1500;   // the area searched for paths (doors' bounding box + margin)
import { secIsDay } from '../sec/sec-npc-motion.js';
import { loadMobsForSecMap, loadSecStaticObjectPoints } from '../sec/sec-object-points.js';
import { SEC_TERRAIN_MAX_CELLS, secDetectBlankSectors, secSectorKey, secSectorLabel, secSectorsInView, secVisibleSectorRange } from '../sec/sec-placeholders.js';
import { loadGameAreas, secretAreaName } from '../sec/sec-locations.js';
import { loadLightSchemeNames, loadMapData, loadMapList, loadTownMapNames } from '../sec/sec-map-data.js';
import { attachView } from '../explorer/nav-history.js';
import { editorRequested, saveDataExplorerState, setEditorFlag } from '../explorer/state-store.js';
import { loadTerrainMap, loadTerrainSector } from '../sec/sec-terrain.js';
import { loadSecRoofNames, loadSecRoofsForSectors, secRoofNum } from '../sec/sec-roofs.js';
import {
  loadSecFacadeArt,
  loadSecFacadeNames,
  loadSecTileArt,
  loadSecTileManifest,
  loadSecTileNameMes,
  secFacadeFrame,
  secFacadeNumber,
  secFacadeWalkable,
  secSectorAllZero,
  secTileArtFilename,
  secTileColor,
  secTileInfo,
  secTileNameMesMap,
} from '../sec/sec-tile-art.js';
import { drawSecWallOverlay, secEdgeRotation, secWallPlacementNote } from '../sec/sec-walls.js';
import {
  SEC_FACADE_FIELD_MASK,
  SEC_MOB_KINDS,
  secAidWithRotation,
  secBuildMobObject,
  secBuildSectorBytes,
  secBuildStaticObject,
  secGameProto,
  secGameProtoForKey,
  secObjectAt,
  secEdgeKey,
  secEnsureObjectBytes,
  secEnsureRoofs,
  secFacadeFile,
  secMakeFacadeRaw,
  secIsRoofId,
  secEnsureLights,
  secLightsDiffer,
  secLoadProtoOrderFields,
  secObjectListDiffers,
  secProtoCatalog,
  secRoofsDiffer,
  secStartProtoScan,
  secWallAid,
} from './sec-writer.js';
import { buildOwnerInventory } from '../sec/sec-inventory.js';
import { createMobEditPanel } from './mob-edit-panel.js';
import { createExtraTools } from './sec-extra-tools.js';
import { secExtrasDiffer } from './sec-sector-extras.js';
import { createDialogPanel, createQuestPanel } from './story-panel.js';
import { dialogStem, storyFileCount, storyFiles } from './story-data.js';
import { addContextTool, editorSlot, layoutSettled, toolRail } from '../ui/shell.js';

// Interface art number -> file (art/interface/interface.mes): the editor's map-data markers.
const interfaceArtNames = mesTable(`${DATA_ROOT}art/interface/interface.mes`);

// `focusFilename` fits the view to one sector (an opened .sec); the map and
// the editor are always those of the whole folder.
// opts.virtual: a new world that exists only in memory (see the world editor dialog): its sectors are
// all exported, as no .sec file exists for any of them yet; opts.startEditing opens the editor at once.
export async function renderSecFolderMap(relativePath, folderName, sectors, focusFilename = null, opts = {}) {
  const valid = sectors.filter(s => s.decoded && s.position);
  if (!valid.length) return null;
  // The sectors that exist (what the view fits and the PNG export frames)...
  const content = {
    minX: Math.min(...valid.map(s => s.position.x)), maxX: Math.max(...valid.map(s => s.position.x)),
    minY: Math.min(...valid.map(s => s.position.y)), maxY: Math.max(...valid.map(s => s.position.y)),
  };
  // ...and the map itself, as the game sizes it: map.prp's width and height (map_open()), from sector
  // 0, 0. A town or secret-area sub-folder uses its world map's. Widened if a sector lies outside.
  // (a copy: the Map tool edits it, and the loaded one is shared by every view of this map)
  let mapData = await loadMapData(relativePath).catch(() => null);
  mapData = mapData ? { ...mapData, start: mapData.start && { ...mapData.start }, jumps: mapData.jumps.map(j => ({ ...j, dst: { ...j.dst } })), blockedSectors: new Set(mapData.blockedSectors) }
    : { folder: String(relativePath || '').split('/')[0], limits: null, start: null, jumps: [], blockedSectors: new Set() };
  const lim = mapData?.limits;
  const minX = lim ? Math.min(0, content.minX) : content.minX, maxX = lim ? Math.max(lim.sectorsX - 1, content.maxX) : content.maxX;
  const minY = lim ? Math.min(0, content.minY) : content.minY, maxY = lim ? Math.max(lim.sectorsY - 1, content.maxY) : content.maxY;
  const bounds = { minX, maxX, minY, maxY };
  await loadSecTileNameMes();
  // MOBs are deliberately lazy-loaded. Loading every MOB while opening a
  // large SEC map is expensive, and at the initial overview zoom they are
  // not useful. They are loaded only once the map reaches 60% zoom.
  let mobPoints = [];
  let mobDiagnostics = null;
  let mobLoadStarted = false;
  let mobLoadPromise = null;
  const staticCovered = new Set();   // sectors whose static objects the bulk load above included
  // Terrain sectors sharing a template have the same objects, only moved: build them once per
  // template and copy them to each sector's place. Everything else loads as before.
  const templateObjects = new Map();   // template path -> Promise<{ sector, points }>
  const staticPointsFor = async (sectors, diag) => {
    const plain = sectors.filter(s => !s.terrain);
    const out = plain.length ? await loadSecStaticObjectPoints(plain, diag) : [];
    const copies = await Promise.all(sectors.filter(s => s.terrain).map(async sector => {
      const path = sector.terrain.template.path;
      if (!templateObjects.has(path)) {
        const p = loadSecStaticObjectPoints([sector], diag).then(points => ({ sector, points }));
        templateObjects.set(path, p);
        p.catch(() => templateObjects.delete(path));
      }
      const base = await templateObjects.get(path);
      if (base.sector === sector) return base.points;
      const dx = (sector.position.x - base.sector.position.x) * 64, dy = (sector.position.y - base.sector.position.y) * 64;
      const from = base.sector.filename;
      const shift = t => ({ x: t.x + dx, y: t.y + dy });
      return base.points.map(p => ({
        ...p, motion: p.motion && { ...p.motion, waypoints: p.motion.waypoints.map(shift), standDay: p.motion.standDay && shift(p.motion.standDay), standNight: p.motion.standNight && shift(p.motion.standNight) },
        file: p.file.replace(from, sector.filename), name: p.name.startsWith(from) ? sector.filename + p.name.slice(from.length) : p.name,
        worldX: p.worldX + dx, worldY: p.worldY + dy, sectorX: sector.position.x, sectorY: sector.position.y
      }));
    }));
    for (const c of copies) for (const p of c) out.push(p);
    return out;
  };
  let onMobPointsLoaded = null; // set by the lighting controls: object lights need their art
  const loadMobDataAtZoom = async () => {
    if (mobLoadStarted || mobLoadPromise) return mobLoadPromise;
    mobLoadStarted = true;
    mobLoadPromise = (async () => {
      try {
        // The .mob files and the sector-embedded static objects are independent,
        // so load them concurrently (they share the art/prototype caches) and
        // merge the static-object diagnostics afterwards.
        const staticDiag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
        for (const s of valid) staticCovered.add(secSectorKey(s));   // terrain sectors loaded later add their own objects
        const [loaded, staticPoints] = await Promise.all([
          opts.virtual ? [] : loadMobsForSecMap(relativePath, secManifest),
          staticPointsFor(valid, staticDiag)
        ]);
        mobDiagnostics = loaded.mobDiagnostics || null;
        if (!mobDiagnostics) mobDiagnostics = { relativePath, manifestLoaded: true, manifestError: null, manifestMobFiles: 0, filesExamined: 0, fetchFailures: [], decodeFailures: [], locationFailures: [], loaded: 0, wallLoaded: 0, staticObjectCount: 0, staticObjectTypeCounts: {}, objectTypeCounts: {} };
        mobDiagnostics.decodeFailures = (mobDiagnostics.decodeFailures || []).concat(staticDiag.decodeFailures);
        mobDiagnostics.locationFailures = (mobDiagnostics.locationFailures || []).concat(staticDiag.locationFailures);
        mobDiagnostics.staticObjectCount = (mobDiagnostics.staticObjectCount || 0) + staticDiag.staticObjectCount;
        mobDiagnostics.wallLoaded = (mobDiagnostics.wallLoaded || 0) + staticDiag.wallLoaded;
        mobDiagnostics.staticObjectTypeCounts = mobDiagnostics.staticObjectTypeCounts || {};
        for (const [k, v] of Object.entries(staticDiag.staticObjectTypeCounts)) mobDiagnostics.staticObjectTypeCounts[k] = (mobDiagnostics.staticObjectTypeCounts[k] || 0) + v;
        if (staticDiag.staticObjectErrors) mobDiagnostics.staticObjectErrors = (mobDiagnostics.staticObjectErrors || []).concat(staticDiag.staticObjectErrors);
        if (staticDiag.inventoryItemsSkipped) mobDiagnostics.inventoryItemsSkipped = (mobDiagnostics.inventoryItemsSkipped || 0) + staticDiag.inventoryItemsSkipped;
        mobPoints = loaded.concat(staticPoints);
      } catch (err) {
        mobDiagnostics = { relativePath, manifestLoaded: false, manifestError: errText(err), manifestMobFiles: 0, filesExamined: 0, fetchFailures: [], decodeFailures: [], locationFailures: [], loaded: 0, wallLoaded: 0, staticObjectCount: 0, staticObjectTypeCounts: {}, objectTypeCounts: {} };
        mobPoints = [];
      }
      if (onMobPointsLoaded) { try { await onMobPointsLoaded(); } catch (_) {} }
      updateMobMapMeta();
      redraw();
      return mobPoints;
    })();
    return mobLoadPromise;
  };
  let mapBackground = null;
  try {
    const mapUrl = `${SEC_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}Map.bmp`;
    const resp = await fetch(mapUrl, { cache: 'no-store' });
    if (resp.ok) {
      const blob = await resp.blob(), objectUrl = URL.createObjectURL(blob), img = new Image();
      mapBackground = await new Promise(resolve => {
        img.onload = () => {
          try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0); const im = cx.getImageData(0, 0, c.width, c.height); for (let i=0;i<im.data.length;i+=4) { const g=Math.round(im.data[i]*.299+im.data[i+1]*.587+im.data[i+2]*.114); im.data[i]=im.data[i+1]=im.data[i+2]=g; } cx.putImageData(im,0,0); const gray = new Image(); gray.onload=()=>{ URL.revokeObjectURL(objectUrl); resolve(gray); }; gray.onerror=()=>{ URL.revokeObjectURL(objectUrl); resolve(null); }; gray.src=c.toDataURL(); } catch (_) { URL.revokeObjectURL(objectUrl); resolve(null); }
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); }; img.src = objectUrl;
      });
    }
  } catch (_) {}

  const article = document.createElement('article'); article.className = 'sec-viewer sec-folder-viewer';
  const head = document.createElement('div'); head.className = 'sec-viewer-head';
  head.innerHTML = `<div><h2 class="sec-viewer-title"></h2><div class="sec-viewer-meta"></div></div>`;
  const titleEl = head.querySelector('.sec-viewer-title');
  let focusedFile = focusFilename;
  const showWhole = document.createElement('button'); showWhole.type = 'button'; showWhole.className = 'btn-back sec-show-whole'; showWhole.textContent = 'Show whole folder';
  const refreshFocusUi = () => {
    titleEl.textContent = focusedFile ? `${folderName} · ${focusedFile}` : folderName;
    showWhole.hidden = !focusedFile;
  };
  refreshFocusUi();
  // The counts (sectors, tiles, objects, mobs) and the zoom go in the explorer breadcrumb: the folder path
  // on the left, the data on the right, separated by tabs.
  head.querySelector('.sec-viewer-meta').remove();
  const crumbBase = breadcrumbEl.textContent;
  const crumbData = document.createElement('span'); crumbData.className = 'crumb-data';
  let crumbCounts = '', crumbZoom = '', crumbStarted = false;
  const renderCrumb = () => {
    if (!crumbData.isConnected) {
      if (crumbStarted) return;   // another view owns the breadcrumb now
      breadcrumbEl.replaceChildren(crumbBase, crumbData); crumbStarted = true;
    }
    const text = [crumbCounts, crumbZoom].filter(Boolean).join('\t');
    if (crumbData.textContent !== text) crumbData.textContent = text;
  };
  const updateMobMapMeta = () => {
    const parts = [`${valid.length} sector${valid.length === 1 ? '' : 's'}`, `${valid.length * 4096} Tiles`,
      ...(mobDiagnostics ? [`${mobDiagnostics.staticObjectCount ?? 0} Objects`, `${mobPoints.length} MOBs`] : ['Objects load at 60% zoom'])];
    crumbCounts = parts.join('\t'); renderCrumb();
  };
  updateMobMapMeta();
  head.append(showWhole);   // the head (title) lives in the right side bar, see "Map" below

  const layout = document.createElement('div'); layout.className = 'sec-map-layout';
  const mapCard = document.createElement('section'); mapCard.className = 'sec-map-card';
  const toolbar = document.createElement('div'); toolbar.className = 'sec-map-toolbar';
  const status = document.createElement('span'); status.className = 'sec-viewer-meta sec-map-status';   // progress and problems only
  const zoomOut = document.createElement('button'); zoomOut.type='button'; zoomOut.className='btn-back'; zoomOut.textContent='−'; zoomOut.title='Zoom out';
  const zoomIn = document.createElement('button'); zoomIn.type='button'; zoomIn.className='btn-back'; zoomIn.textContent='+'; zoomIn.title='Zoom in';
  const modeBtn = document.createElement('button'); modeBtn.type = 'button'; modeBtn.className = 'btn-back sec-map-mode'; modeBtn.textContent = 'Isometric view';
  const viewRow = document.createElement('div'); viewRow.className = 'sec-view-row';
  // Everything above, in the order it appears in the right bar (also used when leaving the editor).
  const layoutToolbar = () => {
    viewRow.replaceChildren(modeBtn, displayAllBtn);
    toolbar.replaceChildren(viewRow, overlayControls, lightControls, status);
  };
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button'; exportBtn.className = 'btn-back sec-map-export';
  exportBtn.textContent = 'Export PNG';
  exportBtn.title = 'Save the map exactly as shown in the display';
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      status.textContent = 'Preparing export…';
      await new Promise(r => setTimeout(r, 0)); // let the status text paint
      // Objects and lights only exist once the MOB data is loaded.
      const wantsObjects = lightState.enabled || ['containers', 'walls', 'scenery', 'otherMobs'].some(k => overlayVisibility[k]);
      if (wantsObjects) await loadMobDataAtZoom();
      if (lightLoading) await lightLoading;
      if (overlayVisibility.roofs) await ensureRoofArt();
      // Whole map at 100% zoom, rendered off screen: independent of the display
      // size, current zoom/pan and device pixel ratio. No selection highlight.
      // The sectors there are, not the whole map (a world map is mostly empty around them).
      const rect = contentRect();
      const fullW = Math.ceil(rect.w), fullH = Math.ceil(rect.h);
      // Browsers cap canvas size; if the map is bigger, use the largest zoom that fits.
      const MAX_DIM = 32767, MAX_AREA = 268435456;
      let zoom = 1;
      if (fullW > MAX_DIM || fullH > MAX_DIM || fullW * fullH > MAX_AREA) {
        zoom = Math.floor(Math.min(MAX_DIM / fullW, MAX_DIM / fullH, Math.sqrt(MAX_AREA / (fullW * fullH))) * 1000) / 1000;
      }
      const outW = Math.max(1, Math.floor(fullW * zoom)), outH = Math.max(1, Math.floor(fullH * zoom));
      const off = document.createElement('canvas');
      const exportView = Object.assign({}, view, { zoom, offsetX: -rect.x * zoom, offsetY: -rect.y * zoom });
      drawSecFolderMap(off, valid, bounds, null, mode, artTiles, exportView, mobPoints, mapBackground, overlayVisibility, { cssW: outW, cssH: outH, dpr: 1 });
      const folder = String(relativePath || '').split('/').filter(Boolean).pop() || 'map';
      await exportCanvasPng(off, `${folder}_${mode === 'art' ? 'tiles' : 'colors'}_${Math.round(zoom * 100)}pct`);
      status.textContent = zoom < 1
        ? `Exported ${outW} × ${outH} px at ${Math.round(zoom * 100)}% (100% would be ${fullW} × ${fullH} px, over the browser canvas limit)`
        : `Exported ${outW} × ${outH} px at 100%`;
    } catch (err) {
      status.textContent = `Export failed: ${errText(err)}`;
    } finally {
      exportBtn.disabled = false;
    }
  });
  addContextTool(exportBtn, article);   // top bar, next to Edit
  const displayAllBtn = document.createElement('button');
  displayAllBtn.type = 'button'; displayAllBtn.className = 'btn-back sec-map-display-all';
  displayAllBtn.textContent = 'Display all';
  displayAllBtn.title = 'Actual tiles for every sector in view, plus containers, walls, scenery, other MOBs and roofs (lighting stays manual)';
  displayAllBtn.addEventListener('click', async () => {
    displayAllBtn.disabled = true;
    try {
      // 1. actual tiles
      if (mode !== 'art') await applyMode('art');
      // 2. every non-blank sector in view (not just the ones already clicked)
      const inView = secSectorsInView(valid, bounds, iso, view, stage.clientWidth, stage.clientHeight);
      const todo = inView.filter(sec =>!view.loadedSectors.has(secSectorKey(sec)) && !view.blankSectors?.has(secSectorKey(sec)));
      let done = 0;
      for (let i = 0; i < todo.length; i += 4) {
        status.textContent = `Loading sectors… ${done}/${todo.length}`;
        await Promise.all(todo.slice(i, i + 4).map(sec => loadSectorTiles(sec).then(() => { done++; })));
      }
      // 2b. world maps: the terrain-generated sectors in view (skipped while too many would be visible)
      if (view.terrain.map) {
        const r = secVisibleSectorRange(view, bounds, iso, stage.clientWidth, stage.clientHeight);
        if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= SEC_TERRAIN_MAX_CELLS) {
          const cands = [];
          for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
            const cand = terrainCandidate(x, y);
            if (cand && !view.loadedSectors.has(`${x},${y}`)) cands.push(cand);
          }
          const visible = new Set(secSectorsInView(cands.map(c => ({ position: { x: c.x, y: c.y } })), bounds, iso, view, stage.clientWidth, stage.clientHeight).map(secSectorKey));
          const terrainTodo = cands.filter(c => visible.has(`${c.x},${c.y}`));
          let tdone = 0;
          for (let i = 0; i < terrainTodo.length; i += 4) {
            status.textContent = `Loading terrain sectors… ${tdone}/${terrainTodo.length}`;
            await Promise.all(terrainTodo.slice(i, i + 4).map(c => loadTerrainSectorAt(c).then(() => { tdone++; })));
          }
        } else status.textContent = 'Too many terrain sectors in view: zoom in to load them';
      }
      // 3. object overlays (bounds outlines are a debug aid, so they are left as they are)
      for (const key of ['containers', 'walls', 'scenery', 'otherMobs', 'roofs']) {
        overlayVisibility[key] = true;
        overlayButtons[key]?.setAttribute('aria-pressed', 'true');
        overlayButtons[key]?.classList.add('active');
      }
      status.textContent = 'Loading objects…';
      await loadMobDataAtZoom();
      await ensureRoofArt();
      // Lighting is deliberately NOT switched on here; it stays a manual toggle.
      redraw();
      status.textContent = `All elements displayed · ${view.loadedSectors.size} sectors · ${mobPoints.length} objects`;
    } catch (err) {
      status.textContent = `Display all failed: ${errText(err)}`;
    } finally {
      displayAllBtn.disabled = false;
    }
  });
  const editBtn = document.createElement('button');
  editBtn.type = 'button'; editBtn.className = 'btn-back sec-edit-btn';
  editBtn.textContent = 'Edit'; editBtn.setAttribute('aria-pressed', 'false');
  editBtn.title = 'Open the map editor: the window is used in full, zoom goes to 100% and the tools open on the right. Leave with "Exit edit".';
  const exportSecBtn = document.createElement('button');
  exportSecBtn.type = 'button'; exportSecBtn.className = 'btn-back sec-edit-export';
  exportSecBtn.textContent = 'Export .SEC'; exportSecBtn.disabled = true;
  exportSecBtn.title = 'Save the altered .sec file(s)';
  // The editor switch lives in the top bar while this map is on screen.
  addContextTool(editBtn, article);
  // "Export .SEC" only exists in the editor (it is moved into the editor menu on entry).
  const overlayControls = document.createElement('div');
  overlayControls.className = 'sec-overlay-controls';
  overlayControls.setAttribute('role', 'group');
  overlayControls.setAttribute('aria-label', 'Map overlays');
  const overlayVisibility = { containers: false, walls: false, scenery: false, otherMobs: false, roofs: false, bounds: false };
  const overlayButtons = {};
  // One button can drive several layers ("Mob" = containers + NPCs and the other MOBs).
  const addOverlayToggle = (keys, label, title) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sec-overlay-toggle';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      const on = !overlayVisibility[keys[keys.length - 1]];
      for (const k of keys) overlayVisibility[k] = on;
      button.setAttribute('aria-pressed', String(on));
      button.classList.toggle('active', on);
      // Objects (terrain sectors' included) only exist once the object data is loaded.
      if (on && !keys.includes('roofs') && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
      redraw();
    });
    overlayControls.appendChild(button);
    for (const k of keys) overlayButtons[k] = button;
    return button;
  };
  addOverlayToggle(['scenery'], 'Objects', 'Show or hide scenery');
  addOverlayToggle(['containers', 'otherMobs'], 'Mob', 'Show or hide containers, NPCs and the other MOBs (items, portals…)');
  addOverlayToggle(['walls'], 'Walls', 'Show or hide walls');
  addOverlayToggle(['roofs'], 'Roofs', 'Show or hide roofs (isometric view)').addEventListener('click', () => { ensureRoofArt(); });
  // "Areas" (top-down view): the game's areas (gamearea.mes) and, in red, the secret areas, as on the
  // world map. Areas are placed in world tiles, so only the world map folder and its sub-folders get it.
  const areaState = { on: false, areas: null };
  const areasBtn = document.createElement('button');
  areasBtn.type = 'button'; areasBtn.className = 'sec-overlay-toggle'; areasBtn.textContent = 'Areas'; areasBtn.hidden = true;
  areasBtn.title = "The game's areas (where each one is detected) and, in red, the secret areas · top-down view";
  areasBtn.setAttribute('aria-pressed', 'false');
  areasBtn.addEventListener('click', () => {
    areaState.on = !areaState.on;
    areasBtn.setAttribute('aria-pressed', String(areaState.on)); areasBtn.classList.toggle('active', areaState.on);
    if (areaState.on && mode === 'art' && !edit.on) applyMode('color'); else redraw();
  });
  overlayControls.appendChild(areasBtn);
  // Map data the game keeps beside the tiles and objects (both views): jump points (map.jmp), tile
  // scripts (in the .sec), blocked tiles (.sec) and blocked sectors (map.sbf), the start location
  // (startloc.txt). Each button only shows when this map has some.
  const layers = { jumps: false, scripts: false, blocked: false, waypoints: false, start: false };
  const layerBtns = {};
  for (const [key, label, title] of [
    ['jumps', 'Jumps', 'Jump points (map.jmp): the tiles that take you to another map · select one to go there'],
    ['scripts', 'Scripts', 'Tile scripts: scripts the game runs on a tile · select one to open its .scr'],
    ['blocked', 'Blocked', 'Blocked tiles, as the editor shows them: bright red where placed (in the .sec), dark red where generated by the tile art or an object; hatched, the blocked sectors (map.sbf)'],
    ['waypoints', 'Waypoints', "The NPCs' waypoints, numbered, one colour per NPC (isometric view, as in the game's editor)"],
    ['start', 'Start', 'Where the player starts on this map (startloc.txt)'],
  ]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sec-overlay-toggle'; b.textContent = label; b.title = title; b.hidden = key !== 'waypoints';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      layers[key] = !layers[key]; b.setAttribute('aria-pressed', String(layers[key])); b.classList.toggle('active', layers[key]);
      // Objects block tiles and carry the waypoints: they only exist once the object data is loaded.
      if (layers[key] && (key === 'blocked' || key === 'waypoints') && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
      redraw();
    });
    overlayControls.appendChild(b);
    layerBtns[key] = b;
  }
  loadTerrainMap(String(relativePath || '').split('/')[0]).then(async map => {
    if (!map) return;
    areaState.areas = await loadGameAreas().catch(() => null);
    if (areaState.areas?.length) areasBtn.hidden = false;
  }).catch(() => {});
  // Ambient lighting: hour slider driven by the map's mapinfo.txt LightScheme.
  const lightControls = document.createElement('div');
  lightControls.className = 'sec-overlay-controls sec-light-controls';
  lightControls.setAttribute('role', 'group');
  lightControls.setAttribute('aria-label', 'Ambient lighting');
  const lightToggle = document.createElement('button');
  lightToggle.type = 'button'; lightToggle.className = 'sec-overlay-toggle'; lightToggle.textContent = 'Lighting';
  lightToggle.title = "Apply the map's ambient lighting (Actual tiles mode)"; lightToggle.setAttribute('aria-pressed', 'false');
  // Each press moves to the next time of day (day first), then back to no lighting.
  const LIGHT_STAGES = [{ name: 'Day', hour: 12 }, { name: 'Dusk', hour: 18 }, { name: 'Night', hour: 0 }, { name: 'Dawn', hour: 6 }];
  let lightStage = -1;
  const lightLabel = document.createElement('span'); lightLabel.className = 'sec-viewer-meta'; lightLabel.textContent = '';
  // LF_ANIMATING lights (torches, fires...) cycle through the frames of their ART in the game.
  const lightAnim = document.createElement('button');
  lightAnim.type = 'button'; lightAnim.className = 'sec-overlay-toggle'; lightAnim.textContent = 'Animate';
  lightAnim.title = 'Play animated objects (camp fires, torches, ...) and animated lights; click a door or chest to open / close it and a trap to set it off; NPCs walk, and idle ones breathe, their waypoints and standpoints (the hour slider switches between day and night routes)'; lightAnim.setAttribute('aria-pressed', 'false');
  lightControls.append(lightToggle, lightAnim, lightLabel);
  layoutToolbar();
  const lightState = { enabled: false, hour: 12, table: null, animate: false, animTime: 0 };
  let lightAnimTimer = null;
  // What NPCs can walk on, built from the objects loaded so far and rebuilt when more arrive.
  let navCache = null;
  const currentNav = () => {
    if (!mobPoints.length) return null;
    if (!navCache || navCache.points !== mobPoints || navCache.count !== mobPoints.length) {
      navCache = { points: mobPoints, count: mobPoints.length, nav: buildSecNav(view.sectorMap, mobPoints) };
    }
    return navCache.nav;
  };
  const syncLightAnim = () => {
    const want = lightState.animate;
    if (want && !lightAnimTimer) {
      lightAnimTimer = setInterval(() => {
        if (!canvas.isConnected) { clearInterval(lightAnimTimer); lightAnimTimer = null; return; }
        lightState.animTime = performance.now(); secObjectAnim.time = lightState.animTime;
        secObjectAnim.nav = currentNav();
        redraw();
      }, 130);
    } else if (!want && lightAnimTimer) { clearInterval(lightAnimTimer); lightAnimTimer = null; }
  };
  lightAnim.addEventListener('click', () => {
    lightState.animate = !lightState.animate; secObjectAnim.enabled = lightState.animate;
    if (lightState.animate) { secObjectAnim.start = secObjectAnim.time = performance.now(); secObjectAnim.hour = lightState.hour; secObjectAnim.nav = currentNav(); }
    lightAnim.setAttribute('aria-pressed', String(lightState.animate));
    lightAnim.classList.toggle('active', lightState.animate);
    refreshLightLabel(); syncLightAnim(); redraw();
    if (lightState.animate && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
  });
  let lightLoading = null;
  const refreshLightLabel = () => {
    syncLightAnim();
    if (!lightState.enabled) { lightLabel.textContent = lightState.animate ? `${secIsDay(lightState.hour) ? 'Day' : 'Night'} routes` : ''; return; }
    if (lightState.error) { lightLabel.textContent = lightState.error; return; }
    if (!lightState.table) { lightLabel.textContent = 'loading…'; return; }
    lightLabel.textContent = (lightState.disks?.error ? `light disks: ${lightState.disks.error}` : '') + (mode === 'art' ? '' : 'Shown in isometric view');
  };
  lightToggle.addEventListener('click', async () => {
    lightStage = lightStage + 1 >= LIGHT_STAGES.length ? -1 : lightStage + 1;
    lightState.enabled = lightStage >= 0;
    if (lightState.enabled) lightState.hour = secObjectAnim.hour = LIGHT_STAGES[lightStage].hour;
    lightToggle.textContent = lightState.enabled ? `Lighting · ${LIGHT_STAGES[lightStage].name}` : 'Lighting';
    lightToggle.setAttribute('aria-pressed', String(lightState.enabled));
    lightToggle.classList.toggle('active', lightState.enabled);
    if (lightState.enabled && !lightState.table && !lightLoading) {
      lightLoading = loadMapLighting(relativePath).then(res => {
        if (res.error) { lightState.error = res.error; return; }
        lightState.table = res.table; lightState.schemeName = `${res.requested} (${res.name})`; lightState.note = res.note || '';
        if (!res.mapinfoFound) lightState.note += ' · no mapinfo.txt, using default scheme';
        return ensureSecLightArt(valid, mobPoints).then(stats => { lightState.disks = stats; });
      }).catch(err => { lightState.error = errText(err); }).finally(() => { lightLoading = null; refreshLightLabel(); redraw(); });
    }
    // Lamps, torches and other objects carry lights too, so their data must be loaded
    // even below the usual 60% zoom threshold.
    if (lightState.enabled && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    refreshLightLabel(); redraw();
  });
  onMobPointsLoaded = async () => {
    if (!lightState.enabled || !lightState.table) return;
    lightState.disks = await ensureSecLightArt(valid, mobPoints);
    refreshLightLabel();
  };
  const stage = document.createElement('div'); stage.className = 'sec-map-stage sec-folder-map-stage';
  const canvas = document.createElement('canvas'); const tip = document.createElement('div'); tip.className = 'sec-map-tooltip'; tip.hidden = true;
  stage.append(canvas, tip); mapCard.appendChild(stage);
  const hint = document.createElement('p'); hint.className = 'sec-map-hint';   // the editor's status bar; only in the card while editing

  // Right side bar, top to bottom. Every section can be folded.
  const fold = (cls, title, body, open = true) => `<details class="sec-fold ${cls}"${open ? ' open' : ''}><summary>${title}</summary><div class="sec-fold-body">${body}</div></details>`;
  const infoRow = label => `<div class="sec-info-row"><span>${label}</span><span>—</span></div>`;
  const info = document.createElement('aside'); info.className = 'sec-tile-info';
  info.innerHTML =
    fold('sec-fold-map', 'Map', '') +
    fold('sec-fold-tile', 'Selected tile', ['Sector X / Y', 'Tile X / Y', 'World X / Y', 'Art ID', 'Tile', 'SEC file', 'Hex'].map(infoRow).join('')) +
    fold('sec-fold-art', 'Art IDs on map', '<div class="sec-art-legend"></div>') +
    fold('sec-fold-objects', 'Objects on tile', '<div class="sec-obj-info">—</div>') +
    fold('sec-fold-mobs', 'Mobs on tile', '<div class="sec-mob-info">—</div>');
  info.querySelector('.sec-fold-map .sec-fold-body').append(head, toolbar);
  layout.append(mapCard, info); article.appendChild(layout);
  const legendEl = info.querySelector('.sec-art-legend');
  const fillLegend = () => {
    legendEl.innerHTML = '';
    for (const entry of secFolderLegendEntries(valid)) {
      const row = document.createElement('div'); row.className = 'sec-art-legend-row';
      const swatch = document.createElement('span'); swatch.className = 'sec-art-legend-swatch'; swatch.style.background = entry.color;
      const label = document.createElement('span'); label.className = 'sec-art-legend-label'; label.textContent = `${entry.artId}${entry.name ? ` · ${entry.name}` : ''}`;
      const count = document.createElement('span'); count.className = 'sec-art-legend-count'; count.textContent = String(entry.count);
      row.append(swatch, label, count); legendEl.appendChild(row);
    }
  };
  fillLegend();

  const mapW = (maxX - minX + 1) * 64, mapH = (maxY - minY + 1) * 64;
  const iso = secIsoMetrics(bounds);
  const sectorMap = new Map(valid.map(s => [`${s.position.x},${s.position.y}`, s]));
  const view = { zoom: 1, offsetX: 0, offsetY: 0, initialized: false, sectorMap, colorSectorCache: new Map(), light: lightState,
    blankSectors: null, loadedSectors: new Set(), loadingSectors: new Set(), roofArt: new Map() };
  let selected = null, mode = 'color', artTiles = new Map(), artLoadStarted = false, artLoadTimer = null;
  // World maps: the sectors without a .sec are generated from data/terrain through terrain.tdf.
  // They appear as their own placeholders and are only ever loaded by clicking them.
  view.terrain = { map: null, loading: new Set() };
  loadTerrainMap(relativePath).then(map => { if (map) { view.terrain.map = map; if (mode === 'art') sectorStatus(); redraw(); } }).catch(() => {});
  // The map-data buttons, for what this map has; map names label the jump points.
  let mapNames = null;
  loadMapList().then(m => { mapNames = m; redraw(); }).catch(() => {});
  layerBtns.jumps.hidden = !mapData?.jumps.length;
  layerBtns.scripts.hidden = !valid.some(s => s.decoded?.tileScripts?.length);
  layerBtns.blocked.hidden = false;   // tile art and objects block too, so every map has some
  // Many startloc.txt files were copied from another map and point outside this one: only a start
  // inside the map is offered.
  const startIsInMap = () => !!mapData?.start && mapData.start.x >= minX * 64 && mapData.start.x < (maxX + 1) * 64
    && mapData.start.y >= minY * 64 && mapData.start.y < (maxY + 1) * 64;
  let startInMap = startIsInMap();
  layerBtns.start.hidden = !startInMap;
  // Centre the map on a place ({ sectorX, sectorY, tileX, tileY, x, y, name, zoomTo? }) and select its tile.
  const goToPlace = place => {
    const lx = (place.sectorX - minX) * 64 + place.tileX, ly = (place.sectorY - minY) * 64 + place.tileY;
    if (lx < 0 || ly < 0 || lx >= mapW || ly >= mapH) { status.textContent = `${place.name} (${place.x}, ${place.y}) lies outside the area of this map`; return; }
    const w = Math.max(320, stage.clientWidth || 760), h = Math.max(260, stage.clientHeight || 620);
    view.zoom = place.zoomTo ?? Math.max(view.zoom, mode === 'art' ? 0.12 : 3);
    const px = mode === 'art' ? secIsoProject(lx, ly, iso).x : mapW - 1 - lx + 0.5;
    const py = mode === 'art' ? secIsoProject(lx, ly, iso).y : ly + 0.5;
    view.offsetX = w / 2 - px * view.zoom; view.offsetY = h / 2 - py * view.zoom;
    selected = { sectorX: place.sectorX, sectorY: place.sectorY, tileX: place.tileX, tileY: place.tileY };
    updateInfo(selected);
    status.textContent = `${place.name} · tile ${place.x}, ${place.y} · sector ${place.sectorX}, ${place.sectorY}`;
    redraw(); scheduleVisibleArtLoad();
    if (view.zoom >= 0.6 && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
  };
  const terrainCandidate = (sx, sy) => {
    const t = view.terrain.map;
    if (!t || sx < minX || sx > maxX || sy < minY || sy > maxY || sectorMap.has(`${sx},${sy}`)) return null;
    const info = t.describe(sx, sy);
    return info?.template ? info : null;
  };
  const loadTerrainSectorAt = async cand => {
    const key = `${cand.x},${cand.y}`;
    if (sectorMap.has(key) || view.terrain.loading.has(key)) return;
    view.terrain.loading.add(key); redraw();
    try {
      const sector = await loadTerrainSector(cand);
      if (!sector) { status.textContent = `Terrain sector ${cand.id}: template ${cand.template.path} was not found`; return; }
      valid.push(sector); sectorMap.set(key, sector);
      await loadSectorTiles(sector);
      status.textContent = `Terrain sector ${cand.id} loaded · ${cand.label} · terrain/${cand.template.path}`;
      // Objects and lights of the template, once the object data is in use at all.
      if (mobLoadPromise) await mobLoadPromise;
      if (mobLoadStarted && !staticCovered.has(key)) {
        staticCovered.add(key);
        const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
        // read mobPoints only after the await: sectors load several at a time and each one appends
        const points = await staticPointsFor([sector], diag);
        mobPoints = mobPoints.concat(points);
        updateMobMapMeta();
      }
      if (lightState.enabled && lightState.table) { lightState.disks = await ensureSecLightArt(valid, mobPoints); refreshLightLabel(); }
    } catch (err) {
      status.textContent = `Could not load terrain sector ${cand.id}: ${errText(err)}`;
    } finally {
      view.terrain.loading.delete(key); redraw();
    }
  };
  // Tile-editor state (see the "Tile editing" block below).
  let drawCursorHook = null;
  const edit = {
    on: false, pan: false, brush: null, size: 1, variation: 'auto', plainA3: 0, tool: 'tile',
    undo: [], redo: [], stroke: null, painting: false, last: null, lastF: null, hover: null,
    dirty: new Map(),        // sector key -> { sector, orig } for every sector whose tiles differ from the file on disk
    objSecs: new Map(),      // sector key -> sector whose object list was changed
    roofSecs: new Map(),     // sector key -> sector whose roof grid was changed
    lightSecs: new Map(),    // sector key -> sector whose light list was changed
    extraSecs: new Map(),    // sector key -> sector whose block list, tile scripts or properties were changed
    newMobs: [],             // the .mob files made here: { name, bytes, obj, pt } (exported next to the sectors)
    modMobs: new Map(),      // file name -> { name, bytes, orig, pt, ... } of a .mob file of the map that was changed (exported as its replacement)
    kidMobs: [],             // the items put in an inventory: { name, bytes, oid, owner (the owner's file name) } (exported with the others)
    mobSel: null,            // the NPC / container being edited (its map point)
    story: { dialogs: [], quests: [] },   // the Dialog and Quest tools' work: exported as .dlg + .scr files and the logbook
    objOps: [], strokeSeen: new Set(), sel: {}, objectsReady: false, commonPiece: 0, skippedMob: 0, problem: null,
    unsaved: false, panning: false, eyeTile: null, fillCount: 0, wallBrush: 'line', wallDrag: null, houseNote: null,
    // the last placeholder house: what "Generate again" / "Turn" rebuild (see houseAction); houseSnap: its state before
    // and after the stroke being recorded, so undo / redo bring the right one back
    lastHouse: null, housePts: null, houseSnap: null,
    pathDoors: [], pathSeed: 1       // Paths tool: the doors chosen, layout number
  };
  let extra = null;            // the Roof, Light, Block, Sector and Map tools (sec-extra-tools.js), made further down
  const infoRows = info.querySelectorAll('.sec-info-row span:last-child');
  // Under the tile rows: what the game keeps about this tile and its sector besides tiles and objects.
  const mapInfoEl = document.createElement('div'); mapInfoEl.className = 'sec-mapdata-info';
  info.querySelector('.sec-fold-tile .sec-fold-body').appendChild(mapInfoEl);
  let townNames = null, lightNames = null;
  Promise.all([loadTownMapNames().catch(() => null), loadLightSchemeNames().catch(() => null)]).then(([t, l]) => { townNames = t; lightNames = l; });
  const openScript = async num => { const m = await import('../scr/scr-explorer.js'); if (!(await m.openScrByNumber(num))) status.textContent = `There is no .scr numbered ${num}`; };
  const fillMapInfo = (p, sector) => {
    mapInfoEl.replaceChildren();
    const X = p.sectorX * 64 + p.tileX, Y = p.sectorY * 64 + p.tileY;
    const row = (k, ...v) => {
      const r = document.createElement('div'); r.className = 'sec-info-row';
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.append(...v);
      r.append(a, b); mapInfoEl.appendChild(r); return r;
    };
    const link = (text, title, fn) => { const a = document.createElement('a'); a.href = '#'; a.className = 'sec-mapdata-link'; a.textContent = text; a.title = title; a.addEventListener('click', ev => { ev.preventDefault(); fn(); }); return a; };
    const scriptLink = num => {
      const a = link(`#${num}`, `Open script ${num} in the .SCR explorer`, () => openScript(num));
      import('../scr/scr-explorer.js').then(m => m.scrFileForNumber(num)).then(f => { if (f) { a.textContent = `#${num} · ${f.replace(/^\d+_?|\.scr$/gi, '')}`; a.title += ` (${f})`; } }).catch(() => {});
      return a;
    };
    // On this tile.
    const ts = sector.decoded.tileScripts?.find(t => t.tileX === p.tileX && t.tileY === p.tileY);
    if (ts && ts.script.num) row('Tile script', scriptLink(ts.script.num));
    for (const j of mapData?.jumps || []) {
      if (j.x !== X || j.y !== Y) continue;
      const folder = mapNames?.get(j.dstMap);
      const text = `${folder || `map ${j.dstMap}`} · ${j.dst.x}, ${j.dst.y}`;
      row('Jump point', folder ? link(text, `Open ${folder} at tile ${j.dst.x}, ${j.dst.y}`, async () => {
        const m = await import('../sec/sec-explorer.js');
        await m.openSecAtTile(folder, folder, { sectorX: Math.floor(j.dst.x / 64), sectorY: Math.floor(j.dst.y / 64), tileX: j.dst.x & 63, tileY: j.dst.y & 63 }, `Arrival from ${relativePath}`);
      }) : text);
    }
    const mask = sector.decoded.blockMask, bit = p.tileX | (p.tileY << 6);
    const why = [];
    if (mask && ((mask[bit >> 5] >>> (bit & 31)) & 1)) why.push('placed (sector block list)');
    if (!sector.terrain && genBlockFor(sector)[bit]) why.push(artType(sector.decoded.tiles[bit] >>> 0) === ART_TYPE.FACADE ? 'generated: facade not walkable' : 'generated: tile art (b/f in tilename.mes)');
    if (mobPoints.some(o => o.worldX === X && o.worldY === Y && o.type !== 0 && o.type !== 1 && !((o.objFlags | 0) & 0x400))) why.push('generated: an object');
    if (why.length) row('Blocked', why.join(' · '));
    if (mapData?.blockedSectors.has(`${p.sectorX},${p.sectorY}`)) row('Blocked', 'this whole sector (map.sbf)');
    if (mapData?.start && mapData.start.x === X && mapData.start.y === Y) row('Start', 'the player starts here');
    // The sector's own properties.
    const si = sector.decoded.sectorInfo;
    if (si) {
      if (si.script?.num) row('Sector script', scriptLink(si.script.num));
      if (si.townmap) row('Town map', `${townNames?.get(si.townmap) || '?'} (${si.townmap})`);
      if (si.lightScheme) row('Light scheme', `${lightNames?.get(si.lightScheme) || '?'} (${si.lightScheme})`);
      if (si.music > 0 || si.ambient > 0) row('Music / ambient', `scheme ${si.music > 0 ? si.music : '—'} / ${si.ambient > 0 ? si.ambient : '—'}`);
      if (si.aptitudeAdj) row('Aptitude adj.', `${si.aptitudeAdj > 0 ? '+' : ''}${si.aptitudeAdj}`);
    }
    if (lim) row('Map size', `${lim.sectorsX} × ${lim.sectorsY} sectors (map.prp)`);
  };
  const mobInfoEl = info.querySelector('.sec-mob-info');
  const wallInfoEl = info.querySelector('.sec-obj-info');
  // The part of the map the view fits: the focused sector, or everything.
  // The rectangle (in unzoomed view units) covering sectors x0..x1, y0..y1.
  const sectorsRect = (x0, x1, y0, y1) => {
    const ix0 = x0 - minX, ix1 = x1 - minX, iy0 = y0 - minY, iy1 = y1 - minY;
    if (mode !== 'art') return { x: mapW - (ix1 + 1) * 64, y: iy0 * 64, w: (ix1 - ix0 + 1) * 64, h: (iy1 - iy0 + 1) * 64 };
    const pts = [[ix0 * 64, iy0 * 64], [ix1 * 64 + 63, iy0 * 64], [ix0 * 64, iy1 * 64 + 63], [ix1 * 64 + 63, iy1 * 64 + 63]].map(([x, y]) => secIsoProject(x, y, iso));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x: Math.min(...xs) - SEC_ISO_HALF_W, y: Math.min(...ys) - SEC_ISO_HALF_H,
             w: Math.max(...xs) - Math.min(...xs) + SEC_ISO_HALF_W * 2, h: Math.max(...ys) - Math.min(...ys) + SEC_ISO_HALF_H * 2 };
  };
  // What the view fits: the focused sector, or every sector there is (the map itself can be far larger).
  const contentRect = () => sectorsRect(content.minX, content.maxX, content.minY, content.maxY);
  const viewRect = () => {
    const sec = focusedFile && valid.find(v => v.filename === focusedFile);
    return sec ? sectorsRect(sec.position.x, sec.position.x, sec.position.y, sec.position.y) : contentRect();
  };
  const fitView = () => {
    const w = Math.max(320, stage.clientWidth || 760), h = Math.max(260, stage.clientHeight || 620);
    const r = viewRect();
    view.zoom = Math.max(.01, Math.min(32, Math.min(w / r.w, h / r.h)));
    view.offsetX = (w - r.w * view.zoom) / 2 - r.x * view.zoom;
    view.offsetY = (h - r.h * view.zoom) / 2 - r.y * view.zoom;
    view.initialized = true; redraw();
    if (view.zoom >= 0.6 && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    if (mode === 'art') scheduleVisibleArtLoad();
  };
  // Focus another sector of this folder (or null for the whole map) without rebuilding the view.
  const setFocus = filename => { focusedFile = filename || null; refreshFocusUi(); fitView(); };
  showWhole.addEventListener('click', () => setFocus(null));
  article.focusSector = setFocus;
  // "See on map" of a .mob: the isometric view at 100%, centred on the tile, with the tile selected
  // (so the objects on it are listed in the side bar) and every layer shown.
  article.goToTile = async (sectorX, sectorY, tileX, tileY, label) => {
    if (mode !== 'art') await applyMode('art');
    const x = sectorX * 64 + tileX, y = sectorY * 64 + tileY;
    goToPlace({ sectorX, sectorY, tileX, tileY, name: label || 'Object', x, y, zoomTo: 1 });
    displayAllBtn.click();
    // The objects of the tile can only be listed once they are loaded.
    for (let i = 0; i < 300 && displayAllBtn.disabled; i++) await new Promise(r => setTimeout(r, 100));
    if (selected) updateInfo(selected);
  };
  // What the user is looking at, to come back to it after a jump to another file (a tile script, a
  // jump point): view, zoom and position, the selected tile, the layers shown and the sectors loaded.
  const setToggle = (btn, on) => { btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('active', on); };
  article.viewState = () => ({
    mode, zoom: view.zoom, offsetX: view.offsetX, offsetY: view.offsetY, selected: selected && { ...selected },
    layers: { ...layers }, areas: areaState.on, overlays: { ...overlayVisibility }, loaded: [...view.loadedSectors],
  });
  article.restoreView = async s => {
    if (!s) return;
    if (s.mode !== mode) await applyMode(s.mode);
    for (const k of Object.keys(layers)) { layers[k] = !!s.layers?.[k] && !layerBtns[k].hidden; setToggle(layerBtns[k], layers[k]); }
    areaState.on = !!s.areas && !areasBtn.hidden; setToggle(areasBtn, areaState.on);
    for (const [k, btn] of Object.entries(overlayButtons)) if (!!s.overlays?.[k] !== !!overlayVisibility[k]) { overlayVisibility[k] = !!s.overlays?.[k]; setToggle(btn, overlayVisibility[k]); }
    view.zoom = s.zoom; view.offsetX = s.offsetX; view.offsetY = s.offsetY; view.initialized = true;
    selected = s.selected; if (selected) updateInfo(selected);
    redraw();
    if (Object.values(overlayVisibility).some(Boolean) && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    if (overlayVisibility.roofs) ensureRoofArt();
    // The sectors that were loaded (isometric view), a few at a time.
    const todo = (s.loaded || []).filter(k => !view.loadedSectors.has(k));
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(key => {
        const sec = sectorMap.get(key);
        if (sec) return loadSectorTiles(sec);
        const [x, y] = key.split(',').map(Number), cand = terrainCandidate(x, y);
        return cand ? loadTerrainSectorAt(cand) : null;
      }));
    }
    if (mode === 'art') scheduleVisibleArtLoad();
  };
  // Back from a file this map jumped to brings the map back as it is now (zoom, selection, layers).
  article.attachHistory = () => attachView({ mode: 'sec', path: relativePath, capture: () => article.viewState(), restore: state => article.restoreView(state) });
  article.attachHistory();
  let editBarSync = null;      // set by the editor: refreshes its status bar and view switch
  // Frame-time readout next to the zoom: add ?perf to the page address (or localStorage.secPerf = 1).
  const showPerf = /[?&]perf\b/.test(location.search) || (() => { try { return localStorage.getItem('secPerf') === '1'; } catch (_) { return false; } })();
  let perfText = '';
  const updateZoomLabel = () => { crumbZoom = `Zoom ${Math.round(view.zoom * 100)}%${perfText}`; renderCrumb(); if (editBarSync) editBarSync(); };
  // Redraws are coalesced: any number of redraw() calls within a frame (wheel and pointer events
  // arrive faster than the display refreshes) paint once. redrawNow() paints immediately.
  let redrawQueued = false, lastDrawAt = 0;
  const redrawNow = () => {
    redrawQueued = false;
    const t0 = performance.now();
    const sinceLast = t0 - lastDrawAt; lastDrawAt = t0;
    updateZoomLabel();
    drawSecFolderMap(canvas, valid, bounds, selected, mode, artTiles, view, mobPoints, mapBackground, overlayVisibility);
    if (areaState.on && areaState.areas && mode === 'color') drawAreasTopDown();
    if (Object.values(layers).some(Boolean)) drawMapLayers();
    if (drawCursorHook) drawCursorHook();
    const ms = performance.now() - t0;
    // What a lit frame costs: its own time, or the gap since the previous frame when frames run
    // back to back (which also includes the browser's painting). Decides whether lighting pauses.
    if (view.lastDrawLit) {
      const cost = Math.max(ms, sinceLast < 120 ? sinceLast : 0);
      view.litFrameMs = view.litFrameMs ? view.litFrameMs * 0.6 + cost * 0.4 : cost;
    }
    if (showPerf) {
      const p = view.perf || {};
      perfText = ` · ${ms.toFixed(1)} ms${sinceLast < 120 ? ` (${sinceLast.toFixed(0)} ms/frame)` : ''} · ${p.objectsDrawn}/${p.objectsTotal} objects${view.lastDrawLit ? ' · lit' : ''}`;
      updateZoomLabel();
    }
    if (view.lodPending) redraw();   // low-detail images still catching up with newly loaded art
  };
  // The "Areas" overlay in the top-down view, where world tile column X is drawn mirrored at
  // (mapW - 1 - (X - minX * 64)) * zoom + offsetX and row Y at (Y - minY * 64) * zoom + offsetY.
  // An area's zone (tiles closer than its radius) is the square x ± (r - 1), y ± (r - 1).
  const areaFont = getComputedStyle(document.body).getPropertyValue('--font-mono').trim() || 'monospace';
  function drawAreasTopDown() {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const z = Math.max(0.01, Math.min(32, view.zoom)), ox = view.offsetX, oy = view.offsetY;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const TX0 = minX * 64, TY0 = minY * 64;
    const left = X => (mapW - 1 - (X - TX0)) * z + ox, top = Y => (Y - TY0) * z + oy;
    const visible = (x0, y0, x1, y1) => x1 >= 0 && x0 <= cw && y1 >= 0 && y0 <= ch;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    for (const a of areaState.areas) {
      if (a.tiles <= 0) continue;
      const x0 = left(a.x + a.tiles - 1), x1 = left(a.x - a.tiles + 1) + z, y0 = top(a.y - a.tiles + 1), y1 = top(a.y + a.tiles - 1) + z;
      if (!visible(x0, y0, x1, y1)) continue;
      ctx.fillStyle = 'rgba(255,215,0,.08)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,215,0,.6)'; ctx.strokeRect(x0 + .5, y0 + .5, x1 - x0 - 1, y1 - y0 - 1);
    }
    // Secret areas: the sectors of the "Secret Area - …" folders (a sector merged in from a sub-folder
    // carries it in `dir`, see loadSecFolderSectors()).
    const secrets = new Map();
    for (const s of valid) {
      if (s.terrain || !s.position) continue;
      const folder = s.dir || String(relativePath || '').split('/').pop();
      const name = secretAreaName(folder);
      if (name) (secrets.get(name) || secrets.set(name, []).get(name)).push(s.position);
    }
    ctx.fillStyle = 'rgba(226,60,50,.38)'; ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 1;
    for (const list of secrets.values()) for (const p of list) {
      const x0 = left(p.x * 64 + 63), y0 = top(p.y * 64);
      if (!visible(x0, y0, x0 + 64 * z, y0 + 64 * z)) continue;
      ctx.fillRect(x0, y0, 64 * z, 64 * z); ctx.strokeRect(x0 + .5, y0 + .5, 64 * z - 1, 64 * z - 1);
    }
    // Dots and names (secret areas first, then the widest zones; a name that would cover another is left out).
    const marks = [
      ...[...secrets].map(([name, list]) => ({ name, X: list.reduce((n, p) => n + p.x, 0) / list.length * 64 + 32, Y: list.reduce((n, p) => n + p.y, 0) / list.length * 64 + 32, kind: 'secret', rank: Infinity })),
      ...areaState.areas.map(a => ({ name: a.name, X: a.x, Y: a.y, kind: a.tiles <= 0 ? 'hidden' : 'area', rank: a.tiles })),
    ].sort((p, q) => q.rank - p.rank);
    const COLORS = { area: ['#ffd700', '#f1e4c3'], hidden: ['#20b2aa', '#7fe0d8'], secret: ['#ff5a4a', '#ff9b8f'] };
    const fs = 12;
    ctx.font = `600 ${fs}px ${areaFont}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const placed = [], labels = [];
    for (const m of marks) {
      const x = left(m.X) + z / 2, y = top(m.Y) + z / 2;
      if (x < -200 || x > cw + 200 || y < -20 || y > ch + 20) continue;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[m.kind][0]; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
      const w = ctx.measureText(m.name).width;
      const box = { x0: x - w / 2 - 4, x1: x + w / 2 + 4, y0: y - 6 - fs - 3, y1: y - 4 };
      if (placed.some(o => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) continue;
      placed.push(box); labels.push({ m, x, y, box });
    }
    for (const { m, x, y, box } of labels) {
      ctx.fillStyle = 'rgba(13,12,10,.8)'; ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      ctx.fillStyle = COLORS[m.kind][1]; ctx.fillText(m.name, x, y - 6);
    }
    ctx.restore();
  }
  // Jump points, tile scripts, blocked tiles / sectors, NPC waypoints and the start location, drawn
  // the way the game's editor marks them, with its own interface art (art/interface/interface.mes):
  //   jump points   350 jmp_iso / 351 jmp_td    jumppoint_draw()        as is
  //   tile scripts  475 ts_iso  / 476 ts_td     tile_script_draw()      as is
  //   blocked tiles 614 tb_iso  / 615 tb_td     tileblock_draw()        tinted 255,0,0 when placed (the
  //                 sector's block list), 128,0,0 when generated (a facade that is not walkable, a tile
  //                 whose tilename.mes entry has b or f, an object other than a wall or portal without
  //                 OF_NO_BLOCK)
  //   waypoints     672 wp_iso                  wp_draw(): isometric only, frame = waypoint number,
  //                 added in the NPC's colour
  // In the isometric view the art is placed by its hotspot on the tile (x - hot_x + 40,
  // y - (40 - h) / 2 - hot_y + 40 from the tile's 80 x 40 box); in the top-down view it fills the
  // tile's square. Markers keep a readable minimum size when zoomed far out. Blocked sectors
  // (map.sbf) and the start location have no art in the game; they keep a hatch and a star.
  // World tile (X, Y) is at local (X - minX * 64, Y - minY * 64); see sectorAtPoint() for the inverse.
  let hatch = null, overlayArt = null, overlayArtLoading = null, genBlockSrc = null, genBlockObjects = null;
  const OVERLAY_ART = { jmp: [350, 351], ts: [475, 476], tb: [614, 615], wp: [672, 673] };
  const loadOverlayArt = () => overlayArtLoading ??= (async () => {
    const names = await interfaceArtNames();
    const load = async num => {
      const name = String(names.get(num) || '').trim();
      if (!name) return null;
      // interface.mes and the files do not always agree on the case of the extension.
      for (const file of [name, name.replace(/\.art$/i, '.ART'), name.replace(/\.art$/i, '.art')]) {
        const resp = await fetch(`${DATA_ROOT}art/interface/${encodeURIComponent(file)}`).catch(() => null);
        if (resp?.ok) return parseArtBuffer(await resp.arrayBuffer());
      }
      return null;
    };
    const out = {};
    for (const [key, [isoNum, tdNum]] of Object.entries(OVERLAY_ART)) out[key] = { iso: await load(isoNum).catch(() => null), td: await load(tdNum).catch(() => null) };
    overlayArt = out; redraw();
  })();
  // TIG_ART_BLT_BLEND_COLOR_CONST: the picture multiplied by a colour (its transparency kept).
  const tinted = new Map();
  const tintOf = (frame, rgb) => {
    if (!rgb) return frame.canvas;
    const key = `${frame.index}|${frame.width}x${frame.height}|${rgb}`;
    let c = tinted.get(key);
    if (!c) {
      c = document.createElement('canvas'); c.width = frame.width; c.height = frame.height;
      const x = c.getContext('2d');
      x.drawImage(frame.canvas, 0, 0);
      x.globalCompositeOperation = 'multiply'; x.fillStyle = `rgb(${rgb})`; x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in'; x.drawImage(frame.canvas, 0, 0);
      tinted.set(key, c);
    }
    return c;
  };
  // Blocking that comes from the tile art and the objects, per sector (computed once, cached).
  const genBlockFor = s => {
    if (s._genBlock) return s._genBlock;
    const out = new Uint8Array(4096), tiles = s.decoded?.tiles;
    if (tiles) for (let i = 0; i < 4096; i++) {
      const raw = tiles[i] >>> 0;
      if (artType(raw) === ART_TYPE.FACADE ? !secFacadeWalkable(raw) : /[bf]/.test(String(secTileNameMesMap?.get(secTileInfo(raw).artId)?.flags || '').split(/\s/)[0])) out[i] = 1;
    }
    return (s._genBlock = out);
  };
  const OF_NO_BLOCK = 0x400;
  const objectBlocks = () => {
    if (genBlockSrc === mobPoints) return genBlockObjects;
    genBlockSrc = mobPoints; genBlockObjects = new Set();
    for (const o of mobPoints) if (o.type !== 0 && o.type !== 1 && !((o.objFlags | 0) & OF_NO_BLOCK)) genBlockObjects.add(`${o.worldX},${o.worldY}`);
    return genBlockObjects;
  };
  // A colour per NPC (the editor gives each NPC its own), as "r,g b" for tintOf(): a hue from its file name.
  const wpColors = new Map();
  const wpColor = id => {
    let c = wpColors.get(id);
    if (!c) {
      let h = 0; for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
      const hue = ((h >>> 0) % 360) / 60, x = 1 - Math.abs((hue % 2) - 1);
      const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(hue) % 6];
      c = [r, g, b].map(v => Math.round(80 + v * 175)).join(',');
      wpColors.set(id, c);
    }
    return c;
  };

  function drawMapLayers() {
    if (!overlayArt) loadOverlayArt();
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const z = Math.max(0.01, Math.min(32, view.zoom)), ox = view.offsetX, oy = view.offsetY;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const iso_ = mode === 'art';
    const centre = (X, Y) => {
      const lx = X - minX * 64, ly = Y - minY * 64;
      if (iso_) { const p = secIsoProject(lx, ly, iso); return { x: p.x * z + ox, y: p.y * z + oy }; }
      return { x: (mapW - 1 - lx + 0.5) * z + ox, y: (ly + 0.5) * z + oy };
    };
    // A block of tiles x0..x1, y0..y1 (a diamond in the isometric view): for the blocked sectors.
    const tilesPath = (x0, y0, x1, y1) => {
      if (!iso_) {
        const a = centre(x1, y0), b = centre(x0, y1);
        ctx.rect(a.x - z / 2, a.y - z / 2, b.x - a.x + z, b.y - a.y + z); return;
      }
      const hw = SEC_ISO_HALF_W * z, hh = SEC_ISO_HALF_H * z;
      const n = centre(x0, y0), e = centre(x0, y1), s = centre(x1, y1), w = centre(x1, y0);
      ctx.moveTo(n.x, n.y - hh); ctx.lineTo(e.x + hw, e.y); ctx.lineTo(s.x, s.y + hh); ctx.lineTo(w.x - hw, w.y); ctx.closePath();
    };
    const onScreen = (p, m = 40) => p.x > -m && p.x < cw + m && p.y > -m && p.y < ch + m;
    const sectorOnScreen = (sx, sy) => {
      const a = centre(sx * 64, sy * 64), b = centre(sx * 64 + 63, sy * 64 + 63), c = centre(sx * 64 + 63, sy * 64), d = centre(sx * 64, sy * 64 + 63);
      const xs = [a.x, b.x, c.x, d.x], ys = [a.y, b.y, c.y, d.y];
      return Math.max(...xs) > -50 && Math.min(...xs) < cw + 50 && Math.max(...ys) > -50 && Math.min(...ys) < ch + 50;
    };
    // One piece of the game's art on tile (X, Y). `minPx`: the smallest it may get on screen.
    const blit = (frames, frameNo, X, Y, { tint = null, minPx = 0 } = {}) => {
      const f = frames?.[Math.min(frameNo, frames.length - 1)];
      if (!f) return null;
      const p = centre(X, Y), img = tintOf(f, tint);
      if (iso_) {
        const s = Math.max(z, minPx / Math.max(f.width, f.height));
        // The game's top-left: tile box (centre - 40, centre - 20) + (40 - hot_x, 40 - (40 - h) / 2 - hot_y).
        ctx.drawImage(img, p.x - f.hotspotX * s, p.y + (20 - (40 - f.height) / 2 - f.hotspotY) * s, f.width * s, f.height * s);
      } else {
        const size = Math.max(z, minPx);
        ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
      }
      return p;
    };
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    const tilePx = iso_ ? SEC_ISO_HALF_W * 2 * z : z;   // how wide one tile is on screen
    const art = k => overlayArt?.[k]?.[iso_ ? 'iso' : 'td'];

    if (layers.blocked) {
      if (!hatch) {
        const c = document.createElement('canvas'); c.width = c.height = 8;
        const h = c.getContext('2d'); h.strokeStyle = 'rgba(255,90,74,.9)'; h.lineWidth = 1.5;
        h.beginPath(); h.moveTo(-2, 10); h.lineTo(10, -2); h.moveTo(-2, 2); h.lineTo(2, -2); h.moveTo(6, 10); h.lineTo(10, 6); h.stroke();
        hatch = ctx.createPattern(c, 'repeat');
      }
      // Blocked sectors (map.sbf): the whole sector.
      ctx.beginPath();
      for (const key of mapData?.blockedSectors || []) {
        const [sx, sy] = key.split(',').map(Number);
        if (sx < minX || sx > maxX || sy < minY || sy > maxY || !sectorOnScreen(sx, sy)) continue;
        tilesPath(sx * 64, sy * 64, sx * 64 + 63, sy * 64 + 63);
      }
      ctx.fillStyle = 'rgba(226,60,50,.22)'; ctx.fill(); ctx.fillStyle = hatch; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ff5a4a'; ctx.stroke();
      // Blocked tiles, as tileblock_draw(): generated (dark red) then placed (bright red) on top.
      // Left out while a tile is under 3 px on screen: there would be thousands of specks.
      const tb = art('tb');
      if (tb && tilePx >= 3) {
        const objs = objectBlocks();
        for (const s of valid) {
          if (!s.decoded || !sectorOnScreen(s.position.x, s.position.y)) continue;
          const gen = genBlockFor(s), mask = s.decoded.blockMask, bx = s.position.x * 64, by = s.position.y * 64;
          for (let i = 0; i < 4096; i++) {
            const X = bx + (i & 63), Y = by + (i >> 6);
            if (gen[i] || objs.has(`${X},${Y}`)) blit(tb, 0, X, Y, { tint: '128,0,0' });
            if (mask && ((mask[i >> 5] >>> (i & 31)) & 1)) blit(tb, 0, X, Y, { tint: '255,0,0' });
          }
        }
      }
    }

    const fs = 11;
    ctx.font = `600 ${fs}px ${areaFont}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const placed = [];
    const label = (text, p, color) => {
      const w = ctx.measureText(text).width;
      const box = { x0: p.x - w / 2 - 4, x1: p.x + w / 2 + 4, y0: p.y - 12 - fs - 3, y1: p.y - 10 };
      if (placed.some(o => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) return;
      placed.push(box);
      ctx.fillStyle = 'rgba(13,12,10,.85)'; ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      ctx.fillStyle = color; ctx.fillText(text, p.x, p.y - 12);
    };
    const showLabels = tilePx >= 1.5;

    // NPC waypoints (wp_draw(): isometric view only), numbered by the art's frames, in the NPC's colour.
    const wp = overlayArt?.wp?.iso;
    if (layers.waypoints && iso_ && wp) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const o of mobPoints) {
        const list = o.motion?.waypoints;
        if (!list?.length) continue;
        const rgb = wpColor(o.file || o.name || `${o.worldX},${o.worldY}`);
        list.forEach((w, n) => { if (onScreen(centre(w.x, w.y), 80)) blit(wp, n, w.x, w.y, { tint: rgb, minPx: 14 }); });
      }
      ctx.restore();
    }
    if (layers.start && startInMap) {
      const p = centre(mapData.start.x, mapData.start.y);
      if (onScreen(p, 200)) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#7CFC9A'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#0d0c0a'; ctx.stroke();
        label('★ Start', p, '#b9ffc8');
      }
    }
    if (layers.jumps) for (const j of mapData?.jumps || []) {
      if (!onScreen(centre(j.x, j.y), 200)) continue;
      const p = blit(art('jmp'), 0, j.x, j.y, { minPx: 16 });
      if (p && showLabels) label(`→ ${mapNames?.get(j.dstMap) || `map ${j.dstMap}`}`, p, '#dcc6ff');
    }
    if (layers.scripts) for (const s of valid) {
      const list = s.decoded?.tileScripts;
      if (!list?.length || !sectorOnScreen(s.position.x, s.position.y)) continue;
      for (const t of list) {
        const X = s.position.x * 64 + t.tileX, Y = s.position.y * 64 + t.tileY;
        if (!onScreen(centre(X, Y))) continue;
        const p = blit(art('ts'), 0, X, Y, { minPx: 14 });
        if (p && tilePx >= 6) label(`script ${t.script.num}`, p, '#ffd2a3');
      }
    }
    ctx.restore();
  }
  // While the user pans or zooms, lighting is paused on big maps (see drawSecFolderMap) and
  // repainted in full as soon as the gesture has been quiet for a moment.
  let settleTimer = 0;
  const markGesture = () => {
    if (!view.light?.enabled) return;
    view.fastUntil = performance.now() + 180;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(redraw, 200);
  };
  const redraw = () => {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => { if (redrawQueued) redrawNow(); });
  };
  const zoomAt = (factor, cx, cy) => {
    const old = view.zoom, next = Math.max(.01, Math.min(32, old * factor));
    if (next === old) return;
    const wx = (cx - view.offsetX) / old, wy = (cy - view.offsetY) / old;
    view.zoom = next; view.offsetX = cx - wx * next; view.offsetY = cy - wy * next; markGesture(); redraw();
    if (view.zoom >= 0.6 && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    if (mode === 'art') scheduleVisibleArtLoad();
  };
  const sectorAtPoint = event => {
    const r = canvas.getBoundingClientRect();
    const sx = (event.clientX - r.left - view.offsetX) / view.zoom;
    const sy = (event.clientY - r.top - view.offsetY) / view.zoom;
    if (mode === 'art') {
      const p = secIsoUnproject(sx, sy, iso);
      const worldTileX = Math.round(p.x), worldTileY = Math.round(p.y);
      if (worldTileX < 0 || worldTileY < 0 || worldTileX >= mapW || worldTileY >= mapH) return null;
      // In isometric mode the projected X coordinate already follows the
      // game's world convention: X=0 is top-right and X increases leftward.
      const originalX = worldTileX;
      return { sectorX: minX + Math.floor(originalX / 64), sectorY: minY + Math.floor(worldTileY / 64), tileX: originalX & 63, tileY: worldTileY & 63 };
    }
    if (sx < 0 || sy < 0 || sx >= mapW || sy >= mapH) return null;
    const worldTileX = Math.floor(sx), worldTileY = Math.floor(sy);
    const originalX = mapW - 1 - worldTileX;
    return { sectorX: minX + Math.floor(originalX / 64), sectorY: minY + Math.floor(worldTileY / 64), tileX: originalX & 63, tileY: worldTileY & 63 };
  };
  const findSector = (sx, sy) => sectorMap.get(`${sx},${sy}`);
  const updateInfo = p => {
    const sector = findSector(p.sectorX, p.sectorY); if (!sector?.decoded) return;
    const raw = sector.decoded.tiles[p.tileY * 64 + p.tileX] >>> 0, tile = secTileInfo(raw);
    infoRows[0].textContent = `${p.sectorX}, ${p.sectorY}`; infoRows[1].textContent = `${p.tileX}, ${p.tileY}`;
    infoRows[2].textContent = `${p.sectorX * 64 + p.tileX}, ${p.sectorY * 64 + p.tileY}`; infoRows[3].textContent = String(tile.artId);
    infoRows[4].textContent = tile.name || '—'; infoRows[5].textContent = sector.terrain ? `${sector.filename} ← terrain/${sector.terrain.template.path}` : sector.filename; infoRows[6].textContent = `0x${raw.toString(16).padStart(8, '0').toUpperCase()}`;
    fillMapInfo(p, sector);
    const atTile = mobPoints.filter(m => m.sectorX === p.sectorX && m.sectorY === p.sectorY && m.tileX === p.tileX && m.tileY === p.tileY);
    // The .mob files on this tile go under "Mobs on tile"; the sector's own objects under "Objects on tile".
    const mobsHere = atTile.filter(m => !m.staticSecObject), objectsHere = atTile.filter(m => m.staticSecObject);
    // The Art ID, or when the packed id can't be decoded to one (no art, or a format that has no table
    // entry) the .art file used, or failing that the raw id.
    const artText = o => {
      if (o.artId != null) return String(o.artId);
      const critter = (o.type === 15 || o.type === 16) && protoCritterAidInfo(o.currentAidRaw, o.type);
      if (critter) return critter.text;
      if (o.artFile || o.artName) return o.artFile || o.artName;
      const raw = o.currentAidRaw == null ? null : Number(o.currentAidRaw) >>> 0;
      return raw == null || raw === 0xFFFFFFFF ? 'none' : `0x${raw.toString(16).toUpperCase()}`;
    };
    const mobLink = (text, title, fn) => { const a = document.createElement('a'); a.href = '#'; a.className = 'sec-mapdata-link'; a.textContent = text; a.title = title; a.addEventListener('click', ev => { ev.preventDefault(); fn(); }); return a; };
    // Scripts of the objects on the 8 tiles around this one.
    const nearbyScripts = new Set();
    {
      const wx = p.sectorX * 64 + p.tileX, wy = p.sectorY * 64 + p.tileY;
      for (const m of mobPoints) {
        const dx = m.sectorX * 64 + m.tileX - wx, dy = m.sectorY * 64 + m.tileY - wy;
        if ((dx || dy) && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) for (const s of m.scripts || []) nearbyScripts.add(s.num);
      }
    }
    // On or off, and the scripts attached, each with its way back to this map.
    const stateAndScripts = o => {
      const extra = document.createElement('div'); extra.className = 'sec-mob-links';
      const state = document.createElement('div');
      state.append('State: ', Object.assign(document.createElement('strong'), { textContent: ((o.objFlags | 0) & 0x2) !== 0 ? 'OFF' : 'ON' }));   // OF_OFF
      extra.appendChild(state);
      for (const s of o.scripts || []) {
        if (nearbyScripts.has(s.num)) continue;   // the same script also sits on a surrounding tile: listed once, not on each
        const line = document.createElement('div');
        const a = mobLink(`#${s.num}`, `Open script ${s.num} in the .SCR explorer`, () => openScript(s.num));
        import('../scr/scr-explorer.js').then(m => m.scrFileForNumber(s.num)).then(f => { if (f) { a.textContent = `#${s.num} · ${f.replace(/^\d+_?|\.scr$/gi, '')}`; a.title += ` (${f})`; } }).catch(() => {});
        line.append('Script: ', a, s.point ? ` (${s.point})` : '');
        extra.appendChild(line);
      }
      return extra;
    };
    mobInfoEl.innerHTML = '';
    if (!mobsHere.length) mobInfoEl.textContent = '—';
    else for (const mob of mobsHere) {
      const row = document.createElement('div'); row.className = 'sec-mob-info-row';
      const title = document.createElement('div');
      title.appendChild(mobLink(mob.file, `Open ${mob.file} in the .MOB explorer (the Back button comes back to this map)`, async () => {
        saveDataExplorerState('mob', relativePath, folderName, mob.file);
        const m = await import('../mob/mob-explorer.js');
        await m.enterMobExplorer(true);
      }));
      const detail = document.createElement('div');
      detail.textContent = `${mob.name && mob.name !== mob.file ? `${mob.name} · ` : ''}Type ${mob.type} (${mob.typeName || 'unknown'}) · Art ID ${artText(mob)}` +
        (mob.artFile && mob.artId != null ? ` · ${mob.artFile}` : '') + (mob.artNote ? ` · ${mob.artNote}` : '');
      row.append(title, detail, stateAndScripts(mob));
      const inventory = buildOwnerInventory(mob);   // what an NPC carries, below it
      if (inventory) row.appendChild(inventory);
      mobInfoEl.appendChild(row);
    }

    // Objects on this tile: one card per object (walls keep their full decoding), then the roof cell above it.
    wallInfoEl.innerHTML = '';
    const fmt = v => (v == null ? '—' : String(v));
    const hex = v => (v == null ? '—' : `0x${(Number(v) >>> 0).toString(16).toUpperCase()}`);
    const card = html => { const box = document.createElement('div'); box.className = 'sec-mob-info-row'; box.innerHTML = html; return box; };
    const esc = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const wallCard = wall => {
      const fields = Array.isArray(wall.wallFields) ? wall.wallFields : [];
      const field = n => fields.find(f => f.field === n)?.value;
      const aid = wall.currentAidRaw;
      const flags = Number(wall.wallFlags) >>> 0;
      const box = card(`<strong>${esc(wall.file || 'Unknown wall')}</strong><br>` +
        `Object type: ${wall.type} (${esc(wall.typeName || 'WALL')})<br>` +
        `F_LOCATION (2): ${esc(fmt(wall.locationRaw))}<br>` +
        `F_CURRENT_AID (1) raw: ${esc(fmt(aid))}${aid != null ? ` · hex ${hex(aid)}` : ''}<br>` +
        `F_WALL_FLAGS (39): ${flags} · hex 0x${flags.toString(16).padStart(8, '0').toUpperCase()}<br>` +
        `Decoded art ID: ${wall.artId == null ? 'wall-specific' : wall.artId}<br>` +
        `Wall ART: ${esc(wall.artName || '—')}<br>` +
        `Wall AID decode: ${wall.wallDecode ? (wall.wallDecode.missing ? 'no matching .art found' : `num=${wall.wallDecode.num}, piece=${wall.wallDecode.piece}, variation=${wall.wallDecode.variation}, rotation=${wall.wallDecode.rotation}, piece name=${esc(wall.wallDecode.pieceName ?? '?')}, palette=${wall.wallDecode.palette}, file=${esc(wall.artName || wall.wallDecode.filename || '?')}, art direction=${wall.wallDecode.artDirection ?? '?'} (${esc(wall.wallDecode.mappingNote || '')}), damage=0x${(wall.wallDecode.damage >>> 0).toString(16).toUpperCase()}`) : 'not decoded'}<br>` +
        `Wall structure: ${wall.wallDecode?.structureNum ?? '?'} · interior ${esc(wall.wallDecode?.interiorStem ?? '?')} · exterior ${esc(wall.wallDecode?.exteriorStem ?? '?')} · used ${esc(wall.wallDecode?.usedSide ?? '?')} (structure bits 20-27 = ${wall.wallDecode?.num ?? '?'})<br>` +
        `Placement: ${esc(secWallPlacementNote(wall) || '—')}<br>` +
        `Field 3: ${esc(fmt(field(3)))} · Field 4: ${esc(fmt(field(4)))} · Field 5: ${esc(fmt(field(5)))}`);
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'All decoded fields';
      const pre = document.createElement('pre'); pre.textContent = fields.map(f => `F_${f.field}: ${fmt(f.value)}`).join('\n') || '—';
      details.append(summary, pre);
      box.appendChild(details);
      return box;
    };
    // Every other kind of object (NPCs, scenery, containers, portals, items, traps…).
    const objectCard = obj => card(`<strong>${esc(obj.name || obj.file || 'Unknown object')}</strong><br>` +
      `Object type: ${obj.type} (${esc(obj.typeName || 'unknown')})<br>` +
      (obj.file && obj.file !== obj.name ? `Prototype: ${esc(obj.file)}<br>` : '') +
      `Art ID: ${esc(artText(obj))}` +
      (obj.artFile && obj.artId != null ? ` · ${esc(obj.artFile)}` : '') + (obj.artNote ? ` · ${esc(obj.artNote)}` : '') + '<br>' +
      `F_CURRENT_AID raw: ${esc(fmt(obj.currentAidRaw))}${obj.currentAidRaw != null ? ` · hex ${hex(obj.currentAidRaw)}` : ''}` +
      (obj.sceneryFlags != null ? `<br>Scenery flags: ${hex(obj.sceneryFlags)}` : ''));
    for (const obj of objectsHere) {
      const el = obj.type === 0 ? wallCard(obj) : objectCard(obj);
      el.appendChild(stateAndScripts(obj));
      const inventory = buildOwnerInventory(obj);   // NPC / container contents
      if (inventory) el.appendChild(inventory);
      wallInfoEl.appendChild(el);
    }
    const roofRaw = sector.decoded.roofArtIds ? sector.decoded.roofArtIds[(p.tileY >> 2) * 16 + (p.tileX >> 2)] : 0;
    const roofCell = roofRaw === 0xFFFFFFFF ? 0 : roofRaw;   // all ones = no roof on this cell
    if (roofCell) wallInfoEl.appendChild(card(`<strong>Roof</strong><br>Roof cell ${p.tileX >> 2}, ${p.tileY >> 2} (covers 4 × 4 tiles) · art ID ${roofCell} · hex ${hex(roofCell)}`));
    if (!objectsHere.length && !roofCell) {
      const msg = document.createElement('div'); msg.className = 'sec-mob-info-row'; msg.textContent = mobLoadStarted ? 'No object was loaded on this exact tile.' : 'Objects load at 60% zoom; zoom in or press Display all.'; wallInfoEl.appendChild(msg);
    }
    selected = p; redraw();
  };
  canvas.addEventListener('wheel', event => { event.preventDefault(); const r=canvas.getBoundingClientRect(); zoomAt(event.deltaY < 0 ? 1.18 : 1/1.18, event.clientX-r.left, event.clientY-r.top); }, {passive:false});
  let dragging=false, dragX=0, dragY=0;
  canvas.addEventListener('mousedown', e => {
    if (edit.on) {
      // Edit mode: left button uses the current tool (Move pans; Alt+click picks a tile), middle/right button always pans.
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
      if (e.button === 0) {
        e.preventDefault();
        if (edit.pan) { dragging=true; dragX=e.clientX; dragY=e.clientY; canvas.style.cursor='grabbing'; }
        else if (e.altKey && (edit.tool === 'tile' || edit.tool === 'fill')) pickTileFromMap(e);
        else if (edit.tool === 'eyedropper') inspectTile(e);
        else if (edit.tool === 'paths') pickDoor(e);
        else if (edit.tool === 'mobedit') pickMobToEdit(e);
        else if (edit.tool === 'dialog' || edit.tool === 'quest') { /* panel tools: nothing is placed on the map */ }
        else beginStroke(e);
      }
      else if (e.button === 1 || e.button === 2) { e.preventDefault(); dragging=true; dragX=e.clientX; dragY=e.clientY; canvas.style.cursor='grabbing'; }
      return;
    }
    if (e.button !== 0) return; dragging=true; dragX=e.clientX; dragY=e.clientY; canvas.style.cursor='grabbing';
  });
  canvas.addEventListener('contextmenu', e => { if (edit.on) e.preventDefault(); });
  window.addEventListener('mouseup', () => { dragging=false; canvas.style.cursor = edit.on ? (edit.pan ? 'grab' : 'crosshair') : 'crosshair'; endStroke(); });
  canvas.addEventListener('mousemove', event => {
    if (edit.on && edit.painting && !dragging) { continueStroke(event); return; }
    if (edit.on && !dragging) { const t = sectorAtPoint(event); if (t) { selected = t; scheduleEditRedraw(); } }
    if (dragging) { view.offsetX += event.clientX-dragX; view.offsetY += event.clientY-dragY; dragX=event.clientX; dragY=event.clientY; markGesture(); redraw(); scheduleVisibleArtLoad(); return; }
    const p = sectorAtPoint(event), sector = p && findSector(p.sectorX, p.sectorY);
    if (!sector?.decoded) {
      const cand = mode === 'art' && !edit.on && p && terrainCandidate(p.sectorX, p.sectorY);
      if (!cand) { tip.hidden=true; return; }
      canvas.style.cursor = 'pointer';
      tip.hidden=false; tip.textContent=`Terrain sector ${cand.id} (${cand.x}, ${cand.y}) · ${cand.label} · terrain/${cand.template.path} · click to load`;
      const srT=stage.getBoundingClientRect(); tip.style.left=`${event.clientX-srT.left}px`; tip.style.top=`${event.clientY-srT.top}px`;
      return;
    }
    if (mode === 'art' && !edit.on && !view.loadedSectors.has(secSectorKey(sector))) {
      canvas.style.cursor = view.blankSectors?.has(secSectorKey(sector)) ? 'crosshair' : 'pointer';
      if (view.blankSectors?.has(secSectorKey(sector))) { tip.hidden=true; return; }
      tip.hidden=false; tip.textContent=`Sector ${secSectorLabel(sector)} · click to load`;
      const sr0=stage.getBoundingClientRect(); tip.style.left=`${event.clientX-sr0.left}px`; tip.style.top=`${event.clientY-sr0.top}px`;
      return;
    }
    canvas.style.cursor = edit.on && edit.pan ? 'grab' : 'crosshair';
    const raw=sector.decoded.tiles[p.tileY*64+p.tileX]>>>0, tile=secTileInfo(raw);
    const loadedArt = artTiles.get(raw);
    tip.hidden=false; tip.textContent=`Sector ${p.sectorX},${p.sectorY} · Tile ${p.tileX},${p.tileY} · Art ID ${tile.artId}${tile.name?` · ${tile.name}`:''}${loadedArt?.facadeName?` · frame ${loadedArt.facadeFrame}`:''}`;
    const sr=stage.getBoundingClientRect(); tip.style.left=`${event.clientX-sr.left}px`; tip.style.top=`${event.clientY-sr.top}px`;
  });
  canvas.addEventListener('mouseleave', () => { tip.hidden=true; });
  canvas.addEventListener('click', event => {
    if (edit.on) return; // in edit mode a press changes tiles instead of inspecting them
    if (Math.abs(event.clientX-dragX)+Math.abs(event.clientY-dragY)>6) return;
    const p=sectorAtPoint(event); if(!p) return;
    const sec=findSector(p.sectorX,p.sectorY);
    if (!sec?.decoded) {
      const cand = mode === 'art' && terrainCandidate(p.sectorX, p.sectorY);
      if (cand) loadTerrainSectorAt(cand);
      return;
    }
    if (mode === 'art' && !view.loadedSectors.has(secSectorKey(sec))) {
      if (!view.blankSectors?.has(secSectorKey(sec))) loadSectorTiles(sec);
      return;
    }
    updateInfo(p);
    // Animate mode: a click opens / closes the doors and chests on the tile, and sets traps off.
    if (secObjectAnim.enabled) {
      secObjectAnim.time = performance.now();
      let played = false;
      for (const m of mobPoints) if (m.sectorX === p.sectorX && m.sectorY === p.sectorY && m.tileX === p.tileX && m.tileY === p.tileY && secToggleAction(m)) played = true;
      if (played) redraw();
    }
  });
  zoomOut.addEventListener('click',()=>zoomAt(1/1.4,stage.clientWidth/2,stage.clientHeight/2));
  zoomIn.addEventListener('click',()=>zoomAt(1.4,stage.clientWidth/2,stage.clientHeight/2));

  const scheduleVisibleArtLoad = () => {
    if (mode !== 'art' || !artLoadStarted) return;
    clearTimeout(artLoadTimer);
    artLoadTimer = setTimeout(() => { loadVisibleFolderTileArt().catch(() => {}); }, 80);
  };
  const sectorStatus = () => {
    status.textContent = '';
  };
  // Roofs: load the art of every roof id of the loaded sectors (isometric view only).
  async function ensureRoofArt() {
    if (mode !== 'art' || !overlayVisibility.roofs) return;
    const loaded = valid.filter(s => view.loadedSectors.has(secSectorKey(s)));
    try {
      const r = await loadSecRoofsForSectors(loaded, view.roofArt);
      if (r.missing) status.textContent = `Roofs: ${r.missing} of ${r.requested} roof art ids could not be resolved (check art/roof/*.art and roofname.mes)`;
      else if (r.requested) status.textContent = `Roofs: ${r.requested} distinct roof ids loaded`;
    } catch (err) {
      status.textContent = `Roofs: ${errText(err)}`;
    }
    redraw();
  }
  // Resolves the art of every unique tile in one sector, then reveals it.
  const loadSectorTiles = async sector => {
    const key = secSectorKey(sector);
    if (view.loadedSectors.has(key) || view.loadingSectors.has(key)) return;
    view.loadingSectors.add(key); redraw();
    try {
      await loadSecTileManifest();
      const need = new Set();
      const zeroSector = secSectorAllZero(sector.decoded);
      for (const t of sector.decoded.tiles) { const raw = t >>> 0; if ((raw !== 0 || !zeroSector) && !artTiles.has(raw)) need.add(raw); }
      const results = await Promise.all([...need].map(async raw => ({ raw, art: await loadSecTileArt(secTileInfo(raw)) })));
      for (const { raw, art } of results) if (art) artTiles.set(raw, art);
      view.loadedSectors.add(key);
    } catch (err) {
      status.textContent = `Could not load sector ${secSectorLabel(sector)}: ${errText(err)}`;
    } finally {
      view.loadingSectors.delete(key);
      if (mode === 'art' && view.loadedSectors.has(key)) sectorStatus();
      redraw();
      if (overlayVisibility.roofs) ensureRoofArt();
    }
  };
  const applyMode = async (nextMode) => {
    // The view keeps looking at the same place: remember the tile in the middle (and the zoom
    // in the old projection) before the switch, restore them after it.
    const keep = view.initialized && nextMode !== mode ? { c: centreWorld(), zoom: view.zoom, from: mode } : null;
    mode=nextMode; modeBtn.textContent=mode==='art'?'Top-down view':'Isometric view';
    if (mode === 'art') {
      // Before anything is shown, find the sectors made only of blank tiles.
      if (!view.blankSectors) {
        modeBtn.disabled = true; status.textContent = 'Looking for blank sectors…';
        await new Promise(r => setTimeout(r, 0)); // let the status text paint
        try { view.blankSectors = secDetectBlankSectors(valid); }
        finally { modeBtn.disabled = false; }
      }
      artLoadStarted = true;
      sectorStatus();
    } else {
      status.textContent = '';
    }
    if (!keep) { fitView(); return; }
    // One tile step is about 44 px long in the isometric drawing and 1 px in the top-down one.
    const ISO_PER_TOPDOWN = 44;
    const zoom = Math.max(.01, Math.min(32, mode === 'art' ? keep.zoom / ISO_PER_TOPDOWN : keep.zoom * ISO_PER_TOPDOWN));
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    view.zoom = zoom;
    if (mode === 'art') { const p = secIsoProject(keep.c.x, keep.c.y, iso); view.offsetX = cx - p.x * zoom; view.offsetY = cy - p.y * zoom; }
    else { view.offsetX = cx - (mapW - 1 - keep.c.x + 0.5) * zoom; view.offsetY = cy - (keep.c.y + 0.5) * zoom; }
    redraw();
    if (view.zoom >= 0.6 && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    if (mode === 'art') scheduleVisibleArtLoad();
  };
  modeBtn.addEventListener('click', () => { if (edit.on) return; applyMode(mode === 'color' ? 'art' : 'color'); });
  async function loadVisibleFolderTileArt(){
    const needed=new Set();
    const w=stage.clientWidth,h=stage.clientHeight;
    if (mode === 'art') {
      // Determine which tile centers can fall inside the viewport in
      // isometric coordinates.  Convert the four viewport corners back to
      // tile space, then add a generous margin for diamond edges.
      const corners = [
        secIsoUnproject((-view.offsetX) / view.zoom, (-view.offsetY) / view.zoom, iso),
        secIsoUnproject((w - view.offsetX) / view.zoom, (-view.offsetY) / view.zoom, iso),
        secIsoUnproject((-view.offsetX) / view.zoom, (h - view.offsetY) / view.zoom, iso),
        secIsoUnproject((w - view.offsetX) / view.zoom, (h - view.offsetY) / view.zoom, iso)
      ];
      const minXv=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.x)))-2);
      const maxXv=Math.min(mapW-1,Math.ceil(Math.max(...corners.map(p=>p.x)))+2);
      const minYv=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y)))-2);
      const maxYv=Math.min(mapH-1,Math.ceil(Math.max(...corners.map(p=>p.y)))+2);
      for(const s of valid){
        if (!view.loadedSectors.has(secSectorKey(s))) continue;
        const bx=(s.position.x-minX)*64, by=(s.position.y-minY)*64;
        const x0=Math.max(0,minXv-bx),x1=Math.min(63,maxXv-bx),y0=Math.max(0,minYv-by),y1=Math.min(63,maxYv-by);
        if(x0>x1||y0>y1) continue;
        for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
          const raw = s.decoded.tiles[y*64+x]>>>0;
          if (raw !== 0 || !secSectorAllZero(s.decoded)) needed.add(raw);
        }
      }
    }
    const arr=[...needed].filter(raw=>!artTiles.has(raw));
    if (!arr.length) return;

    // Pre-resolve every unique visible SEC tile before drawing. The ART-file
    // cache above collapses duplicate filenames, so each physical ART is
    // fetched and parsed at most once even when many tile IDs reference it.
    status.textContent=`Resolving ${arr.length} unique visible tiles…`;
    const results = await Promise.all(arr.map(async raw => {
      const art = await loadSecTileArt(secTileInfo(raw));
      return { raw, art };
    }));
    for (const { raw, art } of results) {
      if (art) artTiles.set(raw, art);
    }
    status.textContent='';
    redraw();
  }

  // "Edit" opens a tool bar: Move · Eraser · Tile · Facade · Scenery · Wall · Portal · Ground items · NPCs · Containers.
  //  - Tile / Facade change the 4096-tile list of a sector (facades are tiles of art type 11).
  //  - Scenery / Wall / Portal add or remove *static objects* of the sector (the object list at the
  //    end of the .sec file). A new object only stores its prototype number, F_CURRENT_AID and
  //    F_LOCATION; everything else comes from the prototype.
  //  - Ground items / NPCs / Containers make new .mob files instead (see "new .mob files" below): the game files those
  //    objects apart from the sector.
  // "Export .SEC" writes the original bytes back with only the tile list and the object list replaced, and the new
  // .mob files beside them.
  const hexRaw = raw => `0x${(raw >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

  const ICON_HAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>';
  const ICON_CURSOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5l12.2 9.3-5.4 1 3.1 6-2.6 1.3-3.1-6.1-4.2 3.6z" fill="currentColor"/></svg>';
  const ICON_ERASER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><g transform="rotate(-45 12 11)"><rect x="3.5" y="7.5" width="17" height="7.5" rx="1.6"/><path d="M11 7.5v7.5"/></g><path d="M5 20.5h14"/></svg>';
  const ICON_FILL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4.6 12.2l7.1-7.1 7.2 7.2-6.6 6.6a1.7 1.7 0 0 1-2.4 0l-5.3-5.3a1.7 1.7 0 0 1 0-2.4z"/><path d="M4.6 12.2h14.3"/><path d="M11.7 5.1L9.4 2.8"/><path d="M21 14.6c0 1.3-.9 2.2-1.6 2.2s-1.6-.9-1.6-2.2c0-1.1 1.6-3.1 1.6-3.1s1.6 2 1.6 3.1z" fill="currentColor"/></svg>';
  const ICON_EYEDROPPER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M17.3 2.9a2.2 2.2 0 0 1 3.1 3.1l-2.3 2.3-3.1-3.1z"/><path d="M15 5.2l3.8 3.8"/><path d="M15 6.9l-9.4 9.4a2 2 0 0 0-.55 1.1l-.35 2.7 2.7-.35a2 2 0 0 0 1.1-.55l9.4-9.4"/></svg>';
  const svgIcon = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
  const ICON_TILE = svgIcon('<path d="M12 3.5l8.5 4.6L12 12.7 3.5 8.1z"/><path d="M3.5 12l8.5 4.6 8.5-4.6"/><path d="M3.5 15.9l8.5 4.6 8.5-4.6"/>');
  const ICON_FACADE = svgIcon('<rect x="4" y="4.5" width="16" height="15.5" rx="1"/><path d="M4 9h16"/><path d="M7.5 12h3v3h-3zM13.5 12h3v3h-3z"/><path d="M10.5 20v-2.5h3V20"/>');
  const ICON_SCENERY = svgIcon('<path d="M12 3c-3.3 0-5.3 2.4-5.3 5 0 .9.3 1.7.8 2.4-1 .5-1.7 1.7-1.7 3 0 2.4 2.7 4 6.2 4s6.2-1.6 6.2-4c0-1.3-.7-2.5-1.7-3 .5-.7.8-1.5.8-2.4 0-2.6-2-5-5.3-5z"/><path d="M12 17.4V21"/>');
  const ICON_WALL = svgIcon('<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M3.5 9.7h17M3.5 14.3h17"/><path d="M9 5v4.7M15 9.7v4.6M9 14.3V19"/>');
  const ICON_PORTAL = svgIcon('<path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21"/><path d="M4 21h16"/><circle cx="14.6" cy="12.4" r=".9" fill="currentColor"/>');
  const ICON_GENERATE = svgIcon('<path d="M4 11.5L12 5l8 6.5"/><path d="M6.5 10v9.5h11V10"/><path d="M10.5 19.5v-4.5h3v4.5"/><path d="M18.5 2.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor"/>');
  const ICON_PATHS = svgIcon('<rect x="2.8" y="3.5" width="5.4" height="5" rx=".8"/><rect x="15.8" y="15.5" width="5.4" height="5" rx=".8"/><path d="M5.5 8.5c0 4.5 4 3 6.5 6.5s3.8 3 6.5 3" stroke-dasharray="1.2 2.4"/>');
  const ICON_MOVE = svgIcon('<path d="M12 3v18M3 12h18"/><path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5"/>');
  const ICON_ITEMS = svgIcon('<path d="M9.2 3.8h5.6l-1.1 3h-3.4z"/><path d="M8.6 8.2C6.4 10.7 5 13.2 5 15.8c0 2.9 3 4.7 7 4.7s7-1.8 7-4.7c0-2.6-1.4-5.1-3.6-7.6"/><path d="M10 14.2h4"/>');
  const ICON_NPCS = svgIcon('<circle cx="12" cy="7.6" r="3.3"/><path d="M5.3 20.2c.4-4.1 3-6.6 6.7-6.6s6.3 2.5 6.7 6.6z"/>');
  const ICON_CONTAINERS = svgIcon('<path d="M4 10a8 3.6 0 0 1 16 0"/><rect x="4" y="10" width="16" height="9.5" rx="1"/><path d="M4 13.6h16"/><rect x="10.6" y="12" width="2.8" height="3.2" rx=".5"/>');
  const ICON_MOBEDIT = svgIcon('<circle cx="9.5" cy="7.6" r="3"/><path d="M3.8 19.6c.3-3.7 2.6-5.9 5.7-5.9 1.3 0 2.4.4 3.3 1"/><path d="M14 20.2l.6-3 5.4-5.4 2.4 2.4-5.4 5.4z"/>');
  const ICON_DIALOG = svgIcon('<path d="M4 5.5h16v10.5H11l-4.5 3.8V16H4z"/><path d="M8 9.2h8M8 12.4h5"/>');
  const ICON_QUEST = svgIcon('<path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14.5H8a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M6.5 18a1.5 1.5 0 0 0-1.5 1.5A1.5 1.5 0 0 0 6.5 21H19"/><path d="M10 8h5.5M10 11.2h5.5M10 14.4h3"/>');
  const ICON_STAMP = svgIcon('<rect x="8.5" y="8.5" width="12" height="12" rx="1.4"/><path d="M15.5 8.5V5.2a1.4 1.4 0 0 0-1.4-1.4H5.2a1.4 1.4 0 0 0-1.4 1.4v8.9a1.4 1.4 0 0 0 1.4 1.4h3.3"/><path d="M14.5 11.5v6M11.5 14.5h6"/>');
  const ICON_ROOF = svgIcon('<path d="M2.5 12.5L12 4l9.5 8.5"/><path d="M5 11v8.5h14V11"/><path d="M7 14.5l3-3M11 14.5l3-3M15 14.5l2.5-2.5"/>');
  const ICON_LIGHT = svgIcon('<path d="M9 17.5h6M10 20.5h4"/><path d="M12 3.2a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.1v1.4h5v-1.4c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3.2z"/>');
  const ICON_BLOCK = svgIcon('<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M6.5 17.5l11-11"/><path d="M6.5 10.5l4-4M13.5 17.5l4-4"/>');
  const ICON_SECTOR = svgIcon('<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><path d="M12 3.5v17M3.5 12h17"/><path d="M15.5 14.5l2 2 3-3.6"/>');
  const ICON_MAPDATA = svgIcon('<path d="M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/><path d="M17.5 8.7v.1"/>');
  // Tools that share one button: it shows the one used last (the first of the list by default); a long press, or a right
  // click, opens the list to pick another. The names are the ones the list shows.
  const TOOL_GROUPS = [['tile', 'facade'], ['wall', 'portal'], ['roof', 'light'], ['block', 'sector', 'mapdata'], ['dialog', 'quest']];
  const TOOL_NAMES = { tile: 'Tiles', facade: 'Facades', wall: 'Walls', portal: 'Doors and windows', roof: 'Roofs', light: 'Lights', block: 'Blocked tiles', sector: 'Sector and tile scripts', mapdata: 'Map: start and jump points', dialog: 'Dialog', quest: 'Quest' };
  const TOOLS = [
    { id: 'move', icon: ICON_MOVE, title: 'Move objects: press on a tile and drag - its scenery (else its walls with their doors and windows) goes to the tile where you release' },
    { id: 'eraser', icon: ICON_ERASER, title: 'Eraser: removes the scenery, then the portal, then the wall of a tile (never the tile or facade)' },
    { id: 'fill', icon: ICON_FILL, title: 'Fill: replaces the clicked tile and every identical tile connected to it (paint bucket)' },
    { id: 'eyedropper', icon: ICON_EYEDROPPER, title: 'Eyedropper: lists everything on a tile; click an entry to open its tool with it selected' },
    { id: 'stamp', icon: ICON_STAMP, title: 'Copy and paste: drag a rectangle to copy its tiles, objects, lights and roofs, then click to paste the copy wherever you like (Shift snaps to whole roof cells)' },
    { id: 'tile', icon: ICON_TILE, sep: true, title: 'Tile: pick a ground tile and paint it' },
    { id: 'facade', icon: ICON_FACADE, title: 'Facade: stamp a whole facade' },
    { id: 'scenery', icon: ICON_SCENERY, title: 'Scenery: trees, rocks, lamps…' },
    { id: 'wall', icon: ICON_WALL, title: 'Wall: draw on tile edges (top-down view)' },
    { id: 'portal', icon: ICON_PORTAL, title: 'Portal: doors and windows, placed on an existing wall' },
    { id: 'items', name: SEC_MOB_KINDS.items.name, icon: ICON_ITEMS, sep: true, title: 'Ground items: weapons, armor, food, gold... lying on a tile. Each one is exported as a new .mob file' },
    { id: 'npcs', name: SEC_MOB_KINDS.npcs.name, icon: ICON_NPCS, title: 'NPCs: a creature or person standing on a tile. Each one is exported as a new .mob file' },
    { id: 'containers', name: SEC_MOB_KINDS.containers.name, icon: ICON_CONTAINERS, title: 'Containers: chests, barrels, crates (empty). Each one is exported as a new .mob file' },
    { id: 'mobedit', icon: ICON_MOBEDIT, title: 'Edit NPC / container: click one on the map to change its attributes, flags, inventory and scripts. The changed file is exported (a placed NPC or container with its new .mob file, one of the map with a replacement of its file)' },
    { id: 'generate', icon: ICON_GENERATE, sep: true, title: 'Generate: a whole building of a kind the game has (inn, store, warehouse...) - walls, door, windows, rooms, roof and the furniture the game gives that kind' },
    { id: 'paths', icon: ICON_PATHS, title: 'Paths: pick the doors of houses and lay natural-looking paths between them' },
    { id: 'roof', icon: ICON_ROOF, sep: true, title: 'Roofs: paint or erase the roof of a building (cells of 4 x 4 tiles) in any style the game has, fitted to the roofs around it' },
    { id: 'light', icon: ICON_LIGHT, title: "Lights: place the glow of a lamp, a fire, the moon, daylight or a shadow on a tile, as the game's sectors keep them" },
    { id: 'block', icon: ICON_BLOCK, title: 'Blocked tiles: mark tiles nobody can walk on (cliffs, water, the edge of a sector), or open them again' },
    { id: 'sector', icon: ICON_SECTOR, title: "Sector: a sector's script, town map, light scheme, sounds and aptitude; scripts on single tiles (traps, triggers)" },
    { id: 'mapdata', icon: ICON_MAPDATA, title: 'Map: the start location, the jump points to other maps and the blocked sectors of the map' },
    { id: 'dialog', icon: ICON_DIALOG, sep: true, title: 'Dialog: write what an NPC says and the choices the player has, each with what it needs, does and leads to. Exported as a .dlg file with its script' },
    { id: 'quest', icon: ICON_QUEST, title: 'Quest: write the logbook text of a quest, to start, advance or finish from a dialog. Exported in the logbook (gamequestlog.mes)' }
  ];

  const PROTO_TYPE = { wall: 0, portal: 1, scenery: 3 };
  const MOB_ITEM_KINDS = [[5, 'Weapons'], [6, 'Ammo'], [7, 'Armor'], [8, 'Gold'], [9, 'Food'], [10, 'Scrolls'], [11, 'Keys'], [12, 'Key rings'], [13, 'Written (books, notes)'], [14, 'Other (tools, potions...)']];
  // the armor part (bits 20-23) of a critter's art id, in the game's order (name.c)
  const NPC_OUTFITS = ['Underwear', 'Villager', 'Leather armor', 'Chain mail', 'Plate armor', 'Robe', 'Plate armor (classic)', 'Barbarian', 'City dweller'];
  const optList = (n, f) => Array.from({ length: n }, (_, i) => `<option value="${i}">${f ? f(i) : i}</option>`).join('');
  const PANE_OPTIONS = {
    facade: '<label>Columns <input type="number" class="sec-opt-cols" min="1" max="64" value="1"></label><label><input type="checkbox" class="sec-opt-walk" checked> Walkable</label><label><input type="checkbox" class="sec-opt-swap"> Swap axes</label><label class="sec-opt-wide sec-opt-group" title="Some facades are the parts of one bigger thing (a ship, a castle...). Ticked: the list shows each of those once, and a click stamps all its parts, each where the game puts it"><input type="checkbox" class="sec-opt-whole" checked> <span>Whole structure</span></label>',
    scenery: `<label>Rotation <select class="sec-opt-rot"><option value="proto">As prototype</option>${optList(8)}</select></label><label class="sec-opt-wide">Base prototype <select class="sec-opt-base"><option value="">(scanning prototypes…)</option></select></label>`,
    wall: `<div class="sec-wall-brushes sec-opt-wide" role="group" aria-label="Wall brush"><span>Draw</span><button type="button" class="sec-wall-brush" data-brush="edge" aria-pressed="false" title="One edge at a time: click or drag along tile edges">Edge</button><button type="button" class="sec-wall-brush" data-brush="line" aria-pressed="true" title="Straight line: press where it starts, release where it ends">Line</button><button type="button" class="sec-wall-brush" data-brush="house" aria-pressed="false" title="House: press on one corner, release on the opposite one. Draws the four walls with their corner pieces and a roof over them">House</button></div><label class="sec-opt-wide sec-opt-floors" title="With the House brush: lays the floor the game gives a house of this wall style (every tile inside the walls)"><input type="checkbox" class="sec-opt-floor" checked disabled> Floor tiles</label><label class="sec-opt-wide sec-opt-placeholders" title="With the House brush: also puts the door, the windows and the furniture the game gives a house of this wall style"><input type="checkbox" class="sec-opt-ph" disabled> Placeholder houses</label><label class="sec-opt-wide sec-opt-shapes" title="With placeholder houses: the house may be an L, T, U... shape (as the game's are) instead of a rectangle. Drawn on the roof grid. The roof always goes with the walls; when it is one whose inner corners the game never closes (the brick parapets, snow, sea...), the house stays a rectangle."><input type="checkbox" class="sec-opt-shapes-on" checked disabled> Varied shapes (L, T, U...)</label><div class="sec-house-actions sec-opt-wide" role="group" aria-label="Last placeholder house"><button type="button" class="sec-house-regen" disabled title="Draw new furniture in the last placeholder house">Generate again</button><button type="button" class="sec-house-turn" disabled title="Move the front door of the last placeholder house to the next side (NE, SE, SW, NW), with new furniture">Turn</button></div><label>Piece<select class="sec-opt-piece"><option value="auto">Auto</option>${optList(WALL_PIECES.length, i => `${i} · ${WALL_PIECES[i]}`)}</select></label><label>Variation <select class="sec-opt-var">${optList(4)}</select></label><label class="sec-opt-wide">House roof <select class="sec-opt-roof"><option value="auto">Auto (the map's usual roof)</option><option value="none">No roof</option></select></label><label class="sec-opt-wide">Base prototype <select class="sec-opt-base"><option value="">(scanning prototypes…)</option></select></label>`,
    portal: `<label class="sec-opt-wide">Base prototype <select class="sec-opt-base"><option value="">(scanning prototypes…)</option></select></label>`,
    // the .mob tools: what is listed is every prototype of the kind, named as the game names it
    items: `<label class="sec-opt-wide">Kind <select class="sec-mob-category" aria-label="Kind of item"><option value="all">All items</option>${MOB_ITEM_KINDS.map(([t, n]) => `<option value="${t}">${n}</option>`).join('')}</select></label><label class="sec-opt-wide" title="The item lies where you click inside the tile (its pixel offset). Unticked, it lies on the tile's centre"><input type="checkbox" class="sec-mob-drop" checked> Drop where clicked</label><label class="sec-opt-wide sec-mob-qty-row" title="How many coins (gold) or rounds (ammo) the pile holds" hidden>Quantity <input type="number" class="sec-mob-qty" min="1" max="1000000000" value="1"></label>`,
    npcs: `<label class="sec-opt-wide" title="The clothes the NPC is drawn in: the critter art the game shows (not an item in its inventory). 'As prototype' keeps the art of the prototype - underwear for most people. Monsters have no clothes to change; an outfit that has no art for this body is greyed out"><span>Outfit</span> <select class="sec-npc-outfit" aria-label="Outfit"><option value="proto">As prototype</option>${NPC_OUTFITS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>`,
    containers: ''
  };
  const paneHtml = kind => `
      <section class="sec-tool-pane" data-pane="${kind}" hidden>
        <div class="sec-edit-filters"><input type="search" class="sec-edit-search" placeholder="Search name or number…" aria-label="Search"></div>
        <p class="sec-edit-note"></p>
        <div class="sec-edit-controls">${PANE_OPTIONS[kind]}</div>
        <div class="sec-pal-status"></div>
        <div class="sec-edit-tiles" role="listbox"></div>
      </section>`;
  // Brush size, Photoshop style: a slider plus the exact value (n x n tiles).
  const brushRowHtml = '<div class="sec-brush-row"><span class="sec-brush-label">Size</span><input type="range" class="sec-brush-range" min="1" max="64" step="1" value="1" aria-label="Brush size"><input type="number" class="sec-brush-num" min="1" max="64" value="1" aria-label="Brush size in tiles" title="Brush size in tiles (n × n)"></div>';
  const editPanel = document.createElement('div');
  editPanel.className = 'sec-edit-panel'; editPanel.hidden = true;
  editPanel.innerHTML = `
      <h3 class="sec-panel-title">Tile</h3>
      <div class="sec-tool-bar" role="toolbar" aria-label="Editing tools"><button type="button" class="sec-tool sec-tool-mode" data-mode="pan" title="Move: while it is on, left-drag moves the map and nothing is placed (middle / right-drag always moves it)" aria-label="move" aria-pressed="false">${ICON_HAND}</button><span class="sec-tool-sep" aria-hidden="true"></span>${TOOLS.map(t =>
      `${t.sep ? '<span class="sec-tool-sep" aria-hidden="true"></span>' : ''}<button type="button" class="sec-tool" data-tool="${t.id}" title="${t.title}" aria-label="${t.id}" aria-pressed="false">${t.icon || `<span class="sec-tool-label">${t.label}</span>`}</button>`).join('')}</div>
      <section class="sec-tool-pane" data-pane="tile" hidden>
        <div class="sec-edit-filters"><input type="search" class="sec-edit-search" placeholder="Search name or number…" aria-label="Search tiles"></div>
        ${brushRowHtml}
        <p class="sec-edit-note"></p>
        <div class="sec-edit-controls">
          <label>Variation <select class="sec-edit-variation"></select></label>
          <label title="Where outdoor terrains meet, rebuild the neighbouring tiles as the transition (edge) tiles the game uses"><input type="checkbox" class="sec-edit-blend" checked> Blend transitions</label>
        </div>
        <div class="sec-edit-filters">
          <select class="sec-edit-category" aria-label="Tile category">
            <option value="all">All tiles</option>
            <option value="0">Outdoor · 0–99</option>
            <option value="1">Outdoor · 100–199</option>
            <option value="2">Indoor · 200–299</option>
            <option value="3">Indoor · 300–399</option>
          </select>
          <label class="sec-edit-used"><input type="checkbox" class="sec-edit-used-only"> Only tiles used on this map</label>
        </div>
        <div class="sec-edit-tiles" role="listbox" aria-label="Game tiles"></div>
      </section>
      <section class="sec-tool-pane" data-pane="move" hidden>
        <p class="sec-eye-head">Press on a tile and drag: what is on it goes to the tile where you release - its scenery, or when it has none its doors and windows with their walls. Everything else about them stays (prototype, art, offset, flags). Ctrl+Z undoes it.</p>
      </section>
      <section class="sec-tool-pane" data-pane="eraser" hidden>${brushRowHtml}</section>
      <section class="sec-tool-pane" data-pane="eyedropper" hidden>
        <p class="sec-eye-head">Click a tile on the map to see what is on it.</p>
        <div class="sec-eye-list" role="list"></div>
      </section>
      ${['facade', 'scenery', 'wall', 'portal', ...Object.keys(SEC_MOB_KINDS)].map(paneHtml).join('')}
      <section class="sec-tool-pane" data-pane="stamp" hidden></section>
      <section class="sec-tool-pane" data-pane="roof" hidden></section>
      <section class="sec-tool-pane" data-pane="light" hidden></section>
      <section class="sec-tool-pane" data-pane="block" hidden>${brushRowHtml}</section>
      <section class="sec-tool-pane" data-pane="sector" hidden></section>
      <section class="sec-tool-pane" data-pane="mapdata" hidden></section>
      <section class="sec-tool-pane" data-pane="mobedit" hidden></section>
      <section class="sec-tool-pane" data-pane="dialog" hidden></section>
      <section class="sec-tool-pane" data-pane="quest" hidden></section>
      <section class="sec-tool-pane" data-pane="paths" hidden>
        <p class="sec-eye-head sec-path-info"></p>
        <p class="sec-edit-note sec-path-ground"></p>
        <div class="sec-edit-controls">
          <label>Width <input type="number" class="sec-path-width" min="1" max="8" value="3"></label>
          <label title="0: as direct as the houses allow · 100: winding">Winding <input type="range" class="sec-path-wind" min="0" max="100" value="50"></label>
        </div>
        <div class="sec-house-actions">
          <button type="button" class="sec-path-draw" disabled title="Lay the paths with the ground tile picked in the Tile tool (Trodden Dirt when none). Press again for another layout; Ctrl+Z undoes it">Draw paths</button>
          <button type="button" class="sec-path-clear" disabled title="Forget the chosen doors">Clear doors</button>
        </div>
      </section>
      <section class="sec-tool-pane" data-pane="generate" hidden>
        <p class="sec-eye-head">Pick what to build, then press on one corner of it on the map and release on the opposite one. It gets the walls, door, windows, rooms, roof and furniture of the game's buildings of that kind.</p>
        <div class="sec-edit-controls">
          <div class="sec-opt-wide sec-gen-walls"><span>Walls</span><select class="sec-gen-style" aria-label="Walls of the building"><option value="auto">Auto</option>${Object.entries(HOUSE_STYLES).map(([n, s]) => `<option value="${n}">${s.name}</option>`).join('')}</select><small class="sec-gen-walls-note">Auto: the walls the game's buildings of that kind have</small></div>
          <label class="sec-opt-wide" title="The building may be an L, T, U... shape (as the game's are) instead of a rectangle"><input type="checkbox" class="sec-gen-shapes" checked> Varied shapes (L, T, U...)</label>
          <div class="sec-house-actions sec-opt-wide" role="group" aria-label="Last building"><button type="button" class="sec-gen-regen" disabled title="Draw new furniture in the last building">Generate again</button><button type="button" class="sec-gen-turn" disabled title="Move the front door of the last building to the next side (NE, SE, SW, NW), with new furniture">Turn</button></div>
        </div>
        <div class="sec-gen-list" role="listbox" aria-label="Kinds of building">${HOUSE_KIND_LIST.map(k => `<button type="button" class="sec-gen-kind" data-kind="${k.id}" aria-pressed="false" title="${k.n} in the game"><span>${k.name}</span><small>${k.n}</small></button>`).join('')}</div>
      </section>`;
  info.appendChild(editPanel);
  const q1 = (root, sel) => root.querySelector(sel);
  const panes = {};
  for (const el of editPanel.querySelectorAll('.sec-tool-pane')) panes[el.dataset.pane] = el;
  const ui = {
    toolBar: q1(editPanel, '.sec-tool-bar'),
    title: q1(editPanel, '.sec-panel-title'),
    toolBtns: [...editPanel.querySelectorAll('.sec-tool[data-tool]')],
    panBtn: q1(editPanel, '.sec-tool-mode'),
    sizeRanges: [...editPanel.querySelectorAll('.sec-brush-range')],
    sizeNums: [...editPanel.querySelectorAll('.sec-brush-num')],
    tileBrushRow: q1(panes.tile, '.sec-brush-row'),
    note: q1(panes.tile, '.sec-edit-note'),
    variation: q1(panes.tile, '.sec-edit-variation'),
    blend: q1(panes.tile, '.sec-edit-blend'),
    pathInfo: q1(panes.paths, '.sec-path-info'),
    pathGround: q1(panes.paths, '.sec-path-ground'),
    pathWidth: q1(panes.paths, '.sec-path-width'),
    pathWind: q1(panes.paths, '.sec-path-wind'),
    pathDraw: q1(panes.paths, '.sec-path-draw'),
    pathClear: q1(panes.paths, '.sec-path-clear'),
    search: q1(panes.tile, '.sec-edit-search'),
    category: q1(panes.tile, '.sec-edit-category'),
    usedOnly: q1(panes.tile, '.sec-edit-used-only'),
    list: q1(panes.tile, '.sec-edit-tiles')
  };
  // per-palette references (facade, scenery, wall, portal)
  const pk = {};
  for (const kind of ['facade', 'scenery', 'wall', 'portal']) {
    const pane = panes[kind];
    pk[kind] = {
      pane, built: false, rendered: -1, obs: null,
      meta: q1(pane, '.sec-edit-note'),
      brushBtns: kind === 'wall' ? [...pane.querySelectorAll('.sec-wall-brush')] : null,
      search: q1(pane, '.sec-edit-search'), status: q1(pane, '.sec-pal-status'), list: q1(pane, '.sec-edit-tiles'),
      cols: q1(pane, '.sec-opt-cols'), walk: q1(pane, '.sec-opt-walk'), swap: q1(pane, '.sec-opt-swap'), whole: q1(pane, '.sec-opt-whole'),
      rot: q1(pane, '.sec-opt-rot'), roof: q1(pane, '.sec-opt-roof'), placeholders: q1(pane, '.sec-opt-ph'), shapes: q1(pane, '.sec-opt-shapes-on'), floor: q1(pane, '.sec-opt-floor'), base: q1(pane, '.sec-opt-base'), piece: q1(pane, '.sec-opt-piece'), variation: q1(pane, '.sec-opt-var'),
      regen: q1(pane, '.sec-house-regen'), turn: q1(pane, '.sec-house-turn')
    };
  }
  // per-palette references of the .mob tools (items, npcs, containers)
  const mk = {};
  for (const kind of Object.keys(SEC_MOB_KINDS)) {
    const pane = panes[kind];
    mk[kind] = {
      pane, built: false, obs: null, meta: q1(pane, '.sec-edit-note'), search: q1(pane, '.sec-edit-search'),
      status: q1(pane, '.sec-pal-status'), list: q1(pane, '.sec-edit-tiles'), category: q1(pane, '.sec-mob-category'), drop: q1(pane, '.sec-mob-drop'),
      qty: q1(pane, '.sec-mob-qty'), qtyRow: q1(pane, '.sec-mob-qty-row'), outfit: q1(pane, '.sec-npc-outfit')
    };
  }
  // Wall brushes: Edge (one edge at a time), Line, House (four walls with their corners, and a roof).
  // The shapes come from the placeholder plan, so that box is on only for a House with placeholders.
  const syncShapesBox = () => { pk.wall.shapes.disabled = edit.wallBrush !== 'house' || !pk.wall.placeholders.checked; };
  const setWallBrush = brush => {
    edit.wallBrush = brush;
    for (const b of pk.wall.brushBtns) b.setAttribute('aria-pressed', String(b.dataset.brush === brush));
    pk.wall.placeholders.disabled = pk.wall.floor.disabled = brush !== 'house';   // only a House has a floor and a door to put
    syncShapesBox();
    if (brush === 'house' &&pk.wall.placeholders.checked) secStartProtoScan();
    status.textContent = brush === 'house' ? 'House: press on one corner, release on the opposite one' : brush === 'edge' ? 'Edge: click or drag along tile edges' : 'Line: press where it starts, release where it ends';
  };
  for (const b of pk.wall.brushBtns) b.addEventListener('click', () => setWallBrush(b.dataset.brush));
  // The door, windows and furniture are prototypes: start the scan now, so it is done by the time a house is drawn.
  pk.wall.placeholders.addEventListener('change', () => { syncShapesBox(); if (pk.wall.placeholders.checked) secStartProtoScan(); });
  // Generate: the kind of building to put (HOUSE_KIND_LIST: what the game's houses were told to be, by their sign or what
  // is in them), its walls (Auto: walls the game's buildings of that kind have, as often as they have them)
  const gen = {
    style: q1(panes.generate, '.sec-gen-style'), note: q1(panes.generate, '.sec-gen-walls-note'), shapes: q1(panes.generate, '.sec-gen-shapes'),
    regen: q1(panes.generate, '.sec-gen-regen'), turn: q1(panes.generate, '.sec-gen-turn'), kinds: [...panes.generate.querySelectorAll('.sec-gen-kind')]
  };
  for (const b of gen.kinds) b.addEventListener('click', () => {
    edit.genKind = b.dataset.kind;
    for (const o of gen.kinds) o.setAttribute('aria-pressed', String(o === b));
    const k = HOUSE_KIND_LIST.find(q => q.id === edit.genKind);
    // the walls the game's buildings of this kind have come first, with how many, then all the others
    const keep = gen.style.value, used = Object.entries(k.styles).sort((p, q) => q[1] - p[1]).filter(([s]) => HOUSE_STYLES[s]);
    const opt = (n, text) => `<option value="${n}">${text}</option>`;
    gen.style.innerHTML = opt('auto', 'Auto') + (used.length ? `<optgroup label="Used by the game's ${k.name.toLowerCase()}s">${used.map(([s, c]) => opt(s, `${HOUSE_STYLES[s].name} · ${c}`)).join('')}</optgroup>` : '')
      + `<optgroup label="Other walls">${Object.entries(HOUSE_STYLES).filter(([n]) => !k.styles[n]).map(([n, s]) => opt(n, s.name)).join('')}</optgroup>`;
    gen.style.value = [...gen.style.options].some(o => o.value === keep) ? keep : 'auto';
    gen.note.textContent = `Auto: ${used.slice(0, 3).map(([s]) => HOUSE_STYLES[s].name).join(', ')}${used.length > 3 ? '…' : ''}, as often as the game's ${k.name.toLowerCase()}s have them`;
    secStartProtoScan();
    status.textContent = `${k.name}: press on one corner, release on the opposite one`;
  });
  // The roof styles of art/roof/roofname.mes, for the House brush.
  loadSecRoofNames().then(names => {
    for (const [i, name] of Object.entries(names)) if (name) pk.wall.roof.insertAdjacentHTML('beforeend', `<option value="${i}">${i} · ${String(name).replace(/[&<>"]/g, '')}</option>`);
  }).catch(() => {});
  ui.variation.innerHTML = '<option value="auto">Auto (mix)</option>' + 'abcdefgh'.split('').map((c, i) => `<option value="${i}">${c}</option>`).join('');
  ui.variation.value = 'auto';    // default: mix every variant that exists

  // Keep the tool labels inside their square whatever the width of the panel.
  const fitToolLabels = () => {
    const w = ui.toolBtns[0].clientWidth;
    if (w > 0) ui.toolBar.style.setProperty('--tool-font', `${Math.max(6, Math.min(11, w * 0.19)).toFixed(1)}px`);
  };
  new ResizeObserver(fitToolLabels).observe(ui.toolBar);

  // A plain (non-blended) tile: num1 = num2 = the chosen tile, so every corner uses it.
  // Layout (decodeSecTileArtId): num1 22-27 · num2 16-21 · a3 12-15 · a4 9-11 ·
  // type 8 (1 = outdoor) · flippable1 7 · flippable2 6 · palette 4-5 · mirror 0.
  // tilename.mes ids: 0-99 outdoor+flippable, 100-199 outdoor, 200-299 indoor+flippable, 300-399 indoor.
  const plainTileRaw = (artId, a4) => {
    const group = Math.floor(artId / 100), num = artId % 100;
    const type = group < 2 ? 1 : 0, flip = group % 2 === 0 ? 1 : 0;
    return ((num << 22) | (num << 16) | (edit.plainA3 << 12) | (a4 << 9) | (type << 8) | (flip << 7) | (flip << 6)) >>> 0;
  };
  // Plain tiles in existing sectors tell us whether the game stores them with a3 = 0 or 15.
  const detectPlainA3 = () => {
    const counts = new Map();
    for (const s of valid) {
      const t = s.decoded.tiles;
      for (let i = 0; i < t.length; i++) {
        const raw = t[i] >>> 0;
        if (artType(raw)) continue;
        if (((raw >>> 22) & 63) !== ((raw >>> 16) & 63)) continue;
        const a3 = (raw >>> 12) & 15;
        if (a3 === 0 || a3 === 15) counts.set(a3, (counts.get(a3) || 0) + 1);
      }
    }
    edit.plainA3 = (counts.get(15) || 0) > (counts.get(0) || 0) ? 15 : 0;
  };

  // Which ART variants (a4 = 0..7 -> letters a..h) exist for a plain tile.
  const variantCache = new Map(), thumbCache = new Map();
  const variantArt = async (artId, a4) => {
    const raw = plainTileRaw(artId, a4);
    const tile = secTileInfo(raw);
    const manifest = await loadSecTileManifest();
    const names = secTileArtFilename(tile);
    if (manifest.size && names.length && !manifest.has(String(names[0]).toLowerCase())) return null;
    const art = await loadSecTileArt(tile);
    return art ? { a4, raw, art } : null;
  };
  const resolveVariants = async artId => {
    if (variantCache.has(artId)) return variantCache.get(artId);
    const out = [];
    for (let a4 = 0; a4 < 8; a4++) { const v = await variantArt(artId, a4); if (v) out.push(v); }
    variantCache.set(artId, out);
    return out;
  };
  const firstVariant = async artId => {
    if (thumbCache.has(artId)) return thumbCache.get(artId);
    let found = null;
    for (let a4 = 0; a4 < 8 && !found; a4++) found = await variantArt(artId, a4);
    thumbCache.set(artId, found);
    return found;
  };
  const drawThumb = (cv, art) => {
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height); c.imageSmoothingEnabled = false;
    if (!art?.canvas) return false;
    const k = Math.min(cv.width / art.canvas.width, cv.height / art.canvas.height, 1);
    const w = art.canvas.width * k, h = art.canvas.height * k;
    c.drawImage(art.canvas, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
    return true;
  };

  const showBrush = () => {
    // The chosen tile is highlighted in the list below; this line only adds what the list cannot show.
    const b = edit.brush;
    ui.note.textContent = !b ? ''
      : b.custom ? `Picked from the map: ${b.name || 'unnamed tile'} (${hexRaw(b.raw)})`
      : (b.variants.length ? `${b.variants.length} variant${b.variants.length === 1 ? '' : 's'}: ${b.variants.map(v => 'abcdefgh'[v.a4]).join(' ')}` : 'no ART file found – draws blank');
  };
  const markActiveTile = () => {
    ui.list.querySelectorAll('.sec-edit-tile.active').forEach(el => el.classList.remove('active'));
    if (edit.brush && !edit.brush.custom) ui.list.querySelector(`.sec-edit-tile[data-art="${edit.brush.artId}"]`)?.classList.add('active');
  };
  const selectPaletteTile = async (artId, name) => {
    const variants = await resolveVariants(artId);
    for (const v of variants) artTiles.set(v.raw, v.art);
    edit.brush = { custom: false, artId, name, variants, fallbackRaw: plainTileRaw(artId, 0) };
    showBrush(); markActiveTile();
    status.textContent = `Brush: #${artId}${name ? ` ${name}` : ''} · left-drag to paint`;
  };
  const pickTileFromMap = async event => {
    const t = worldTileAt(event); if (!t) return;
    const at = sectorAtWorld(t.wx, t.wy); if (!at) return;
    const raw = at.sec.decoded.tiles[at.idx] >>> 0;
    const tinfo = secTileInfo(raw);
    if (!artTiles.has(raw)) { const art = await loadSecTileArt(tinfo); if (art) artTiles.set(raw, art); }
    edit.brush = { custom: true, raw, name: tinfo.name, artId: tinfo.artId };
    showBrush(); markActiveTile();
    status.textContent = `Picked ${tinfo.name || 'tile'} (${hexRaw(raw)}) from the map`;
  };
  const brushRawAt = (wx, wy) => {
    const b = edit.brush;
    if (b.custom) return b.raw;
    let list = b.variants;
    if (!list.length) return b.fallbackRaw;
    if (edit.variation !== 'auto') {
      const match = list.filter(v => v.a4 === Number(edit.variation));
      list = match.length ? match : [list[0]];
    }
    return scatterRaw(list, wx, wy);
  };
  // Position-based scatter: stable, so undo/redo and re-painting never shuffle the tiles.
  const scatterRaw = (list, wx, wy) => {
    if (list.length === 1) return list[0].raw;
    let h = (Math.imul(wx, 73856093) ^ Math.imul(wy, 19349663)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    return list[(h >>> 8) % list.length].raw;
  };

  // World tile coordinates are map-local: x = 0 is the right-most tile column, y = 0 the top row.
  // Top-down: column = mapW-1-x. Isometric: secIsoProject(x, y).
  const worldFloat = event => {
    const r = canvas.getBoundingClientRect();
    const sx = (event.clientX - r.left - view.offsetX) / view.zoom, sy = (event.clientY - r.top - view.offsetY) / view.zoom;
    let fx, fy;
    if (mode === 'art') { const p = secIsoUnproject(sx, sy, iso); fx = p.x; fy = p.y; }
    else { fx = mapW - 1 - (sx - 0.5); fy = sy - 0.5; }
    const wx = Math.round(fx), wy = Math.round(fy);
    return (wx < 0 || wy < 0 || wx >= mapW || wy >= mapH) ? null : { fx, fy, wx, wy };
  };
  const worldTileAt = event => { const f = worldFloat(event); return f ? { wx: f.wx, wy: f.wy } : null; };
  const sectorAtWorld = (wx, wy) => {
    if (wx < 0 || wy < 0 || wx >= mapW || wy >= mapH) return null;
    const sec = findSector(minX + (wx >> 6), minY + (wy >> 6));
    // Terrain-generated sectors are templates shared by many places: never edited or exported.
    return sec?.decoded && !sec.terrain ? { sec, idx: (wy & 63) * 64 + (wx & 63) } : null;
  };
  // nearest tile edge (dir 0..3 = NE, SE, SW, NW) to a continuous world position
  const edgeFromFloat = f => {
    const mids = [[f.wx - 0.5, f.wy], [f.wx, f.wy + 0.5], [f.wx + 0.5, f.wy], [f.wx, f.wy - 0.5]];
    let best = 0, bd = Infinity;
    mids.forEach((m, i) => { const d = (m[0] - f.fx) ** 2 + (m[1] - f.fy) ** 2; if (d < bd) { bd = d; best = i; } });
    return { wx: f.wx, wy: f.wy, dir: best };
  };
  const wxOf = p => (p.sectorX - minX) * 64 + p.tileX;
  const wyOf = p => (p.sectorY - minY) * 64 + p.tileY;

  let objIndex = null, edgeIndex = null;
  const invalidateObjIdx = () => { objIndex = null; edgeIndex = null; };
  const idxPush = (m, k, p) => { const arr = m.get(k); if (arr) arr.push(p); else m.set(k, [p]); };
  const idxDrop = (m, k, p) => { const arr = m.get(k); if (!arr) return; const i = arr.indexOf(p); if (i >= 0) arr.splice(i, 1); };
  const indexAdd = p => {
    if (objIndex && (p.type === 0 || p.type === 1 || p.type === 3)) idxPush(objIndex, `${wxOf(p)},${wyOf(p)}`, p);
    if (edgeIndex && (p.type === 0 || p.type === 1)) { const k = edgeKeyOf(p); if (k != null) idxPush(edgeIndex, k, p); }
  };
  const indexRemove = p => {
    if (objIndex) idxDrop(objIndex, `${wxOf(p)},${wyOf(p)}`, p);
    if (edgeIndex) { const k = edgeKeyOf(p); if (k != null) idxDrop(edgeIndex, k, p); }
  };
  const getObjIndex = () => {
    if (objIndex) return objIndex;
    objIndex = new Map();
    for (const p of mobPoints) {
      if (p.type !== 0 && p.type !== 1 && p.type !== 3) continue;
      const k = `${wxOf(p)},${wyOf(p)}`;
      const arr = objIndex.get(k); if (arr) arr.push(p); else objIndex.set(k, [p]);
    }
    return objIndex;
  };
  const objectsAt = (wx, wy) => getObjIndex().get(`${wx},${wy}`) || [];
  const edgeKeyOf = p => { const rot = secEdgeRotation(p) ?? p.__rot; return rot == null ? null : secEdgeKey(wxOf(p), wyOf(p), (rot >> 1) & 3); };
  const getEdgeIndex = () => {
    if (edgeIndex) return edgeIndex;
    edgeIndex = new Map();
    for (const p of mobPoints) {
      if (p.type !== 0 && p.type !== 1) continue;
      const k = edgeKeyOf(p); if (k == null) continue;
      const arr = edgeIndex.get(k); if (arr) arr.push(p); else edgeIndex.set(k, [p]);
    }
    return edgeIndex;
  };
  const objectsReady = async () => {
    if (edit.objectsReady) return;
    await loadMobDataAtZoom();
    // Remember which serialized object each static point came from (valid until the first edit).
    for (const p of mobPoints) {
      if (p.staticSecObject && p.seq >= 0 && !p.__obj) p.__obj = findSector(p.sectorX, p.sectorY)?.decoded?.staticObjects?.[p.seq];
    }
    const counts = new Map();
    for (const p of mobPoints) if (p.type === 0 && p.wallDecode && Number.isInteger(p.wallDecode.piece)) counts.set(p.wallDecode.piece, (counts.get(p.wallDecode.piece) || 0) + 1);
    let bestPiece = 0, bestN = 0;
    for (const [pc, n] of counts) if (n > bestN) { bestN = n; bestPiece = pc; }
    edit.commonPiece = bestPiece;
    edit.objectsReady = true;
    invalidateObjIdx();
  };
  const prepSector = sec => secEnsureObjectBytes(sec.decoded);
  // Absolute tile of the sector's own place: a map's N.sec is loaded without moving anything. (The objects of a
  // new world's sectors are copies of a terrain template and still carry the template's place.)
  const locationFor = (sec, tileX, tileY) =>
    BigInt(Number(sec.position.x) * 64 + tileX) | (BigInt(Number(sec.position.y) * 64 + tileY) << 32n);

  const hydratePoint = async (pt, sec) => {
    try {
      const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
      const pseudo = { filename: sec.filename, position: sec.position, decoded: { staticObjects: [pt.__obj] } };
      const [p] = await loadSecStaticObjectPoints([pseudo], diag);
      if (p) Object.assign(pt, p, { file: pt.file, seq: pt.seq, __obj: pt.__obj, __rot: pt.__rot, name: pt.name });
    } catch (_) { /* the placeholder point stays */ }
    redraw();
  };
  const addObject = (wx, wy, objType, item, aid, rot, offset = null) => {
    const at = sectorAtWorld(wx, wy); if (!at) return null;
    const sec = at.sec;
    if (!prepSector(sec)) { edit.problem = `${sec.filename}: its object list could not be parsed, so objects cannot be added there`; return null; }
    const tileX = wx & 63, tileY = wy & 63;
    const loc = locationFor(sec, tileX, tileY);
    // placed with the game's prototype for its art: also the fields the game's objects of that art set over it
    const game = secGameProto(objType, aid);
    const obj = secBuildStaticObject(objType, item.num, aid, loc, offset, game?.num === item.num ? game.fields : null);
    sec.decoded.staticObjects.push(obj);
    sec.decoded.staticObjectCount = sec.decoded.staticObjects.length;
    const pt = {
      file: `${sec.filename}#new`, name: item.label,
      worldX: Number(sec.position.x) * 64 + tileX, worldY: Number(sec.position.y) * 64 + tileY,
      sectorX: Number(sec.position.x), sectorY: Number(sec.position.y), tileX, tileY,
      type: objType, typeName: mobObjectTypeName(objType), artId: null, artName: null, artCanvas: null,
      wallFlags: 0, wallDecode: objType === 0 ? decodeWallArtId(aid) : null,
      portalRotation: objType === 1 ? rot : null, artFile: null, artNote: null,
      currentAidRaw: aid | 0, locationRaw: loc.toString(), objFlags: 0, sceneryFlags: 0, seq: -1,
      wallFields: objType === 0 ? obj.fields.map(f => ({ field: f.field, value: f.value })) : null,
      hotspotX: 0, hotspotY: 0, offsetX: offset?.[0] || 0, offsetY: offset?.[1] || 0, blitScale: 1, blitFlags: 0,
      lightSources: [], nocturnal: false, staticSecObject: true, __obj: obj, __rot: rot
    };
    mobPoints.push(pt);
    edit.housePts?.push(pt);
    edit.objSecs.set(secSectorKey(sec), sec);
    edit.objOps.push({ kind: 'add', sec, obj, pt, index: sec.decoded.staticObjects.length - 1 });
    indexAdd(pt);
    hydratePoint(pt, sec);
    return pt;
  };
  const removeObject = pt => {
    if (!pt.staticSecObject || !pt.__obj) { edit.skippedMob++; return false; }
    const sec = findSector(pt.sectorX, pt.sectorY), d = sec?.decoded;
    if (!d || sec.terrain || !prepSector(sec)) return false;
    const i = d.staticObjects.indexOf(pt.__obj); if (i < 0) return false;
    d.staticObjects.splice(i, 1); d.staticObjectCount = d.staticObjects.length;
    const j = mobPoints.indexOf(pt); if (j >= 0) mobPoints.splice(j, 1);
    edit.objSecs.set(secSectorKey(sec), sec);
    edit.objOps.push({ kind: 'del', sec, obj: pt.__obj, pt, index: i });
    indexRemove(pt);
    return true;
  };
  // ---- sector lights (what the game lights a house with): the free-standing records of a sector's light list ----------
  let lightArtQueued = false;
  const refreshLightArt = () => {      // the art of a light the sector did not have before, when the lighting is on
    if (lightArtQueued || !lightState.enabled || !lightState.table) return;
    lightArtQueued = true;
    Promise.resolve().then(async () => {
      lightArtQueued = false;
      lightState.disks = await ensureSecLightArt(valid, mobPoints);
      view._lightModel = null; refreshLightLabel(); redraw();
    });
  };
  // `l`: { wx, wy, offsetX, offsetY, flags, artId, r, g, b }; resolves to { sec, light }
  const addLight = l => {
    const at = sectorAtWorld(l.wx, l.wy); if (!at || at.sec.terrain) return null;
    const sec = at.sec, d = sec.decoded;
    secEnsureLights(d);
    const light = { x: minX * 64 + l.wx, y: minY * 64 + l.wy, offsetX: l.offsetX, offsetY: l.offsetY, flags: l.flags, artId: l.artId, r: l.r, g: l.g, b: l.b };
    d.lights.push(light);
    edit.lightSecs.set(secSectorKey(sec), sec);
    edit.objOps.push({ kind: 'ladd', sec, light, index: d.lights.length - 1 });
    touchSector(sec); refreshLightArt();
    return { sec, light };
  };
  const removeLight = (sec, light) => {
    const d = sec.decoded, i = d.lights.indexOf(light); if (i < 0 || sec.terrain) return false;
    secEnsureLights(d);
    d.lights.splice(i, 1);
    edit.lightSecs.set(secSectorKey(sec), sec);
    edit.objOps.push({ kind: 'ldel', sec, light, index: i });
    touchSector(sec);
    return true;
  };
  // the lights a placeholder house was given, taken away again
  const liftLights = list => { for (const { sec, light } of list || []) removeLight(sec, light); };
  const applyObjOp = (e, forward) => {
    const d = e.sec.decoded;
    if (e.kind === 'ladd' || e.kind === 'ldel') {
      if ((e.kind === 'ladd') === forward) d.lights.splice(Math.min(e.index, d.lights.length), 0, e.light);
      else { const i = d.lights.indexOf(e.light); if (i >= 0) d.lights.splice(i, 1); }
      return;
    }
    if ((e.kind === 'add') === forward) { d.staticObjects.splice(Math.min(e.index, d.staticObjects.length), 0, e.obj); mobPoints.push(e.pt); }
    else {
      const i = d.staticObjects.indexOf(e.obj); if (i >= 0) d.staticObjects.splice(i, 1);
      const j = mobPoints.indexOf(e.pt); if (j >= 0) mobPoints.splice(j, 1);
    }
    d.staticObjectCount = d.staticObjects.length;
  };

  // ---- new .mob files: ground items, NPCs, containers ------------------------------------------------------------
  // The game files these objects apart from the sector (one G_<guid>.mob each), so they are not in a sector's
  // object list: edit.newMobs holds them, they are drawn from mobPoints like the shipped .mob files, and Export
  // writes them next to the sectors. History entries: { kind: 'madd' | 'mdel', mob }.
  const mobPointOf = (obj, item, sec, tileX, tileY, loc) => ({
    file: obj.name, name: item.label,
    worldX: Number(sec.position.x) * 64 + tileX, worldY: Number(sec.position.y) * 64 + tileY,
    sectorX: Number(sec.position.x), sectorY: Number(sec.position.y), tileX, tileY,
    type: item.objType, typeName: mobObjectTypeName(item.objType), protoNum: item.num, artId: null, artName: null, artCanvas: null,
    wallFlags: 0, wallDecode: null, portalRotation: null, artFile: null, artNote: null,
    currentAidRaw: null, locationRaw: loc.toString(), objFlags: 0, sceneryFlags: 0, seq: -1, scripts: null,
    hotspotX: 0, hotspotY: 0, offsetX: 0, offsetY: 0, blitScale: 1, blitFlags: 0,
    lightSources: [], nocturnal: false, staticSecObject: false
  });
  // The point gets its art, offsets, lights... from the object itself, the way a .mob file loaded from disk does.
  const hydrateMobPoint = async (pt, obj, sec) => {
    try {
      const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
      const pseudo = { filename: sec.filename, position: sec.position, decoded: { staticObjects: [obj] } };
      const [p] = await loadSecStaticObjectPoints([pseudo], diag);
      if (p) Object.assign(pt, p, { file: pt.file, name: pt.name, seq: -1, staticSecObject: false, __newMob: pt.__newMob });
    } catch (_) { /* the placeholder point stays */ }
    redraw();
  };
  // where inside its tile a click fell, as the sprite's pixel offset from the tile's centre
  const mobOffsetFor = f => {
    if (edit.tool !== 'items' || !mk.items.drop.checked) return [0, 0];
    const a = secIsoProject(f.wx, f.wy, iso), b = secIsoProject(f.fx, f.fy, iso);
    return [Math.round(b.x - a.x), Math.round(b.y - a.y)];
  };
  // The art id of the NPC `item` in the chosen outfit (its prototype's with another armor part), or null to keep the
  // prototype's. A shield is dropped: it is drawn over the armor of the prototype only.
  const npcOutfitAid = item => {
    const v = mk.npcs.outfit.value;
    if (item.objType !== 16 || v === 'proto' || item.aid == null || (item.aid >>> 28) !== 2) return null;
    return (((item.aid & ~((0xF << 20) | (1 << 19))) | (Number(v) << 20)) >>> 0);
  };
  const placeMob = f => {
    const kind = edit.tool, item = edit.sel[kind];
    if (!item) return false;
    const at = sectorAtWorld(f.wx, f.wy);
    if (!at) { edit.problem = 'There is no sector file there to hold the object'; return false; }
    const sec = at.sec, tileX = f.wx & 63, tileY = f.wy & 63, loc = locationFor(sec, tileX, tileY);
    const quantity = item.qty != null ? Math.max(1, Math.round(Number(mk.items.qty.value)) || item.qty || 1) : null;
    const obj = secBuildMobObject(item.objType, item.num, loc, { offset: mobOffsetFor(f), npcFlags: item.npcFlags, quantity, currentAid: npcOutfitAid(item) });
    const pt = mobPointOf(obj, item, sec, tileX, tileY, loc);
    const mob = { name: obj.name, bytes: obj.__bytes, obj, pt, kind };
    pt.__newMob = mob;
    edit.newMobs.push(mob); mobPoints.push(pt);
    edit.objOps.push({ kind: 'madd', mob });
    hydrateMobPoint(pt, obj, sec);
    return true;
  };
  const removeNewMob = mob => {
    const i = edit.newMobs.indexOf(mob); if (i < 0) return false;
    edit.newMobs.splice(i, 1);
    const j = mobPoints.indexOf(mob.pt); if (j >= 0) mobPoints.splice(j, 1);
    edit.objOps.push({ kind: 'mdel', mob });
    return true;
  };
  const applyMobOp = (e, forward) => {
    const have = edit.newMobs.indexOf(e.mob);
    if ((e.kind === 'madd') === forward) {
      if (have < 0) { edit.newMobs.push(e.mob); mobPoints.push(e.mob.pt); }
    } else if (have >= 0) {
      edit.newMobs.splice(have, 1);
      const j = mobPoints.indexOf(e.mob.pt); if (j >= 0) mobPoints.splice(j, 1);
    }
  };
  // The .mob files Export writes: the new ones, the changed ones of the map (each replaces the file of the same name)
  // and the items put in an inventory (when the NPC or container that holds them is written too).
  const mobFiles = () => {
    const owners = new Set([...edit.newMobs.map(m => m.name), ...edit.modMobs.keys()]);
    return [
      ...edit.newMobs.map(m => ({ name: m.name, bytes: m.bytes })),
      ...[...edit.modMobs.values()].map(m => ({ name: m.name, bytes: m.bytes })),
      ...edit.kidMobs.filter(k => owners.has(k.owner)).map(k => ({ name: k.name, bytes: k.bytes }))
    ];
  };
  // how many changes wait for Export: sector files and .mob files
  // (the map-level files - startloc.txt, map.jmp, map.sbf - count with the dialog and quest files)
  const pendingCounts = () => ({ sectors: dirtySectors().size, mobs: mobFiles().length, story: storyFileCount(edit.story) + (extra ? extra.mapFiles().length : 0) });

  // ---- the Edit NPC / container tool ---------------------------------------------------------------------------------
  // Works on the .mob files of NPCs and containers: the ones placed here (edit.newMobs) and the ones the map has (read
  // again from disk when first opened). The panel (mob-edit-panel.js) rewrites the record's bytes.
  const shippedRecs = new Map();
  const mobEditor = createMobEditPanel(panes.mobedit, {
    kids: edit.kidMobs, cache: new Map(),
    // the scripts made by the Dialog tool can be attached too: number -> file name
    extraScripts: () => new Map(edit.story.dialogs.map(d => [d.num, `${dialogStem(d)}.scr`])),
    changed: (rec, reverted) => {
      if (rec.shipped) {
        const same = rec.bytes.length === rec.orig.length && rec.bytes.every((b, i) => b === rec.orig[i]);
        if (reverted || (same && !edit.kidMobs.some(k => k.owner === rec.name))) edit.modMobs.delete(rec.name); else edit.modMobs.set(rec.name, rec);
      }
      edit.unsaved = true; refreshEditUi();
    }
  });
  // ---- the Dialog and Quest tools ------------------------------------------------------------------------------------
  // Pure side panels (story-panel.js): nothing happens on the map. What they hold is exported as files (see "Export").
  const storyChanged = () => { edit.unsaved = true; refreshEditUi(); };
  let shippedScriptNumbers = new Set();
  import('../scr/scr-explorer.js').then(m => m.getScrNumberIndex()).then(ix => { shippedScriptNumbers = new Set(ix.keys()); }).catch(() => {});
  const dialogPanel = createDialogPanel(panes.dialog, {
    story: edit.story, changed: storyChanged, scriptNumbers: () => shippedScriptNumbers,
    // the Edit NPC tool takes over: the next NPC clicked gets the dialog
    giveToNpc: async num => { await setTool('mobedit'); mobEditor.expect(num); }
  });
  const questPanel = createQuestPanel(panes.quest, { story: edit.story, changed: storyChanged });
  const fetchDataBytes = async path => {
    const resp = await fetch(`${DATA_ROOT}${path}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  };

  const mobRecordFor = async pt => {
    if (pt.__newMob) { const m = pt.__newMob; m.protoNum = pt.protoNum; m.shipped = false; return m; }
    let rec = shippedRecs.get(pt.file);
    if (!rec) {
      if (!pt.mobUrl) return null;
      const resp = await fetch(pt.mobUrl, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      rec = { name: pt.file, bytes, orig: bytes.slice(), pt, shipped: true, kind: pt.type === 2 ? 'containers' : 'npcs', protoNum: pt.protoNum };
      shippedRecs.set(pt.file, rec);
    }
    return rec;
  };
  // the NPCs and containers filed as .mob within a tile of (wx, wy), nearest first
  const editableMobsNear = (wx, wy) => mobPoints
    .filter(p => (p.type === 2 || p.type === 16) && !p.staticSecObject && Math.abs(wxOf(p) - wx) <= 1 && Math.abs(wyOf(p) - wy) <= 1)
    .sort((a, b) => (Math.abs(wxOf(a) - wx) + Math.abs(wyOf(a) - wy)) - (Math.abs(wxOf(b) - wx) + Math.abs(wyOf(b) - wy)));
  const openMobEdit = async (pt, near = []) => {
    if (edit.tool !== 'mobedit') await setTool('mobedit');
    edit.mobSel = pt; scheduleCursor();
    try {
      const rec = await mobRecordFor(pt);
      if (!rec) { status.textContent = 'This object has no file the editor can read.'; return; }
      status.textContent = '';
      await mobEditor.show(rec, near.filter(p => p !== pt).slice(0, 6).map(p => ({ label: `${p.name} · ${wxOf(p)}, ${wyOf(p)}`, pick: () => openMobEdit(p, near) })));
    } catch (err) { status.textContent = `Could not open it: ${errText(err)}`; }
  };
  const pickMobToEdit = async event => {
    const t = worldTileAt(event); if (!t) return;
    if (!edit.objectsReady) { status.textContent = 'Objects are still loading…'; return; }
    const near = editableMobsNear(t.wx, t.wy);
    if (!near.length) {
      const fixed = mobPoints.some(p => p.type === 2 && p.staticSecObject && wxOf(p) === t.wx && wyOf(p) === t.wy);
      status.textContent = fixed ? "That container is part of the map's sector file: only NPCs and containers filed as .mob can be edited here." : 'There is no NPC or container there (click on or next to one).';
      return;
    }
    await openMobEdit(near[0], near);
  };

  let editRedrawQueued = false;
  const scheduleEditRedraw = () => {
    if (editRedrawQueued) return;
    editRedrawQueued = true;
    requestAnimationFrame(() => { editRedrawQueued = false; redrawNow(); });
  };
  const sectorDiffers = d => { const a = d.sector.decoded.tiles, b = d.orig; for (let i = 0; i < 4096; i++) if (a[i] !== b[i]) return true; return false; };
  const dirtySectors = () => {
    const m = new Map();
    if (opts.virtual) { for (const s of valid) m.set(secSectorKey(s), s); return m; }   // nothing is on disk yet: export everything
    for (const [k, d] of edit.dirty) m.set(k, d.sector);
    for (const [k, s] of edit.objSecs) m.set(k, s);
    for (const [k, s] of edit.roofSecs) m.set(k, s);
    for (const [k, s] of edit.lightSecs) m.set(k, s);
    for (const [k, s] of edit.extraSecs) m.set(k, s);
    return m;
  };
  const touchSector = sec => {
    delete sec.decoded.__allZero;               // blank/all-zero detection must be redone
    view.colorSectorCache.delete(sec.filename); // colour-mode bitmap
    view.lodSectorCache?.delete(sec.filename);  // low-detail isometric bitmap
    delete sec.decoded.__indoor;                // indoor-tile list used by the light mask
    view._lightModel = null;
    const key = secSectorKey(sec);
    view.blankSectors?.delete(key);             // an edited sector is no longer "blank"
    if (!view.loadedSectors.has(key) && !view.loadingSectors.has(key)) loadSectorTiles(sec);
  };
  const pendingText = ({ sectors: n, mobs: m, story: s = 0 }) => [n ? `${n} sector${n === 1 ? '' : 's'}` : '', m ? `${m} ${edit.modMobs.size ? '' : 'new '}.mob file${m === 1 ? '' : 's'}` : '', s ? `${s} ${edit.story.dialogs.length || edit.story.quests.length ? 'dialog / quest / map' : 'map'} file${s === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  const refreshEditUi = () => {
    const { sectors: n, mobs: m, story: s } = pendingCounts();
    exportSecBtn.disabled = n + m + s === 0;
    exportSecBtn.textContent = m || s ? (n ? `Export (${n} + ${m + s} files)` : `Export ${m + s} files`) : n ? `Export .SEC (${n})` : 'Export .SEC';
    exportSecBtn.title = n + m + s ? `Save ${pendingText({ sectors: n, mobs: m, story: s })}${n + m + s > 1 ? ' (as a .zip)' : ''}` : 'Nothing changed yet';
  };
  const setTile = (wx, wy, raw) => {
    const at = sectorAtWorld(wx, wy); if (!at) return false;
    const { sec, idx } = at;
    const old = sec.decoded.tiles[idx] >>> 0;
    if (old === raw) return false;
    const key = secSectorKey(sec);
    if (!edit.dirty.has(key)) edit.dirty.set(key, { sector: sec, orig: Uint32Array.from(sec.decoded.tiles) });
    const sk = `${key}:${idx}`;
    if (!edit.stroke.has(sk)) edit.stroke.set(sk, { sec, idx, before: old });
    sec.decoded.tiles[idx] = raw;
    touchSector(sec);
    return true;
  };
  const brushOffset = () => Math.floor((edit.size - 1) / 2);
  const forFootprint = (wx, wy, fn) => {
    const n = edit.size, o = brushOffset();
    let changed = false;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) if (fn(wx + dx - o, wy + dy - o)) changed = true;
    return changed;
  };

  // Transitions. An outdoor tile blends two terrains through the four corners of the tile (the vertices of
  // the tile grid): a3 bit 2 = corner (x, y), bit 0 = (x+1, y+1) and bits 1 / 3 = (x+1, y) / (x, y+1), those two
  // swapped when the tile is mirrored (raw bit 0). A set bit shows num1's terrain, a clear one num2's.
  // (Read off data/terrain: neighbouring tiles agree on every shared corner.) A terrain is named by its tilename.mes
  // id: 0-99 flippable, 100-199 not; num1 is always the lower one.
  let tileManifest = null;
  loadSecTileManifest().then(m => { tileManifest = m; }).catch(() => {});
  const tileCorners = raw => {
    if (artType(raw) || !((raw >>> 8) & 1)) return null;   // facades and indoor tiles never blend
    const t1 = (((raw >>> 7) & 1) ? 0 : 100) + ((raw >>> 22) & 63), t2 = (((raw >>> 6) & 1) ? 0 : 100) + ((raw >>> 16) & 63);
    if (t1 === t2) return [t1, t1, t1, t1];
    const a3 = (raw >>> 12) & 15, mirrored = raw & 1;
    return [(a3 >> 2) & 1, (a3 >> (mirrored ? 3 : 1)) & 1, (a3 >> (mirrored ? 1 : 3)) & 1, a3 & 1].map(b => (b ? t1 : t2));
  };
  const tileArtExists = raw => {
    const names = secTileArtFilename(secTileInfo(raw));
    return names.length > 0 && tileManifest.has(String(names[0]).toLowerCase());
  };
  // The id of a transition tile between terrains lo < hi (tilename.mes ids), a3 = its corner bits, mirrored = bit 0.
  const pairTileRaw = (lo, hi, a3, a4, mirrored) =>
    ((lo % 100) << 22 | (hi % 100) << 16 | a3 << 12 | a4 << 9 | 1 << 8 | (lo < 100 ? 1 : 0) << 7 | (hi < 100 ? 1 : 0) << 6 | mirrored) >>> 0;
  // Does the game have transition art between these two terrains? (a3 = 3, half and half, is in every set)
  const pairArtCache = new Map();
  const pairHasArt = (a, b) => {
    if (a === b || !tileManifest?.size) return true;
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * 1000 + hi;
    let has = pairArtCache.get(key);
    if (has === undefined) {
      has = false;
      for (let a4 = 0; a4 < 8 && !has; a4++) has = tileArtExists(pairTileRaw(lo, hi, 3, a4, 0));
      pairArtCache.set(key, has);
    }
    return has;
  };
  // Two terrains without art between them are separated by a third one that has art with both (Dirt, for most):
  // grass | dirt | water, as the game's own maps do it.
  const HUB_ORDER = [0, 27, 1, 2, 3, 4, 5, 18, 19, 20, 21, 22, 8, 9, 10, 11];
  const hubFor = (a, b) => {
    for (const h of HUB_ORDER) if (h !== a && h !== b && pairHasArt(a, h) && pairHasArt(b, h)) return h;
    return null;
  };
  // The tile for four corner terrains, with the variant (a..h) that exists and the Variation choice; null when the
  // game has no art for this pair of terrains (not every pair has transitions).
  const cornersRaw = (corners, wx, wy, prefer) => {
    let kinds = [...new Set(corners)];
    if (kinds.length > 2) {   // a tile blends two terrains: keep the painted one and the most common other
      const count = t => corners.filter(c => c === t).length;
      const keep = kinds.includes(prefer) ? prefer : kinds.sort((a, b) => count(b) - count(a))[0];
      const other = kinds.filter(t => t !== keep).sort((a, b) => count(b) - count(a))[0];
      corners = corners.map(t => (t === keep ? keep : other));
      kinds = [keep, other];
    }
    const makes = [];   // every way to write this tile: [a4 -> raw]
    if (kinds.length === 1) makes.push(a4 => plainTileRaw(kinds[0], a4));
    else {
      const lo = Math.min(...kinds), hi = Math.max(...kinds);
      const [c0, c1, c2, c3] = corners.map(t => (t === lo ? 1 : 0));
      // The game draws a tile mirrored when bit 0 of its id is set, which swaps its two side corners: so a corner
      // pattern is written as a3 (not mirrored) or as the a3 with those corners swapped (mirrored). Not every pair
      // of terrains has the art for every a3 (a3 2, 9, 12 and 13 usually only exist as the mirror of 8, 3, 6, 7).
      makes.push(a4 => pairTileRaw(lo, hi, (c0 << 2) | (c1 << 1) | c3 | (c2 << 3), a4, 0));
      if (c1 !== c2) makes.push(a4 => pairTileRaw(lo, hi, (c0 << 2) | (c2 << 1) | c3 | (c1 << 3), a4, 1));
      else makes.push(a4 => pairTileRaw(lo, hi, (c0 << 2) | (c1 << 1) | c3 | (c2 << 3), a4, 1));
    }
    let list = [];
    for (const make of makes) for (let a4 = 0; a4 < 8; a4++) { const raw = make(a4); if (tileArtExists(raw)) list.push({ a4, raw }); }
    if (!list.length) return null;
    if (edit.variation !== 'auto') { const match = list.filter(v => v.a4 === Number(edit.variation)); if (match.length) list = match; }
    return scatterRaw(list, wx, wy);
  };
  const artRequested = new Set();
  const ensureArt = raw => {
    if (artTiles.has(raw) || artRequested.has(raw)) return;
    artRequested.add(raw);
    loadSecTileArt(secTileInfo(raw)).then(art => { if (art) { artTiles.set(raw, art); scheduleEditRedraw(); } }).catch(() => {});
  };
  // The tile at (wx, wy) now has `terrain` on all four corners: rebuild the eight tiles that share a corner with it.
  // `skip(x, y)` (optional) names tiles that must stay as they are.
  // The vertices of the painted tile take `terrain`; the tiles around are rebuilt from their corners. Where two terrains
  // meet that the game has no edge art for, the thinner side becomes the hub terrain instead (see hubFor), which may
  // spread to the tiles a ring further out, hence the 5 x 5 area.
  const blendAround = (wx, wy, terrain, skip) => {
    const vkey = (vx, vy) => vy * 0x100000 + vx;
    const over = new Map();   // vertex -> terrain, where it differs from what the tiles say
    for (let k = 0; k < 4; k++) over.set(vkey(wx + (k & 1), wy + (k >> 1)), terrain);
    const area = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = wx + dx, ny = wy + dy, at = sectorAtWorld(nx, ny);
      if (!at || ((dx || dy) && skip && skip(nx, ny))) continue;
      const base = tileCorners(at.sec.decoded.tiles[at.idx] >>> 0); if (!base) continue;
      area.push({ x: nx, y: ny, base });
    }
    const cornersNow = t => t.base.map((b, k) => over.get(vkey(t.x + (k & 1), t.y + (k >> 1))) ?? b);
    if (tileManifest?.size) for (let round = 0; round < 4; round++) {
      let moved = false;
      for (const t of area) {
        const cs = cornersNow(t), kinds = [...new Set(cs)];
        if (kinds.length !== 2 || pairHasArt(kinds[0], kinds[1])) continue;
        const n0 = cs.filter(c => c === kinds[0]).length;
        const gives = n0 === 2 ? (kinds[0] === terrain ? kinds[1] : kinds[0]) : n0 < 2 ? kinds[0] : kinds[1];   // the thinner side, else the one not painted
        const hub = hubFor(kinds[0], kinds[1]); if (hub == null) continue;
        cs.forEach((c, k) => { if (c === gives) { over.set(vkey(t.x + (k & 1), t.y + (k >> 1)), hub); moved = true; } });
      }
      if (!moved) break;
    }
    let changed = false;
    for (const t of area) {
      const next = cornersNow(t);
      if (next.every((c, k) => c === t.base[k])) continue;
      const raw = cornersRaw(next, t.x, t.y, terrain); if (raw == null) continue;
      if (setTile(t.x, t.y, raw)) { ensureArt(raw); changed = true; }
    }
    return changed;
  };
  const paintTile = (wx, wy, raw) => {
    let changed = setTile(wx, wy, raw);
    const corners = ui.blend.checked && tileManifest?.size ? tileCorners(raw) : null;
    if (corners && corners.every(t => t === corners[0]) && blendAround(wx, wy, corners[0])) changed = true;
    return changed;
  };
  const applyBrush = (wx, wy) => forFootprint(wx, wy, (x, y) => paintTile(x, y, brushRawAt(x, y)));

  // Two tiles count as "the same" when they show the same ground: a plain tile is compared by its tile number
  // (so its a/b/c... variants and flips all match), a facade by its facade number, and a blended edge tile by its
  // exact value (an edge piece is only ever the same as the very same piece).
  const fillKey = raw => {
    const info = secTileInfo(raw);
    if (info.isFacade) return `f${info.facadeNum}`;
    if (!artType(raw) && info.num1 === info.num2 && info.flippable1 === info.flippable2) return `t${info.artId}`;
    return `r${raw >>> 0}`;
  };
  const fillAt = (wx, wy) => {
    const start = sectorAtWorld(wx, wy); if (!start) return false;
    const keyCache = new Map();
    const keyOf = raw => { let k = keyCache.get(raw); if (k === undefined) { k = fillKey(raw); keyCache.set(raw, k); } return k; };
    const target = keyOf(start.sec.decoded.tiles[start.idx] >>> 0);
    // Only the visited tiles are recorded: the map (map.prp) can be thousands of sectors wide.
    const seen = new Set();
    const first = wy * mapW + wx;
    const stack = [first]; seen.add(first);
    let changed = 0;
    const region = [];   // found first, painted after: blending rewrites tiles the search has yet to visit
    while (stack.length) {
      const v = stack.pop(), x = v % mapW, y = (v - x) / mapW;
      const at = sectorAtWorld(x, y);
      if (!at || keyOf(at.sec.decoded.tiles[at.idx] >>> 0) !== target) continue;
      region.push(x, y);
      if (x > 0 && !seen.has(v - 1)) { seen.add(v - 1); stack.push(v - 1); }
      if (x < mapW - 1 && !seen.has(v + 1)) { seen.add(v + 1); stack.push(v + 1); }
      if (y > 0 && !seen.has(v - mapW)) { seen.add(v - mapW); stack.push(v - mapW); }
      if (y < mapH - 1 && !seen.has(v + mapW)) { seen.add(v + mapW); stack.push(v + mapW); }
    }
    for (let i = 0; i < region.length; i += 2) if (paintTile(region[i], region[i + 1], brushRawAt(region[i], region[i + 1]))) changed++;
    edit.fillCount = changed;
    if (!changed) edit.problem = 'Nothing to fill: the connected tiles already are the chosen tile.';
    return changed > 0;
  };

  // ---- Path to houses (the route-finding and the look of the strip are in sec-village-paths.js) ---------------------
  // The doors are picked on the map; each path starts on the tile in front of its door. Nothing is laid on a house (its
  // floor, a facade, a tile that carries a wall or a door), on water or on a tree, and the edge tiles that blend a path
  // into its surroundings are never put on a house either.
  const DIR_STEP = [[-1, 0], [0, 1], [1, 0], [0, -1]];   // the tile across each edge of a tile (dir 0..3 = NE, SE, SW, NW)
  const isDoorPoint = p => p.type === 1 && p.currentAidRaw != null && ((Number(p.currentAidRaw) >>> 10) & 1) === 1 && (secEdgeRotation(p) ?? p.__rot) != null;
  let doorList = null;
  const allDoors = () => {
    if (!doorList || doorList.n !== mobPoints.length) doorList = { n: mobPoints.length, list: mobPoints.filter(isDoorPoint) };
    return doorList.list;
  };
  const doorSides = p => {
    const hx = wxOf(p), hy = wyOf(p), dir = (((secEdgeRotation(p) ?? p.__rot) >> 1) & 3);
    return { hx, hy, dir, ox: hx + DIR_STEP[dir][0], oy: hy + DIR_STEP[dir][1] };
  };
  const tileRawAt = (x, y) => { const at = sectorAtWorld(x, y); return at ? at.sec.decoded.tiles[at.idx] >>> 0 : null; };
  const isHouseRaw = raw => raw != null && !!(artType(raw) || !((raw >>> 8) & 1));   // a facade or an indoor tile
  // The tiles reachable from (sx, sy) without crossing a wall or a door, up to `cap`: a house is a small closed region.
  const flood = (sx, sy, cap = 600) => {
    const seen = new Set([sy * mapW + sx]), queue = [sx, sy], edges = getEdgeIndex();
    for (let q = 0; q < queue.length && seen.size <= cap; q += 2) {
      const x = queue[q], y = queue[q + 1];
      for (let d = 0; d < 4; d++) {
        const nx = x + DIR_STEP[d][0], ny = y + DIR_STEP[d][1];
        if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH || seen.has(ny * mapW + nx) || edges.has(secEdgeKey(x, y, d))) continue;
        seen.add(ny * mapW + nx); queue.push(nx, ny);
      }
    }
    return { open: seen.size > cap, size: seen.size, cells: queue };
  };
  // Which side of a door is the outside: the side that is not a floor, else the side that is not a closed room, else
  // the side farther from the walls around the door.
  const doorRecord = p => {
    const s = doorSides(p), A = { x: s.hx, y: s.hy }, B = { x: s.ox, y: s.oy };
    const ia = isHouseRaw(tileRawAt(A.x, A.y)), ib = isHouseRaw(tileRawAt(B.x, B.y));
    let out;
    if (ia !== ib) out = ia ? B : A;
    else {
      const fa = flood(A.x, A.y), fb = flood(B.x, B.y);
      if (fa.open !== fb.open) out = fa.open ? A : B;
      else if (!fa.open) out = fa.size >= fb.size ? A : B;
      else {
        let cx = 0, cy = 0, n = 0;
        for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) for (const q of objectsAt(s.hx + dx, s.hy + dy)) if (q.type === 0) { cx += s.hx + dx; cy += s.hy + dy; n++; }
        out = !n || Math.hypot(A.x - cx / n, A.y - cy / n) > Math.hypot(B.x - cx / n, B.y - cy / n) ? A : B;
      }
    }
    const inn = out === A ? B : A;
    return { key: `${s.hx},${s.hy},${s.dir}`, hx: s.hx, hy: s.hy, dir: s.dir, ox: out.x, oy: out.y, ix: inn.x, iy: inn.y };
  };
  const renderPathInfo = () => {
    const n = edit.pathDoors.length;
    ui.pathInfo.textContent = !edit.objectsReady ? 'Loading the map objects…'
      : n ? `${n} door${n === 1 ? '' : 's'} chosen · click a chosen door again to drop it`
      : 'Click the doors to join on the map (the doors light up), then press Draw paths.';
    ui.pathDraw.disabled = n < 2; ui.pathClear.disabled = !n;
    const ground = secTileNameMesMap?.get(pathTerrain())?.name;
    ui.pathGround.textContent = `Ground: ${ground || 'Trodden Dirt'} · the tile picked in the Tile tool, when it is one plain outdoor tile`;
  };
  const pickDoor = event => {
    if (!edit.objectsReady) { status.textContent = 'Objects are still loading…'; return; }
    const f = worldFloat(event); if (!f) return;
    let best = null, bd = 1.5;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const p of objectsAt(f.wx + dx, f.wy + dy)) {
      if (!isDoorPoint(p)) continue;
      const s = doorSides(p), d = ((s.hx + s.ox) / 2 - f.fx) ** 2 + ((s.hy + s.oy) / 2 - f.fy) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { status.textContent = 'No door there: click on a door.'; return; }
    const rec = doorRecord(best), at = edit.pathDoors.findIndex(d => d.key === rec.key);
    if (at >= 0) edit.pathDoors.splice(at, 1); else edit.pathDoors.push(rec);
    renderPathInfo(); scheduleCursor();
  };
  // Doors in the view (teal), the chosen ones (yellow) with the tile in front of them.
  const drawDoorMarks = c => {
    if (!edit.objectsReady) return;
    const chosen = new Set(edit.pathDoors.map(d => d.key)), W = stage.clientWidth, H = stage.clientHeight;
    c.save(); c.lineCap = 'round';
    for (const p of allDoors()) {
      const s = doorSides(p), q = tileCentre(s.hx, s.hy);
      if (q.x < -80 || q.y < -80 || q.x > W + 80 || q.y > H + 80) continue;
      const on = chosen.has(`${s.hx},${s.hy},${s.dir}`);
      c.beginPath(); edgePath(c, s.hx, s.hy, s.dir);
      c.strokeStyle = on ? '#ffe066' : 'rgba(32,178,170,.9)'; c.lineWidth = on ? 5 : 3; c.stroke();
    }
    for (const d of edit.pathDoors) { c.beginPath(); tilePath(c, d.ox, d.oy); c.fillStyle = 'rgba(255,224,102,.28)'; c.fill(); }
    c.restore();
  };
  // The ground the paths are made of: the selected tile when it is one plain outdoor terrain, else Trodden Dirt.
  const pathTerrain = () => {
    const b = edit.brush;
    if (b?.custom) { const c = tileCorners(b.raw); if (c && c.every(t => t === c[0])) return c[0]; }
    else if (b && b.artId < 200) return b.artId;
    return 27;
  };
  const pathRaw = (terrain, x, y) => {
    const b = edit.brush;
    if (b && !b.custom && b.artId === terrain) return brushRawAt(x, y);
    if (b?.custom && tileCorners(b.raw)?.every(t => t === terrain)) return b.raw;
    return tileManifest?.size ? cornersRaw([terrain, terrain, terrain, terrain], x, y, terrain) : plainTileRaw(terrain, 0);
  };
  const terrainClass = new Map();   // tilename.mes id -> 0 open ground, 1 paved or a floor (walked over, never painted), 2 blocks
  const classOf = t => {
    let v = terrainClass.get(t);
    if (v === undefined) {
      const f = String(secTileNameMesMap?.get(t)?.flags || '').split(/\s/)[0];
      v = !secTileNameMesMap ? 0 : /[bfs]/.test(f) ? 2 : /n/.test(f) ? 0 : 1;
      terrainClass.set(t, v);
    }
    return v;
  };
  const drawPaths = () => {
    const doors = edit.pathDoors;
    if (doors.length < 2) return;
    const t0 = performance.now();
    const M = 24;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of doors) { x0 = Math.min(x0, d.ox, d.ix); y0 = Math.min(y0, d.oy, d.iy); x1 = Math.max(x1, d.ox, d.ix); y1 = Math.max(y1, d.oy, d.iy); }
    x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(mapW - 1, x1 + M); y1 = Math.min(mapH - 1, y1 + M);
    const w = x1 - x0 + 1, h = y1 - y0 + 1, terrain = pathTerrain();
    if (w * h > PATH_MAX_CELLS) return `The chosen doors are too far apart (${w} × ${h} tiles): pick doors that are closer together.`;
    const kind = new Uint8Array(w * h), prefer = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, at = sectorAtWorld(x0 + x, y0 + y);
      if (!at) { kind[i] = PATH_CELL.OBSTACLE; continue; }
      const raw = at.sec.decoded.tiles[at.idx] >>> 0, bm = at.sec.decoded.blockMask;
      if (isHouseRaw(raw)) { kind[i] = PATH_CELL.HOUSE; continue; }
      const corners = tileCorners(raw), cls = Math.max(...[...new Set(corners)].map(classOf));
      kind[i] = (bm && ((bm[at.idx >> 5] >>> (at.idx & 31)) & 1)) || cls === 2 ? PATH_CELL.OBSTACLE : cls === 1 ? PATH_CELL.STREET : PATH_CELL.GROUND;
      if (corners.every(t => t === terrain)) prefer[i] = 1;
    }
    // walls and doors make a house of the tile they stand on; a tree or a rock blocks it
    for (const p of mobPoints) {
      const x = wxOf(p) - x0, y = wyOf(p) - y0;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (p.type === 0 || p.type === 1) kind[i] = PATH_CELL.HOUSE;
      else if ((p.type === 2 || p.type === 3) && !((p.objFlags | 0) & 0x401) && kind[i] !== PATH_CELL.HOUSE) kind[i] = PATH_CELL.OBSTACLE;
    }
    // the room behind each chosen door is a house too (a floor of outdoor tiles has no other sign), but the tile in front of the door is not
    const specs = [];
    for (const d of doors) {
      const room = flood(d.ix, d.iy);
      if (!room.open) for (let q = 0; q < room.cells.length; q += 2) {
        const x = room.cells[q] - x0, y = room.cells[q + 1] - y0;
        if (x >= 0 && y >= 0 && x < w && y < h) kind[y * w + x] = PATH_CELL.HOUSE;
      }
    }
    for (const d of doors) {
      const x = d.ox - x0, y = d.oy - y0, i = y * w + x, raw = tileRawAt(d.ox, d.oy);
      if (raw != null && !isHouseRaw(raw) && kind[i] === PATH_CELL.HOUSE) kind[i] = Math.max(...tileCorners(raw).map(classOf)) === 1 ? PATH_CELL.STREET : PATH_CELL.GROUND;
      specs.push({ x, y, dx: d.ox - d.ix, dy: d.oy - d.iy });
    }
    const seed = edit.pathSeed++;
    const plan = planVillagePaths({ w, h, kind, prefer }, specs, { width: Math.max(1, Math.min(8, Math.round(Number(ui.pathWidth.value)) || 3)), wind: Number(ui.pathWind.value) / 100, seed, timeLimit: Math.max(500, PATH_TIME_LIMIT_MS - (performance.now() - t0)) });
    const skip = (x, y) => {   // never blend onto a house or a street
      const lx = x - x0, ly = y - y0;
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
      const k = kind[ly * w + lx];
      return k === PATH_CELL.HOUSE || k === PATH_CELL.STREET;
    };
    const blend = ui.blend.checked && tileManifest?.size;
    const laid = [];
    let noArt = false;
    for (let i = 0; i < plan.paint.length; i++) {
      if (!plan.paint[i]) continue;
      const x = x0 + (i % w), y = y0 + ((i / w) | 0), raw = pathRaw(terrain, x, y);
      if (raw == null) { noArt = true; continue; }
      if (setTile(x, y, raw)) ensureArt(raw);
      laid.push(x, y);
    }
    let blendCut = false;
    if (blend) for (let i = 0; i < laid.length; i += 2) {
      if ((i & 63) === 62 && performance.now() - t0 > PATH_TIME_LIMIT_MS) { blendCut = true; break; }   // never hang on a huge path
      blendAround(laid[i], laid[i + 1], terrain, skip);
    }
    const name = secTileNameMesMap?.get(terrain)?.name;
    const cut = plan.timedOut ? ` · stopped after ${PATH_TIME_LIMIT_MS / 1000} s: some doors have no path` : blendCut ? ' · stopped smoothing the edges after 5 s' : '';
    return !laid.length ? `Could not lay a path: the doors are shut in by houses, water or trees${cut}.`
      : `${laid.length / 2} path tiles${name ? ` of ${name}` : ''} between ${plan.joined.length} doors${plan.failed.length && !plan.timedOut ? ` · ${plan.failed.length} door${plan.failed.length === 1 ? '' : 's'} could not be reached` : ''}${cut}${noArt ? ' · some tiles have no art' : ''}. Undo (Ctrl+Z) and press Draw paths again for another layout.`;
  };
  ui.pathClear.addEventListener('click', () => { edit.pathDoors = []; renderPathInfo(); scheduleCursor(); });
  ui.pathDraw.addEventListener('click', () => {
    if (edit.painting || edit.pathDoors.length < 2) return;
    edit.painting = true; edit.stroke = new Map(); edit.objOps = []; edit.strokeSeen = new Set(); edit.skippedMob = 0; edit.problem = null;
    let note = '';
    try { note = drawPaths(); } catch (err) { note = edit.problem = `Could not draw the paths: ${errText(err)}`; }
    edit.houseNote = note;
    endStroke();
    ui.pathInfo.textContent = note;
  });

  const eraseTile = (wx, wy) => {
    const k = `e${wx},${wy}`;
    if (edit.strokeSeen.has(k)) return false;   // one layer per tile and stroke
    edit.strokeSeen.add(k);
    // what was added here as a new .mob file goes first, the last one placed first
    if (overlayVisibility.otherMobs || overlayVisibility.containers) {
      const fresh = edit.newMobs.filter(m => wxOf(m.pt) === wx && wyOf(m.pt) === wy);
      if (fresh.length && removeNewMob(fresh[fresh.length - 1])) return true;
    }
    const list = objectsAt(wx, wy);
    const layers = [
      { on: overlayVisibility.scenery, items: list.filter(p => p.type === 3) },
      { on: overlayVisibility.otherMobs, items: list.filter(p => p.type === 1) },
      { on: overlayVisibility.walls, items: list.filter(p => p.type === 0) }
    ];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li]; if (!L.on || !L.items.length) continue;
      let targets = L.items.slice();
      if (li === 2) {
        const idx = getEdgeIndex();
        for (const w of L.items) { const ek = edgeKeyOf(w); if (ek != null) for (const e of idx.get(ek) || []) if (e.type === 1 && !targets.includes(e)) targets.push(e); }
      }
      let changed = false;
      for (const p of targets) if (removeObject(p)) changed = true;
      if (changed) return true;
    }
    return false;
  };
  const eraseFootprint = (wx, wy) => forFootprint(wx, wy, eraseTile);

  // ---- Move objects -------------------------------------------------------------------------------------------
  // What a press on (wx, wy) picks up, like the eraser's layers: the tile's scenery, else its walls with the doors and
  // windows on their edges. Only objects of the sector files (not .mob ones).
  const movableAt = (wx, wy) => {
    const list = objectsAt(wx, wy).filter(p => p.staticSecObject && p.__obj);
    if (overlayVisibility.scenery) { const s = list.filter(p => p.type === 3); if (s.length) return s; }
    if (!overlayVisibility.walls) return [];
    const walls = list.filter(p => p.type === 0), out = walls.slice(), idx = getEdgeIndex();
    for (const w of walls) { const ek = edgeKeyOf(w); if (ek != null) for (const e of idx.get(ek) || []) if (e.type === 1 && e.staticSecObject && e.__obj && !out.includes(e)) out.push(e); }
    return out;
  };
  // `pt` moved to tile (wx, wy): the same object (every field kept) at its new place, in that tile's sector.
  const moveObject = (pt, wx, wy) => {
    const at = sectorAtWorld(wx, wy); if (!at) return null;
    const from = findSector(pt.sectorX, pt.sectorY);
    if (!from?.decoded || from.terrain || !prepSector(from) || !prepSector(at.sec)) return null;
    const sec = at.sec, tileX = wx & 63, tileY = wy & 63, loc = locationFor(sec, tileX, tileY);
    const obj = secObjectAt(pt.__obj, loc); if (!obj) return null;
    if (!removeObject(pt)) return null;
    sec.decoded.staticObjects.push(obj);
    sec.decoded.staticObjectCount = sec.decoded.staticObjects.length;
    const np = Object.assign({}, pt, {
      file: `${sec.filename}#new`, sectorX: Number(sec.position.x), sectorY: Number(sec.position.y), tileX, tileY,
      worldX: Number(sec.position.x) * 64 + tileX, worldY: Number(sec.position.y) * 64 + tileY,
      locationRaw: loc.toString(), seq: -1, __obj: obj
    });
    mobPoints.push(np);
    edit.objSecs.set(secSectorKey(sec), sec);
    edit.objOps.push({ kind: 'add', sec, obj, pt: np, index: sec.decoded.staticObjects.length - 1 });
    indexAdd(np);
    return np;
  };
  // A copy of the static object `pt` on tile (wx, wy) (the original stays): every field kept - prototype, art, offsets,
  // flags, scripts - except its own object id, which two objects must not share.
  const cloneObject = (pt, wx, wy) => {
    if (!pt.__obj) return null;
    const at = sectorAtWorld(wx, wy); if (!at || !prepSector(at.sec)) return null;
    const sec = at.sec, tileX = wx & 63, tileY = wy & 63, loc = locationFor(sec, tileX, tileY);
    const obj = secObjectAt(pt.__obj, loc); if (!obj) return null;
    obj.__bytes.fill(0, 28, 52);
    obj.objectOid = new Uint8Array(24);
    sec.decoded.staticObjects.push(obj);
    sec.decoded.staticObjectCount = sec.decoded.staticObjects.length;
    const np = Object.assign({}, pt, {
      file: `${sec.filename}#new`, sectorX: Number(sec.position.x), sectorY: Number(sec.position.y), tileX, tileY,
      worldX: Number(sec.position.x) * 64 + tileX, worldY: Number(sec.position.y) * 64 + tileY,
      locationRaw: loc.toString(), seq: -1, __obj: obj
    });
    mobPoints.push(np);
    edit.objSecs.set(secSectorKey(sec), sec);
    edit.objOps.push({ kind: 'add', sec, obj, pt: np, index: sec.decoded.staticObjects.length - 1 });
    indexAdd(np);
    return np;
  };
  const beginMove = f => {
    const pts = movableAt(f.wx, f.wy);
    if (!pts.length) { edit.problem = 'Nothing to move on that tile (scenery, or walls with their doors and windows).'; return; }
    edit.moveDrag = { pts, wx: f.wx, wy: f.wy, tx: f.wx, ty: f.wy };
    scheduleCursor();
  };
  const commitMove = () => {
    const d = edit.moveDrag; edit.moveDrag = null;
    if (!d || (d.tx === d.wx && d.ty === d.wy)) return;
    const dx = d.tx - d.wx, dy = d.ty - d.wy;
    let moved = 0;
    for (const p of d.pts) if (moveObject(p, wxOf(p) + dx, wyOf(p) + dy)) moved++;
    if (moved < d.pts.length) edit.problem = `${d.pts.length - moved} object${d.pts.length - moved === 1 ? '' : 's'} could not be moved there`;
    if (moved) edit.houseNote = `Moved ${moved} object${moved === 1 ? '' : 's'}`;
  };

  // ---- the site of a new house -----------------------------------------------------------------------------------
  // What stands where a house goes is taken away first, as the game's houses have nothing under them: the objects
  // (a tree, grass, a lamp...) on its floor and under its roof, and walls, doors and windows across its inside.
  // `tiles`: its floor ([[x, y]]); `roofCells`: the roof cells over it ([{ cx, cy }], 4 x 4 tiles each).
  const clearHouseSite = (tiles, roofCells) => {
    const tk = (x, y) => `${x},${y}`, inside = new Set(tiles.map(([x, y]) => tk(x, y))), area = new Set(inside);
    for (const { cx, cy } of roofCells || []) for (let y = cy * 4; y < cy * 4 + 4; y++) for (let x = cx * 4; x < cx * 4 + 4; x++) area.add(tk(x, y));
    const NB = [[-1, 0], [0, 1], [1, 0], [0, -1]];      // the tile across edge NE, SE, SW, NW
    let removed = 0;
    // (items lying there and traps too; not containers - their contents are objects of their own - nor critters)
    for (const p of mobPoints.slice()) {
      if (!p.staticSecObject || !p.__obj || p.type === 2 || p.type === 15 || p.type === 16) continue;
      const x = wxOf(p), y = wyOf(p), k = tk(x, y);
      if (!area.has(k)) continue;
      if (p.type === 0 || p.type === 1) {
        const rot = secEdgeRotation(p) ?? p.__rot; if (rot == null) continue;
        const nb = NB[(rot >> 1) & 3];
        if (!(inside.has(k) && inside.has(tk(x + nb[0], y + nb[1])))) continue;   // only walls inside the house
      }
      if (removeObject(p)) removed++;
    }
    // and the lights of the old rooms (the sector lights standing on its floor)
    for (const sec of valid) for (const light of (sec.decoded.lights || []).slice()) if (inside.has(tk(light.x - minX * 64, light.y - minY * 64)) && removeLight(sec, light)) removed++;
    return removed;
  };
  const houseRoofCells = (house, plan, roofed) => {
    if (!roofed) return [];
    if (plan?.roof?.length) return plan.roof;
    const { x0, x1, y0, y1 } = houseRoofBlock(house), cells = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) cells.push({ cx, cy });
    return cells;
  };
  const houseTiles = ({ a, b, c, e }, plan) => {
    if (plan?.tiles) return plan.tiles;
    const out = [];
    for (let y = c; y < e; y++) for (let x = a; x < b; x++) out.push([x, y]);
    return out;
  };

  const placeScenery = (wx, wy) => {
    const item = edit.sel.scenery; if (!item) return false;
    const k = `s${wx},${wy}`;
    if (edit.strokeSeen.has(k)) return false;
    edit.strokeSeen.add(k);
    const rv = pk.scenery.rot.value;
    const aid = rv === 'proto' ? item.aid : secAidWithRotation(item.aid, Number(rv));
    if (objectsAt(wx, wy).some(p => p.type === 3 && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num && (Number(p.currentAidRaw) >>> 0) === aid)) return false;
    return !!addObject(wx, wy, 3, item, aid, null);
  };

  const wallPiece = () => pk.wall.piece.value === 'auto' ? (edit.commonPiece ?? 0) : Number(pk.wall.piece.value);
  // The game stores a wall's rotation as 1, 3, 5, 7 for its NE, SE, SW, NW edge (all 421,797 walls of
  // the shipped sectors: no wall has an even rotation), so that is what is written.
  const wallRotation = dir => dir * 2 + 1;
  const placeWall = ({ wx, wy, dir, piece }) => {
    const item = edit.sel.wall; if (!item || item.num == null) return false;
    const key = secEdgeKey(wx, wy, dir);
    if (edit.strokeSeen.has(`w${key}`)) return false;
    edit.strokeSeen.add(`w${key}`);
    const rot = wallRotation(dir);
    const aid = secWallAid(item.aid, piece ?? wallPiece(), rot, Number(pk.wall.variation.value));
    const existing = (getEdgeIndex().get(key) || []).filter(p => p.type === 0);
    if (existing.some(p => (Number(p.currentAidRaw) >>> 0) === aid && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num)) return false;
    let changed = false;
    for (const p of existing) if (removeObject(p)) changed = true;   // replacing the wall that stood there
    if (addObject(wx, wy, 0, item, aid, rot)) changed = true;
    return changed;
  };

  // The nearest roofable span to tiles [lo, hi) on an axis of `size` tiles: lo = 2 mod 4, hi = 3 mod 4, at
  // least 5 tiles, and its roof cells inside the map (houseRoofBlock).
  const snapHouseSpan = (lo, hi, size) => {
    let a = 4 * Math.round((lo - 2) / 4) + 2, b = 4 * Math.round((hi - 3) / 4) + 3;
    if (a < 2) a = 2;
    if (b - a < 5) b = a + 5;
    while (b > size - 1) b -= 4;
    if (b - a < 5) a = b - 5;
    return [a, b];
  };
  // Line / rectangle brushes work on tile CORNERS. Corner (i, j) sits at world (i - 0.5, j - 0.5), so tile x lies
  // between corners x and x + 1. Edge directions: 0 = NE (towards x-1), 1 = SE (y+1), 2 = SW (x+1), 3 = NW (y-1).
  // the House brush of the Wall tool, and the Generate tool: a house drawn corner to corner
  const houseBrush = () => edit.tool === 'generate' || edit.wallBrush === 'house';
  const vertexFromFloat = f => ({ i: Math.max(0, Math.min(mapW, Math.round(f.fx + 0.5))), j: Math.max(0, Math.min(mapH, Math.round(f.fy + 0.5))) });
  const wallSegments = d => {
    const out = [], inMap = (x, y) => x >= 0 && y >= 0 && x < mapW && y < mapH;
    if (houseBrush()) {
      let a = Math.min(d.i0, d.i1), b = Math.max(d.i0, d.i1), c = Math.min(d.j0, d.j1), e = Math.max(d.j0, d.j1);
      if (b > a && e > c) {
        // With a roof, the walls are snapped to the roof grid (see houseRoofBlock): the roof pieces are
        // whole 4 x 4-tile pictures, so any other rectangle is left partly uncovered or overhung. (A generated building
        // always has its roof.)
        if (edit.tool === 'generate' || pk.wall.roof.value !== 'none' || wantShapes()) { [a, b] = snapHouseSpan(a, b, mapW); [c, e] = snapHouseSpan(c, e, mapH); }
        // Every wall belongs to a tile inside the house. The game ends each side with a corner piece, and
        // the pieces are the ones it uses in its own houses (read off every house of the shipped sectors):
        //   top corner (a, c)       NE 6 · NW 5        right corner (a, e-1)   NE 2 · SE 1
        //   bottom corner (b-1, e-1) SE 4 · SW 3       left corner (b-1, c)    SW 1 · NW 2
        // and 0 (a plain wall) between them.
        const piece = (isFirst, isLast, first, last) => isFirst ? first : isLast ? last : 0;
        for (let x = a; x < b; x++) {
          out.push({ wx: x, wy: c, dir: 3, piece: piece(x === a, x === b - 1, 5, 2) });        // NW side: top corner → left corner
          out.push({ wx: x, wy: e - 1, dir: 1, piece: piece(x === a, x === b - 1, 1, 4) });    // SE side: right corner → bottom corner
        }
        for (let y = c; y < e; y++) {
          out.push({ wx: a, wy: y, dir: 0, piece: piece(y === c, y === e - 1, 6, 2) });        // NE side: top corner → right corner
          out.push({ wx: b - 1, wy: y, dir: 2, piece: piece(y === c, y === e - 1, 1, 3) });    // SW side: left corner → bottom corner
        }
        out.house = { a, b, c, e };
        return out;
      }                               // a flat "house" is just a line
    }
    const dx = d.i1 - d.i0, dy = d.j1 - d.j0;
    if (!dx && !dy) return out;
    if (Math.abs(dx) >= Math.abs(dy)) {            // runs along x: the walls sit on the edge between rows j-1 and j
      const j = d.j0, lo = Math.min(d.i0, d.i1), hi = Math.max(d.i0, d.i1), upper = d.sy < j - 0.5;
      for (let x = lo; x < hi; x++) {
        let wy = upper ? j - 1 : j, dir = upper ? 1 : 3;
        if (!inMap(x, wy)) { wy = upper ? j : j - 1; dir = upper ? 3 : 1; }
        if (inMap(x, wy)) out.push({ wx: x, wy, dir });
      }
    } else {                                       // runs along y: the walls sit on the edge between columns i-1 and i
      const i = d.i0, lo = Math.min(d.j0, d.j1), hi = Math.max(d.j0, d.j1), left = d.sx < i - 0.5;
      for (let y = lo; y < hi; y++) {
        let wx = left ? i - 1 : i, dir = left ? 2 : 0;
        if (!inMap(wx, y)) { wx = left ? i : i - 1; dir = left ? 0 : 2; }
        if (inMap(wx, y)) out.push({ wx, wy: y, dir });
      }
    }
    return out;
  };
  // ---- house roof ----------------------------------------------------------------------------------
  // The roof grid has one art id per 4 x 4 tiles: type 10 (28-31), roof number (19-27), piece (14-18) and
  // bits 0 + 4 for a mirrored picture. A roof is a block of cells; which piece goes where was read off the
  // roofs of the shipped sectors (the same piece and mirror in every one of their thousands of blocks):
  //   corners   top (smallest x and y) 7 · left (largest x, smallest y) 0 · right 0 mirrored · bottom 4
  //   edges     smallest y 2 · largest x 1 · largest y 1 mirrored · smallest x 2 mirrored      centre 8
  const roofId = (num, piece, mirrored) => (((ART_TYPE.ROOF << 28) | (num << 19) | (piece << 14) | (mirrored ? 0x11 : 0)) >>> 0);
  const roofPieceAt = (i, j, w, h) => {
    const x0 = i === 0, x1 = i === w - 1, y0 = j === 0, y1 = j === h - 1;
    if (x0 && y0) return [7, false];
    if (x1 && y0) return [0, false];
    if (x0 && y1) return [0, true];
    if (x1 && y1) return [4, false];
    if (y0) return [2, false];
    if (x1) return [1, false];
    if (y1) return [1, true];
    if (x0) return [2, true];
    return [8, false];
  };
  // The map's most used roof style (the fallback of "Auto").
  const usualRoofNum = () => {
    const counts = new Map();
    for (const s of valid) for (const v of s.decoded.roofArtIds || []) if (secIsRoofId(v)) { const n = secRoofNum(v >>> 0); counts.set(n, (counts.get(n) || 0) + 1); }
    let best = 2, bc = 0;
    for (const [n, c] of counts) if (c > bc) { best = n; bc = c; }
    return best;
  };
  // The roof chosen in the House brush: "Auto" is the one the game's houses of the selected wall style have (read off
  // the map: HOUSE_STYLE_ROOFS), else the map's usual one.
  // The roof always follows the walls, as in the game; a roof whose inner corners the game never closes keeps the house a
  // rectangle (houseShapes) rather than taking another roof.
  const wantShapes = () => !pk.wall.shapes.disabled && pk.wall.shapes.checked;
  const chosenRoofNum = () => {
    const choice = pk.wall.roof.value;
    if (choice !== 'auto') return Number(choice);
    return roofForWallStyle(edit.sel.wall?.artKey) ?? usualRoofNum();
  };
  // The cells of the roof of a house with tiles [a, b) x [c, e). In the game's own houses (322 of them, read
  // off the shipped sectors) the roof block is the one that spans tiles [a - 2, b + 1) on each axis: a 5 x 5
  // house standing on a tile 2 mod 4 has the 2 x 2 cells around it, a 9 x 9 one 3 x 3... so a roofed house
  // has a = 2 mod 4, b = 3 mod 4 and at least 5 tiles a side (a roof of a single cell has no piece in the
  // game's art). wallSegments() snaps the House brush to that (snapHouseSpan), so the block is exact.
  const houseRoofBlock = ({ a, b, c, e }) => ({ x0: (a - 2) >> 2, x1: ((b + 1) >> 2) - 1, y0: (c - 2) >> 2, y1: ((e + 1) >> 2) - 1 });
  const setRoofCell = (cx, cy, raw) => {
    const at = sectorAtWorld(cx * 4, cy * 4); if (!at) return false;
    const d = at.sec.decoded;
    if (d.roofListOffset == null || !d.sourceBuffer) { edit.problem = `${at.sec.filename}: its roof list could not be located, so a roof cannot be added there`; return false; }
    const ids = secEnsureRoofs(d);
    const i = (((cy * 4) & 63) >> 2) * 16 + (((cx * 4) & 63) >> 2);
    if ((ids[i] >>> 0) === raw) return false;
    // a cell changed twice in one step (painted, then fitted to its neighbours) is one entry: undo restores the first state
    const again = edit.objOps.find(o => o.kind === 'roof' && o.sec === at.sec && o.idx === i);
    if (again) again.after = raw; else edit.objOps.push({ kind: 'roof', sec: at.sec, idx: i, before: ids[i] >>> 0, after: raw });
    ids[i] = raw;
    edit.roofSecs.set(secSectorKey(at.sec), at.sec);
    return true;
  };
  // `cells`: the roof of a shaped house ([{ cx, cy, piece, mirrored }], from its plan) instead of the whole block.
  // `roofNum`: that roof whatever the Wall tool's choice (a generated building's)
  const placeHouseRoof = (house, cells = null, roofNum = null) => {
    if (roofNum == null && pk.wall.roof.value === 'none') return;
    const num = roofNum ?? chosenRoofNum();
    const { x0, x1, y0, y1 } = houseRoofBlock(house);
    let changed = false;
    if (cells) {
      for (const r of cells) if (setRoofCell(r.cx, r.cy, roofId(num, r.piece, r.mirrored))) changed = true;
    } else for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const [piece, mirrored] = roofPieceAt(cx - x0, cy - y0, x1 - x0 + 1, y1 - y0 + 1);
      if (setRoofCell(cx, cy, roofId(num, piece, mirrored))) changed = true;
    }
    if (!changed) return;
    // Roofs are only drawn with the Roofs layer on; it is left as the user has it.
    if (overlayVisibility.roofs) ensureRoofArt();
  };
  // ---- placeholder houses (see sec-house-plan.js) ----------------------------------------------------
  // The prototype a door, window or piece of furniture is placed with: the one that already has its art, else
  // the one this map uses most (of the doors for a door, of the windows for a window), with the art id
  // overridden - what the Portal and Scenery palettes do for a texture without a prototype of its own.
  const makeProtoPicker = () => {
    const used = {};
    const mostUsed = (kind, pool) => {
      if (!used[kind]) {
        used[kind] = new Map();
        for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === PROTO_TYPE[kind]) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) used[kind].set(n, (used[kind].get(n) || 0) + 1); }
      }
      let best = pool[0], bn = -1;
      for (const it of pool) { const n = used[kind].get(it.num) || 0; if (n > bn) { bn = n; best = it; } }
      return best;
    };
    const isDoorAid = aid => ((aid >>> 10) & 1) === 1;
    const cache = new Map();
    // portal: key = door number, or window number + 1001 (portal.mes); scenery: key = scenery.mes number
    return (kind, key) => {
      const ck = `${kind}${key}`;
      if (cache.has(ck)) return cache.get(ck);
      const items = secProtoCatalog.byType[PROTO_TYPE[kind]] || [];
      const keyOf = it => kind === 'portal' ? TEX.portal.keyOfAid(it.aid) : protoCurrentAidArtId(it.aid, 3);
      const game = secGameProtoForKey(PROTO_TYPE[kind], key);
      let proto = (game && items.find(it => it.num === game.num)) || items.find(it => keyOf(it) === key) || null;
      if (!proto && items.length) {
        const like = kind === 'portal' ? items.filter(it => isDoorAid(it.aid) === (key < 1001)) : items;
        proto = mostUsed(kind, like.length ? like : items);
      }
      const item = proto && { num: proto.num, label: proto.label, objType: PROTO_TYPE[kind], aid: kind === 'portal' ? TEX.portal.aidOf(key, proto.aid) : sceneryAidOf(key) };
      cache.set(ck, item);
      return item;
    };
  };
  // A portal on the tile edge of a wall that has just been drawn (placePortal does the same from a mouse click).
  const placePortalOnEdge = ({ wx, wy, dir }, item) => {
    const rot = wallRotation(dir), aid = secAidWithRotation(item.aid, rot);
    let changed = false;
    for (const p of (getEdgeIndex().get(secEdgeKey(wx, wy, dir)) || []).filter(q => q.type === 1)) if (removeObject(p)) changed = true;
    return !!addObject(wx, wy, 1, item, aid, rot) || changed;
  };
  // Other shapes than the rectangle need a roof whose art closes an inner corner (the brick parapets do not: the game only
  // has rectangles of those, side by side)
  const houseShapes = () => wantShapes() && (pk.wall.roof.value === 'none' || roofTakesShapes(chosenRoofNum()));
  const planPlaceholders = house => {
    const num = edit.sel.wall.artKey;
    // other shapes than the rectangle only on the roof grid (the walls are snapped to it when there is a roof)
    const plan = num == null ? null : planHouse(num, house, null, { shapes: houseShapes() });
    if (!plan) { edit.houseNote = 'no placeholders: the game has no houses with this wall style'; return null; }
    if (!secProtoCatalog.done) { edit.houseNote = 'no placeholders yet: the prototypes are still being scanned'; return null; }
    return plan;
  };
  // (the bits of a rug cell beside its facade, cell and walkable flag: what all 3548 rug cells of the game's maps have)
  const HOUSE_RUG_KEEP = 0x4000800;
  // `portals` false: only the furniture and rugs (the door and windows stay)
  const placePlaceholders = (plan, { portals = true } = {}) => {
    const pick = makeProtoPicker();
    let missing = 0;
    if (portals) for (const p of plan.portals) {
      const item = pick('portal', p.door ? p.num : p.num + 1001);
      if (item) placePortalOnEdge(p, item); else missing++;
    }
    for (const s of plan.scenery) {
      const item = pick('scenery', s.key);
      if (!item) { missing++; continue; }
      const aid = secAidWithRotation(item.aid, s.rot ?? 0);
      if (objectsAt(s.wx, s.wy).some(p => p.type === 3 && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num && (Number(p.currentAidRaw) >>> 0) === aid)) continue;
      addObject(s.wx, s.wy, 3, item, aid, null, s.off);
    }
    // the rugs: facade cells over the floor's tiles, walkable, with the other bits the game's rugs have. What each tile was
    // is kept, so "Generate again" can lay the floor back before laying new ones.
    const rugs = [];
    for (const f of plan.facades || []) {
      const at = sectorAtWorld(f.wx, f.wy); if (!at) continue;
      const before = at.sec.decoded.tiles[at.idx] >>> 0, raw = secMakeFacadeRaw(f.num, f.frame, 1, HOUSE_RUG_KEEP);
      if (setTile(f.wx, f.wy, raw)) { rugs.push({ wx: f.wx, wy: f.wy, before, raw }); ensureArt(raw); }
    }
    // the light of its rooms (daylight by the windows, a lamp's glow): sector lights, which the game lights its houses with
    const lights = (plan.lights || []).map(l => addLight(l)).filter(Boolean);
    edit.houseNote = missing ? `${missing} placeholder${missing === 1 ? '' : 's'} skipped (no prototype to place ${missing === 1 ? 'it' : 'them'} with)` : `${plan.style.name} house with its door, windows and furniture`;
    return { rugs, lights };
  };
  // the rugs a placeholder house was given, taken up again (where the tile is still the rug's)
  const liftRugs = rugs => {
    for (const r of rugs || []) {
      const at = sectorAtWorld(r.wx, r.wy);
      if (at && (at.sec.decoded.tiles[at.idx] >>> 0) === r.raw) setTile(r.wx, r.wy, r.before);
    }
  };
  // ---- house floor: the tile the game lays under a house of this wall style (HOUSE_FLOORS) ---------------
  const houseFloorId = () => houseFloorTile(edit.sel.wall?.artKey);
  // Its art files take a moment to load: start that when the House drag begins, so they are there at release.
  const preloadHouseFloor = () => {
    const id = houseFloorId();
    if (id != null && pk.wall.floor.checked) resolveVariants(id).then(vs => { for (const v of vs) artTiles.set(v.raw, v.art); });
  };
  const placeHouseFloor = ({ a, b, c, e }, tiles = null) => {
    const id = houseFloorId(); if (id == null) return false;
    const vs = variantCache.get(id);
    if (!vs) {
      // not loaded yet (Generate never preloads for its own style): lay variant a now, then scatter the variants over
      // the tiles still showing it once they are there, or the whole floor would look the same
      const plain = plainTileRaw(id, 0), spots = tiles ? [...tiles] : [];
      if (!tiles) for (let y = c; y < e; y++) for (let x = a; x < b; x++) spots.push([x, y]);
      resolveVariants(id).then(loaded => {
        if (!loaded.length) return;
        for (const v of loaded) artTiles.set(v.raw, v.art);
        // written straight into the tiles: the stroke that laid variant a already holds their old values, so undo still restores them
        for (const [x, y] of spots) {
          const at = sectorAtWorld(x, y);
          if (at && (at.sec.decoded.tiles[at.idx] >>> 0) === plain) { at.sec.decoded.tiles[at.idx] = scatterRaw(loaded, x, y); touchSector(at.sec); }
        }
        redraw();
      });
    }
    const list = vs?.length ? vs : [{ raw: plainTileRaw(id, 0) }];
    let changed = false;
    if (tiles) { for (const [x, y] of tiles) if (setTile(x, y, scatterRaw(list, x, y))) changed = true; return changed; }   // a shaped house
    for (let y = c; y < e; y++) for (let x = a; x < b; x++) if (setTile(x, y, scatterRaw(list, x, y))) changed = true;
    return changed;
  };
  // A wall of structure `num` to build with, as the Wall palette would pick it: the prototype that has that art, else the
  // one this map uses most with the art set on it.
  const wallItemFor = num => {
    const items = secProtoCatalog.byType[PROTO_TYPE.wall] || [];
    if (!items.length) return null;
    const game = secGameProtoForKey(PROTO_TYPE.wall, num);
    let proto = (game && items.find(it => it.num === game.num)) || items.find(it => TEX.wall.keyOfAid(it.aid) === num);
    if (!proto) {
      const use = new Map();
      for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === PROTO_TYPE.wall) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) use.set(n, (use.get(n) || 0) + 1); }
      proto = items.reduce((b, it) => (use.get(it.num) || 0) > (use.get(b.num) || 0) ? it : b, items[0]);
    }
    return { num: proto.num, label: HOUSE_STYLES[num]?.name || String(num), aid: TEX.wall.aidOf(num, proto.aid), objType: PROTO_TYPE.wall, artKey: num };
  };
  // Generate: the building of the kind picked, on the drag's rectangle (snapped to the roof grid), with its walls drawn when
  // Auto; the roof the game gives those walls (one that closes inner corners, for a shape)
  const commitGenerate = d => {
    const kind = HOUSE_KIND_LIST.find(k => k.id === edit.genKind); if (!kind) return;
    const num = gen.style.value === 'auto' ? styleForKind(kind.id) : Number(gen.style.value);
    const item = wallItemFor(num);
    if (!item) { edit.houseNote = 'the wall prototypes are still being scanned - try again in a moment'; return; }
    const sel = edit.sel.wall;
    edit.sel.wall = item;
    try {
      const segs = wallSegments(d); if (!segs.house) return;
      const roofNum = roofForWallStyle(num) ?? usualRoofNum();
      const shapes = gen.shapes.checked && roofTakesShapes(roofNum);
      const plan = planHouse(num, segs.house, null, { shapes, kind: kind.id });
      if (!plan) { edit.houseNote = 'the game has no houses with these walls'; return; }
      const cleared = clearHouseSite(houseTiles(segs.house, plan), houseRoofCells(segs.house, plan, true));
      placeHouseFloor(segs.house, plan.tiles);
      edit.housePts = [];
      for (const s of plan.walls) placeWall(s);
      placeHouseRoof(segs.house, plan.roof?.length ? plan.roof : null, roofNum);
      const { rugs, lights } = placePlaceholders(plan);
      setLastHouse({ house: segs.house, num, wallItem: item, shapes, seed: plan.seed, doorSide: plan.doorSide,
        styleName: `${kind.name} (${plan.style.name})`, pts: edit.housePts, rugs, lights, kind: kind.id });
      edit.housePts = null;
      if (!(edit.houseNote || '').includes('skipped')) edit.houseNote = `${kind.name}, ${plan.style.name} walls`;
      if (cleared) edit.houseNote += ` · ${cleared} object${cleared === 1 ? '' : 's'} that stood there removed`;
    } finally { edit.sel.wall = sel; }
  };
  const commitWallDrag = () => {
    const d = edit.wallDrag; edit.wallDrag = null;
    if (!d) return;
    if (edit.tool === 'generate') { commitGenerate(d); return; }
    const segs = wallSegments(d);
    // With placeholders, the plan decides the house's shape: its walls (outline, openings, dividers), floor and roof.
    const plan = segs.house && pk.wall.placeholders.checked ? planPlaceholders(segs.house) : null;
    const cleared = segs.house ? clearHouseSite(houseTiles(segs.house, plan), houseRoofCells(segs.house, plan, pk.wall.roof.value !== 'none')) : 0;
    if (segs.house && pk.wall.floor.checked) placeHouseFloor(segs.house, plan?.tiles);
    if (plan) edit.housePts = [];
    for (const s of plan ? plan.walls : segs) placeWall(s);
    if (segs.house) placeHouseRoof(segs.house, plan?.roof?.length ? plan.roof : null);
    if (plan) {
      const { rugs, lights } = placePlaceholders(plan);
      // what "Generate again" and "Turn" work on: this house, the objects it was built with, how to plan it again
      setLastHouse({ house: segs.house, num: edit.sel.wall.artKey, wallItem: edit.sel.wall, shapes: houseShapes(),
        seed: plan.seed, doorSide: plan.doorSide, styleName: plan.style.name, pts: edit.housePts, rugs, lights });
      edit.housePts = null;
    }
    if (cleared) edit.houseNote = `${edit.houseNote ? `${edit.houseNote} · ` : ''}${cleared} object${cleared === 1 ? '' : 's'} that stood there removed`;
  };
  // ---- "Generate again" / "Turn": the last placeholder house rebuilt from its plan's seed ---------------------------
  // Generate again: new furniture. Turn: the front door on the next side (NE → SE → SW → NW → NE), its walls and windows
  // redone to match, and new furniture. The shape, rooms, floor and roof stay (the same seed gives the same layout).
  const setLastHouse = h => {
    const before = edit.lastHouse;
    edit.lastHouse = h;
    edit.houseSnap = { before, after: h };
    syncHouseBtns();
  };
  const syncHouseBtns = () => { pk.wall.regen.disabled = pk.wall.turn.disabled = gen.regen.disabled = gen.turn.disabled = !edit.lastHouse; };
  const SIDE_NAMES = ['NE', 'SE', 'SW', 'NW'];
  const houseAction = turn => {
    const h = edit.lastHouse; if (!h || edit.painting) return;
    edit.objOps = []; edit.stroke = new Map(); edit.strokeSeen = new Set(); edit.problem = null; edit.skippedMob = 0; edit.houseNote = null;
    // take away what the house was given: its furniture and rugs; to turn it, its walls, door and windows too
    const keep = [];
    for (const p of h.pts) if (p.type === 3 || turn) removeObject(p); else keep.push(p);
    liftRugs(h.rugs);
    liftLights(h.lights);
    const plan = planHouse(h.num, h.house, null, { shapes: h.shapes, seed: h.seed, doorSide: turn ? (h.doorSide + 1) % 4 : h.doorSide, kind: h.kind || null });
    const sel = edit.sel.wall;
    edit.sel.wall = h.wallItem;
    edit.housePts = keep;
    let rugs = [], lights = [];
    try {
      if (turn) for (const s of plan.walls) placeWall(s);
      ({ rugs, lights } = placePlaceholders(plan, { portals: turn }));
    } finally { edit.sel.wall = sel; }
    setLastHouse({ ...h, doorSide: plan.doorSide, pts: edit.housePts, rugs, lights });
    edit.housePts = null;
    const entries = [];
    for (const e of edit.stroke.values()) entries.push({ kind: 'tile', sec: e.sec, idx: e.idx, before: e.before, after: e.sec.decoded.tiles[e.idx] >>> 0 });
    entries.push(...edit.objOps);
    edit.objOps = []; edit.stroke = null;
    if (entries.length) {
      entries.house = edit.houseSnap;
      edit.undo.push(entries); if (edit.undo.length > 300) edit.undo.shift();
      edit.redo.length = 0; edit.unsaved = true;
    }
    edit.houseSnap = null;
    const what = h.kind ? h.styleName : `${h.styleName} house`;
    status.textContent = turn ? `${what}: front door on the ${SIDE_NAMES[plan.doorSide]} side` : `${what}: new furniture`;
    if (edit.houseNote && edit.houseNote.includes('skipped')) status.textContent += ` · ${edit.houseNote}`;
    edit.houseNote = null;
    invalidateObjIdx(); refreshEditUi(); scheduleEditRedraw();
  };
  pk.wall.regen.addEventListener('click', () => houseAction(false));
  pk.wall.turn.addEventListener('click', () => houseAction(true));
  gen.regen.addEventListener('click', () => houseAction(false));
  gen.turn.addEventListener('click', () => houseAction(true));
  const cancelWallDrag = () => {
    if (!edit.wallDrag) return;
    edit.wallDrag = null; edit.painting = false; edit.stroke = null; edit.objOps = [];
    status.textContent = 'Cancelled'; scheduleCursor();
  };

  const portalTarget = f => {
    const idx = getEdgeIndex();
    let best = null, bd = 0.75 * 0.75;
    for (let tx = f.wx - 1; tx <= f.wx + 1; tx++) for (let ty = f.wy - 1; ty <= f.wy + 1; ty++) for (const dir of [0, 1]) {
      const key = `${tx},${ty},${dir}`;
      const wall = (idx.get(key) || []).find(p => p.type === 0);
      if (!wall) continue;
      const mid = dir === 0 ? [tx - 0.5, ty] : [tx, ty + 0.5];
      const d = (mid[0] - f.fx) ** 2 + (mid[1] - f.fy) ** 2;
      if (d < bd) { bd = d; best = { tx, ty, dir, key, wall }; }
    }
    return best;
  };
  const placePortal = f => {
    const item = edit.sel.portal; if (!item || item.num == null) return false;
    const hit = portalTarget(f);
    if (!hit) { edit.problem = 'Portals can only be placed on a wall: click right on a wall.'; return false; }
    const rot = secEdgeRotation(hit.wall) ?? hit.wall.__rot ?? 0;
    const aid = secAidWithRotation(item.aid, rot);
    const existing = (getEdgeIndex().get(hit.key) || []).filter(p => p.type === 1);
    if (existing.some(p => (Number(p.currentAidRaw) >>> 0) === aid && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num)) return false;
    let changed = false;
    for (const p of existing) if (removeObject(p)) changed = true;
    if (addObject(wxOf(hit.wall), wyOf(hit.wall), 1, item, aid, rot)) changed = true;
    return changed;
  };

  // The cells to stamp with the picked facade's first cell on (wx, wy): { num, frame, wx, wy, art }. With "Whole
  // structure" the other parts of its group (sel.parts, see selectFacade) come along, each at its place.
  const facadeCells = (sel, wx, wy) => {
    const cells = sel.offsets ? sel.idxs.map(fr => {
      const o = sel.offsets.get(fr) || [0, 0];
      return { frame: fr, wx: wx + o[0], wy: wy + o[1] };
    }) : sel.idxs.map(fr => {
      const rel = fr - sel.idxs[0], col = rel % sel.cols, row = Math.floor(rel / sel.cols);
      return { frame: fr, wx: wx + col * sel.colVec[0] + row * sel.rowVec[0], wy: wy + col * sel.colVec[1] + row * sel.rowVec[1] };
    });
    for (const c of cells) { c.num = sel.num; c.art = sel.artByFrame.get(c.frame); }
    if (sel.whole && sel.parts) {
      for (const part of sel.parts) {
        for (const [fr, o] of part.offsets) cells.push({ num: part.num, frame: fr, wx: wx + part.dx + o[0], wy: wy + part.dy + o[1], art: part.artByFrame.get(fr) });
      }
    }
    return cells;
  };
  const placeFacade = (wx, wy) => {
    const sel = edit.sel.facade; if (!sel) return false;
    let changed = false;
    for (const c of facadeCells(sel, wx, wy)) {
      const raw = secMakeFacadeRaw(c.num, c.frame, sel.walkable, sel.keep);
      if (!artTiles.has(raw) && c.art) artTiles.set(raw, c.art);
      if (setTile(c.wx, c.wy, raw)) changed = true;
    }
    return changed;
  };
  // The ART file does not say where its cells go (and their order is not a plain grid). sec-facade-layouts.js holds
  // each facade's cell offsets, worked out from the game's maps and the pictures' borders (see
  // toolbox/extract_facade_layouts.py); only a facade it has no layout for falls back to this: look at how it is
  // already used on the map, otherwise guess and let the user adjust Columns / Swap axes.
  const inferFacadeLayout = (num, idxs) => {
    const pos = new Map(); let keep = null, walk = null;
    for (const s of valid) {
      const t = s.decoded.tiles, bx = (s.position.x - minX) * 64, by = (s.position.y - minY) * 64;
      for (let i = 0; i < 4096; i++) {
        const raw = t[i] >>> 0;
        if (artType(raw) !== ART_TYPE.FACADE) continue;
        if (keep === null) keep = (raw & ~SEC_FACADE_FIELD_MASK) >>> 0;
        if (secFacadeNumber(raw) !== num) continue;
        const fr = secFacadeFrame(raw);
        if (!pos.has(fr)) pos.set(fr, [bx + (i & 63), by + (i >> 6)]);
        if (walk === null) walk = secFacadeWalkable(raw);
      }
    }
    const n = idxs.length, first = idxs[0];
    let colVec = [1, 0], rowVec = [0, 1], cols = Math.max(1, Math.ceil(Math.sqrt(n))), known = false;
    const p0 = pos.get(first), p1 = pos.get(idxs[1]);
    if (p0 && p1 && idxs[1] === first + 1 && Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]) === 1) {
      colVec = [p1[0] - p0[0], p1[1] - p0[1]]; rowVec = [colVec[1], colVec[0]]; cols = n; known = true;
      for (const k of idxs) {
        if (k === first || k === first + 1) continue;
        const pk2 = pos.get(k); if (!pk2) continue;
        const d = [pk2[0] - p0[0], pk2[1] - p0[1]];
        if (colVec[0] * d[1] - colVec[1] * d[0] !== 0 && Math.abs(d[0]) + Math.abs(d[1]) === 1) { cols = k - first; rowVec = d; break; }
      }
    }
    return { colVec, rowVec, cols, known, keep: keep ?? 0, walkable: walk ?? 1 };
  };

  const needsObjects = t => t === 'move' || t === 'stamp' || t === 'eraser' || t === 'scenery' || t === 'wall' || t === 'portal' || t === 'eyedropper' || t === 'mobedit' || t === 'generate' || t === 'paths' || !!SEC_MOB_KINDS[t];
  const toolReady = () => {
    const t = edit.tool;
    if (edit.pan || t === 'eyedropper' || t === 'mobedit' || t === 'paths') return false;
    if (SEC_MOB_KINDS[t] && !edit.sel[t]) { status.textContent = `Pick ${t === 'npcs' ? 'an NPC' : t === 'items' ? 'an item' : 'a container'} in the list on the right first.`; return false; }
    if (t === 'generate' && !edit.genKind) { status.textContent = 'Pick what to build in the list on the right first.'; return false; }
    if (t === 'generate' && !secProtoCatalog.done) { secStartProtoScan(); status.textContent = 'The prototypes are still being scanned - try again in a moment.'; return false; }
    if ((t === 'tile' || t === 'fill') && !edit.brush) { status.textContent = 'Pick a tile in the list on the right first (Alt+click picks one from the map).'; return false; }
    if ((t === 'facade' || t === 'scenery' || t === 'wall' || t === 'portal') && !edit.sel[t]) { status.textContent = `Pick a ${t} in the palette on the right first.`; return false; }
    if ((t === 'wall' || t === 'portal') && edit.sel[t].num == null) { status.textContent = `The ${t} prototypes are still being scanned - try again in a moment.`; return false; }
    if (t === 'scenery' && edit.sel.scenery.num == null) { status.textContent = 'Scenery prototypes are still being scanned - try again in a moment.'; return false; }
    if (needsObjects(t) && !edit.objectsReady) { status.textContent = 'Objects are still loading…'; return false; }
    return true;
  };
  // Bresenham between two mouse samples, so a fast drag leaves no gaps (like Paint's pencil).
  const paintLine = (a, b, fn) => {
    let x0 = a.wx, y0 = a.wy;
    const x1 = b.wx, y1 = b.wy, dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const tileToolFn = () => ({ tile: applyBrush, eraser: eraseFootprint, scenery: placeScenery }[edit.tool]);
  const beginStroke = event => {
    if (!toolReady()) return;
    const f = worldFloat(event); if (!f) return;
    edit.painting = true; edit.stroke = new Map(); edit.objOps = []; edit.strokeSeen = new Set(); edit.skippedMob = 0; edit.problem = null;
    edit.last = { wx: f.wx, wy: f.wy }; edit.lastF = f;
    const t = edit.tool;
    if (t === 'wall') {
      if (edit.wallBrush === 'edge') placeWall(edgeFromFloat(f));
      else { if (edit.wallBrush === 'house') preloadHouseFloor(); const v = vertexFromFloat(f); edit.wallDrag ={ i0: v.i, j0: v.j, i1: v.i, j1: v.j, sx: f.fx, sy: f.fy }; scheduleCursor(); }
    }
    else if (t === 'generate') { const v = vertexFromFloat(f); edit.wallDrag = { i0: v.i, j0: v.j, i1: v.i, j1: v.j, sx: f.fx, sy: f.fy }; scheduleCursor(); }
    else if (t === 'portal') placePortal(f);
    else if (t === 'move') beginMove(f);
    else if (t === 'facade') placeFacade(f.wx, f.wy);
    else if (t === 'fill') fillAt(f.wx, f.wy);
    else if (SEC_MOB_KINDS[t]) placeMob(f);
    else if (extra.owns(t)) extra.press(t, f, event);
    else tileToolFn()(f.wx, f.wy);
    scheduleEditRedraw();
  };
  const continueStroke = event => {
    const f = worldFloat(event);
    if (!f) { edit.last = null; edit.lastF = null; return; }
    const t = edit.tool;
    if (extra.owns(t)) {
      if (!edit.last || edit.last.wx !== f.wx || edit.last.wy !== f.wy) extra.drag(t, edit.last || f, f);
      edit.last = { wx: f.wx, wy: f.wy }; edit.lastF = f;
      scheduleEditRedraw();
      return;
    }
    if (t === 'move') {
      const d = edit.moveDrag;
      if (d && (f.wx !== d.tx || f.wy !== d.ty)) {
        d.tx = f.wx; d.ty = f.wy;
        status.textContent = `Move · ${d.pts.length} object${d.pts.length === 1 ? '' : 's'} · ${d.tx - d.wx}, ${d.ty - d.wy} tiles · release to place, Esc to cancel`;
        scheduleCursor();
      }
      return;
    }
    if ((t === 'wall' || t === 'generate') && edit.wallDrag) {
      const v = vertexFromFloat(f), d = edit.wallDrag;
      if (v.i !== d.i1 || v.j !== d.j1) {
        d.i1 = v.i; d.j1 = v.j;
        const segs = wallSegments(d), n = segs.length, hs = segs.house;
        status.textContent = t === 'generate' ? `${HOUSE_KIND_LIST.find(k => k.id === edit.genKind)?.name}${hs ? ` · ${hs.b - hs.a} x ${hs.e - hs.c} tiles` : ''} · release to place, Esc to cancel`
          : `${edit.wallBrush === 'house' ? 'House' : 'Line'} · ${n} wall${n === 1 ? '' : 's'} · release to place, Esc to cancel`;
        scheduleCursor();
      }
      return;
    }
    if (t === 'wall') {
      // sample along the pointer path so a quick drag still catches every edge
      const a = edit.lastF || f, steps = Math.max(1, Math.ceil(Math.hypot(f.fx - a.fx, f.fy - a.fy) / 0.2));
      for (let i = 1; i <= steps; i++) {
        const fx = a.fx + (f.fx - a.fx) * i / steps, fy = a.fy + (f.fy - a.fy) * i / steps;
        const wx = Math.round(fx), wy = Math.round(fy);
        if (wx < 0 || wy < 0 || wx >= mapW || wy >= mapH) continue;
        placeWall(edgeFromFloat({ fx, fy, wx, wy }));
      }
    } else if (t === 'tile' || t === 'eraser' || t === 'scenery') {
      if (edit.last && edit.last.wx === f.wx && edit.last.wy === f.wy) return;
      paintLine(edit.last || f, f, tileToolFn());
    }
    edit.last = { wx: f.wx, wy: f.wy }; edit.lastF = f;
    scheduleEditRedraw();
  };
  function endStroke() {
    if (!edit.painting) return;
    edit.painting = false; edit.last = null; edit.lastF = null;
    commitWallDrag();
    commitMove();
    extra.commitStroke();
    const entries = [];
    if (edit.stroke) for (const e of edit.stroke.values()) entries.push({ kind: 'tile', sec: e.sec, idx: e.idx, before: e.before, after: e.sec.decoded.tiles[e.idx] >>> 0 });
    for (const e of edit.objOps || []) entries.push(e);
    if (edit.houseSnap) { entries.house = edit.houseSnap; edit.houseSnap = null; }
    if (entries.length) {
      edit.undo.push(entries); if (edit.undo.length > 300) edit.undo.shift();
      edit.redo.length = 0; edit.unsaved = true;
      const n = dirtySectors().size, m = edit.newMobs.length;
      status.textContent = `${edit.fillCount ? `Filled ${edit.fillCount} tile${edit.fillCount === 1 ? '' : 's'} · ` : ''}${n} sector${n === 1 ? '' : 's'} modified${m ? ` · ${m} new .mob file${m === 1 ? '' : 's'}` : ''} · Export .SEC to save`;
    } else if (edit.problem) status.textContent = edit.problem;
    if (edit.skippedMob) status.textContent += ` · ${edit.skippedMob} object${edit.skippedMob === 1 ? '' : 's'} come from .mob files and cannot be erased here`;
    if (edit.houseNote) { status.textContent = `${status.textContent ? `${status.textContent} · ` : ''}${edit.houseNote}`; edit.houseNote = null; }
    edit.stroke = null; edit.objOps = []; edit.fillCount = 0; refreshEditUi(); scheduleEditRedraw();
  }
  const replayHistory = (from, to, useAfter) => {
    const entries = from.pop(); if (!entries) return;
    if (entries.house) {      // the placeholder house "Generate again" / "Turn" work on, as it was then
      edit.lastHouse = useAfter ? entries.house.after : entries.house.before;
      syncHouseBtns();
    }
    const touched = new Set();
    for (const e of entries) if (e.kind === 'tile') { e.sec.decoded.tiles[e.idx] = useAfter ? e.after : e.before; touched.add(e.sec); }
    for (const e of entries) if (e.kind === 'roof') { e.sec.decoded.roofArtIds[e.idx] = useAfter ? e.after : e.before; touched.add(e.sec); }
    // block list, tile scripts, sector properties, map-level data: each entry knows how to go either way
    for (const e of (useAfter ? entries : entries.slice().reverse())) if (e.kind === 'fn') { e.apply(useAfter); if (e.sec) touched.add(e.sec); }
    const objs = entries.filter(e => e.kind === 'add' || e.kind === 'del' || e.kind === 'ladd' || e.kind === 'ldel');
    for (const e of (useAfter ? objs : objs.slice().reverse())) { applyObjOp(e, useAfter); touched.add(e.sec); }
    const mobOps = entries.filter(e => e.kind === 'madd' || e.kind === 'mdel');
    for (const e of (useAfter ? mobOps : mobOps.slice().reverse())) applyMobOp(e, useAfter);
    for (const sec of touched) {
      touchSector(sec);
      const key = secSectorKey(sec), d = edit.dirty.get(key);
      if (d && !sectorDiffers(d)) edit.dirty.delete(key);
      if (secObjectListDiffers(sec.decoded)) edit.objSecs.set(key, sec); else edit.objSecs.delete(key);
      if (secRoofsDiffer(sec.decoded)) edit.roofSecs.set(key, sec); else edit.roofSecs.delete(key);
      if (secLightsDiffer(sec.decoded)) edit.lightSecs.set(key, sec); else edit.lightSecs.delete(key);
      if (secExtrasDiffer(sec.decoded)) edit.extraSecs.set(key, sec); else edit.extraSecs.delete(key);
    }
    extra.afterReplay();
    to.push(entries); edit.unsaved = true; invalidateObjIdx();
    refreshEditUi(); redraw();
  };
  const undoEdit = () => replayHistory(edit.undo, edit.redo, false);
  const redoEdit = () => replayHistory(edit.redo, edit.undo, true);
  const onEditKey = e => {
    if (!article.isConnected) { document.removeEventListener('keydown', onEditKey, true); return; }
    if (edit.on && e.key === 'Escape' && edit.wallDrag) { e.preventDefault(); e.stopPropagation(); cancelWallDrag(); return; }
    if (edit.on && e.key === 'Escape' && edit.moveDrag) {
      e.preventDefault(); e.stopPropagation();
      edit.moveDrag = null; edit.painting = false; edit.stroke = null; edit.objOps = [];
      status.textContent = 'Cancelled'; scheduleCursor(); return;
    }
    if (!edit.on || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    // A text box that holds text keeps its own Ctrl+Z; everywhere else it undoes the map.
    const t = e.target;
    if (t && /^(textarea)$/i.test(t.tagName) && t.value) return;
    if (t && /^input$/i.test(t.tagName) && /^(text|search|number|)$/i.test(t.type || '') && t.value) return;
    const k = String(e.key || '').toLowerCase(), c = e.code;
    if ((k === 'z' || c === 'KeyZ') && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      if (edit.undo.length) { undoEdit(); status.textContent = `Undone · ${edit.undo.length} step${edit.undo.length === 1 ? '' : 's'} left`; }
      else status.textContent = 'Nothing to undo';
    } else if (k === 'y' || c === 'KeyY' || ((k === 'z' || c === 'KeyZ') && e.shiftKey)) {
      e.preventDefault(); e.stopPropagation();
      if (edit.redo.length) { redoEdit(); status.textContent = 'Redone'; } else status.textContent = 'Nothing to redo';
    }
  };
  document.addEventListener('keydown', onEditKey, true);   // capture: runs before any focused control sees the key
  window.addEventListener('beforeunload', e => { if (article.isConnected && edit.unsaved) { e.preventDefault(); e.returnValue = ''; } });
  const setBrushSize = n => {
    edit.size = Math.max(1, Math.min(64, Math.round(Number(n)) || 1));
    for (const r of ui.sizeRanges) r.value = String(edit.size);
    for (const x of ui.sizeNums) x.value = String(edit.size);
    scheduleCursor();
  };
  ui.sizeRanges.forEach(r => r.addEventListener('input', () => setBrushSize(r.value)));
  ui.sizeNums.forEach(x => { x.addEventListener('input', () => { if (x.value !== '') setBrushSize(x.value); }); x.addEventListener('change', () => setBrushSize(x.value)); });
  const setPanMode = on => {
    edit.pan = !!on;
    ui.panBtn.setAttribute('aria-pressed', String(edit.pan));
    canvas.style.cursor = editCursor();
    cancelWallDrag(); edit.hover = null; scheduleCursor();
  };
  ui.panBtn.addEventListener('click', () => { if (edit.on) setPanMode(!edit.pan); });
  ui.variation.addEventListener('change', () => { edit.variation = ui.variation.value; });

  const cursorCv = document.createElement('canvas');
  cursorCv.className = 'sec-edit-cursor';
  stage.appendChild(cursorCv);
  const tileCentre = (wx, wy) => {
    if (mode === 'art') { const p = secIsoProject(wx, wy, iso); return { x: p.x * view.zoom + view.offsetX, y: p.y * view.zoom + view.offsetY }; }
    return { x: (mapW - 1 - wx + 0.5) * view.zoom + view.offsetX, y: (wy + 0.5) * view.zoom + view.offsetY };
  };
  const tilePath = (c, wx, wy) => {
    const p = tileCentre(wx, wy), z = view.zoom;
    if (mode === 'art') { const hw = SEC_ISO_HALF_W * z, hh = SEC_ISO_HALF_H * z; c.moveTo(p.x, p.y - hh); c.lineTo(p.x + hw, p.y); c.lineTo(p.x, p.y + hh); c.lineTo(p.x - hw, p.y); c.closePath(); }
    else c.rect(p.x - z / 2, p.y - z / 2, z, z);
  };
  const edgePath = (c, wx, wy, dir) => {
    const p = tileCentre(wx, wy), z = view.zoom;
    if (mode === 'art') {
      const hw = SEC_ISO_HALF_W * z, hh = SEC_ISO_HALF_H * z;
      const T = [p.x, p.y - hh], R = [p.x + hw, p.y], B = [p.x, p.y + hh], L = [p.x - hw, p.y];
      const seg = [[T, R], [R, B], [B, L], [L, T]][dir];
      c.moveTo(seg[0][0], seg[0][1]); c.lineTo(seg[1][0], seg[1][1]);
    } else {
      const x0 = p.x - z / 2, y0 = p.y - z / 2, x1 = x0 + z, y1 = y0 + z;
      const seg = [[[x1, y0], [x1, y1]], [[x0, y1], [x1, y1]], [[x0, y0], [x0, y1]], [[x0, y0], [x1, y0]]][dir];
      c.moveTo(seg[0][0], seg[0][1]); c.lineTo(seg[1][0], seg[1][1]);
    }
  };
  const PREVIEW_ALPHA = 0.62;
  const previewCache = new Map();
  // Objects are previewed with the very same art/anchor code as placed ones: build the object once,
  // let loadSecStaticObjectPoints() resolve its art, then redraw that point at the hovered tile.
  const previewTemplate = (objType, item, aid) => {
    const key = `${objType}|${item.num}|${aid}`;
    let e = previewCache.get(key);
    if (!e) {
      e = { pt: null };
      previewCache.set(key, e);
      (async () => {
        try {
          const obj = secBuildStaticObject(objType, item.num, aid, 0n);
          const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
          const [pt] = await loadSecStaticObjectPoints([{ filename: 'preview', position: { x: 0, y: 0 }, decoded: { staticObjects: [obj] } }], diag);
          e.pt = pt && pt.artCanvas ? pt : false;
        } catch (_) { e.pt = false; }
        scheduleCursor();
      })();
    }
    return e.pt || null;
  };
  // The preview of a ground item, NPC or container: built the way the object would be, art resolved from its prototype.
  const mobPreviewTemplate = item => {
    const aid = npcOutfitAid(item), key = `mob|${item.num}|${aid ?? ''}`;
    let e = previewCache.get(key);
    if (!e) {
      e = { pt: null };
      previewCache.set(key, e);
      (async () => {
        try {
          const obj = secBuildMobObject(item.objType, item.num, 0n, { npcFlags: item.npcFlags, currentAid: aid });
          const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
          const [pt] = await loadSecStaticObjectPoints([{ filename: 'preview', position: { x: 0, y: 0 }, decoded: { staticObjects: [obj] } }], diag);
          e.pt = pt && pt.artCanvas ? pt : false;
        } catch (_) { e.pt = false; }
        scheduleCursor();
      })();
    }
    return e.pt || null;
  };
  // `offset` ([x, y] pixels, optional): where inside the tile it would lie
  const drawObjectPreview = (c, tpl, wx, wy, offset = null) => {
    if (!tpl) return;
    const pt = Object.assign({}, tpl, {
      sectorX: minX + (wx >> 6), sectorY: minY + (wy >> 6), tileX: wx & 63, tileY: wy & 63,
      worldX: (minX + (wx >> 6)) * 64 + (wx & 63), worldY: (minY + (wy >> 6)) * 64 + (wy & 63)
    }, offset ? { offsetX: offset[0], offsetY: offset[1] } : null);
    c.save(); c.globalAlpha = PREVIEW_ALPHA; c.imageSmoothingEnabled = false;
    if (pt.type === 0 || pt.type === 1) drawSecWallOverlay(c, [pt], bounds, mode, view.zoom, view.offsetX, view.offsetY, iso, null);
    else drawSecMobOverlay(c, [pt], bounds, mode, view.zoom, view.offsetX, view.offsetY, iso, false, null);
    c.restore();
  };
  const drawTilePreview = (c, raw, wx, wy) => {
    if (wx < 0 || wy < 0 || wx >= mapW || wy >= mapH) return;
    c.save(); c.globalAlpha = PREVIEW_ALPHA; c.imageSmoothingEnabled = false;
    if (mode === 'art') {
      const art = artTiles.get(raw);
      if (art?.canvas) {
        const p = tileCentre(wx, wy), w = art.canvas.width * view.zoom, h = art.canvas.height * view.zoom;
        c.drawImage(art.canvas, p.x - w / 2, p.y - h / 2, w, h);
      }
    } else {
      const p = tileCentre(wx, wy), z = view.zoom;
      c.fillStyle = secTileColor(secTileInfo(raw).artId);
      c.fillRect(p.x - z / 2, p.y - z / 2, z, z);
    }
    c.restore();
  };
  const drawCursor = () => {
    const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
    if (cursorCv.width !== Math.round(w * dpr) || cursorCv.height !== Math.round(h * dpr)) { cursorCv.width = Math.round(w * dpr); cursorCv.height = Math.round(h * dpr); }
    const c = cursorCv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const f = edit.hover, t = edit.tool;
    const picking = edit.on && t === 'paths';   // the doors are shown and picked, nothing is painted
    if (picking) drawDoorMarks(c);
    if (edit.on && extra.owns(t)) extra.markers(c, t);
    if (!edit.on || !f || edit.pan || edit.panning) return;
    const lw = Math.max(1.5, Math.min(3, view.zoom * 0.1));
    // outline of the footprint; `fill` (optional) tints it lightly, the preview shows through
    const footprint = (cells, fill, stroke) => {
      c.beginPath(); for (const k of cells) tilePath(c, k[0], k[1]);
      if (fill) { c.fillStyle = fill; c.fill(); }
      c.strokeStyle = stroke; c.lineWidth = lw; c.stroke();
    };
    const edgeLine = (wx, wy, dir, colour) => {
      c.save(); c.beginPath(); edgePath(c, wx, wy, dir);
      c.strokeStyle = colour; c.lineWidth = Math.max(2, Math.min(5, view.zoom * 0.12)); c.lineCap = 'round'; c.stroke(); c.restore();
    };
    if (t === 'fill') {
      if (edit.brush) drawTilePreview(c, brushRawAt(f.wx, f.wy), f.wx, f.wy);
      footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (t === 'eyedropper') {
      if (edit.eyeTile) footprint([[edit.eyeTile.wx, edit.eyeTile.wy]], 'rgba(32,178,170,.18)', '#20b2aa');
      footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (t === 'mobedit') {
      if (edit.mobSel) footprint([[wxOf(edit.mobSel), wyOf(edit.mobSel)]], 'rgba(32,178,170,.18)', '#20b2aa');
      footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (picking) {
      footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (extra.owns(t)) {
      extra.cursor(c, f, t, { footprint });
    } else if (t === 'move') {
      const d = edit.moveDrag;
      if (d) {
        // what is picked up, drawn where it would land; its old tile in red, the new one in yellow
        const dx = d.tx - d.wx, dy = d.ty - d.wy;
        for (const p of d.pts) drawObjectPreview(c, p, wxOf(p) + dx, wyOf(p) + dy);
        footprint([[d.wx, d.wy]], 'rgba(255,143,132,.18)', '#ff8f84');
        footprint([[d.tx, d.ty]], null, '#ffe066');
      } else footprint([[f.wx, f.wy]], edit.objectsReady && movableAt(f.wx, f.wy).length ? 'rgba(255,224,102,.18)' : null, '#ffe066');
    } else if (t === 'tile' || t === 'eraser') {
      const n = edit.size, o = brushOffset(), cells = [];
      for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cells.push([f.wx + dx - o, f.wy + dy - o]);
      if (t === 'tile') {
        if (edit.brush) for (const k of cells) drawTilePreview(c, brushRawAt(k[0], k[1]), k[0], k[1]);
        footprint(cells, null, '#ffe066');
      } else footprint(cells, 'rgba(255,143,132,.25)', '#ff8f84');
    } else if (t === 'facade') {
      const sel = edit.sel.facade;
      if (sel) {
        const cells = facadeCells(sel, f.wx, f.wy);
        for (const k of cells) {
          if (!k.art) continue;
          const raw = secMakeFacadeRaw(k.num, k.frame, sel.walkable, sel.keep);
          if (!artTiles.has(raw)) artTiles.set(raw, k.art);
          drawTilePreview(c, raw, k.wx, k.wy);
        }
        footprint(cells.map(k => [k.wx, k.wy]), null, '#ffe066');
      } else footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (SEC_MOB_KINDS[t]) {
      const item = edit.sel[t];
      if (item) drawObjectPreview(c, mobPreviewTemplate(item), f.wx, f.wy, mobOffsetFor(f));
      footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (t === 'scenery') {
      const item = edit.sel.scenery;
      if (item && item.num != null) {
        const rv = pk.scenery.rot.value, aid = rv === 'proto' ? item.aid : secAidWithRotation(item.aid, Number(rv));
        drawObjectPreview(c, previewTemplate(3, item, aid), f.wx, f.wy);
      }
      footprint([[f.wx, f.wy]], null, '#ffe066');
    } else if (t === 'wall' || t === 'generate') {
      // (Generate: the outline only - its walls are drawn when it is placed)
      const item = t === 'wall' && edit.sel.wall && edit.sel.wall.num != null ? edit.sel.wall : null, hasWall = e => (getEdgeIndex().get(secEdgeKey(e.wx, e.wy, e.dir)) || []).some(p => p.type === 0);
      const drawSeg = (e, withArt) => {
        if (withArt && item) drawObjectPreview(c, previewTemplate(0, item, secWallAid(item.aid, e.piece ?? wallPiece(), wallRotation(e.dir), Number(pk.wall.variation.value))), e.wx, e.wy);
        edgeLine(e.wx, e.wy, e.dir, hasWall(e) ? '#ff8f84' : '#ffe066');
      };
      if (t === 'wall' && edit.wallBrush === 'edge') drawSeg(edgeFromFloat(f), true);
      else {
        const dot = (i, j, r, col) => { const p = tileCentre(i - 0.5, j - 0.5); c.save(); c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fillStyle = col; c.fill(); c.restore(); };
        const d = edit.wallDrag;
        if (d) {
          const segs = wallSegments(d);
          segs.forEach((s, n) => drawSeg(s, n < 250));
          dot(d.i0, d.j0, 4, '#20b2aa');
          dot(d.i1, d.j1, 4, '#ffe066');
        } else { const v = vertexFromFloat(f); dot(v.i, v.j, 4, '#ffe066'); }
      }
    } else if (t === 'portal') {
      const item = edit.sel.portal && edit.sel.portal.num != null ? edit.sel.portal : null, hit = edit.objectsReady ? portalTarget(f) : null;
      if (hit) {
        if (item) {
          const rot = secEdgeRotation(hit.wall) ?? hit.wall.__rot ?? 0;
          drawObjectPreview(c, previewTemplate(1, item, secAidWithRotation(item.aid, rot)), wxOf(hit.wall), wyOf(hit.wall));
        }
        edgeLine(hit.tx, hit.ty, hit.dir, '#20b2aa');
      } else footprint([[f.wx, f.wy]], 'rgba(255,143,132,.10)', 'rgba(255,143,132,.7)');
    }
  };
  drawCursorHook = drawCursor;
  let cursorQueued = false;
  const scheduleCursor = () => { if (cursorQueued) return; cursorQueued = true; requestAnimationFrame(() => { cursorQueued = false; drawCursor(); }); };
  const updateHover = event => { edit.hover = worldFloat(event); scheduleCursor(); };
  canvas.addEventListener('mouseleave', () => { edit.hover = null; scheduleCursor(); });
  canvas.addEventListener('mousemove', event => { if (edit.on) updateHover(event); });

  // Tile palette: every tile listed in tilename.mes
  let paletteBuilt = false, usedArtIds = new Map(), thumbObserver = null;
  const applyPaletteFilter = () => {
    const qs = ui.search.value.trim().toLowerCase(), cat = ui.category.value, used = ui.usedOnly.checked;
    for (const el of ui.list.children) {
      const id = Number(el.dataset.art);
      const ok = (cat === 'all' || Math.floor(id / 100) === Number(cat))
        && (!used || usedArtIds.has(id))
        && (!qs || el.dataset.search.includes(qs));
      el.hidden = !ok;
    }
  };
  const buildPalette = () => {
    usedArtIds = new Map(secFolderLegendEntries(valid).map(e => [e.artId, e.count]));
    if (paletteBuilt) { prioritizeList(ui.list, usedArtIds, 'art'); applyPaletteFilter(); return; }
    paletteBuilt = true;
    ui.list.innerHTML = '';
    const entries = [...(secTileNameMesMap || new Map()).entries()].sort((a, b) => a[0] - b[0]);
    thumbObserver = new IntersectionObserver(items => {
      for (const it of items) {
        if (!it.isIntersecting) continue;
        const el = it.target; thumbObserver.unobserve(el);
        const cv = el.querySelector('canvas');
        firstVariant(Number(el.dataset.art)).then(v => { if (!drawThumb(cv, v?.art)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
      }
    }, { root: ui.list, rootMargin: '120px' });
    for (const [artId, entry] of entries) {
      if (artId % 100 > 63) continue; // the packed tile id only has 6 bits per tile number
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sec-edit-tile';
      btn.dataset.art = String(artId);
      btn.dataset.search = `${artId} ${entry.name} ${entry.comment || ''}`.toLowerCase();
      btn.title = `#${artId} ${entry.name}${entry.comment ? ` — ${entry.comment}` : ''}`;
      const cv = document.createElement('canvas'); cv.width = 80; cv.height = 40;
      const label = document.createElement('span'); label.textContent = `${artId} · ${entry.name || '?'}`;
      btn.append(cv, label);
      btn.addEventListener('click', () => selectPaletteTile(artId, entry.name));
      ui.list.appendChild(btn);
      thumbObserver.observe(btn);
    }
    prioritizeList(ui.list, usedArtIds, 'art');
    markActiveTile(); applyPaletteFilter();
  };
  ui.search.addEventListener('input', applyPaletteFilter);
  ui.category.addEventListener('change', applyPaletteFilter);
  ui.usedOnly.addEventListener('change', applyPaletteFilter);

  // generic helpers for the other palettes
  const makePaletteButton = (id, search, title, label) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sec-edit-tile';
    btn.dataset.id = String(id); btn.dataset.search = search.toLowerCase(); btn.title = title;
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 40;
    const span = document.createElement('span'); span.textContent = label;
    btn.append(cv, span);
    return btn;
  };
  const filterPane = P => {
    const qs = P.search.value.trim().toLowerCase();
    // facades: with "Whole structure" a group is listed once (its first part, found by the names of all its parts)
    const grouped = P === pk.facade && P.whole.checked;
    for (const el of P.list.children) {
      const hay = grouped && el.dataset.searchAll ? el.dataset.searchAll : el.dataset.search;
      el.hidden = (grouped && !!el.dataset.member) || (!!qs && !hay.includes(qs));
    }
  };
  // Whatever is already used on this map is listed first (most frequent first), then everything else in numeric order.
  const prioritizeList = (list, counts, attr) => {
    const kids = [...list.children];
    if (!kids.length) return;
    const idOf = el => Number(el.dataset[attr]), cnt = el => counts.get(idOf(el)) || 0;
    kids.sort((a, b) => (cnt(b) - cnt(a)) || (idOf(a) - idOf(b)));
    const frag = document.createDocumentFragment();
    for (const el of kids) { const n = cnt(el); el.classList.toggle('on-map', n > 0); frag.appendChild(el); }
    list.appendChild(frag);
    const act = list.querySelector('.sec-edit-tile.active');
    if (act) act.scrollIntoView({ block: 'nearest' }); else list.scrollTop = 0;
  };
  const countBy = (arr, keyFn) => { const m = new Map(); for (const p of arr) { const k = keyFn(p); if (k != null) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const usageFor = kind => {
    if (kind === 'facade') {
      const m = new Map();
      for (const s of valid) {
        const t = s.decoded.tiles;
        for (let i = 0; i < t.length; i++) {
          const raw = t[i] >>> 0; if (!artType(raw)) continue;
          const info = secTileInfo(raw);
          if (info.isFacade) m.set(info.facadeNum, (m.get(info.facadeNum) || 0) + 1);
        }
      }
      return m;
    }
    if (kind === 'scenery') return countBy(mobPoints.filter(p => p.type === 3), p => p.currentAidRaw != null ? protoCurrentAidArtId(Number(p.currentAidRaw) >>> 0, 3) : null);
    const type = PROTO_TYPE[kind];
    return countBy(mobPoints.filter(p => p.type === type), p => { const aid = p.currentAidRaw != null ? Number(p.currentAidRaw) >>> 0 : (protoItemFor(p)?.aid ?? null); return aid == null ? null : TEX[kind].keyOfAid(aid); });
  };
  const prioritizeKind = kind => {
    if (kind === 'tile') prioritizeList(ui.list, usedArtIds, 'art');
    else if (pk[kind]) prioritizeList(pk[kind].list, usageFor(kind), 'id');
  };
  const markActivePane = (kind, id) => {
    const P = pk[kind];
    P.list.querySelectorAll('.sec-edit-tile.active').forEach(el => el.classList.remove('active'));
    if (id != null) P.list.querySelector(`.sec-edit-tile[data-id="${id}"]`)?.classList.add('active');
  };
  const makeThumbObserver = (P, draw) => new IntersectionObserver(items => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      const el = it.target; P.obs.unobserve(el);
      draw(el, el.querySelector('canvas'));
    }
  }, { root: P.list, rootMargin: '120px' });

  // Facade palette (facadename.mes)
  // facade number -> its group (sec-facade-groups.js): { nums: every part, rep: the one listed for it }
  const facadeGroupOf = new Map();
  for (const g of SEC_FACADE_GROUPS) {
    const nums = []; for (let i = 0; i < g.length; i += 3) nums.push(g[i]);
    const grp = { nums, rep: Math.min(...nums) };
    for (const n of nums) facadeGroupOf.set(n, grp);
  }
  // the list entry to highlight: a part of a group that is listed once is shown by its first part
  const markActiveFacade = num => markActivePane('facade', num != null && pk.facade.whole.checked ? (facadeGroupOf.get(num)?.rep ?? num) : num);
  const facadeThumbCache = new Map();
  const facadeThumbArt = async num => {
    if (facadeThumbCache.has(num)) return facadeThumbCache.get(num);
    const file = await secFacadeFile(num);
    let art = null;
    if (file) {
      const f0 = file.frames.filter(f => f.direction === 0).sort((a, b) => a.index - b.index)[0];
      if (f0) art = await loadSecFacadeArt(secMakeFacadeRaw(num, f0.index, 1, 0));
    }
    facadeThumbCache.set(num, art);
    return art;
  };
  const selectFacade = async (num, name) => {
    const P = pk.facade;
    P.meta.textContent = 'loading cells…';
    const file = await secFacadeFile(num);
    if (!file) { P.meta.textContent = 'ART file not found'; edit.sel.facade = null; return; }
    const idxs = file.frames.filter(f => f.direction === 0).map(f => f.index).sort((a, b) => a - b);
    if (!idxs.length) { P.meta.textContent = 'no cells'; edit.sel.facade = null; return; }
    const lay = inferFacadeLayout(num, idxs);
    const table = SEC_FACADE_LAYOUTS[num];
    let offsets = null;
    if (table) {
      offsets = new Map();
      for (let i = 0; i < table.cells.length; i += 3) offsets.set(table.cells[i], [table.cells[i + 1], table.cells[i + 2]]);
      if (!idxs.every(fr => offsets.has(fr))) offsets = null;
    }
    const artByFrame = new Map();
    await Promise.all(idxs.map(async fr => { const a = await loadSecFacadeArt(secMakeFacadeRaw(num, fr, lay.walkable, lay.keep)); if (a) artByFrame.set(fr, a); }));
    // the other parts of the thing this facade belongs to (sec-facade-groups.js), where the game puts them
    const group = SEC_FACADE_GROUPS.find(g => { for (let i = 0; i < g.length; i += 3) if (g[i] === num) return true; return false; });
    const parts = [];
    if (group) {
      let at = [0, 0];
      for (let i = 0; i < group.length; i += 3) if (group[i] === num) at = [group[i + 1], group[i + 2]];
      for (let i = 0; i < group.length; i += 3) {
        const pn = group[i], pt = SEC_FACADE_LAYOUTS[pn];
        if (pn === num || !pt) continue;
        const partOffsets = new Map();
        for (let k = 0; k < pt.cells.length; k += 3) partOffsets.set(pt.cells[k], [pt.cells[k + 1], pt.cells[k + 2]]);
        const partArt = new Map();
        await Promise.all([...partOffsets.keys()].map(async fr => { const a = await loadSecFacadeArt(secMakeFacadeRaw(pn, fr, lay.walkable, lay.keep)); if (a) partArt.set(fr, a); }));
        parts.push({ num: pn, dx: group[i + 1] - at[0], dy: group[i + 2] - at[1], offsets: partOffsets, artByFrame: partArt });
      }
    }
    edit.sel.facade = { num, name, idxs, artByFrame, offsets, parts, whole: parts.length > 0 && P.whole.checked, cols: lay.cols, colVec: lay.colVec, rowVec: lay.rowVec, keep: lay.keep, walkable: lay.walkable };
    P.cols.value = String(lay.cols); P.walk.checked = !!lay.walkable; P.swap.checked = false;
    for (const el of [P.cols, P.swap]) { const lab = el.closest('label'); if (lab) lab.hidden = !!offsets; }
    const how = !offsets ? (lay.known ? 'taken from this map' : 'guessed: adjust Columns / Swap axes')
      : table.src === 's' ? 'guessed from the pictures\' borders' : 'from the game\'s maps';
    P.meta.textContent = `${idxs.length} cell${idxs.length === 1 ? '' : 's'} · layout ${how}${parts.length ? ` · part of a ${parts.length + 1}-part structure${P.whole.checked ? ' (all stamped)' : ''}` : ''}`;
    markActiveFacade(num);
    status.textContent = `Facade #${num} ${name} · click to stamp it`;
    scheduleCursor();
  };
  pk.facade.cols.addEventListener('change', () => { const s = edit.sel.facade; if (s) { s.cols = Math.max(1, Number(pk.facade.cols.value) || 1); scheduleCursor(); } });
  pk.facade.walk.addEventListener('change', () => { const s = edit.sel.facade; if (s) s.walkable = pk.facade.walk.checked ? 1 : 0; });
  pk.facade.swap.addEventListener('change', () => { const s = edit.sel.facade; if (s) { [s.colVec, s.rowVec] = [s.rowVec, s.colVec]; scheduleCursor(); } });
  pk.facade.whole.addEventListener('change', () => {
    const s = edit.sel.facade;
    if (s) { s.whole = s.parts.length > 0 && pk.facade.whole.checked; scheduleCursor(); }
    filterPane(pk.facade); markActiveFacade(s?.num);
    pk.facade.list.querySelector('.sec-edit-tile.active')?.scrollIntoView({ block: 'nearest' });
  });
  pk.facade.search.addEventListener('input', () => filterPane(pk.facade));
  const buildFacadePalette = async () => {
    const P = pk.facade;
    if (P.built) return;
    P.built = true;
    P.status.textContent = 'Loading facade list…';
    let names;
    try { names = await loadSecFacadeNames(); }
    catch (err) { P.built = false; P.status.textContent = `Could not load facadename.mes: ${errText(err)}`; return; }
    P.obs = makeThumbObserver(P, (el, cv) => {
      facadeThumbArt(Number(el.dataset.id)).then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    let count = 0;
    names.forEach((name, num) => {
      if (!name) return;
      count++;
      const grp = facadeGroupOf.get(num), first = grp && grp.rep === num;
      const label = first ? `${num} · ${name} (+${grp.nums.length - 1})` : `${num} · ${name}`;
      const btn = makePaletteButton(num, `${num} ${name}`, first ? `#${num} ${name}\nWhole structure: ${grp.nums.map(n => names[n]).join(', ')}` : `#${num} ${name}`, label);
      if (first) btn.dataset.searchAll = grp.nums.map(n => `${n} ${names[n]}`).join(' ').toLowerCase();
      else if (grp) btn.dataset.member = '1';
      btn.addEventListener('click', () => selectFacade(num, name));
      P.list.appendChild(btn); P.obs.observe(btn);
    });
    P.status.textContent = '';
    filterPane(P);
    markActiveFacade(edit.sel.facade?.num);
    prioritizeKind('facade');
  };

  // Scenery / wall / portal palettes (prototypes, found by scanning /proto/ once)
  const protoThumbArt = async item => {
    if (item.objType === 0) return loadWallArtFromRaw(secWallAid(item.aid, edit.commonPiece ?? 0, 0, 0));
    const artId = protoCurrentAidArtId(item.aid, item.objType);
    if (artId == null) return null;
    const artObjType = protoArtObjectType(item.aid, item.objType);
    const pal = artObjType === 3 ? (item.aid >>> 4) & 3 : null;
    return loadMobMapArtShared(artId, artObjType, pal, aidRotation(item.aid), item.aid);
  };
  // Wall and portal palettes list the TEXTURES that go onto the prototypes, like the scenery palette does:
  //   wall   : one entry per wall structure (structure.mes; its interior / exterior wallname stems)
  //   portal : one entry per portal.mes key (doors at n, windows at n + 1001)
  // A texture that already has a prototype is placed with it; any other one is placed as an instance of the
  // "base prototype" with the art id overridden (an object's F_CURRENT_AID wins over its prototype's).
  const TEX = {
    wall: {
      keyOfAid: aid => decodeWallArtId(aid)?.num ?? null,
      aidOf: (key, base) => (((((base ?? (1 << 28)) >>> 0) & ~(0xFF << 20)) | (key << 20)) >>> 0),
      entries: async () => {
        const [structs, names] = await Promise.all([loadWallStructureTable(), loadWallNameTable()]);
        const out = [];
        structs.forEach((st, num) => {
          if (num > 255) return;
          const a = names[st.interior]?.name || '', b = names[st.exterior]?.name || '';
          if (!a && !b) return;
          out.push({ key: num, label: a && b && a.toLowerCase() !== b.toLowerCase() ? `${a} / ${b}` : (a || b), search: `${a} ${b}` });
        });
        return out;
      }
    },
    portal: {
      keyOfAid: aid => (artType(aid) === ART_TYPE.PORTAL ? protoCurrentAidArtId(aid, 1) : null),
      aidOf: (key, base) => {
        const win = key >= 1001, num = win ? key - 1001 : key;
        return ((((base ?? 0) >>> 0) & ~((0x1FF << 19) | (1 << 10)) & 0x0FFFFFFF) | (3 << 28) | (num << 19) | (win ? 0 : (1 << 10))) >>> 0;
      },
      entries: async () => {
        const mes = await loadPortalMes(), out = [];
        for (const [k, text] of [...mes.entries()].sort((a, b) => a[0] - b[0])) {
          const m = String(text).trim().match(/^(.*?)\.art\b/i); if (!m) continue;
          const win = k >= 1001, num = win ? k - 1001 : k;
          if (k < 0 || num > 0x1FF) continue;
          out.push({ key: k, label: `${m[1].replace(/^.*[\\/]/, '')}${win ? ' (window)' : ''}`, search: win ? 'window' : 'door' });
        }
        return out;
      }
    }
  };
  const texExact = { wall: new Map(), portal: new Map() };   // texture key -> prototype that already uses it
  const texLabelMap = {};
  const textureLabel = async (kind, key) => {
    if (kind === 'scenery') {
      try { const t = (await loadSceneryMes()).get(key); if (t != null) return String(t).trim().replace(/\.art\b.*$/i, ''); } catch (_) {}
      return String(key);
    }
    if (!texLabelMap[kind]) { try { texLabelMap[kind] = new Map((await TEX[kind].entries()).map(e => [e.key, e.label])); } catch (_) { return String(key); } }
    return texLabelMap[kind].get(key) ?? String(key);
  };
  const syncSelectedTexture = kind => {
    const P = pk[kind], sel = edit.sel[kind]; if (!sel) return;
    const items = secProtoCatalog.byType[PROTO_TYPE[kind]], exact = texExact[kind].get(sel.artKey);
    // the one picked off the map, else the one the game places this art with, else its own, else the base prototype
    const gameNum = secGameProtoForKey(PROTO_TYPE[kind], sel.artKey)?.num;
    let proto = sel.prefer != null ? items.find(i => i.num === sel.prefer) : null;
    const game = !proto && gameNum != null ? items.find(i => i.num === gameNum) || null : null;
    if (!proto) proto = game || exact || items.find(i => String(i.num) === P.base.value) || null;
    sel.num = proto ? proto.num : null;
    sel.exact = !!proto && TEX[kind].keyOfAid(proto.aid) === sel.artKey;
    sel.aid = TEX[kind].aidOf(sel.artKey, proto ? proto.aid : null);
    P.meta.textContent = !proto ? 'waiting for the prototype scan…'
      : proto === game ? `prototype #${proto.num}, as the game places this ${kind}`
      : sel.exact ? `own prototype #${proto.num}` : `no prototype of its own · uses base prototype #${proto.num}`;
  };
  const refreshTextureBase = kind => {
    const P = pk[kind], T = TEX[kind], items = secProtoCatalog.byType[PROTO_TYPE[kind]], exact = texExact[kind];
    exact.clear();
    for (const it of items) { const k = T.keyOfAid(it.aid); if (k != null && !exact.has(k)) exact.set(k, it); }
    if (P.base.options.length !== items.length || !P.base.value) {
      const cur = P.base.value;
      P.base.innerHTML = items.length ? items.map(i => `<option value="${i.num}">#${i.num} · ${i.label}</option>`).join('') : '<option value="">(scanning prototypes…)</option>';
      if (cur && items.some(i => String(i.num) === cur)) P.base.value = cur;
      else if (items.length) {
        const use = new Map();    // prefer the prototype this map already uses most
        for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === PROTO_TYPE[kind]) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) use.set(n, (use.get(n) || 0) + 1); }
        let best = items[0].num, bn = -1;
        for (const it of items) { const n = use.get(it.num) || 0; if (n > bn) { bn = n; best = it.num; } }
        P.base.value = String(best);
      }
    }
    for (const el of P.list.children) {          // the search also finds a texture by the name of its prototype
      const it = exact.get(Number(el.dataset.id));
      el.dataset.search = `${el.dataset.baseSearch || ''}${it ? ` ${it.num} ${it.label}` : ''}`.toLowerCase();
    }
    syncSelectedTexture(kind);
  };
  const selectTexture = (kind, key, label, prefer = null) => {
    edit.sel[kind] = { num: null, label, aid: TEX[kind].aidOf(key, null), objType: PROTO_TYPE[kind], artKey: key, prefer };
    syncSelectedTexture(kind);
    markActivePane(kind, key);
    scheduleCursor();
  };
  for (const kind of ['wall', 'portal']) {
    // (a base prototype picked by hand is used even where the game has its own for that art)
    pk[kind].base.addEventListener('change', () => { const s = edit.sel[kind]; if (s) s.prefer = Number(pk[kind].base.value) || null; syncSelectedTexture(kind); });
    secProtoCatalog.listeners.push(() => { if (pk[kind].built) refreshTextureBase(kind); });
  }
  const buildTexturePalette = async kind => {
    const P = pk[kind], T = TEX[kind];
    refreshTextureBase(kind);
    if (P.built) return;
    P.built = true;
    P.status.textContent = `Loading ${kind} textures…`;
    let entries;
    try { entries = await T.entries(); }
    catch (err) { P.built = false; P.status.textContent = `Could not load the ${kind} texture list: ${errText(err)}`; return; }
    texLabelMap[kind] = new Map(entries.map(e => [e.key, e.label]));
    P.obs = makeThumbObserver(P, (el, cv) => {
      protoThumbArt({ objType: PROTO_TYPE[kind], aid: T.aidOf(Number(el.dataset.id), null) })
        .then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    for (const e of entries) {
      const btn = makePaletteButton(e.key, `${e.key} ${e.label} ${e.search || ''}`, `#${e.key} ${e.label}`, `${e.key} · ${e.label}`);
      btn.dataset.baseSearch = btn.dataset.search;
      btn.addEventListener('click', () => selectTexture(kind, e.key, e.label));
      P.list.appendChild(btn); P.obs.observe(btn);
    }
    P.status.textContent = '';
    refreshTextureBase(kind);
    filterPane(P); markActivePane(kind, edit.sel[kind]?.artKey);
    prioritizeKind(kind);
  };
  const buildProtoPalette = kind => {
    const P = pk[kind];
    secStartProtoScan();
    if (kind === 'scenery') { buildSceneryPalette().then(() => prioritizeKind('scenery')); return; }
    buildTexturePalette(kind);
  };

  // Palettes of the .mob tools (ground items, NPCs, containers): every prototype of the kind, named as the game names
  // it (description.mes), the ones this map already uses first. A prototype is what the new object is an instance of.
  const mobCatalog = kind => SEC_MOB_KINDS[kind].types.flatMap(t => secProtoCatalog.byType[t] || []).sort((a, b) => a.num - b.num);
  const mobThumbArt = async item => {
    if (item.aid == null) return null;
    if (item.objType === 16) return loadCritterMapArt(protoCritterAidInfo(item.aid, 16));
    return protoThumbArt(item);
  };
  const filterMob = kind => {
    const P = mk[kind], qs = P.search.value.trim().toLowerCase(), cat = P.category ? P.category.value : 'all';
    for (const el of P.list.children) el.hidden = (cat !== 'all' && el.dataset.type !== cat) || (!!qs && !el.dataset.search.includes(qs));
  };
  const prioritizeMob = kind => {
    const types = SEC_MOB_KINDS[kind].types;
    prioritizeList(mk[kind].list, countBy(mobPoints.filter(p => types.includes(p.type)), p => p.protoNum), 'id');
  };
  // The outfit list for the NPC picked: only the outfits that have art for its body are open to choose (a monster or a
  // unique NPC has none to change, so the whole list is shut), and the choice goes back to the prototype's when its
  // outfit has no art here.
  const syncOutfits = it => {
    const sel = mk.npcs.outfit, critter = it.aid != null && (it.aid >>> 28) === 2;
    sel.disabled = !critter;
    if (!critter) { sel.value = 'proto'; return; }
    for (const o of sel.options) {
      if (o.value === 'proto') continue;
      const aid = (((it.aid & ~((0xF << 20) | (1 << 19))) | (Number(o.value) << 20)) >>> 0);
      o.disabled = true;
      resolveCritterArt(protoCritterAidInfo(aid, 16)).then(res => {
        if (edit.sel.npcs?.num !== it.num) return;           // another NPC was picked since
        o.disabled = !res;
        if (!res && sel.value === o.value) { sel.value = 'proto'; scheduleCursor(); }
      }, () => {});
    }
  };
  const selectMob = (kind, it) => {
    const P = mk[kind];
    edit.sel[kind] = { num: it.num, label: it.label, objType: it.objType, aid: it.aid, npcFlags: it.npcFlags || 0, qty: it.qty ?? null };
    if (P.qtyRow) {           // gold and ammo come in piles: the quantity box starts at the prototype's (gold: 100, one coin is no pile)
      P.qtyRow.hidden = it.qty == null;
      if (it.qty != null) P.qty.value = String(it.objType === 8 ? Math.max(it.qty, 100) : it.qty);
    }
    if (P.outfit) syncOutfits(it);
    P.list.querySelectorAll('.sec-edit-tile.active').forEach(el => el.classList.remove('active'));
    P.list.querySelector(`.sec-edit-tile[data-id="${it.num}"]`)?.classList.add('active');
    P.meta.textContent = `Prototype #${it.num} · ${it.label}${it.fileLabel && it.fileLabel !== it.label ? ` (${it.fileLabel})` : ''} · click a tile to place it`;
    scheduleCursor();
  };
  const buildMobPalette = kind => {
    const P = mk[kind];
    secStartProtoScan();
    if (!secProtoCatalog.done) {         // the catalog listener calls this again as the scan goes on
      P.status.textContent = secProtoCatalog.error ? `Could not scan the prototypes: ${secProtoCatalog.error}` : `Scanning prototypes… ${secProtoCatalog.scanned} / ${secProtoCatalog.total || '?'}`;
      return;
    }
    P.status.textContent = '';
    if (P.built) { prioritizeMob(kind); return; }
    P.built = true;
    const items = mobCatalog(kind), byNum = new Map(items.map(it => [it.num, it]));
    P.obs = makeThumbObserver(P, (el, cv) => {
      mobThumbArt(byNum.get(Number(el.dataset.id))).then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    for (const it of items) {
      const btn = makePaletteButton(it.num, `${it.num} ${it.label} ${it.fileLabel} ${mobObjectTypeName(it.objType)}`, `#${it.num} ${it.label} (${it.fileLabel})`, `${it.num} · ${it.label}`);
      btn.dataset.type = String(it.objType);
      btn.addEventListener('click', () => selectMob(kind, it));
      P.list.appendChild(btn); P.obs.observe(btn);
    }
    if (!items.length) P.status.textContent = 'No prototype of this kind was found.';
    filterMob(kind); prioritizeMob(kind);
    if (edit.sel[kind]) P.list.querySelector(`.sec-edit-tile[data-id="${edit.sel[kind].num}"]`)?.classList.add('active');
  };
  for (const kind of Object.keys(SEC_MOB_KINDS)) {
    mk[kind].search.addEventListener('input', () => filterMob(kind));
    mk[kind].category?.addEventListener('change', () => filterMob(kind));
    mk[kind].drop?.addEventListener('change', scheduleCursor);
    mk[kind].outfit?.addEventListener('change', scheduleCursor);
    secProtoCatalog.listeners.push(() => { if (edit.on && edit.tool === kind) buildMobPalette(kind); });
  }

  // Scenery palette: every entry of scenery.mes (key = 1000 * type + num). Only a few dozen scenery
  // prototypes exist, so an entry without its own prototype is placed as an instance of the chosen
  // "base prototype" with the art id overridden (an object's F_CURRENT_AID wins over its prototype's).
  const sceneryAidOf = key => ((4 << 28) | ((key % 1000) << 19) | (Math.floor(key / 1000) << 6)) >>> 0;
  const exactSceneryProto = new Map();       // art key -> prototype that already uses that art
  const syncSelectedScenery = () => {
    const P = pk.scenery, sel = edit.sel.scenery;
    if (!sel) return;
    // the prototype the game places this art with (or uses for its type of scenery), else its own, else the base one
    // (a base prototype picked by hand wins)
    const gameNum = sel.byHand ? null : secGameProtoForKey(3, sel.artKey)?.num;
    const game = gameNum != null ? secProtoCatalog.byType[3].find(i => i.num === gameNum) || null : null;
    const exact = sel.byHand ? null : exactSceneryProto.get(sel.artKey);
    sel.num = game ? game.num : exact ? exact.num : (Number(P.base.value) || null);
    sel.exact = !!exact && sel.num === exact.num;
    P.meta.textContent = sel.num == null ? 'waiting for the prototype scan…'
      : game ? `prototype #${game.num} (${game.label}), as the game places this art`
      : exact ? `own prototype #${exact.num}` : `no prototype of its own · uses base prototype #${sel.num}`;
  };
  const refreshSceneryBase = () => {
    const P = pk.scenery, items = secProtoCatalog.byType[3];
    exactSceneryProto.clear();
    for (const it of items) { const k = protoCurrentAidArtId(it.aid, 3); if (k != null && !exactSceneryProto.has(k)) exactSceneryProto.set(k, it); }
    if (P.base.options.length !== items.length || !P.base.value) {
      const cur = P.base.value;
      P.base.innerHTML = items.length ? items.map(i => `<option value="${i.num}">#${i.num} · ${i.label}</option>`).join('') : '<option value="">(scanning prototypes…)</option>';
      if (cur && items.some(i => String(i.num) === cur)) P.base.value = cur;
      else if (items.length) {
        const use = new Map();    // prefer the scenery prototype this map already uses most
        for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === 3) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) use.set(n, (use.get(n) || 0) + 1); }
        let best = items[0].num, bn = -1;
        for (const it of items) { const n = use.get(it.num) || 0; if (n > bn) { bn = n; best = it.num; } }
        P.base.value = String(best);
      }
    }
    syncSelectedScenery();
  };
  pk.scenery.base.addEventListener('change', () => { if (edit.sel.scenery) edit.sel.scenery.byHand = true; syncSelectedScenery(); });
  secProtoCatalog.listeners.push(() => { if (pk.scenery.built) refreshSceneryBase(); });
  const selectScenery = (key, label) => {
    const P = pk.scenery;
    edit.sel.scenery = { num: null, label, aid: sceneryAidOf(key), objType: 3, artKey: key };
    syncSelectedScenery();
    markActivePane('scenery', key);
    status.textContent = `Scenery: #${key} ${label}`;
    scheduleCursor();
  };
  const buildSceneryPalette = async () => {
    const P = pk.scenery;
    refreshSceneryBase();
    if (P.built) return;
    P.built = true;
    P.status.textContent = 'Loading scenery.mes…';
    let mes;
    try { mes = await loadSceneryMes(); }
    catch (err) { P.built = false; P.status.textContent = `Could not load scenery.mes: ${errText(err)}`; return; }
    const entries = [...mes.entries()].filter(([k]) => k >= 0 && k % 1000 <= 255 && Math.floor(k / 1000) <= 31).sort((a, b) => a[0] - b[0]);
    P.obs = makeThumbObserver(P, (el, cv) => {
      const key = Number(el.dataset.id);
      protoThumbArt({ objType: 3, aid: sceneryAidOf(key) }).then(a => { if (!drawThumb(cv, a)) el.classList.add('no-art'); }).catch(() => el.classList.add('no-art'));
    });
    P.list.innerHTML = '';
    for (const [key, text] of entries) {
      const label = String(text).trim().replace(/\.art\b.*$/i, '');
      const btn = makePaletteButton(key, `${key} ${label}`, `#${key} ${label}`, `${key} · ${label}`);
      btn.addEventListener('click', () => selectScenery(key, label));
      P.list.appendChild(btn); P.obs.observe(btn);
    }
    P.status.textContent = '';
    filterPane(P); markActivePane('scenery', edit.sel.scenery?.artKey);
    prioritizeKind('scenery');
  };

  const eye = { head: q1(panes.eyedropper, '.sec-eye-head'), list: q1(panes.eyedropper, '.sec-eye-list') };
  const EDGE_NAMES = ['NE', 'SE', 'SW', 'NW'];
  let eyeSeq = 0;
  const protoCatalogReady = () => new Promise(resolve => {
    secStartProtoScan();
    if (secProtoCatalog.done) { resolve(); return; }
    const fn = () => {
      if (!secProtoCatalog.done) return;
      const i = secProtoCatalog.listeners.indexOf(fn); if (i >= 0) secProtoCatalog.listeners.splice(i, 1);
      resolve();
    };
    secProtoCatalog.listeners.push(fn);
  });
  // Rotation and palette bits differ between instances of one prototype, so they are ignored when matching.
  const stripAidVariant = v => ((v >>> 0) & ~((7 << 11) | (3 << 4))) >>> 0;
  const protoItemFor = p => {
    const list = secProtoCatalog.byType[p.type] || [];
    const n = p.__obj ? mobOidTypeAndNumber(p.__obj.protoOid)?.number : null;
    if (n != null) { const it = list.find(i => i.num === n); if (it) return it; }
    if (p.currentAidRaw == null) return null;
    const aid = Number(p.currentAidRaw) >>> 0;
    if (p.type === 0) { const d = decodeWallArtId(aid); return d ? (list.find(i => decodeWallArtId(i.aid)?.num === d.num) || null) : null; }
    return list.find(i => stripAidVariant(i.aid) === stripAidVariant(aid)) || null;
  };
  const eyeRow = (kind, title, sub, art, onClick) => {
    const el = document.createElement(onClick ? 'button' : 'div');
    el.className = onClick ? 'sec-eye-item' : 'sec-eye-item static';
    if (onClick) { el.type = 'button'; el.addEventListener('click', onClick); }
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 40;
    const text = document.createElement('span'); text.className = 'sec-eye-text';
    const k = document.createElement('strong'); k.textContent = kind;
    const t = document.createElement('span'); t.textContent = title;
    text.append(k, t);
    if (sub) { const s = document.createElement('em'); s.textContent = sub; text.appendChild(s); }
    el.append(cv, text);
    if (art) Promise.resolve(art).then(a => drawThumb(cv, a)).catch(() => {});
    eye.list.appendChild(el);
  };
  const openTileTool = async (raw, info) => {
    await setTool('tile');
    ui.search.value = ''; ui.category.value = 'all'; ui.usedOnly.checked = false; applyPaletteFilter();
    const plain = !artType(raw) && info.num1 === info.num2 && info.flippable1 === info.flippable2;
    if (plain && secTileNameMesMap?.has(info.artId) && info.artId % 100 <= 63) {
      await selectPaletteTile(info.artId, info.name);
      ui.list.querySelector(`.sec-edit-tile[data-art="${info.artId}"]`)?.scrollIntoView({ block: 'nearest' });
    } else {
      // a blended edge piece is not in the list: use that exact piece as the brush
      if (!artTiles.has(raw)) { const art = await loadSecTileArt(info); if (art) artTiles.set(raw, art); }
      edit.brush = { custom: true, raw, name: info.name, artId: info.artId };
      showBrush(); markActiveTile();
      status.textContent = `Picked ${info.name || 'tile'} (${hexRaw(raw)}) · left-drag to paint`;
    }
  };
  const openFacadeTool = async (num, name) => {
    await setTool('facade');
    await selectFacade(num, name);
    pk.facade.search.value = ''; filterPane(pk.facade);
    setTimeout(() => pk.facade.list.querySelector('.sec-edit-tile.active')?.scrollIntoView({ block: 'nearest' }), 200);
  };
  const openObjectTool = async p => {
    const kind = p.type === 0 ? 'wall' : p.type === 1 ? 'portal' : 'scenery';
    await setTool(kind);
    await protoCatalogReady();
    const item = protoItemFor(p);
    const P = pk[kind];
    if (kind === 'scenery') {
      const aid = p.currentAidRaw != null ? Number(p.currentAidRaw) >>> 0 : (item ? item.aid : null);
      if (aid == null) { status.textContent = 'Could not tell which scenery this is.'; return; }
      const key = ((aid >>> 6) & 31) * 1000 + ((aid >>> 19) & 0xFF);
      let label = String(key);
      try { const text = (await loadSceneryMes()).get(key); if (text != null) label = String(text).trim().replace(/\.art\b.*$/i, ''); } catch (_) {}
      selectScenery(key, label);
      const rot = aidRotation(aid);
      if (rot != null && [...P.rot.options].some(o => o.value === String(rot))) P.rot.value = String(rot);
      P.search.value = ''; filterPane(P);
    } else {
      const aid = p.currentAidRaw != null ? Number(p.currentAidRaw) >>> 0 : (item ? item.aid : null);
      const key = aid == null ? null : TEX[kind].keyOfAid(aid);
      if (key == null) { status.textContent = `Could not tell which ${kind} texture this is.`; return; }
      selectTexture(kind, key, await textureLabel(kind, key), item ? item.num : null);
      if (kind === 'wall' && p.wallDecode) {
        if ([...P.piece.options].some(o => o.value === String(p.wallDecode.piece))) P.piece.value = String(p.wallDecode.piece);
        if ([...P.variation.options].some(o => o.value === String(p.wallDecode.variation))) P.variation.value = String(p.wallDecode.variation);
      }
      P.search.value = ''; filterPane(P);
    }
    setTimeout(() => P.list.querySelector('.sec-edit-tile.active')?.scrollIntoView({ block: 'nearest' }), 200);
  };
  const renderInspect = async () => {
    const my = ++eyeSeq, tile = edit.eyeTile;
    eye.list.innerHTML = '';
    if (!tile) { eye.head.textContent = 'Click a tile on the map to see what is on it.'; return; }
    const at = sectorAtWorld(tile.wx, tile.wy); if (!at) return;
    eye.head.textContent = `Sector ${minX + (tile.wx >> 6)},${minY + (tile.wy >> 6)} · tile ${tile.wx & 63},${tile.wy & 63} — click an entry to open its tool`;
    try { await loadSecFacadeNames(); } catch (_) {}
    if (my !== eyeSeq) return;
    const raw = at.sec.decoded.tiles[at.idx] >>> 0, info = secTileInfo(raw);
    if (info.isFacade) {
      eyeRow('Facade', `#${info.facadeNum} · ${info.facadeName || 'unnamed'}`, `cell ${info.facadeFrame}`, loadSecFacadeArt(raw),
        () => openFacadeTool(info.facadeNum, info.facadeName || ''));
    } else {
      const art = artTiles.get(raw) || loadSecTileArt(info).then(a => { if (a) artTiles.set(raw, a); return a; });
      const blend = info.num1 !== info.num2 || info.flippable1 !== info.flippable2;
      eyeRow('Tile', `#${info.artId} · ${info.name || 'unnamed'}`, blend ? 'edge / blend piece' : '', art, () => openTileTool(raw, info));
    }
    if (!edit.objectsReady) {
      eye.head.textContent += ' · loading objects…';
      try { await objectsReady(); } catch (_) {}
      if (my !== eyeSeq) return;
      eye.head.textContent = eye.head.textContent.replace(' · loading objects…', '');
    }
    let n = 0;
    const here = objectsAt(tile.wx, tile.wy);
    for (const [type, label] of [[0, 'Wall'], [1, 'Portal'], [3, 'Scenery']]) {
      for (const p of here.filter(o => o.type === type)) {
        n++;
        const item = protoItemFor(p), kindName = type === 0 ? 'wall' : type === 1 ? 'portal' : 'scenery';
        const aid = p.currentAidRaw != null ? Number(p.currentAidRaw) >>> 0 : (item ? item.aid : null);
        const key = aid == null ? null : (kindName === 'scenery' ? protoCurrentAidArtId(aid, 3) : TEX[kindName].keyOfAid(aid));
        const texName = key == null ? null : await textureLabel(kindName, key);
        if (my !== eyeSeq) return;
        const title = texName != null ? `${key} · ${texName}` : (item ? `#${item.num} · ${item.label}` : (p.artName || p.name || label));
        const rot = type === 3 ? null : (secEdgeRotation(p) ?? p.__rot);
        const sub = [rot != null ? `${EDGE_NAMES[(rot >> 1) & 3]} edge` : null, item ? `prototype #${item.num}` : null, p.staticSecObject ? null : 'from a .mob file'].filter(Boolean).join(' · ');
        const art = p.artCanvas ? { canvas: p.artCanvas } : (item ? protoThumbArt(item) : null);
        eyeRow(label, title, sub, art, () => openObjectTool(p));
      }
    }
    const others = mobPoints.filter(p => p.type !== 0 && p.type !== 1 && p.type !== 3 && wxOf(p) === tile.wx && wyOf(p) === tile.wy).slice(0, 20);
    for (const p of others) {
      n++;
      const editable = (p.type === 2 || p.type === 16) && !p.staticSecObject;
      eyeRow(p.typeName || 'Object', p.artName || p.name || '', editable ? 'click to edit it (attributes, inventory, scripts)' : 'no tool for this one', p.artCanvas ? { canvas: p.artCanvas } : null, editable ? () => openMobEdit(p, editableMobsNear(wxOf(p), wyOf(p))) : null);
    }
    if (!n) { const none = document.createElement('p'); none.className = 'sec-eye-head'; none.textContent = 'No wall, portal, scenery or other object on this tile.'; eye.list.appendChild(none); }
  };
  const inspectTile = async event => {
    const t = worldTileAt(event); if (!t || !sectorAtWorld(t.wx, t.wy)) return;
    edit.eyeTile = { wx: t.wx, wy: t.wy };
    scheduleCursor();
    await renderInspect();
  };
  secProtoCatalog.listeners.push(() => { if (secProtoCatalog.done && edit.on && edit.tool === 'eyedropper' && edit.eyeTile) renderInspect(); });

  // ---- the Roof, Light, Block, Sector and Map tools ----------------------------------------------------------------------
  // (a layer button only shows when its map has something of that kind, or while the layer is on)
  const syncLayerButtons = () => {
    layerBtns.jumps.hidden = !layers.jumps && !mapData.jumps.length;
    layerBtns.scripts.hidden = !layers.scripts && !valid.some(s => s.decoded?.tileScripts?.length);
    layerBtns.start.hidden = !layers.start && !startInMap;
  };
  const setMapLayer = (key, on) => {
    layers[key] = on;
    layerBtns[key].setAttribute('aria-pressed', String(on)); layerBtns[key].classList.toggle('active', on);
    syncLayerButtons();
    if (on && key === 'blocked' && !mobLoadStarted) loadMobDataAtZoom().catch(() => {});
    redraw();
  };
  extra = createExtraTools({
    edit, status, panes, minX, minY, mapW, mapH, valid,
    sectorAtWorld, secKey: secSectorKey, setRoofCell, usualRoofNum, addLight, removeLight,
    setTile, objectsAt, cloneObject, removeObject, drawTilePreview, drawObjectPreview, wxOf, wyOf,
    tileRawAt: (wx, wy) => { const at = sectorAtWorld(wx, wy); return at ? at.sec.decoded.tiles[at.idx] >>> 0 : null; },
    ensureRoofArt: () => ensureRoofArt(), showLayer: key => showLayers([key]), setLayer: setMapLayer, getLayer: key => !!layers[key],
    scheduleCursor: () => scheduleCursor(), redraw, tileCentre, getMode: () => mode, zoom: () => view.zoom,
    pixelOffsetFor: f => { const a = secIsoProject(f.wx, f.wy, iso), b = secIsoProject(f.fx, f.fy, iso); return [Math.round(b.x - a.x), Math.round(b.y - a.y)]; },
    markExtra: sec => { const key = secSectorKey(sec); if (secExtrasDiffer(sec.decoded)) edit.extraSecs.set(key, sec); else edit.extraSecs.delete(key); view.colorSectorCache.delete(sec.filename); },
    // one step of the history made outside a stroke (a panel changed something)
    commit: entries => {
      edit.undo.push(entries); if (edit.undo.length > 300) edit.undo.shift();
      edit.redo.length = 0; edit.unsaved = true; refreshEditUi(); redraw();
    },
    getMapData: () => mapData,
    mapChanged: () => {
      startInMap = startIsInMap(); syncLayerButtons();
      edit.unsaved = true; refreshEditUi(); redraw();
    }
  });
  const layersForTool = { stamp: ['scenery', 'walls', 'otherMobs'], move: ['scenery', 'walls', 'otherMobs'], eraser: ['scenery', 'walls', 'otherMobs'], eyedropper: ['scenery', 'walls', 'otherMobs'], scenery: ['scenery'], wall: ['walls'], portal: ['walls', 'otherMobs'], items: ['containers', 'otherMobs'], npcs: ['containers', 'otherMobs'], containers: ['containers', 'otherMobs'], mobedit: ['containers', 'otherMobs'], generate: ['walls', 'scenery', 'otherMobs'], paths: ['walls', 'scenery', 'otherMobs'] };
  const showLayers = keys => {
    for (const k of keys) {
      if (overlayVisibility[k]) continue;
      overlayVisibility[k] = true;
      overlayButtons[k]?.setAttribute('aria-pressed', 'true'); overlayButtons[k]?.classList.add('active');
    }
  };
  const editCursor = () => edit.pan ? 'grab' : 'crosshair';
  // Leave the view where it is (same tile in the middle of the screen) when switching views.
  const centreWorld = () => {
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    const sx = (cx - view.offsetX) / view.zoom, sy = (cy - view.offsetY) / view.zoom;
    if (mode === 'art') { const p = secIsoUnproject(sx, sy, iso); return { x: p.x, y: p.y }; }
    return { x: mapW - 1 - (sx - 0.5), y: sy - 0.5 };
  };
  const setModePreserve = async (nextMode, zoom) => {
    if (mode === nextMode) return;
    const c = centreWorld(), cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    mode = nextMode; modeBtn.textContent = mode === 'art' ? 'Top-down view' : 'Isometric view';
    if (mode === 'art') { if (!view.blankSectors) view.blankSectors = secDetectBlankSectors(valid); artLoadStarted = true; }
    view.zoom = zoom;
    if (mode === 'art') { const p = secIsoProject(c.x, c.y, iso); view.offsetX = cx - p.x * zoom; view.offsetY = cy - p.y * zoom; }
    else { view.offsetX = cx - (mapW - 1 - c.x + 0.5) * zoom; view.offsetY = cy - (c.y + 0.5) * zoom; }
    redraw(); if (mode === 'art') scheduleVisibleArtLoad();
  };
  // ---- buttons that hold two tools ---------------------------------------------------------------------------------
  const prefStore = { get() { try { return JSON.parse(localStorage.getItem('arcanum.editor.toolPrefs') || '{}') || {}; } catch (_) { return {}; } },
    set(v) { try { localStorage.setItem('arcanum.editor.toolPrefs', JSON.stringify(v)); } catch (_) { /* private window */ } } };
  const groupOf = id => TOOL_GROUPS.find(g => g.includes(id));
  const toolPref = new Map(TOOL_GROUPS.map(g => [g, g.includes(prefStore.get()[g[0]]) ? prefStore.get()[g[0]] : g[0]]));
  const syncGroupButtons = () => {
    for (const g of TOOL_GROUPS) {
      const others = g.filter(t => t !== toolPref.get(g));
      for (const b of ui.toolBtns) {
        if (!g.includes(b.dataset.tool)) continue;
        const shown = b.dataset.tool === toolPref.get(g);
        b.hidden = !shown; b.classList.toggle('sec-tool-grouped', shown);
        if (shown) b.title = `${TOOLS.find(t => t.id === b.dataset.tool).title}\n\n(Hold the button, or right-click it, to switch to ${others.map(t => TOOL_NAMES[t]).join(' / ')}.)`;
      }
    }
  };
  const setToolPref = id => {
    const g = groupOf(id); if (!g || toolPref.get(g) === id) return;
    toolPref.set(g, id); syncGroupButtons();
    const all = prefStore.get(); all[g[0]] = id; prefStore.set(all);
  };
  let flyout = null;
  const closeFlyout = () => { flyout?.remove(); flyout = null; };
  const openFlyout = btn => {
    const g = groupOf(btn.dataset.tool); if (!g) return;
    closeFlyout();
    flyout = document.createElement('div'); flyout.className = 'sec-tool-flyout'; flyout.setAttribute('role', 'menu');
    for (const id of g) {
      const t = TOOLS.find(x => x.id === id);
      const item = document.createElement('button'); item.type = 'button'; item.className = 'sec-tool-flyout-item'; item.dataset.tool = id; item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-current', String(toolPref.get(g) === id));
      item.innerHTML = `${t.icon}<span>${TOOL_NAMES[id]}</span>`;
      item.addEventListener('click', () => { closeFlyout(); if (edit.on) setTool(id); });
      flyout.append(item);
    }
    document.body.append(flyout);
    const r = btn.getBoundingClientRect();
    flyout.style.left = `${Math.round(r.right + 6)}px`; flyout.style.top = `${Math.round(r.top)}px`;
    flyout.querySelector('[aria-current="true"]')?.focus();
  };
  document.addEventListener('pointerdown', e => { if (flyout && !flyout.contains(e.target)) closeFlyout(); }, true);
  document.addEventListener('keydown', e => { if (flyout && e.key === 'Escape') { closeFlyout(); } });
  syncGroupButtons();

  const setTool = async id => {
    edit.tool = id;
    setToolPref(id);
    ui.toolBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== (id === 'fill' ? 'tile' : id);
    ui.tileBrushRow.hidden = id === 'fill';             // the bucket has no brush size
    ui.title.textContent = SEC_MOB_KINDS[id]?.name || (id === 'mobedit' ? 'Edit NPC / container' : id === 'mapdata' ? 'Map' : id === 'stamp' ? 'Copy and paste' : id === 'block' ? 'Blocked tiles' : id.charAt(0).toUpperCase() + id.slice(1));
    canvas.style.cursor = editCursor();
    edit.hover = null;
    if (layersForTool[id]) showLayers(layersForTool[id]);
    if (id === 'eyedropper' || id === 'generate' || id === 'mobedit') secStartProtoScan();
    if (needsObjects(id) && !edit.objectsReady) {
      try { await objectsReady(); } catch (err) { status.textContent = `Could not load objects: ${errText(err)}`; }
      if (edit.tool !== id) return;
    }
    if (id === 'tile' || id === 'fill') buildPalette();
    else if (id === 'facade') buildFacadePalette().then(() => prioritizeKind('facade'));
    else if (PROTO_TYPE[id] != null) buildProtoPalette(id);
    else if (SEC_MOB_KINDS[id]) buildMobPalette(id);
    if (id === 'eyedropper') renderInspect();
    if (id === 'mobedit') mobEditor.refresh();
    if (id === 'dialog') dialogPanel.refresh();
    if (id === 'quest') questPanel.refresh();
    if (id === 'paths') renderPathInfo();
    extra.onTool(id);
    redraw();
  };
  // A button that holds two tools opens its list on a long press or a right click; a plain click uses the tool it shows.
  for (const b of ui.toolBtns) {
    const grouped = !!groupOf(b.dataset.tool);
    let holdTimer = 0, held = false;
    if (grouped) {
      b.addEventListener('pointerdown', e => { if (e.button !== 0) return; held = false; clearTimeout(holdTimer); holdTimer = setTimeout(() => { held = true; openFlyout(b); }, 380); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(holdTimer));
      b.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(holdTimer); held = false; openFlyout(b); });
      b.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openFlyout(b); } });
    }
    b.addEventListener('click', () => { if (held) { held = false; return; } if (edit.on) setTool(b.dataset.tool); });
  }
  // Outside edit mode the plain handler above switches the view; this one only handles edit mode.
  modeBtn.addEventListener('click', () => { if (edit.on) setModePreserve(mode === 'color' ? 'art' : 'color', mode === 'color' ? 1 : 18); });

  function zoom100() {
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2, old = view.zoom;
    const wx = (cx - view.offsetX) / old, wy = (cy - view.offsetY) / old;
    view.zoom = 1; view.offsetX = cx - wx; view.offsetY = cy - wy;
    redraw(); scheduleVisibleArtLoad();
  }
  const loadAllSectorsForEdit = async () => {
    if (!view.blankSectors) view.blankSectors = secDetectBlankSectors(valid);
    const todo = valid.filter(sec => !view.loadedSectors.has(secSectorKey(sec)) && !view.blankSectors.has(secSectorKey(sec)));
    let done = 0;
    for (let i = 0; i < todo.length && edit.on; i += 4) {
      status.textContent = `Edit mode · loading sectors… ${done}/${todo.length}`;
      await Promise.all(todo.slice(i, i + 4).map(sec => loadSectorTiles(sec).then(() => { done++; })));
    }
    if (edit.on) status.textContent = '';
  };

  //   top    : menu bar (title · overlays · lighting · view · … · Export .SEC · Exit edit)
  //   left   : tool strip          right : options + palette (+ messages at the bottom)
  //   bottom : slim status bar "100% - 3 sectors loaded"
  // The controls are the same elements as outside the editor; they are moved here on entry and put back on exit.
  const barText = document.createElement('span'); barText.className = 'sec-bar-text';
  const barMsg = document.createElement('span'); barMsg.className = 'sec-bar-msg';
  const barZoom = document.createElement('span'); barZoom.className = 'sec-bar-zoom'; barZoom.append(zoomOut, zoomIn);
  // The editor shows no running commentary; only a real problem (failed export, missing file…) appears briefly in the status bar.
  let barMsgTimer = 0;
  new MutationObserver(() => {
    if (!edit.on) return;
    const text = (status.textContent || '').trim();
    if (!/fail|could not|couldn.t|cannot|not found|error|nothing to/i.test(text)) return;
    barMsg.textContent = text; clearTimeout(barMsgTimer); barMsgTimer = setTimeout(() => { barMsg.textContent = ''; }, 6000);
  }).observe(status, { childList: true, characterData: true, subtree: true });
  const viewSwitch = document.createElement('div'); viewSwitch.className = 'sec-view-switch';
  viewSwitch.setAttribute('role', 'group'); viewSwitch.setAttribute('aria-label', 'View');
  const viewBtns = [['color', 'Top-down view'], ['art', 'Isometric view']].map(([m, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sec-view-btn'; b.dataset.mode = m; b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { if (edit.on && mode !== m) modeBtn.click(); });
    return b;
  });
  viewSwitch.append(...viewBtns);
  editBarSync = () => {
    if (!edit.on) return;
    const n = view.loadedSectors.size;
    barText.textContent = `${Math.round(view.zoom * 100)}% - ${n} sector${n === 1 ? '' : 's'} loaded`;
    for (const b of viewBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  };
  const moveToWorkspace = () => {
    editorSlot.append(overlayControls, lightControls, viewSwitch, exportSecBtn, editBtn);
    toolRail.prepend(ui.toolBar);
    hint.replaceChildren(barText, barMsg, barZoom);
    mapCard.appendChild(hint);
    hint.title = 'Right/middle-drag: pan · wheel: zoom · Ctrl+Z / Ctrl+Y: undo / redo';
  };
  const moveFromWorkspace = () => {
    viewSwitch.remove();
    ui.title.after(ui.toolBar);
    exportSecBtn.remove();
    layoutToolbar();
    addContextTool(editBtn, article);
    hint.removeAttribute('title');
    hint.replaceChildren();
    hint.remove();
  };

  const enterEdit = async () => {
    if (edit.on) return;
    editBtn.disabled = true;
    try {
      status.textContent = 'Edit mode · loading tile list…';
      await loadSecTileNameMes(); await loadSecTileManifest();
      detectPlainA3();
      edit.on = true; setEditorFlag(true);
      document.body.classList.add('sec-edit-full');    // the side bars and the top bar switch to their editor layout
      window.scrollTo(0, 0);
      article.classList.add('sec-editing'); info.classList.add('editing'); editPanel.hidden = false;
      editBtn.textContent = 'Exit edit'; editBtn.setAttribute('aria-pressed', 'true');
      moveToWorkspace(); editBarSync();
      selected = null;
      buildPalette(); showBrush(); refreshEditUi();
      if (mode !== 'art') await applyMode('art');     // actual tiles are needed to see what is placed
      await nextFrame(); await nextFrame(); await layoutSettled();   // let the side bars finish changing width
      showLayers(['containers', 'walls', 'scenery', 'otherMobs']);   // lights and bounds stay off
      loadMobDataAtZoom().then(() => redraw()).catch(() => {});
      zoom100(); fitToolLabels();
      await setTool(toolPref.get(groupOf(edit.tool)) || edit.tool);   // a button that holds two tools starts with the one it shows
      loadAllSectorsForEdit().catch(err => { status.textContent = `Edit mode · ${errText(err)}`; });
    } finally { editBtn.disabled = false; }
  };
  const exitEdit = () => {
    if (!edit.on) return;
    if (edit.unsaved && !confirm('You have edits that were not exported yet.\n\nPress Cancel, then use "Export .SEC" to save them first. Leave edit mode anyway?')) return;
    endStroke();
    edit.on = false; setEditorFlag(false); dragging = false; edit.hover = null;
    document.body.classList.remove('sec-edit-full');
    article.classList.remove('sec-editing'); info.classList.remove('editing'); editPanel.hidden = true;
    editBtn.textContent = 'Edit'; editBtn.setAttribute('aria-pressed', 'false');
    edit.pan = false; ui.panBtn.setAttribute('aria-pressed', 'false');
    moveFromWorkspace();
    canvas.style.cursor = 'crosshair';
    fillLegend();
    selected = null; redraw();
    layoutSettled().then(() => { if (!edit.on) fitView(); });   // the stage has its normal size again
    const pending = pendingCounts();
    status.textContent = !pending.sectors && !pending.mobs && !pending.story ? ''
      : pending.mobs || pending.story ? `${pendingText(pending)} waiting · Export to save`
      : `${pending.sectors} sector${pending.sectors === 1 ? '' : 's'} modified · Export .SEC to save`;
  };
  editBtn.addEventListener('click', () => { if (edit.on) exitEdit(); else enterEdit(); });

  const saveBlob = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  exportSecBtn.addEventListener('click', async () => {
    const changed = [...dirtySectors().values()], mobs = mobFiles(), mapFiles = extra ? extra.mapFiles() : [], hasStory = storyFileCount(edit.story) > 0 || mapFiles.length > 0;
    if (!changed.length && !mobs.length && !hasStory) return;
    exportSecBtn.disabled = true;
    try {
      status.textContent = 'Export · reading prototypes…';
      const protoFields = changed.length ? await secLoadProtoOrderFields(changed.map(sec => sec.decoded)) : null;
      const files = changed.map(sec => ({ name: sec.filename, bytes: secBuildSectorBytes(sec.decoded, { position: sec.position, protoFields }) }));
      // the new .mob files go beside the sectors: the game reads a map's G_*.mob from its folder
      files.push(...mobs);
      // dialogs (dlg/ + scr/) and the logbook (mes/) go under the folders the game keeps them in
      if (storyFileCount(edit.story) > 0) files.push(...await storyFiles(edit.story, fetchDataBytes));
      files.push(...mapFiles);
      // A new world: map.prp, terrain.tdf, mapinfo.txt. A map that already exists keeps its own files - the editor
      // changes nothing they hold (secMapInfoBytes patches an existing mapinfo.txt once something does).
      if (opts.extraFiles) files.push(...await opts.extraFiles());
      const kind = mobs.length || hasStory ? 'files' : 'sectors';
      if (files.length === 1 && !files[0].name.includes('/')) {
        saveBlob(new Blob([files[0].bytes], { type: 'application/octet-stream' }), files[0].name);
        status.textContent = `Exported ${files[0].name}`;
      } else if (typeof JSZip !== 'undefined') {
        const zip = new JSZip();
        for (const f of files) zip.file(f.name, f.bytes);
        const folder = String(relativePath || '').split('/').filter(Boolean).pop() || 'map';
        const onlyStory = hasStory && !changed.length && !mobs.length;
        saveBlob(await zip.generateAsync({ type: 'blob' }), opts.virtual ? 'new_world_sec.zip' : onlyStory ? (storyFileCount(edit.story) > 0 ? 'dialogs_and_quests.zip' : `${folder}_map_files.zip`) : `${folder}_edited_sec.zip`);
        status.textContent = `Exported ${files.length} altered ${kind} as a .zip`;
      } else {
        for (const f of files) { saveBlob(new Blob([f.bytes], { type: 'application/octet-stream' }), f.name.replace(/^.*\//, '')); await new Promise(r => setTimeout(r, 250)); }
        status.textContent = `Exported ${files.length} altered ${kind}`;
      }
      // The game packs a map's G_*.mob into maps\<name, ROT13 and reversed> when a module loads, and keeps that file
      // while it carries the module's GUID: new .mob files are read only once it is gone (map.c map_preprocess_mobile).
      if (mobs.length && !opts.virtual) {
        const packed = String(folderName || '').replace(/[A-Za-z]/g, c => String.fromCharCode((c.charCodeAt(0) - (c < 'a' ? 65 : 97) + 13) % 26 + (c < 'a' ? 65 : 97))).split('').reverse().join('');
        status.textContent += ` · in the game's maps folder, delete the file "${packed}" so the new .mob files are read`;
      }
      edit.unsaved = false;
    } catch (err) {
      status.textContent = `Export failed: ${errText(err)}`;
    } finally { refreshEditUi(); }
  });

  const ro=new ResizeObserver(()=>{ if(!view.initialized) fitView(); else redraw(); }); ro.observe(stage);
  requestAnimationFrame(fitView);
  if (opts.virtual) edit.unsaved = true;   // leaving a world that was never exported asks first
  if (opts.startEditing || editorRequested()) setTimeout(() => { enterEdit().catch(err => { status.textContent = `Edit mode · ${errText(err)}`; }); }, 0);   // a reload of a link with &editor=on
  // For scripts (browser tests): where a map tile is on the screen, what stands on it, and the editor's state.
  article.editBench = {
    screenOf: (wx, wy) => { const p = tileCentre(wx, wy), r = canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; },
    objectsAt: (wx, wy) => mobPoints.filter(p => p.staticSecObject && wxOf(p) === wx && wyOf(p) === wy)
      .map(p => ({ type: p.type, proto: p.__obj ? mobOidTypeAndNumber(p.__obj.protoOid)?.number : null, aid: Number(p.currentAidRaw) >>> 0 })),
    sectorOrigin: () => ({ minX, minY, mapW, mapH }),
    newMobs: () => edit.newMobs.map(m => ({ name: m.name, size: m.bytes.length, type: m.pt.type, proto: m.pt.protoNum, wx: wxOf(m.pt), wy: wyOf(m.pt), offset: [m.pt.offsetX, m.pt.offsetY], hasArt: !!m.pt.artCanvas })),
    newMobBytes: () => edit.newMobs.map(m => ({ name: m.name, bytes: Array.from(m.bytes) })),
    pickMob: (kind, num) => { const it = mobCatalog(kind).find(i => i.num === num); if (it) selectMob(kind, it); return !!it; },
    editableMobs: () => mobPoints.filter(p => (p.type === 2 || p.type === 16) && !p.staticSecObject).map(p => ({ file: p.file, type: p.type, wx: wxOf(p), wy: wyOf(p), isNew: !!p.__newMob, inv: p.inventoryOids?.length || 0, scripts: (p.scripts || []).length })),
    editMobAt: async (wx, wy) => { const near = editableMobsNear(wx, wy); if (!near.length) return false; await openMobEdit(near[0], near); return near[0].file; },
    mobFiles: () => mobFiles().map(f => ({ name: f.name, bytes: Array.from(f.bytes) })),
    storyFiles: async () => (await storyFiles(edit.story, fetchDataBytes)).map(f => ({ name: f.name, bytes: Array.from(f.bytes) })),
    story: () => edit.story,
    lights: () => valid.flatMap(s => s.decoded.lights.map(l => ({ x: l.x, y: l.y, flags: l.flags, art: (l.artId >>> 19) & 0x1FF, rgb: [l.r, l.g, l.b], isNew: l.__idx == null }))),
    // the Roof / Block / Sector / Map tools' work: per sector, and the map-level data
    extras: () => valid.map(s => ({ file: s.filename, roofs: s.decoded.roofArtIds ? Array.from(s.decoded.roofArtIds).filter(v => secIsRoofId(v)).length : 0,
      blocked: s.decoded.blockMask ? Array.from(s.decoded.blockMask).reduce((n, w) => n + (w >>> 0).toString(2).replace(/0/g, '').length, 0) : 0,
      scripts: (s.decoded.tileScripts || []).map(t => [t.tile, t.script.num]), info: s.decoded.sectorInfo })),
    mapData: () => ({ start: mapData.start, jumps: mapData.jumps.map(j => [j.x, j.y, j.dstMap, j.dst.x, j.dst.y]), blocked: [...mapData.blockedSectors] }),
    undo: () => undoEdit(), redo: () => redoEdit(), setTool: id => setTool(id),
    centreOn: (wx, wy) => {
      const p = tileCentre(wx, wy);
      view.offsetX += stage.clientWidth / 2 - p.x; view.offsetY += stage.clientHeight / 2 - p.y;
      redraw(); scheduleVisibleArtLoad();
    },
    occupiedTiles: () => [...new Set(mobPoints.filter(p => p.staticSecObject).map(p => `${wxOf(p)},${wyOf(p)}`))].map(k => k.split(',').map(Number)),
    state: () => ({ on: edit.on, tool: edit.tool, objectsReady: !!edit.objectsReady, protos: secProtoCatalog.done, status: status.textContent, undo: edit.undo.length })
  };
  return article;
}
