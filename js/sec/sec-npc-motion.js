// Roaming NPCs on the map ("Animate"). Where an NPC goes is decided by game/ai.c
// (ai_action_perform_non_combat), in this order:
//  1. waypoints (ai_waypoints_process): an NPC with F_NPC_WAYPOINTS_IDX and ONF_WAYPOINTS_DAY /
//     ONF_WAYPOINTS_NIGHT set for the current half of the day walks them in a loop, starting
//     at F_NPC_WAYPOINT_CURRENT. It moves on to the next one as soon as it is within 3 tiles
//     of the current one, so corners are cut rather than touched.
//  2. standpoints (ai_standpoints_process): otherwise it walks to F_NPC_STANDPOINT_DAY or
//     _NIGHT (guards go to a post, villagers home for the night). Once there, ONF_WANDERS /
//     ONF_WANDERS_IN_DARK make it wander to random tiles within 4 of the standpoint.
// Day is 06:00-21:00 (ai_is_day). Each leg is path-found over the map's blocking data (see
// sec-nav.js), one tile step at a time, at the game's own pace (see walkTiming). Not simulated:
// sleeping in beds, combat, followers, time-of-day teleports, other critters in the way.

import { protoCritterAidInfo } from '../proto/critter-aid.js';
import { loadCritterIdleArt, loadCritterMapArt, loadCritterWalkArt } from '../objects/critter-art.js';
import { SEC_ROT_STEP } from './sec-nav.js';
import { secRotationFromDelta } from './sec-rotation.js';

export const ONF_WAYPOINTS_DAY = 0x2, ONF_WAYPOINTS_NIGHT = 0x4, ONF_WANDERS = 0x1000, ONF_WANDERS_IN_DARK = 0x2000;
const OF_OFF = 0x2, OF_DONTDRAW = 0x100;
const WAYPOINT_REACHED = 3;      // ai_waypoints_process: location_dist <= 3 selects the next waypoint
const WANDER_RADIUS = 4;         // ai_standpoints_process: anim_goal_wander(obj, standpoint, 4)
const STANDPOINT_RANGE = 1;      // an NPC that does not wander is "at" its standpoint within 1 tile
const FALLBACK_TILES_PER_SEC = 3; // only for an NPC whose walk ART cannot be read (see walkTiming)
const WANDER_PAUSE = [2, 6];     // estimate (s): idle time between two wander steps
const WANDER_STEPS = 24;         // steps of the wander loop before it repeats
const WANDER_MAX_PATH = WANDER_RADIUS;   // sub_425930 refuses a path longer than the radius
const MAX_LEGS = 12;             // waypoint legs tried per waypoint while looking for the loop

export const secIsDay = hour => hour >= 6 && hour < 21;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A track is a chain of timed segments (a walk, or an idle pause when both ends are equal).
// Time past the end of the chain loops over the segments from `loopFrom` on.
function makeTrack(tilesPerSec) {
  const segs = [];
  let t = 0, lastRot = null;
  return {
    segs, loopFrom: -1, loopStart: 0, total: 0,
    // One tile step; every step takes the same time, whichever way it goes.
    step(from, to) {
      lastRot = secRotationFromDelta(to.x - from.x, to.y - from.y);
      segs.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, t0: t, t1: t + 1 / tilesPerSec, rot: lastRot, moving: true });
      t += 1 / tilesPerSec; this.total = t;
    },
    // The tiles of a path, the first one reached from `from`.
    walk(from, tiles) {
      let pos = from;
      for (const tile of tiles) { this.step(pos, tile); pos = tile; }
      return pos;
    },
    idle(at, dur) {
      segs.push({ x0: at.x, y0: at.y, x1: at.x, y1: at.y, t0: t, t1: t + dur, rot: lastRot, moving: false });
      t += dur; this.total = t;
    },
    mark() { return { index: segs.length, time: t }; },
    setLoop(m) { this.loopFrom = m.index; this.loopStart = m.time; }
  };
}

// The waypoint loop. Every leg ends at the tile where the NPC comes within reach of its
// waypoint, so the walk settles on a fixed cycle: the first time the NPC is at the same tile
// heading for the same waypoint again, everything since then is the loop.
function waypointTrack(home, m, tilesPerSec, nav) {
  const wp = m.waypoints, n = wp.length;
  const cur = ((m.current % n) + n) % n;
  const tr = makeTrack(tilesPerSec);
  const seen = new Map();
  let pos = home;
  for (let k = 0; k < MAX_LEGS * n; k++) {
    const state = `${k % n}|${pos.x},${pos.y}`;
    if (seen.has(state)) { tr.setLoop(seen.get(state)); break; }
    seen.set(state, tr.mark());
    // A waypoint that cannot be reached is skipped, as the NPC would give up on it.
    pos = tr.walk(pos, nav.leg(pos, wp[(cur + k) % n], WAYPOINT_REACHED) || []);
  }
  if (tr.loopFrom < 0) tr.setLoop(tr.mark());      // no cycle found: stop where it ended
  return tr.total - tr.loopStart < 0.5 ? null : tr;
}

