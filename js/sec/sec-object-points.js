// Loads map objects and static-object points for SEC maps.

import { ART_TYPE, artType } from '../core/art-id.js';
import { errText } from '../core/text-io.js';
import { MOB_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { decodeMobBuffer, mobLocationInfo } from '../mob/mob-decoder.js';
import { mobObjectTypeName } from '../mob/mob-schema.js';
import { aidRotation } from '../objects/art-frames.js';
import { loadCritterMapArt } from '../objects/critter-art.js';
import { loadMobMapArtShared } from '../objects/map-art-loader.js';
import {
  secObjectBlitFlags,
  secObjectBlitScale,
  secObjectFlagWords,
  secObjectLightSources,
  secObjectNpcMotion,
  secObjectPixelOffsets,
  secObjectPortalFlags,
  secObjectScripts,
} from '../objects/object-fields.js';
import { loadWallArtFromRaw } from '../objects/wall-art.js';
import { protoArtObjectType, protoCritterAidInfo, protoCurrentAidArtId } from '../proto/critter-aid.js';
import { mobOidTypeAndNumber, resolveMobPrototype } from '../proto/proto-resolution.js';
import { loadMapsManifest, manifestFileList } from '../core/manifest.js';
import { secDisplayName } from './sec-explorer.js';
import { inventoryOidsOf, inventorySourceOf, isInventoryItem, registerInventoryItem } from './sec-inventory.js';

export async function loadMobsForSecMap(relativePath = '', manifestHint = null) {
  const diagnostics = {
    relativePath: String(relativePath || ''),
    manifestLoaded: false,
    manifestError: null,
    manifestMobFiles: 0,
    filesExamined: 0,
    fetchFailures: [],
    decodeFailures: [],
    locationFailures: [],
    loaded: 0,
    wallLoaded: 0,
    staticObjectCount: 0,
    staticObjectTypeCounts: {},
    staticObjectErrors: [],
    objectTypeCounts: {}
  };
  let manifest = manifestHint;
  if (!manifest) {
    try { manifest = await loadMapsManifest(relativePath, secDisplayName(relativePath, relativePath ? '' : 'maps')); diagnostics.manifestLoaded = true; }
    catch (err) { diagnostics.manifestError = errText(err); const empty = []; empty.mobDiagnostics = diagnostics; return empty; }
  } else {
    diagnostics.manifestLoaded = true;
  }
  // Only use MOBs listed directly in the manifest for the map folder being
  // displayed. Child folders are loaded when the user opens those folders.
  const files = manifestFileList(manifest).filter(x => /\.mob$/i.test(x));
  diagnostics.manifestMobFiles = files.length;
  const prefix = String(relativePath || '').replace(/^\/+|\/+$/g, '');
  const points = [];
  const BATCH = 32;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.all(batch.map(async name => {
      const path = /\//.test(name) && !manifest?.relativeNames ? name.replace(/^\/+/, '') : (prefix ? `${prefix}/${name}` : name);
      diagnostics.filesExamined++;
      try {
        const resp = await fetch(`${MOB_ROOT}${encPath(path)}`);
        if (!resp.ok) {
          diagnostics.fetchFailures.push({ file: path, status: resp.status, statusText: resp.statusText });
          return;
        }
        let mob;
        try {
          mob = decodeMobBuffer(await resp.arrayBuffer(), name.split('/').pop());
        } catch (err) {
          diagnostics.decodeFailures.push({ file: path, error: errText(err), stack: String(err?.stack || '') });
          return;
        }
        const typeKey = String(mob.objType);
        diagnostics.objectTypeCounts[typeKey] = (diagnostics.objectTypeCounts[typeKey] || 0) + 1;
        // Items carried by a critter or stored in a container have OF_INVENTORY
        // (0x1000) set in F_FLAGS; the game never places them in the world
        // (objlist_insert_internal() refuses them), so they must not be drawn.
        if (isInventoryItem(mob.fields)) {
          diagnostics.inventoryItemsSkipped = (diagnostics.inventoryItemsSkipped || 0) + 1;
          registerInventoryItem(mob);   // listed under its owner in the side bar
          return;
        }
        const locField = mob.fields.find(f => f.field === 2);
        const loc = locField ? mobLocationInfo(locField.value) : null;
        if (!loc) {
          diagnostics.locationFailures.push({ file: path, objectType: mob.objType, locationRaw: locField?.value ?? null });
          return;
        }
        const aidField = mob.fields.find(f => f.field === 1);
        let artId = aidField ? protoCurrentAidArtId(aidField.value, mob.objType) : null;
        let inheritedAidRaw = null;
        let wallArt = null;
        if (mob.objType === 0 && aidField) {
          try { wallArt = await loadWallArtFromRaw(aidField.value); } catch (_) { wallArt = null; }
        }
        const nameField = mob.fields.find(f => f.field === 22);
        const mobName = nameField?.value != null && String(nameField.value).trim() ? String(nameField.value).trim() : (mob.filename || name.split('/').pop());
        if (artId === null) {
          try {
            const proto = await resolveMobPrototype(mob, window.__secMobProtoCache || (window.__secMobProtoCache = new Map()));
            const pf = proto.decodedProto?.fields?.find(f => f.field === 1);
            if (pf) {
              inheritedAidRaw = pf.value;
              artId = protoCurrentAidArtId(pf.value, mob.objType);
            }
          } catch (_) {}
        }
        const resolvedAidRaw = aidField?.value ?? inheritedAidRaw;
        const artObjType = protoArtObjectType(inheritedAidRaw ?? aidField?.value, mob.objType);
        const paletteIndex = artObjType === 3 && resolvedAidRaw != null
          ? (Number(resolvedAidRaw) >>> 4) & 3
          : null;
        // Trap objects whose art id is not an eye-candy id (e.g. the arrow-trap
        // source protos holding a placeholder scenery id) are not drawn on maps.
        if (mob.objType === 17 && (artType(resolvedAidRaw) !== ART_TYPE.EYE_CANDY)) return;
        const sceneryRotation = (artObjType === 3 || artObjType === 2 || artObjType === 1) && resolvedAidRaw != null ? aidRotation(resolvedAidRaw) : null;
        let artCanvas = null, artName = null, artFile = null, artNote = null, hotspotX = 0, hotspotY = 0, animFrames = null, animFps = 8, actionFrames = null, actionFps = 8;
        if (mob.objType === 0 && wallArt?.canvas) {
          artCanvas = wallArt.canvas; artName = wallArt.artName;
          hotspotX = wallArt.hotspotX || 0; hotspotY = wallArt.hotspotY || 0;
        } else if ((artId === null || artId === undefined) && (mob.objType === 15 || mob.objType === 16)) {
          // Critters have no .mes art table: the placed object's own packed id names the ART file.
          try {
            const art = await loadCritterMapArt(protoCritterAidInfo(aidField ? aidField.value : inheritedAidRaw, mob.objType));
            if (art?.canvas) { artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
          } catch (_) {}
        } else if (artId !== null && artId !== undefined) {
          try {
            const art = await loadMobMapArtShared(artId, artObjType, paletteIndex, sceneryRotation, resolvedAidRaw);
            if (art?.canvas) { animFrames = art.animFrames || null; animFps = art.animFps || 8; actionFrames = art.actionFrames || null; actionFps = art.actionFps || 8; artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
          } catch (_) {}
        }
        if (!window.__secMobProtoCache) window.__secMobProtoCache = new Map();
        const { offsetX, offsetY } = await secObjectPixelOffsets(mob, window.__secMobProtoCache);
        const blitScale = await secObjectBlitScale(mob, window.__secMobProtoCache);
        const flagWords = await secObjectFlagWords(mob, window.__secMobProtoCache);
        const blitFlags = await secObjectBlitFlags(mob, window.__secMobProtoCache);
        const objLight = await secObjectLightSources(mob, window.__secMobProtoCache);
        const motion = await secObjectNpcMotion(mob, window.__secMobProtoCache);
        const portalFlags = await secObjectPortalFlags(mob, window.__secMobProtoCache);
        const scripts = await secObjectScripts(mob, window.__secMobProtoCache);
        const wallField = mob.fields.find(f => f.field === 39);
        const currentAidRaw = aidField ? aidField.value : null;
        const locationRaw = locField ? locField.value : null;
        points.push({
          file: mob.filename || name.split('/').pop(), name: mobName, mobUrl: `${MOB_ROOT}${encPath(path)}`,   // (the editor reads the file again to change it)
          worldX: loc.worldX, worldY: loc.worldY,
          sectorX: loc.sectorX, sectorY: loc.sectorY, tileX: loc.tileX, tileY: loc.tileY,
          type: mob.objType, typeName: mobObjectTypeName(mob.objType), protoNum: mobOidTypeAndNumber(mob.protoOid)?.number ?? null, artId, artName, artCanvas,
          wallFlags: wallField ? (Number(wallField.value) >>> 0) : 0,
          wallDecode: wallArt?.wallDecode || null,
          portalRotation: artObjType === 1 ? sceneryRotation : null, artFile, artNote,
          currentAidRaw, locationRaw, inventoryOids: inventoryOidsOf(mob.fields), inventorySource: inventorySourceOf(mob.fields),
          objFlags: flagWords.objFlags,
          sceneryFlags: flagWords.sceneryFlags,
          scripts,
          seq: points.length,
          // Keep the complete decoded field list for wall diagnostics. This
          // is intentionally attached only to wall MOBs to avoid bloating
          // the normal MOB overlay data.
          wallFields: mob.objType === 0 ? mob.fields.map(f => ({ field: f.field, value: f.value })) : null,
          hotspotX, hotspotY, offsetX, offsetY, blitScale, blitFlags,
          lightSources: objLight.sources, nocturnal: objLight.nocturnal,
          animFrames: (flagWords.sceneryFlags & 1) ? null : animFrames, animFps,
          motion, critterAidRaw: (motion || mob.objType === 15 || mob.objType === 16) ? resolvedAidRaw : null, actionFrames, actionFps, portalFlags
        });
        diagnostics.loaded++;
        if (mob.objType === 0) diagnostics.wallLoaded++;
      } catch (err) {
        diagnostics.decodeFailures.push({ file: path, error: errText(err), stack: String(err?.stack || '') });
      }
    }));
  }
  points.mobDiagnostics = diagnostics;
  return points;
}

export async function loadSecStaticObjectPoints(sectors, diagnostics) {
  const points = [];
  const protoCache = new Map();
  // Every object used to be loaded strictly one after another, each awaiting
  // its prototype, art, offsets and lights in turn. The work is independent
  // per object (and heavily de-duplicated by the caches), so run it in
  // parallel chunks and append the results in their original order.
  const CHUNK = 64;
  const processObject = async (sector, pos, obj, i) => {
      if (isInventoryItem(obj.fields)) {
        diagnostics.inventoryItemsSkipped = (diagnostics.inventoryItemsSkipped || 0) + 1;
        registerInventoryItem(obj);   // listed under its owner in the side bar
        return null;
      }
      const locField = obj.fields?.find(f => f.field === 2);
      if (!locField) {
        diagnostics.locationFailures.push({ file: `${sector.filename}#object${i}`, objectType: obj.objType, locationRaw: null, source: 'SEC static object list' });
        return null;
      }
      let raw;
      try { raw = BigInt(locField.value); } catch (_) {
        diagnostics.locationFailures.push({ file: `${sector.filename}#object${i}`, objectType: obj.objType, locationRaw: locField.value, source: 'SEC static object list' });
        return null;
      }
      // objlist_load() in sector_object_list.c converts the stored location
      // to the sector-local tile using tile_id_from_loc(): low 6 bits are X,
      // bits 32..37 are Y. The object is then assigned the sector origin.
      const tileX = Number(raw & 63n);
      const tileY = Number((raw >> 32n) & 63n);
      const currentAidField = obj.fields?.find(f => f.field === 1);
      const wallField = obj.fields?.find(f => f.field === 39);
      let artId = currentAidField ? protoCurrentAidArtId(currentAidField.value, obj.objType) : null;
      let inheritedAidRaw = null;
      if (artId === null && obj.objType !== 0) {
        try {
          const proto = await resolveMobPrototype(obj, protoCache);
          const protoAid = proto.decodedProto?.fields?.find(f => f.field === 1);
          if (protoAid) {
            inheritedAidRaw = protoAid.value;
            artId = protoCurrentAidArtId(protoAid.value, obj.objType);
          }
        } catch (_) {}
      }
      const resolvedAidRaw = currentAidField?.value ?? inheritedAidRaw;
      const artObjType = protoArtObjectType(inheritedAidRaw ?? currentAidField?.value, obj.objType);
      const paletteIndex = artObjType === 3 && resolvedAidRaw != null
        ? (Number(resolvedAidRaw) >>> 4) & 3
        : null;
      // Trap objects whose art id is not an eye-candy id (e.g. the arrow-trap
      // source protos holding a placeholder scenery id) are not drawn on maps.
      if (obj.objType === 17 && (artType(resolvedAidRaw) !== ART_TYPE.EYE_CANDY)) return null;
      const sceneryRotation = (artObjType === 3 || artObjType === 2 || artObjType === 1) && resolvedAidRaw != null ? aidRotation(resolvedAidRaw) : null;
      let artCanvas = null, artName = null, artFile = null, artNote = null, hotspotX = 0, hotspotY = 0, wallArt = null, animFrames = null, animFps = 8, actionFrames = null, actionFps = 8;
      if (obj.objType === 0 && currentAidField) {
        try { wallArt = await loadWallArtFromRaw(currentAidField.value); } catch (_) { wallArt = null; }
        if (wallArt?.canvas) {
          artCanvas = wallArt.canvas; artName = wallArt.artName;
          hotspotX = wallArt.hotspotX || 0; hotspotY = wallArt.hotspotY || 0;
        }
      } else if ((artId === null || artId === undefined) && (obj.objType === 15 || obj.objType === 16)) {
        try {
          const art = await loadCritterMapArt(protoCritterAidInfo(currentAidField ? currentAidField.value : inheritedAidRaw, obj.objType));
          if (art?.canvas) { artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
        } catch (_) {}
      } else if (artId !== null && artId !== undefined) {
        try {
          const art = await loadMobMapArtShared(artId, artObjType, paletteIndex, sceneryRotation, resolvedAidRaw);
          if (art?.canvas) { animFrames = art.animFrames || null; animFps = art.animFps || 8; actionFrames = art.actionFrames || null; actionFps = art.actionFps || 8; artCanvas = art.canvas; artName = art.artName; artFile = art.artFile || null; artNote = art.artNote || null; hotspotX = art.hotspotX || 0; hotspotY = art.hotspotY || 0; }
        } catch (_) {}
      }
      const { offsetX, offsetY } = await secObjectPixelOffsets(obj, protoCache);
      const blitScale = await secObjectBlitScale(obj, protoCache);
      const flagWords = await secObjectFlagWords(obj, protoCache);
      const blitFlags = await secObjectBlitFlags(obj, protoCache);
      const objLight = await secObjectLightSources(obj, protoCache);
      const motion = await secObjectNpcMotion(obj, protoCache);
      const portalFlags = await secObjectPortalFlags(obj, protoCache);
      const scripts = await secObjectScripts(obj, protoCache);
      const nameField = obj.fields?.find(f => f.field === 22);
      const name = nameField?.value != null && String(nameField.value).trim() ? String(nameField.value).trim() : `${sector.filename}#object${i}`;
      const locationRaw = locField.value;
      const point = {
        file: `${sector.filename}#object${i}`, name,
        worldX: Number(pos.x) * 64 + tileX, worldY: Number(pos.y) * 64 + tileY,
        sectorX: Number(pos.x), sectorY: Number(pos.y), tileX, tileY,
        type: obj.objType, typeName: mobObjectTypeName(obj.objType), protoNum: mobOidTypeAndNumber(obj.protoOid)?.number ?? null, artId, artName, artCanvas,
        wallFlags: wallField ? (Number(wallField.value) >>> 0) : 0,
        wallDecode: wallArt?.wallDecode || null,
        portalRotation: artObjType === 1 ? sceneryRotation : null, artFile, artNote,
        currentAidRaw: currentAidField ? currentAidField.value : null,
        locationRaw, inventoryOids: inventoryOidsOf(obj.fields), inventorySource: inventorySourceOf(obj.fields),
        objFlags: flagWords.objFlags,
        sceneryFlags: flagWords.sceneryFlags,
        scripts,
        seq: i,
        wallFields: obj.objType === 0 ? obj.fields.map(f => ({ field: f.field, value: f.value })) : null,
        hotspotX, hotspotY, offsetX, offsetY, blitScale, blitFlags,
        lightSources: objLight.sources, nocturnal: objLight.nocturnal,
        animFrames: (flagWords.sceneryFlags & 1) ? null : animFrames, animFps,
        motion, critterAidRaw: (motion || obj.objType === 15 || obj.objType === 16) ? resolvedAidRaw : null, actionFrames, actionFps, portalFlags,
        staticSecObject: true
      };
      diagnostics.staticObjectCount = (diagnostics.staticObjectCount || 0) + 1;
      const typeKey = String(obj.objType);
      diagnostics.staticObjectTypeCounts[typeKey] = (diagnostics.staticObjectTypeCounts[typeKey] || 0) + 1;
      if (obj.objType === 0) diagnostics.wallLoaded++;
      return point;
  };
  for (const sector of sectors || []) {
    if (sector?.decoded?.staticObjectError) {
      diagnostics.staticObjectErrors = diagnostics.staticObjectErrors || [];
      diagnostics.staticObjectErrors.push({ file: sector.filename, error: sector.decoded.staticObjectError });
    }
  }
  const jobs = [];
  for (const sector of sectors || []) {
    const objects = sector?.decoded?.staticObjects || [];
    const pos = sector?.position;
    if (!pos) continue;
    for (let i = 0; i < objects.length; i++) jobs.push([sector, pos, objects[i], i]);
  }
  for (let k = 0; k < jobs.length; k += CHUNK) {
    const results = await Promise.all(jobs.slice(k, k + CHUNK).map(j =>
      processObject(...j).catch(err => {
        diagnostics.decodeFailures.push({ file: `${j[0].filename}#object${j[3]}`, error: errText(err) });
        return null;
      })));
    for (const p of results) if (p) points.push(p);
  }
  return points;
}
