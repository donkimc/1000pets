// Virtual sensors. A pet only ever sees the world through these; it never reads WorldState directly.
// Each sensor maps to hardware that can later exist on the ESP32 pet.
import { clamp, normAngle } from "./geometry.js";
import { HUMAN_RADIUS, PET_RADIUS, TEACHER_RADIUS, hueOf, type HumanState, type PetState } from "./pet.js";
import { Rng } from "./rng.js";
import { LEGACY, centerOf, circleHitsShape, pointInRect, pointInShape, shapeOf, type Layout } from "./layout.js";
import { WALL_MUFFLE, crossings } from "./acoustics.js";
import type { World } from "./world.js";

export const VISION_RANGE = 400;
export const VISION_HALF_ANGLE = (55 * Math.PI) / 180;
const PROXIMITY_RANGE = 200;
const OBJECT_HUE: Record<string, number> = {
  window: 200, door: 25, plant: 120, table: 30, bed: 230, charger: 55, heater: 15, lamp: 50,
  sofa: 340, shelf: 35, counter: 90, fridge: 190, desk: 28, wardrobe: 32, rug: 5,
};
export const DOOR_SHUT_HUE = 25; // a shut door looks like wood
export const DOOR_OPEN_HUE = 215; // an open doorway shows the dark or the room beyond
export const DOOR_SIZE = 90;

export interface Detection {
  category: "static" | "moving";
  distance: number;
  bearing: number; // radians relative to heading, + = clockwise (to the pet's right on screen)
  size: number;
  hue: number;
  confidence: number;
  door?: "open" | "shut"; // set only on a doorway between rooms: it can be seen to be open or shut
}

/** Anything within arm's reach, in any direction (not just the vision cone): whisker-like, no identity, only what and where. */
export const NEAR_RANGE = 110; // edge-to-edge gap in world units
export interface NearThing { category: "static" | "moving"; gap: number; bearing: number }

export interface Hearing { volume: number; bearing: number; pitch: number }

/**
 * A steady source (the charger's hum) is its own channel: it is heard from any direction out to TONE_RANGE, gets
 * louder as the pet gets closer, and is never masked by other noises. The pet is only given a volume, a bearing and
 * a pitch; what the tone means is something it has to work out from experience.
 */
export const TONE_RANGE = 700;
export const BEACON_PITCH = 534; // Hz, the centre of semitone bin 29, so a little noise never changes its bin
export interface Tone { volume: number; bearing: number; pitch: number }

/** Pitches are compared by semitone, so a small error in hearing does not make one source look like two. */
export const pitchBin = (hz: number) => Math.round(12 * Math.log2(hz / 100));

export interface Observation {
  timeOfDay: number; // minutes since midnight (internal clock)
  light: number; // 0..100
  temperature: number;
  energy: number; // 0..100 battery
  chargeRate: number; // %/min input from solar or charger
  heading: number;
  speed: number;
  turnRate: number;
  bumped: boolean;
  touch: PetState["touch"];
  proximity: { left: number; front: number; right: number };
  vision: Detection[];
  near: NearThing[];
  hearing: Hearing | null;
  tone: Tone | null; // the steady hum of the charger, if it is on and within range
  grid: string[]; // a short-range top-down map around the pet, ahead is up (see egoGrid)
}

export interface Sound { tSec: number; x: number; y: number; volume: number; pitch: number }

type Other = { x: number; y: number };

export function rayDistance(x: number, y: number, angle: number, others: Other[], max = PROXIMITY_RANGE, layout: Layout = LEGACY, shut: readonly string[] = []): number {
  const cx = Math.cos(angle), cy = Math.sin(angle);
  for (let d = 4; d <= max; d += 6) {
    const px = x + cx * d, py = y + cy * d;
    if (px < 0 || py < 0 || px > layout.width || py > layout.height) return d;
    if (layout.walls.some((w) => pointInRect(px, py, w))) return d;
    if (shut.some((id) => layout.doorRects[id] && pointInRect(px, py, layout.doorRects[id]))) return d;
    if (layout.solids.some((s) => pointInShape(px, py, s))) return d;
    // Another body blocks the pet's own body at two radii, so the ray must see it that wide, or the pet believes the way is clear while it is not.
    if (others.some((o) => Math.hypot(px - o.x, py - o.y) < PET_RADIUS * 2)) return d;
  }
  return max;
}

export const HUMAN_HUE = 280;
export const TEACHER_HUE = 170;

