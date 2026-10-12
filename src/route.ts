// Route memory: how it got out last time, so that it can do it again.
//
// While it is in a passage the pet keeps a track of where it has gone, with every loop cut out of it (if it comes back to a
// place it has been, the wandering in between is forgotten). That track is a path it really walked, from where it came in to
// where it is now, so it is also the way back to the start. When it passes through a doorway, or reaches open ground, the
// track becomes a remembered way out. Later, when it has been in a passage a while and wants out (or its battery is
// getting low), it walks back along its own track to where that meets a remembered way out, and then follows that out.
//
// Everything is in the pet's own dead-reckoned frame. It is told nothing about mazes, rooms or exits.
import { clamp, normAngle } from "./geometry.js";
import { GRID_N } from "./sensors.js";
import type { Observation } from "./sensors.js";
import type { PetState } from "./pet.js";
import { newPlaces, repairPlaces, type Pt } from "./places.js";

export const routeSettings = { on: false }; // off until measured against the baseline

const STEP = 30; // a point on the track every this far
const LOOP = 26; // coming within this of an earlier point closes a loop
const MAX_TRACK = 320;
const MAX_ESCAPES = 6;
const MIN_ESCAPE = 150; // shorter than this is not a way out worth remembering
const SAME_START = 80; // two ways out that begin this close are the same way out
const JOIN = 45; // the track meets a remembered way out within this
const JUMP = 120; // moving this far in one tick is being picked up and put down, not walking
const OPEN_SEC = 90; // this long in open ground ends a passage
const CLOSED_IN = 8; // of the 24 cells within two of it
const RESTLESS_SEC = 120; // this long in a passage and it wants out
const WANTS_OUT_BATTERY = 50;
const REACHED = 50;
const NO_PROGRESS_SEC = 90;
const COOLDOWN_SEC = 300; // after a way out was completed
const RETRY_SEC = 30; // after a try that got nowhere

