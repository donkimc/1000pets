// Authoritative 2D world: a single room whose environment changes over simulated time
// (sun, weather, temperature, curtain, door, lamp, heater, noises).
// Stepping is done in fixed one-simulated-minute increments, so the result is identical
// regardless of how often step() is called or at which speed the clock runs.
import { Rng } from "./rng.js";

export const ROOM = { width: 1000, height: 700 };

export type ObjectKind = "window" | "door" | "plant" | "table" | "bed" | "charger" | "heater" | "lamp";
export interface RoomObject { id: string; kind: ObjectKind; x: number; y: number; w: number; h: number }

export const OBJECTS: readonly RoomObject[] = [
  { id: "window", kind: "window", x: 650, y: 0, w: 200, h: 12 },
  { id: "door", kind: "door", x: 880, y: 688, w: 80, h: 12 },
  { id: "plant", kind: "plant", x: 500, y: 200, w: 40, h: 40 },
  { id: "table", kind: "table", x: 400, y: 350, w: 140, h: 80 },
  { id: "bed", kind: "bed", x: 60, y: 500, w: 160, h: 120 },
  { id: "charger", kind: "charger", x: 900, y: 70, w: 40, h: 40 },
  { id: "heater", kind: "heater", x: 40, y: 60, w: 70, h: 24 },
  { id: "lamp", kind: "lamp", x: 300, y: 150, w: 30, h: 30 },
];

export type Shape =
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "rect"; x: number; y: number; w: number; h: number };

/** Plant and lamp are drawn as circles centred on (x, y); everything else is a rectangle with (x, y) as its corner. */
export function shapeOf(o: RoomObject): Shape {
  return o.kind === "plant" || o.kind === "lamp"
    ? { type: "circle", cx: o.x, cy: o.y, r: o.w / 2 }
    : { type: "rect", x: o.x, y: o.y, w: o.w, h: o.h };
}

