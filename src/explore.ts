// Exploring by what it knows least: the pet remembers how often it has trodden each patch of ground (in its own frame,
// from its own dead reckoning) and, in a corridor or a dead end, goes the way it has trodden least. Going straight on is
// preferred, so it follows a passage to its end; a dead end sends it back, and on the way back the first side opening it
// has not tried is the least trodden way, so it takes that. That is Trémaux's rule without needing to name junctions:
// the counts are the marks. Nothing here knows about mazes, rooms or exits; it only counts where it has been.
//
// This is the first step of the design in docs/design-world-model.md (step 2 will grow into the planner there).
import { clamp, normAngle } from "./geometry.js";
import { GRID_N } from "./sensors.js";
import type { Observation } from "./sensors.js";
import type { PetState } from "./pet.js";
import { newPlaces, repairPlaces } from "./places.js";

export const exploreSettings = { on: false }; // off until it has been measured against the baseline

const CELL = 50; // size of a patch of ground, in the pet's own units
const MAX_CELLS = 1500; // the oldest are forgotten beyond this
const PROBE_NEAR = 60;
const PROBE_FAR = 110;
const MOMENTUM = 0.6; // going straight on is worth this many extra visits
const REVERSE = 0.9; // turning round costs this many
const CONFINED_SEC = 12; // stays in corridor mode this long after the walls last closed in
const MAX_TURN = 1.5;
const CLOSED_IN = 8; // of the 24 cells around it

const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

/** Called every tick: one more visit to the patch of ground it is standing on, counted when it first steps onto it. */
export function noteTread(p: PetState): void {
  const pm = (p.places = repairPlaces(p.places ?? newPlaces()));
  const tread = (pm.tread ??= {});
  const key = cellKey(p.odo.x, p.odo.y);
  if (pm.treadCell === key) return;
  pm.treadCell = key;
  tread[key] = (tread[key] ?? 0) + 1;
  const keys = Object.keys(tread);
  if (keys.length > MAX_CELLS) for (const k of keys.slice(0, keys.length - MAX_CELLS + 200)) delete tread[k];
}

const open = (ch: string | undefined) => ch === "." || ch === ":" || ch === "^";

/** True if the first two cells in a direction (0 ahead, 1 right, 2 behind, 3 left) are clear. */
function clear(grid: string[], dir: number): boolean {
  const h = (GRID_N - 1) / 2;
  const at = (k: number) => {
    const [dr, dc] = dir === 0 ? [-k, 0] : dir === 1 ? [0, k] : dir === 2 ? [k, 0] : [0, -k];
    return grid[h + dr]?.[h + dc];
  };
  return open(at(1)) && open(at(2));
}

export interface ExploreSteer { forward: number; turn: number; reason: string }

/** Where to go next while in a passage, or null when it is not in one (or the switch is off): the caller then does what it would have done. */
export function exploreSteer(p: PetState, obs: Observation, nowSec: number): ExploreSteer | null {
  if (!exploreSettings.on || !p.places) return null;
  const s1 = p.s1;
  const g = obs.grid, h = (GRID_N - 1) / 2;
  if (!g || g.length < GRID_N) return null;
  // In a passage when much of the ground within two cells is closed in; in a room, or along one wall, it is not.
  let closed = 0;
  for (let r = h - 2; r <= h + 2; r++) for (let c = h - 2; c <= h + 2; c++) if (!open(g[r]?.[c])) closed++;
  if (closed >= CLOSED_IN) s1.exploreUntil = nowSec + CONFINED_SEC;
  if (nowSec >= (s1.exploreUntil ?? 0)) return null;

  const tread = p.places.tread ?? {};
  const score = (angle: number) => {
    const near = tread[cellKey(p.odo.x + Math.cos(angle) * PROBE_NEAR, p.odo.y + Math.sin(angle) * PROBE_NEAR)] ?? 0;
    const far = tread[cellKey(p.odo.x + Math.cos(angle) * PROBE_FAR, p.odo.y + Math.sin(angle) * PROBE_FAR)] ?? 0;
    return near + 0.5 * far;
  };
  // ahead, right, behind, left
  const rel = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  let best = -1, bestScore = Infinity;
  for (let d = 0; d < 4; d++) {
    if (!clear(g, d)) continue;
    const sc = score(p.heading + rel[d]) - (d === 0 ? MOMENTUM : 0) + (d === 2 ? REVERSE : 0);
    if (sc < bestScore) { bestScore = sc; best = d; }
  }
  if (best < 0) return { forward: 0, turn: 1.2, reason: "boxed in, turning round to look for another way" }; // nowhere clear: turn on the spot
  if (best === 0) return { forward: 0.7, turn: clamp((obs.proximity.right - obs.proximity.left) / 250, -0.35, 0.35), reason: "keeping on along the passage" }; // (and keeping to the middle of it)
  const turn = clamp(rel[best], -MAX_TURN, MAX_TURN);
  const why = best === 2 ? "a dead end, going back" : "taking the opening I have trodden least";
  return { forward: Math.abs(rel[best]) > 1.2 ? 0.1 : 0.4, turn, reason: why };
}

void normAngle;
