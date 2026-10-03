// Virtual sensors. A pet only ever sees the world through these; it never reads WorldState directly.
// Each sensor maps to hardware that can later exist on the ESP32 pet.
import { clamp, normAngle } from "./geometry.js";
import { HUMAN_RADIUS, PET_RADIUS, hueOf, type HumanState, type PetState } from "./pet.js";
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

export interface Hearing { volume: number; bearing: number }

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
  hearing: Hearing | null;
}

export interface Sound { tSec: number; x: number; y: number; volume: number }

type Other = { x: number; y: number };

export function rayDistance(x: number, y: number, angle: number, others: Other[], max = PROXIMITY_RANGE): number {
  const cx = Math.cos(angle), cy = Math.sin(angle);
  for (let d = 4; d <= max; d += 6) {
    const px = x + cx * d, py = y + cy * d;
    if (px < 0 || py < 0 || px > ROOM.width || py > ROOM.height) return d;
    if (SOLIDS.some((s) => pointInShape(px, py, s))) return d;
    if (others.some((o) => Math.hypot(px - o.x, py - o.y) < PET_RADIUS)) return d;
  }
  return max;
}

export const HUMAN_HUE = 280;

export function sense(p: PetState, others: PetState[], world: World, sounds: Sound[], nowSec: number, rng: Rng, human?: HumanState): Observation {
  const env = world.env;
  const noise = (scale: number) => (rng.next() - 0.5) * 2 * scale;
  const otherPts: Other[] = others.filter((o) => o.id !== p.id);
  if (human) otherPts.push({ x: human.x, y: human.y });

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
  vision.sort((a, b) => a.distance - b.distance);

  // Hearing: loudest recent sound, attenuated with distance.
  let hearing: Hearing | null = null;
  for (const s of sounds) {
    if (nowSec - s.tSec > 240) continue;
    const dist = Math.hypot(s.x - p.x, s.y - p.y);
    const vol = s.volume * clamp(1 - dist / 1400, 0, 1);
    if (vol > 0.05 && (!hearing || vol > hearing.volume)) {
      hearing = { volume: Math.round(vol * 100) / 100, bearing: normAngle(Math.atan2(s.y - p.y, s.x - p.x) - p.heading) };
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
    hearing,
  };
}
