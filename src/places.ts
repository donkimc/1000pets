// Places: what a pet knows about where things are in the house, in its own terms.
//
// A pet is never told there are rooms or where anything is. It only ever has its own dead-reckoned position (see
// scenes.ts), and it can recognise two kinds of landmark by feel: a charger pad (by the pitch of its hum, and the pad
// under its feet) and a doorway (the floor changes as it goes through). Each time it reaches one it notes where it was by
// its own reckoning, and when it has gone straight from one landmark to another it remembers that way. That makes a
// small map of its own: landmarks and the straight runs between them, nothing about walls, nothing named.
//
// When its battery is low and no hum leads it anywhere, it can read its map: find the nearest pad it has charged at,
// work out which landmarks to pass, and walk from one to the next, pushing doors open on the way. If it gets nowhere
// it gives that pad up for a while.
import { normAngle } from "./geometry.js";
import { pitchBin } from "./sensors.js";
import type { PetState } from "./pet.js";

export const placeSettings = { on: true }; // switched off only to measure what the map is worth

const MERGE_DOOR = 230; // a doorway reached within this of one it knows is the same one
const MERGE_PAD = 80;
const MIN_RUN = 40; // shorter hops are not worth remembering
const MAX_TRAVEL = 1800; // a run longer than this walked is not remembered
const WINDING = 4; // nor one that wandered more than this many times the straight distance
const TRAIL_STEP = 90; // a breadcrumb every this far
const TRAIL_MAX = 40;
const SIMPLIFY = 55;
const MAX_GAP_SEC = 1800; // the two landmarks must have been reached within this of each other
const REACHED = 60;
const NO_PROGRESS_SEC = 150;
const GIVE_UP_SEC = 3600;
const STALL_PAD_SEC = 60; // on a pad this long and not charging: it does not work now

export interface PlaceNode {
  id: string;
  kind: "pad" | "door";
  x: number; // in the pet's own frame
  y: number;
  key?: string; // a pad's hum, "tone:29"
  visits: number;
  charged: number; // times charging began here
  firstSec: number;
  lastSec: number;
}
export interface PlaceEdge { a: string; b: string; len: number; n: number; lastSec: number; via: { x: number; y: number }[] } // via: the turns of the way it actually walked from a to b, so it can be walked again
export interface Pt { x: number; y: number }
export interface PlaceRoute { to: string; path: string[]; wps: { x: number; y: number; node?: string }[]; step: number; sinceSec: number; lastDist: number; lastProgressSec: number }
export interface PlaceMap {
  nodes: Record<string, PlaceNode>;
  edges: PlaceEdge[];
  last: string | null; // the landmark it reached most recently
  lastSec: number;
  travel: number; // how far it has walked since that landmark
  trail: Pt[]; // breadcrumbs since that landmark
  route: PlaceRoute | null;
  avoid: Record<string, number>; // pads given up on, until when
  seq: number;
  padSince?: number; // when it stepped on the pad it is on now
  chargedHere?: boolean;
}

export const newPlaces = (): PlaceMap => ({ nodes: {}, edges: [], last: null, lastSec: 0, travel: 0, trail: [], route: null, avoid: {}, seq: 0 });
/** Fill in anything a map saved by an older version lacks (the breadcrumbs and a run's turns came later), so an old save keeps running. */
export function repairPlaces(pm: PlaceMap): PlaceMap {
  pm.nodes ??= {}; pm.edges ??= []; pm.avoid ??= {}; pm.trail ??= []; pm.travel ??= 0; pm.seq ??= 0; pm.last ??= null; pm.lastSec ??= 0; pm.route ??= null;
  for (const e of pm.edges) e.via ??= [];
  if (pm.route && (!Array.isArray(pm.route.wps) || !Array.isArray(pm.route.path))) pm.route = null; // a route planned by an older version: plan again
  return pm;
}
const ensure = (p: PetState): PlaceMap => (p.places = repairPlaces(p.places ?? newPlaces()));

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export const keyHz = (key: string) => Math.round(100 * 2 ** (Number(key.split(":")[1]) / 12));

/** Douglas-Peucker: keep only the turns that matter. */
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