export function sense(p: PetState, others: PetState[], world: World, sounds: Sound[], nowSec: number, rng: Rng, human?: HumanState, teacher?: HumanState): Observation {
  const env = world.env;
  const noise = (scale: number) => (rng.next() - 0.5) * 2 * scale;
  const otherPts: Other[] = others.filter((o) => o.id !== p.id);
  if (human) otherPts.push({ x: human.x, y: human.y });
  if (teacher) otherPts.push({ x: teacher.x, y: teacher.y });

  // Vision cone: abstract detections (no identities, only category, size and hue).
  const vision: Detection[] = [];
  const shut = world.shutDoors();
  const consider = (cat: Detection["category"], x: number, y: number, size: number, hue: number, door?: "open" | "shut") => {
    const dx = x - p.x, dy = y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > VISION_RANGE) return;
    const bearing = normAngle(Math.atan2(dy, dx) - p.heading);
    if (Math.abs(bearing) > VISION_HALF_ANGLE) return;
    // Walls and shut doors stop sight. A doorway is looked at from just in front of it, so the wall around it does not hide it.
    if (crossings(world.layout, p, door ? { x: x - (dx / dist) * 10, y: y - (dy / dist) * 10 } : { x, y }, shut) > 0) return;
    vision.push({
      category: cat,
      distance: Math.round(dist + noise(dist * 0.03)),
      bearing: Math.round((bearing + noise(0.03)) * 1000) / 1000,
      size: Math.round(size),
      hue: Math.round(hue),
      confidence: Math.round(clamp(1 - dist / VISION_RANGE + noise(0.05), 0.1, 1) * 100) / 100,
      ...(door ? { door } : {}),
    });
  };
  for (const o of world.layout.objects) {
    const c = centerOf(o);
    const s = shapeOf(o);
    consider("static", c.x, c.y, s.type === "circle" ? s.r * 2 : Math.max(s.w, s.h), OBJECT_HUE[o.kind] ?? 0);
  }
  for (const d of world.layout.doors) {
    const r = world.layout.doorRects[d.id];
    const isShut = shut.includes(d.id);
    consider("static", r.x + r.w / 2, r.y + r.h / 2, DOOR_SIZE, isShut ? DOOR_SHUT_HUE : DOOR_OPEN_HUE, isShut ? "shut" : "open");
  }
  for (const o of others) if (o.id !== p.id) consider("moving", o.x, o.y, PET_RADIUS * 2, hueOf(o.color));
  if (human) consider("moving", human.x, human.y, HUMAN_RADIUS * 2.4, HUMAN_HUE);
  if (teacher) consider("moving", teacher.x, teacher.y, TEACHER_RADIUS * 2.4, TEACHER_HUE);
  vision.sort((a, b) => a.distance - b.distance);

  // Near field: everything within reach, all around. A pet that is touched or crowded from the side or
  // behind still knows something is there, even though it cannot see it.
  const near: NearThing[] = [];
  const addNear = (category: NearThing["category"], x: number, y: number, gap: number) => {
    if (gap > NEAR_RANGE) return;
    near.push({ category, gap: Math.max(0, Math.round(gap)), bearing: Math.round(normAngle(Math.atan2(y - p.y, x - p.x) - p.heading) * 1000) / 1000 });
  };
  for (const o of others) if (o.id !== p.id) addNear("moving", o.x, o.y, Math.hypot(o.x - p.x, o.y - p.y) - 2 * PET_RADIUS);
  if (human) addNear("moving", human.x, human.y, Math.hypot(human.x - p.x, human.y - p.y) - PET_RADIUS - HUMAN_RADIUS);
  if (teacher) addNear("moving", teacher.x, teacher.y, Math.hypot(teacher.x - p.x, teacher.y - p.y) - PET_RADIUS - TEACHER_RADIUS);
  for (const o of world.layout.objects) {
    const s = shapeOf(o);
    const edge = s.type === "circle"
      ? Math.hypot(p.x - s.cx, p.y - s.cy) - s.r
      : Math.hypot(p.x - Math.max(s.x, Math.min(p.x, s.x + s.w)), p.y - Math.max(s.y, Math.min(p.y, s.y + s.h)));
    const c = centerOf(o);
    addNear("static", c.x, c.y, edge - PET_RADIUS);
  }
  near.sort((a, b) => a.gap - b.gap);

  // Hearing: loudest recent sound, attenuated with distance.
  let hearing: Hearing | null = null;
  for (const s of sounds) {
    if (nowSec - s.tSec > 240) continue;
    const dist = Math.hypot(s.x - p.x, s.y - p.y);
    const vol = s.volume * clamp(1 - dist / 1400, 0, 1) * WALL_MUFFLE ** crossings(world.layout, p, s, shut);
    if (vol > 0.05 && (!hearing || vol > hearing.volume)) {
      hearing = { volume: Math.round(vol * 100) / 100, bearing: normAngle(Math.atan2(s.y - p.y, s.x - p.x) - p.heading), pitch: s.pitch };
    }
  }

  // The steady tone: a charger's hum, in its own channel. Each room's charger has its own pitch. Walls muffle it, and it seems to
  // come from the doorway when the charger is round a corner. The pet hears the loudest one.
  let tone: Tone | null = null;
  if (env.beaconOn) {
    let best: { vol: number; src: (typeof world.layout.objects)[number] } | null = null;
    for (const src of world.layout.objects) {
      if (src.kind !== "charger") continue;
      const vol = clamp(1 - world.acoustics.pathDistance(src, p, shut) / TONE_RANGE, 0, 1);
      if (!best || vol > best.vol) best = { vol, src };
    }
    if (best && best.vol > 0.04) {
      tone = {
        volume: Math.round(clamp(best.vol + noise(0.02), 0, 1) * 100) / 100,
        bearing: Math.round(normAngle(world.acoustics.directionTo(best.src, p, shut) - p.heading + noise(0.05)) * 1000) / 1000,
        pitch: Math.round((best.src.pitch ?? BEACON_PITCH) * (1 + noise(0.005))),
      };
    }
  }

  // Temperature: its room's air, warmer near that room's heater, a little colder by its window in bad weather.
  const room = world.roomIdAt(p.x, p.y);
  const renv = world.roomEnv(room);
  let temperature = renv.indoorTemp;
  const inRoom = (kind: string) => world.layout.objects.find((o) => o.kind === kind && (o.room ?? room) === room);
  const heater = inRoom("heater"), win = inRoom("window");
  if (heater && renv.heaterOn) { const hc = centerOf(heater); temperature += 3 * clamp(1 - Math.hypot(p.x - hc.x, p.y - hc.y) / 160, 0, 1); }
  if (win && env.weather !== "clear") { const wc = centerOf(win); temperature -= 1.5 * clamp(1 - Math.hypot(p.x - wc.x, p.y - wc.y) / 150, 0, 1); }

  return {
    timeOfDay: world.snap.simMinute % 1440,
    light: clamp(Math.round(world.lightAt(p.x, p.y) + noise(2)), 0, 100),
    temperature: Math.round((temperature + noise(0.2)) * 10) / 10,
    energy: Math.round(p.energy * 10) / 10,
    chargeRate: p.chargeRate,
    heading: p.heading,
    speed: p.speed,
    turnRate: p.turnRate,
    bumped: p.bumped,
    touch: p.touch,
    proximity: {
      left: rayDistance(p.x, p.y, p.heading - Math.PI / 4, otherPts, PROXIMITY_RANGE, world.layout, shut),
      front: rayDistance(p.x, p.y, p.heading, otherPts, PROXIMITY_RANGE, world.layout, shut),
      right: rayDistance(p.x, p.y, p.heading + Math.PI / 4, otherPts, PROXIMITY_RANGE, world.layout, shut),
    },
    vision,
    near,
    hearing,
    tone,
    grid: egoGrid(p, world.layout, shut, otherPts),
  };
}

