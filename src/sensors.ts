// Virtual sensors. A pet only ever sees the world through these; it never reads WorldState directly.
// Each sensor maps to hardware that can later exist on the ESP32 pet.
import { clamp, normAngle } from "./geometry.js";
import { HUMAN_RADIUS, PET_RADIUS, TEACHER_RADIUS, hueOf, type HumanState, type PetState } from "./pet.js";
import { Rng } from "./rng.js";
import { OBJECTS, ROOM, SOLIDS, centerOf, pointInShape, shapeOf, type World } from "./world.js";

export const VISION_RANGE = 400;
export const VISION_HALF_ANGLE = (55 * Math.PI) / 180;
const PROXIMITY_RANGE = 200;
const OBJECT_HUE: Record<string, number> = {
  window: 200, door: 25, plant: 120, table: 30, bed: 230, charger: 55, heater: 15, lamp: 50,
};

export interface Detection {
  category: "static" | "moving";
  distance: number;
  bearing: number; // radians relative to heading, + = clockwise (to the pet's right on screen)
  size: number;
  hue: number;
  confidence: number;
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
}

export interface Sound { tSec: number; x: number; y: number; volume: number; pitch: number }

type Other = { x: number; y: number };

export function rayDistance(x: number, y: number, angle: number, others: Other[], max = PROXIMITY_RANGE): number {
  const cx = Math.cos(angle), cy = Math.sin(angle);
  for (let d = 4; d <= max; d += 6) {
    const px = x + cx * d, py = y + cy * d;
    if (px < 0 || py < 0 || px > ROOM.width || py > ROOM.height) return d;
    if (SOLIDS.some((s) => pointInShape(px, py, s))) return d;
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
  const consider = (cat: Detection["category"], x: number, y: number, size: number, hue: number) => {
    const dx = x - p.x, dy = y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > VISION_RANGE) return;
    const bearing = normAngle(Math.atan2(dy, dx) - p.heading);
    if (Math.abs(bearing) > VISION_HALF_ANGLE) return;
    vision.push({
      category: cat,
      distance: Math.round(dist + noise(dist * 0.03)),
      bearing: Math.round((bearing + noise(0.03)) * 1000) / 1000,
      size: Math.round(size),
      hue: Math.round(hue),
      confidence: Math.round(clamp(1 - dist / VISION_RANGE + noise(0.05), 0.1, 1) * 100) / 100,
    });
  };
  for (const o of OBJECTS) {
    const c = centerOf(o);
    const s = shapeOf(o);
    consider("static", c.x, c.y, s.type === "circle" ? s.r * 2 : Math.max(s.w, s.h), OBJECT_HUE[o.kind] ?? 0);
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
  for (const o of OBJECTS) {
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
    const vol = s.volume * clamp(1 - dist / 1400, 0, 1);
    if (vol > 0.05 && (!hearing || vol > hearing.volume)) {
      hearing = { volume: Math.round(vol * 100) / 100, bearing: normAngle(Math.atan2(s.y - p.y, s.x - p.x) - p.heading), pitch: s.pitch };
    }
  }

  // The steady tone: the charger's hum, from anywhere in range, in its own channel.
  let tone: Tone | null = null;
  if (env.beaconOn) {
    const c = centerOf(OBJECTS.find((o) => o.kind === "charger")!);
    const vol = clamp(1 - Math.hypot(c.x - p.x, c.y - p.y) / TONE_RANGE, 0, 1);
    if (vol > 0.04) {
      tone = {
        volume: Math.round(clamp(vol + noise(0.02), 0, 1) * 100) / 100,
        bearing: Math.round(normAngle(Math.atan2(c.y - p.y, c.x - p.x) - p.heading + noise(0.05)) * 1000) / 1000,
        pitch: Math.round(BEACON_PITCH * (1 + noise(0.005))),
      };
    }
  }

  // Temperature: indoor air, warmer near the heater, a little colder by the window in bad weather.
  let temperature = env.indoorTemp;
  const heater = OBJECTS.find((o) => o.kind === "heater")!;
  const win = OBJECTS.find((o) => o.kind === "window")!;
  const hc = centerOf(heater), wc = centerOf(win);
  if (env.heaterOn) temperature += 3 * clamp(1 - Math.hypot(p.x - hc.x, p.y - hc.y) / 160, 0, 1);
  if (env.weather !== "clear") temperature -= 1.5 * clamp(1 - Math.hypot(p.x - wc.x, p.y - wc.y) / 150, 0, 1);

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
      left: rayDistance(p.x, p.y, p.heading - Math.PI / 4, otherPts),
      front: rayDistance(p.x, p.y, p.heading, otherPts),
      right: rayDistance(p.x, p.y, p.heading + Math.PI / 4, otherPts),
    },
    vision,
    near,
    hearing,
    tone,
  };
}