/** A landmark was just reached (a pad, or a doorway). Remember where, and the run from the one before. */
export function visit(p: PetState, kind: "pad" | "door", nowSec: number, key?: string): PlaceNode {
  const pm = ensure(p);
  const pose = kind === "pad" && key && p.anchors?.[key] ? p.anchors[key] : { x: p.odo.x, y: p.odo.y };
  const tol = kind === "pad" ? MERGE_PAD : MERGE_DOOR;
  let node = Object.values(pm.nodes).find((n) => n.kind === kind && (kind !== "pad" || !key || !n.key || n.key === key) && dist(n, pose) < tol);
  if (node) {
    node.x = Math.round(node.x * 0.7 + pose.x * 0.3); node.y = Math.round(node.y * 0.7 + pose.y * 0.3);
    node.visits++; node.lastSec = nowSec;
    if (kind === "pad" && key && !node.key) node.key = key;
  } else {
    node = { id: `${kind === "pad" ? "p" : "d"}${++pm.seq}`, kind, x: Math.round(pose.x), y: Math.round(pose.y), ...(key ? { key } : {}), visits: 1, charged: 0, firstSec: nowSec, lastSec: nowSec };
    pm.nodes[node.id] = node;
  }
  const from = pm.last ? pm.nodes[pm.last] : null;
  if (from && from.id !== node.id && nowSec - pm.lastSec <= MAX_GAP_SEC) {
    const chord = dist(from, node), travel = pm.travel;
    if (chord >= MIN_RUN && travel <= MAX_TRAVEL && travel <= WINDING * chord + 150 && pm.trail.length < TRAIL_MAX) {
      const via = simplify([from, ...pm.trail, node], SIMPLIFY).slice(1, -1).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
      const fwd = pm.edges.find((x) => x.a === from.id && x.b === node!.id), back = pm.edges.find((x) => x.a === node!.id && x.b === from.id);
      const e = fwd ?? back;
      if (!e) pm.edges.push({ a: from.id, b: node.id, len: Math.round(travel), n: 1, lastSec: nowSec, via });
      else {
        e.n++; e.lastSec = nowSec;
        if (travel < e.len) { e.len = Math.round(travel); e.via = fwd ? via : via.slice().reverse(); } // a shorter way it has walked
      }
    }
  }
  pm.last = node.id; pm.lastSec = nowSec; pm.travel = 0; pm.trail = [];
  return node;
}

/** Called every tick after the pet has moved: keeps the distance walked since the last landmark, notices a pad underfoot and how charging goes. */
export function observePlaces(p: PetState, obs: { tone: { pitch: number; volume: number } | null }, nowSec: number, enteredDoorway: boolean): void {
  const pm = ensure(p);
  if (p.moved) pm.travel += Math.hypot(p.moved.x, p.moved.y);
  if (pm.last) { // leave breadcrumbs, so the way can be walked again
    const lastCrumb = pm.trail[pm.trail.length - 1] ?? pm.nodes[pm.last];
    if (lastCrumb && dist(lastCrumb, p.odo) >= TRAIL_STEP) { pm.trail.push({ x: p.odo.x, y: p.odo.y }); if (pm.trail.length > TRAIL_MAX) pm.trail = []; }
  }
  if (enteredDoorway) visit(p, "door", nowSec);
  if (p.touch === "pad") {
    if (pm.padSince === undefined) {
      pm.padSince = nowSec; pm.chargedHere = false;
      const key = obs.tone && obs.tone.volume > 0.5 ? `tone:${pitchBin(obs.tone.pitch)}` : undefined;
      visit(p, "pad", nowSec, key);
    }
    const node = pm.last ? pm.nodes[pm.last] : null;
    if (node && node.kind === "pad") {
      if (p.chargeRate > 0.05 && !pm.chargedHere) { pm.chargedHere = true; node.charged++; }
      else if (!pm.chargedHere && nowSec - pm.padSince > STALL_PAD_SEC && p.energy < 90) { pm.avoid[node.id] = nowSec + GIVE_UP_SEC; pm.route = null; } // it does not charge here now
    }
  } else if (pm.padSince !== undefined) { pm.padSince = undefined; pm.chargedHere = false; }
}

/** Cheapest way between two landmarks over the runs it knows, or null. */
export function planRoute(pm: PlaceMap, from: string, to: string): { path: string[]; cost: number } | null {
  const dist0: Record<string, number> = { [from]: 0 };
  const prev: Record<string, string> = {};
  const todo = new Set(Object.keys(pm.nodes));
  while (todo.size) {
    let u: string | null = null;
    for (const id of todo) if (dist0[id] !== undefined && (u === null || dist0[id] < dist0[u])) u = id;
    if (u === null) break;
    todo.delete(u);
    if (u === to) break;
    for (const e of pm.edges) {
      const v = e.a === u ? e.b : e.b === u ? e.a : null;
      if (v === null || !todo.has(v)) continue;
      const nd = dist0[u] + e.len;
      if (dist0[v] === undefined || nd < dist0[v]) { dist0[v] = nd; prev[v] = u; }
    }
  }
  if (dist0[to] === undefined) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return { path, cost: dist0[to] };
}

/** The pad worth walking to: the nearest by its own map, a little favouring ones it has charged at. */
export function chooseTarget(p: PetState, nowSec: number): { to: string; path: string[]; cost: number } | null {
  const pm = p.places;
  if (!pm || !pm.last || !pm.nodes[pm.last]) return null;
  let best: { to: string; path: string[]; cost: number; score: number } | null = null;
  for (const n of Object.values(pm.nodes)) {
    if (n.kind !== "pad" || n.id === pm.last || (pm.avoid[n.id] ?? 0) > nowSec) continue;
    const r = planRoute(pm, pm.last, n.id);
    if (!r) continue;
    const score = r.cost - 150 * Math.min(3, n.charged);
    if (!best || score < best.score) best = { to: n.id, path: r.path, cost: r.cost, score };
  }
  return best;
}