export const GRID_N = 9; // cells across
export const GRID_CELL = 40; // world units per cell

/**
 * A short-range top-down map of the ground around the pet, ahead is up, as if from a ring of range sensors:
 * '#' wall or edge, 'o' furniture, 'D' shut door, ':' open doorway, '@' another body, '^' the pet, '.' open floor.
 */
export function egoGrid(p: Pick<PetState, "x" | "y" | "heading">, layout: Layout, shut: readonly string[], bodies: Other[]): string[] {
  const half = (GRID_N - 1) / 2;
  const cos = Math.cos(p.heading), sin = Math.sin(p.heading);
  const rows: string[] = [];
  for (let row = 0; row < GRID_N; row++) {
    let line = "";
    for (let col = 0; col < GRID_N; col++) {
      const fwd = (half - row) * GRID_CELL, right = (col - half) * GRID_CELL;
      if (row === half && col === half) { line += "^"; continue; }
      // A cell is whatever is most notable inside it: thin walls and doors would be missed by looking only at its centre.
      const cx = p.x + cos * fwd - sin * right, cy = p.y + sin * fwd + cos * right;
      const rank = "D:#o@.";
      let ch = ".";
      for (const [ox, oy] of [[0, 0], [-14, 0], [14, 0], [0, -14], [0, 14]]) {
        const x = cx + ox, y = cy + oy;
        let c = ".";
        if (x < 0 || y < 0 || x > layout.width || y > layout.height) c = "#";
        else if (Object.entries(layout.doorRects).some(([id, r]) => shut.includes(id) && pointInRect(x, y, r))) c = "D";
        else if (Object.values(layout.doorRects).some((r) => pointInRect(x, y, r))) c = ":";
        else if (layout.walls.some((w) => pointInRect(x, y, w))) c = "#";
        else if (layout.solids.some((s) => pointInShape(x, y, s))) c = "o";
        else if (bodies.some((b) => Math.hypot(b.x - x, b.y - y) < GRID_CELL / 2)) c = "@";
        if (rank.indexOf(c) < rank.indexOf(ch)) ch = c;
      }
      line += ch;
    }
    rows.push(line);
  }
  return rows;
}