export function centerOf(o: RoomObject): { x: number; y: number } {
  const s = shapeOf(o);
  return s.type === "circle" ? { x: s.cx, y: s.cy } : { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** Objects a pet cannot walk through. The window, door and charger pad are flush with walls or the floor. */
const SOLID_KINDS: readonly ObjectKind[] = ["plant", "table", "bed", "heater", "lamp"];
export const SOLIDS: readonly Shape[] = OBJECTS.filter((o) => SOLID_KINDS.includes(o.kind)).map(shapeOf);

export function circleHitsShape(x: number, y: number, r: number, s: Shape): boolean {
  if (s.type === "circle") return Math.hypot(x - s.cx, y - s.cy) < r + s.r;
  const nx = Math.max(s.x, Math.min(x, s.x + s.w));
  const ny = Math.max(s.y, Math.min(y, s.y + s.h));
  return Math.hypot(x - nx, y - ny) < r;
}

export function pointInShape(x: number, y: number, s: Shape): boolean {
  return s.type === "circle"
    ? Math.hypot(x - s.cx, y - s.cy) < s.r
    : x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
}

export type Weather = "clear" | "cloudy" | "rain";
const WEATHER_SUN: Record<Weather, number> = { clear: 1, cloudy: 0.45, rain: 0.2 };
const WEATHER_TEMP: Record<Weather, number> = { clear: 0, cloudy: -1, rain: -3 };

export interface EnvState {
  weather: Weather;
  sunIntensity: number; // 0..1 outdoors
  outdoorTemp: number;
  indoorTemp: number;
  curtainOpen: boolean;
  doorOpen: boolean;
  lampOn: boolean;
  heaterOn: boolean;
}

export interface WorldSnapshot {
  simMinute: number; // minutes processed so far
  rngState: number;
  env: EnvState;
  curtainStuckDay: number; // day number when the curtain failed to open, else -1
  doorOpenUntil: number; // simMinute at which the door closes, else -1
}

export interface WorldEvent {
  type: string;
  detail: string;
  simMinute: number;
  day: number;
  hour: number;
  minute: number;
}

const DAY = 1440;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function isWeekend(day: number): boolean {
  return day % 7 >= 5; // day 0 is a Monday
}

export class World {
  private rng: Rng;
  snap: WorldSnapshot;

  constructor(seed: number, snapshot?: WorldSnapshot) {
    this.rng = new Rng(snapshot?.rngState ?? seed);
    this.snap = snapshot
      ? structuredClone(snapshot)
      : {
          simMinute: 0,
          rngState: this.rng.state,
          env: {
            weather: "clear",
            sunIntensity: 0,
            outdoorTemp: 8,
            indoorTemp: 19,
            curtainOpen: false,
            doorOpen: false,
            lampOn: false,
            heaterOn: false,
          },
          curtainStuckDay: -1,
          doorOpenUntil: -1,
        };
  }

  get env(): EnvState {
    return this.snap.env;
  }

  /** Process every simulated minute up to `toSimMs`. maxMinutes caps work done per call. */
  step(toSimMs: number, maxMinutes = Infinity): WorldEvent[] {
    const target = Math.floor(toSimMs / 60000);
    const events: WorldEvent[] = [];
    let n = 0;
    while (this.snap.simMinute < target && n++ < maxMinutes) {
      this.snap.simMinute++;
      this.stepMinute(events);
    }
    this.snap.rngState = this.rng.state;
    return events;
  }

  private emit(events: WorldEvent[], type: string, detail: string) {
    const m = this.snap.simMinute;
    events.push({ type, detail, simMinute: m, day: Math.floor(m / DAY) + 1, hour: Math.floor((m % DAY) / 60), minute: m % 60 });
  }

  private stepMinute(events: WorldEvent[]) {
    const s = this.snap;
    const e = s.env;
    const m = s.simMinute;
    const day = Math.floor(m / DAY);
    const tod = m % DAY;
    const weekend = isWeekend(day);

    // Weather: re-evaluated every 3 hours.
    if (tod % 180 === 0 && this.rng.chance(0.4)) {
      const next = this.rng.pick<Weather>(["clear", "cloudy", "rain"]);
      if (next !== e.weather) {
        e.weather = next;
        this.emit(events, "weather_changed", next);
      }
    }

    // Sun: daylight 06:00-18:00 following a half sine, scaled by weather.
    const daylight = tod >= 360 && tod <= 1080 ? Math.sin((Math.PI * (tod - 360)) / 720) : 0;
    e.sunIntensity = round2(daylight * WEATHER_SUN[e.weather]);

    // Outdoor temperature: coldest 04:00, warmest 16:00.
    e.outdoorTemp = round1(14 - 6 * Math.cos((2 * Math.PI * (tod - 240)) / DAY) + WEATHER_TEMP[e.weather]);

    // Curtain schedule (later at weekends); occasionally it fails to open - a deliberate anomaly.
    const openAt = weekend ? 540 : 420;
    const closeAt = weekend ? 1200 : 1140;
    if (tod === openAt) {
      if (this.rng.chance(0.04)) {
        s.curtainStuckDay = day;
        this.emit(events, "curtain_stuck", "curtain stayed closed this morning");
      } else {
        e.curtainOpen = true;
        this.emit(events, "curtain_opened", weekend ? "weekend" : "weekday");
      }
    }
    if (tod === closeAt && e.curtainOpen) {
      e.curtainOpen = false;
      this.emit(events, "curtain_closed", "");
    }

    // Door: someone passes through now and then during waking hours.
    if (e.doorOpen && m >= s.doorOpenUntil) {
      e.doorOpen = false;
      this.emit(events, "door_closed", "");
    } else if (!e.doorOpen && tod >= 420 && tod <= 1320 && this.rng.chance(1 / 240)) {
      e.doorOpen = true;
      s.doorOpenUntil = m + this.rng.int(3, 10);
      this.emit(events, "door_opened", "");
    }

    // Lamp: on in the evening.
    const lampShouldBeOn = tod >= 1110 && tod < 1380;
    if (lampShouldBeOn !== e.lampOn) {
      e.lampOn = lampShouldBeOn;
      this.emit(events, lampShouldBeOn ? "lamp_on" : "lamp_off", "");
    }

    // Heater with hysteresis, only during waking hours.
    const awake = tod >= 360 && tod < 1380;
    if (!e.heaterOn && awake && e.indoorTemp < 19) {
      e.heaterOn = true;
      this.emit(events, "heater_on", `indoor ${e.indoorTemp}°C`);
    } else if (e.heaterOn && (!awake || e.indoorTemp > 21)) {
      e.heaterOn = false;
      this.emit(events, "heater_off", `indoor ${e.indoorTemp}°C`);
    }

    // Indoor temperature drifts toward a target set by outdoors, sun through the window and heater.
    const target =
      e.outdoorTemp + 4 + (e.curtainOpen ? e.sunIntensity * 3 : 0) + (e.heaterOn ? 5 : 0) + (e.doorOpen ? -2 : 0);
    e.indoorTemp = round2(e.indoorTemp + (target - e.indoorTemp) * 0.01);

    // Occasional ambient noise from outside (for the hearing sensor later).
    if (this.rng.chance(1 / 600)) this.emit(events, "noise", this.rng.pick(["footsteps", "car", "voices", "knock"]));
  }

  /** Light level (0..100) at a point in the room: daylight, a moving sun patch on the floor, and the lamp. */
  lightAt(x: number, y: number): number {
    const e = this.snap.env;
    const tod = this.snap.simMinute % DAY;
    let light = 2 + 18 * e.sunIntensity * (e.curtainOpen ? 1 : 0.1);
    if (e.curtainOpen && e.sunIntensity > 0) {
      const p = this.sunPatch();
      if (Math.hypot(x - p.x, y - p.y) < p.r) light += 70 * e.sunIntensity;
    }
    if (e.lampOn) {
      const lamp = OBJECTS.find((o) => o.id === "lamp")!;
      light += Math.max(0, 1 - Math.hypot(x - lamp.x, y - lamp.y) / 260) * 55;
    }
    void tod;
    return Math.min(100, Math.round(light));
  }

  /** Sun patch on the floor; it slides across as the day goes on. */
  sunPatch(): { x: number; y: number; r: number } {
    const tod = this.snap.simMinute % DAY;
    const f = Math.max(-1, Math.min(1, (tod - 720) / 360));
    return { x: 780 - f * 200, y: 150 + (1 - Math.sin((Math.PI * Math.max(0, tod - 360)) / 720)) * 150, r: 110 };
  }
}