function standpointTrack(home, stand, wanders, seed, tilesPerSec, nav) {
  const tr = makeTrack(tilesPerSec);
  let pos = tr.walk(home, nav.leg(home, stand, wanders ? WANDER_RADIUS : STANDPOINT_RANGE) || []);
  if (!wanders) return tr.segs.length ? tr : null;
  const rng = mulberry32(seed);
  const rand = (lo, hi) => lo + rng() * (hi - lo);
  tr.setLoop(tr.mark());
  const loopPos = pos;
  for (let i = 0; i < WANDER_STEPS; i++) {
    tr.idle(pos, rand(WANDER_PAUSE[0], WANDER_PAUSE[1]));
    // sub_425930: a random tile within the radius of the standpoint; the NPC only goes if the
    // path to it is no longer than the radius.
    const target = { x: stand.x + Math.round(rand(-WANDER_RADIUS, WANDER_RADIUS)), y: stand.y + Math.round(rand(-WANDER_RADIUS, WANDER_RADIUS)) };
    const path = nav.plan(pos, target);
    if (path && path.length && path.length <= WANDER_MAX_PATH) pos = tr.walk(pos, path);
  }
  tr.walk(pos, nav.planLong(pos, loopPos) || []);
  return tr;
}

// Which route the NPC follows at `hour`: { key, build() } or null when it stays put.
function routeFor(mob, hour) {
  const m = mob.motion;
  if (!m || ((mob.objFlags | 0) & (OF_OFF | OF_DONTDRAW))) return null;
  const day = secIsDay(hour);
  const home = { x: mob.worldX, y: mob.worldY };
  if (m.waypoints.length && (m.flags & (day ? ONF_WAYPOINTS_DAY : ONF_WAYPOINTS_NIGHT))) {
    return { key: day ? 'wd' : 'wn', build: (tps, nav) => waypointTrack(home, m, tps, nav) };
  }
  const stand = day ? m.standDay : m.standNight;
  if (!stand) return null;
  const wanders = (m.flags & (ONF_WANDERS | ONF_WANDERS_IN_DARK)) !== 0;
  const seed = Math.imul(mob.worldX, 73856093) ^ Math.imul(mob.worldY, 19349663) ^ (day ? 1 : 2);
  return { key: day ? 'sd' : 'sn', build: (tps, nav) => standpointTrack(home, stand, wanders, seed, tps, nav) };
}

// The NPC's position (absolute world tile coordinates, fractional while walking), the way it
// faces and whether it is walking, `sec` seconds after the animation started. Null for an
// NPC that does not leave its tile at this hour. `nav` is the map's walkability (sec-nav.js).
export function secNpcPose(mob, hour, sec, nav) {
  if (!mob.motion || !nav) return null;
  const route = routeFor(mob, hour);
  if (!route) return null;
  // The pace comes from the walk ART, so the NPC stays put until that has been read.
  const walk = secNpcWalk(mob);
  if (!walk) return null;
  // The route depends on the map's objects, so it is built again when more of them are loaded.
  const key = `${route.key}|${nav.id}`;
  if (!mob._track || mob._track.key !== key) mob._track = { key, track: route.build(walk.tilesPerSec, nav) };
  const tr = mob._track.track;
  if (!tr || !tr.segs.length) return null;
  let t = Math.max(0, sec);
  if (t >= tr.total) {
    if (tr.loopFrom < 0 || tr.total <= tr.loopStart) t = tr.total;
    else t = tr.loopStart + ((t - tr.loopStart) % (tr.total - tr.loopStart));
  }
  const segs = tr.segs;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].t1 <= t) lo = mid + 1; else hi = mid; }
  const s = segs[lo];
  const f = s.t1 > s.t0 ? Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))) : 1;
  const done = t >= tr.total && tr.loopFrom < 0;
  return { x: s.x0 + (s.x1 - s.x0) * f, y: s.y0 + (s.y1 - s.y0) * f, rot: s.rot, moving: s.moving && !done };
}