export interface Escape { path: Pt[]; n: number; lastSec: number }
export interface HomePlan { pts: Pt[]; i: number; sinceSec: number; lastDist: number; lastProgressSec: number }
export interface Passage {
  track: Pt[]; // loop-erased path walked since it came in
  closedSince: number | null; // when it was last shut in, if it still is
  openSince: number | null; // when it was last in the open, if it still is
  escapes: Escape[];
  home: HomePlan | null;
  coolUntil: number;
}
export const newPassage = (): Passage => ({ track: [], closedSince: null, openSince: null, escapes: [], home: null, coolUntil: 0 });
export function repairPassage(pg: Passage | undefined): Passage {
  pg ??= newPassage();
  pg.track ??= []; pg.escapes ??= []; pg.home ??= null; pg.closedSince ??= null; pg.openSince ??= null; pg.coolUntil ??= 0;
  return pg;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const rnd = (q: Pt): Pt => ({ x: Math.round(q.x), y: Math.round(q.y) });

function closedIn(grid: string[]): boolean {
  const h = (GRID_N - 1) / 2;
  let n = 0;
  for (let r = h - 2; r <= h + 2; r++) for (let c = h - 2; c <= h + 2; c++) { const ch = grid[r]?.[c]; if (ch !== "." && ch !== ":" && ch !== "^") n++; }
  return n >= CLOSED_IN;
}

/** Add a point to the track, cutting out any loop it closes. */
function extend(track: Pt[], q: Pt): void {
  const last = track[track.length - 1];
  if (last && dist(last, q) < STEP) return;
  for (let i = 0; i < track.length - 3; i++) {
    if (dist(track[i], q) < LOOP) { track.length = i + 1; return; } // back at an earlier place: forget the loop
  }
  track.push(rnd(q));
  if (track.length > MAX_TRACK) track.splice(0, track.length - MAX_TRACK);
}

/** Douglas-Peucker: keep only the corners. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let worst = -1, wi = 0;
  const L = dist(a, b) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L;
    if (d > worst) { worst = d; wi = i; }
  }
  if (worst <= eps) return [a, b];
  return [...simplify(pts.slice(0, wi + 1), eps).slice(0, -1), ...simplify(pts.slice(wi), eps)];
}

function length(path: Pt[]): number { let s = 0; for (let i = 1; i < path.length; i++) s += dist(path[i - 1], path[i]); return s; }

function remember(pg: Passage, path: Pt[], now: number): void {
  if (path.length < 3 || length(path) < MIN_ESCAPE) return;
  const same = pg.escapes.find((e) => dist(e.path[0], path[0]) < SAME_START);
  if (same) {
    same.n++; same.lastSec = now;
    if (length(path) < length(same.path)) same.path = path.slice(); // a shorter way out
  } else {
    pg.escapes.push({ path: path.slice(), n: 1, lastSec: now });
    if (pg.escapes.length > MAX_ESCAPES) pg.escapes.sort((a, b) => b.lastSec - a.lastSec), pg.escapes.length = MAX_ESCAPES;
  }
}

/** Every tick, after the pet has moved: keeps the track, notices a way out being completed. */
export function noteRoute(p: PetState, obs: Observation, nowSec: number, enteredDoorway: boolean): void {
  const pm = (p.places = repairPlaces(p.places ?? newPlaces()));
  const pg = (pm.passage = repairPassage(pm.passage));
  const here = { x: p.odo.x, y: p.odo.y };
  const trace = p.moveTrace ?? [];
  p.moveTrace = undefined;
  const last = pg.track[pg.track.length - 1];
  if (last && dist(last, here) > JUMP + (p.moved ? Math.hypot(p.moved.x, p.moved.y) : 0)) { pg.track = []; pg.home = null; pg.closedSince = null; pg.openSince = null; } // put down somewhere else
  const closed = !!obs.grid && obs.grid.length >= GRID_N && closedIn(obs.grid);
  if (closed) { pg.closedSince ??= nowSec; pg.openSince = null; } else { pg.openSince ??= nowSec; }
  if (enteredDoorway) { // through a doorway: whatever it walked since it came in is a way out of there
    remember(pg, [...pg.track, rnd(here)], nowSec);
    pg.track = []; pg.home = null; pg.closedSince = null; pg.coolUntil = nowSec + COOLDOWN_SEC;
  } else if (pg.openSince !== null && nowSec - pg.openSince > OPEN_SEC) {
    if (pg.track.length) remember(pg, [...pg.track, rnd(here)], nowSec);
    pg.track = []; pg.home = null; pg.closedSince = null;
  }
  if (closed || pg.track.length) {
    // (a tick is several seconds of walking, so the points along the way are taken from what the odometer read in between)
    const from = { x: here.x - (p.moved?.x ?? 0), y: here.y - (p.moved?.y ?? 0) };
    for (const d of trace) extend(pg.track, { x: from.x + d.x, y: from.y + d.y });
    extend(pg.track, here);
  }
}

/** Where to go to follow a way out it remembers, or null. */
export function routeSteer(p: PetState, nowSec: number): { forward: number; turn: number; reason: string } | null {
  if (!routeSettings.on) return null;
  const pg = p.places?.passage;
  if (!pg || !pg.track.length) return null;
  const here = { x: p.odo.x, y: p.odo.y };
  if (!pg.home) {
    if (nowSec < pg.coolUntil || pg.closedSince === null) return null;
    const wantsOut = nowSec - pg.closedSince >= RESTLESS_SEC || p.energy < WANTS_OUT_BATTERY;
    if (!wantsOut) return null;
    // the latest point on its own track that meets a remembered way out
    let plan: Pt[] | null = null;
    for (let j = pg.track.length - 1; j >= 0 && !plan; j--) {
      for (const e of pg.escapes) {
        let k = -1, d = JOIN;
        for (let m = 0; m < e.path.length; m++) { const dd = dist(e.path[m], pg.track[j]); if (dd < d) { d = dd; k = m; } }
        if (k >= 0 && k < e.path.length - 1) { plan = [...pg.track.slice(j, pg.track.length).reverse(), ...e.path.slice(k + 1)]; break; }
      }
    }
    if (!plan) return null;
    pg.home = { pts: simplify(plan, 20), i: 0, sinceSec: nowSec, lastDist: Infinity, lastProgressSec: nowSec };
  }
  const h = pg.home;
  for (;;) {
    const wp = h.pts[h.i];
    if (!wp) { pg.home = null; pg.coolUntil = nowSec + COOLDOWN_SEC; return null; }
    const d = dist(here, wp);
    if (d < REACHED) { h.i++; h.lastDist = Infinity; h.lastProgressSec = nowSec; continue; }
    if (d < h.lastDist - 8) { h.lastDist = d; h.lastProgressSec = nowSec; }
    if (nowSec - h.lastProgressSec > NO_PROGRESS_SEC) { pg.home = null; pg.coolUntil = nowSec + RETRY_SEC; return null; } // not getting anywhere: work it out again from where it is now
    const bearing = normAngle(Math.atan2(wp.y - here.y, wp.x - here.x) - p.heading);
    // (it turns first and then walks the whole tick in a straight line, so it only walks as far as the corner it is heading for)
    const forward = Math.abs(bearing) > 1.5 ? 0 : clamp(d / (30 * 5), 0.08, 0.7);
    return { forward, turn: clamp(bearing, -1.5, 1.5), reason: "I remember the way I got out of here before; I am walking it again" };
  }
}