export interface PlaceSteer { bearing: number; toDoor: boolean; reason: string; distance: number }

/**
 * Where to head to follow the pet's map toward a pad, or null when there is nothing to follow (no map, no way it knows,
 * or it has just given the attempt up). Moves along the route as landmarks are reached.
 */
export function placeSteer(p: PetState, nowSec: number): PlaceSteer | null {
  if (!placeSettings.on) return null;
  const pm = p.places;
  if (!pm) return null;
  if (pm.route && pm.last && !pm.route.path.includes(pm.last)) pm.route = null; // it ended up somewhere that is not on the plan
  if (!pm.route) {
    const t = chooseTarget(p, nowSec);
    if (!t) return null;
    const wps: PlaceRoute["wps"] = [];
    for (let i = 1; i < t.path.length; i++) {
      const u = t.path[i - 1], v = t.path[i];
      const e = pm.edges.find((x) => (x.a === u && x.b === v) || (x.a === v && x.b === u))!;
      for (const q of e.a === u ? e.via : e.via.slice().reverse()) wps.push({ x: q.x, y: q.y });
      wps.push({ x: pm.nodes[v].x, y: pm.nodes[v].y, node: v });
    }
    pm.route = { to: t.to, path: t.path, wps, step: 0, sinceSec: nowSec, lastDist: Infinity, lastProgressSec: nowSec };
  }
  const r = pm.route;
  for (;;) {
    const wp = r.wps[r.step];
    if (!wp) { pm.route = null; return null; }
    const d = dist(p.odo, wp);
    if (d < (wp.node ? REACHED : 50)) {
      if (r.step >= r.wps.length - 1) { pm.route = null; return null; } // arrived: whatever happens next is up to the pad
      r.step++; r.lastDist = Infinity; r.lastProgressSec = nowSec;
      continue;
    }
    if (d < r.lastDist - 10) { r.lastDist = d; r.lastProgressSec = nowSec; }
    if (nowSec - r.lastProgressSec > NO_PROGRESS_SEC) { pm.avoid[r.to] = nowSec + GIVE_UP_SEC; pm.route = null; return null; }
    const bearing = normAngle(Math.atan2(wp.y - p.odo.y, wp.x - p.odo.x) - p.heading);
    const target = pm.nodes[r.to];
    const nextNode = r.wps.slice(r.step).find((q) => q.node);
    const kind = nextNode && nextNode.node ? pm.nodes[nextNode.node].kind : "pad";
    return { bearing, distance: d, toDoor: kind === "door", reason: `my battery is low and I remember a pad where I charged${target?.key ? ` that hums at ${keyHz(target.key)} Hz` : ""}; I am walking back the way I went (${kind === "door" ? "to a doorway" : "to the pad"} next)` };
  }
}

const DIR = (b: number) => (Math.abs(b) < 0.5 ? "ahead of me" : Math.abs(b) > 2.6 ? "behind me" : b > 0 ? "to my right" : "to my left");

/** Lines for the pet's notes: the pads it knows how to find. */
export function describePlaces(p: PetState, nowSec: number, n = 3, short = false): string[] {
  const pm = p.places;
  if (!pm) return [];
  const pads = Object.values(pm.nodes).filter((x) => x.kind === "pad").sort((a, b) => b.charged - a.charged || b.visits - a.visits).slice(0, n);
  const doors = Object.values(pm.nodes).filter((x) => x.kind === "door").length;
  const lines = pads.map((x) => {
    const ago = nowSec - x.lastSec, when = ago < 3600 ? `${Math.max(1, Math.round(ago / 60))} min ago` : `${(ago / 3600).toFixed(1)} h ago`;
    const d = dist(p.odo, x), way = Math.atan2(x.y - p.odo.y, x.x - p.odo.x) - p.heading;
    // (coarse on purpose: a figure that changes every minute would change the start of the prompt every time, and a repeated start is what a provider's cache discounts)
    const lately = ago < 3600 ? "within the hour" : `${Math.round(ago / 3600)} h ago`;
    if (short) return `- pad${x.key ? ` ${keyHz(x.key)} Hz` : ""}: charged there ${x.charged}x, last ${lately}, about ${Math.round(d / 10) * 10} steps ${DIR(normAngle(way))}${(pm.avoid[x.id] ?? 0) > nowSec ? " (did not work last time)" : ""}`;
    return `- a pad${x.key ? ` that hums at ${keyHz(x.key)} Hz` : ""}: I have charged there ${x.charged} time${x.charged === 1 ? "" : "s"}, last there ${when}; about ${Math.round(d / 10) * 10} steps from here, ${DIR(normAngle(way))}${(pm.avoid[x.id] ?? 0) > nowSec ? " (it did not work last time I tried)" : ""}`;
  });
  if (doors) lines.push(short ? `- ${doors} doorway${doors === 1 ? "" : "s"} known` : `- I know ${doors} doorway${doors === 1 ? "" : "s"} I have been through`);
  return lines;
}

export const padCount = (p: Pick<PetState, "places">) => Object.values(p.places?.nodes ?? {}).filter((x) => x.kind === "pad").length;