// Art for a moving NPC, fetched on first use: its walk animation, and the standing sprite for
// each direction it stops facing. The map redraws every animation tick, so results simply
// appear once loaded; meanwhile the NPC slides along on its original sprite.
function walkInfo(mob) {
  if (mob.critterAidRaw == null) return null;
  const raw = Number(mob.critterAidRaw) >>> 0;
  // Anim 1 (bits 6-10) is the walk; the frame number (bits 14-18) belongs to the idle pose.
  const info = protoCritterAidInfo(((raw & ~((0x1F << 6) | (0x1F << 14))) | (1 << 6)) >>> 0, mob.type);
  // Armed walk first, then the unarmed one; the idle ('a') files protoCritterAidInfo falls
  // back to are no use here.
  if (info?.candidates?.length) info.candidates = [...new Set([info.candidates[0], info.candidates[0].replace(/[A-Za-z]{2}(\.art)$/i, 'Ab$1')])];
  return info;
}

// How the game paces a walking critter (game/anim.c):
//  - sub_437990 turns STAT_SPEED into the walk animation's frame rate: the ART's own fps at
//    speed 8, 6..17 fps below it, 17..30 above it (+4 for dwarf and halfling bodies);
//  - sub_42EE90 makes a frame last 1000 / fps ms, kept within 30..800 ms;
//  - every frame shown moves the critter by that frame's movement offset stored in the ART
//    (object_inc_current_aid), so a walk cycle covers the sum of those offsets.
function walkTiming(mob, info, art) {
  const speed = mob.motion.speed;
  const v1 = info && !info.monster && (info.body === 1 || info.body === 2) ? 4 : 0;
  const v12 = 17 + v1, v13 = 6 + v1, v14 = 30 + v1;
  let fps = art ? art.fps : 10;
  if (speed < 8) fps = v13 + Math.trunc(speed * (v12 - v13) / 8);
  else if (speed > 8) fps = speed < 30 ? v12 + Math.trunc(speed * (v14 - v12) / 30) : v14;
  const frameMs = Math.min(800, Math.max(30, Math.trunc(1000 / Math.max(1, fps))));
  // Tiles covered per second: each direction's cycle offset, projected on one tile step of
  // that direction on screen (80x40 px tiles), over the cycle's duration.
  let sum = 0, count = 0;
  if (art) {
    for (let r = 0; r < 8; r++) {
      const frames = art.dirs[r];
      const [tx, ty] = SEC_ROT_STEP[r];
      const ux = (ty - tx) * 40, uy = (tx + ty) * 20;
      const mx = frames.reduce((a, f) => a + f.moveX, 0), my = frames.reduce((a, f) => a + f.moveY, 0);
      const tiles = Math.abs(mx * ux + my * uy) / (ux * ux + uy * uy);
      if (tiles > 0) { sum += tiles / (frames.length * frameMs / 1000); count++; }
    }
  }
  const measured = count ? sum / count : 0;
  // A measurement outside this range means the offsets were not what they should be.
  return { frameMs, tilesPerSec: measured >= 0.3 && measured <= 12 ? measured : FALLBACK_TILES_PER_SEC };
}

// The NPC's walk: { art, frameMs, tilesPerSec }, or null while its walk ART is still loading.
// `art` is null when it has none (the NPC then glides on its standing sprite).
export function secNpcWalk(mob) {
  if (!mob._walk) {
    mob._walk = { loading: true };
    const info = walkInfo(mob);
    const done = art => { mob._walk = { art, ...walkTiming(mob, info, art) }; };
    (info ? loadCritterWalkArt(info) : Promise.resolve(null)).then(done, () => done(null));
  }
  return mob._walk.loading ? null : mob._walk;
}
// The standing animation of any critter (not only roaming NPCs): { dirs, fps } once its idle
// ART has loaded and has more than one frame, else null. Fetched on first use.
export function secCritterIdle(mob) {
  if (mob.critterAidRaw == null) return null;
  if (mob._idle === undefined) {
    mob._idle = null;
    const info = protoCritterAidInfo(mob.critterAidRaw, mob.type);
    if (info) loadCritterIdleArt(info).then(a => { mob._idle = a; }, () => {});
  }
  return mob._idle;
}
export function secNpcStandArt(mob, rot) {
  if (rot === null || mob.critterAidRaw == null) return null;
  if (!mob._standArt) mob._standArt = new Map();
  if (!mob._standArt.has(rot)) {
    mob._standArt.set(rot, null);
    const info = protoCritterAidInfo(mob.critterAidRaw, mob.type);
    if (info) loadCritterMapArt({ ...info, rotation: rot }).then(a => { mob._standArt.set(rot, a); }, () => {});
  }
  return mob._standArt.get(rot);
}
