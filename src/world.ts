// Authoritative 2D world: a single room whose environment changes over simulated time
// (sun, weather, temperature, curtain, door, lamp, heater, noises).
// Stepping is done in fixed one-simulated-minute increments, so the result is identical
// regardless of how often step() is called or at which speed the clock runs.
import { Rng } from "./rng.js";

import { Acoustics } from "./acoustics.js";
import { LEGACY, centerOf, circleHitsShape, pointInShape, roomAt, shapeOf, type Layout, type ObjectKind, type RoomObject, type Shape } from "./layout.js";
export { centerOf, circleHitsShape, pointInShape, shapeOf };
export type { ObjectKind, RoomObject, Shape };

// The original single room. New code reads the layout from the world; these remain for older tests and tools.
export const ROOM = { width: LEGACY.width, height: LEGACY.height };
export const OBJECTS: readonly RoomObject[] = LEGACY.objects;
export const SOLIDS: readonly Shape[] = LEGACY.solids;

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
  beaconOn: boolean; // the charger's steady hum
}

/** Values a person (or the teacher) can pin. A pinned field holds its value; the automatic schedule leaves it alone until it is released. */
export const OVERRIDE_FIELDS = ["weather", "sunIntensity", "outdoorTemp", "indoorTemp", "curtainOpen", "doorOpen", "lampOn", "heaterOn", "beaconOn"] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];
export type Overrides = {
  weather?: Weather;
  sunIntensity?: number;
  outdoorTemp?: number;
  indoorTemp?: number;
  curtainOpen?: boolean;
  doorOpen?: boolean;
  lampOn?: boolean;
  heaterOn?: boolean;
  beaconOn?: boolean;
};

const WEATHERS: readonly Weather[] = ["clear", "cloudy", "rain"];

/** Validate a value for a field. Throws a readable error; numbers are clamped to a sane range and rounded. */
export function parseOverride(field: string, value: unknown): Overrides[OverrideField] {
  if (!(OVERRIDE_FIELDS as readonly string[]).includes(field)) throw new Error(`unknown field "${field}"`);
  switch (field as OverrideField) {
    case "weather":
      if (!WEATHERS.includes(value as Weather)) throw new Error(`weather must be one of ${WEATHERS.join(", ")}`);
      return value as Weather;
    case "sunIntensity":
    case "outdoorTemp":
    case "indoorTemp": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${field} must be a number`);
      const [lo, hi] = field === "sunIntensity" ? [0, 1] : field === "outdoorTemp" ? [-30, 50] : [0, 40];
      return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
    }
    default:
      if (typeof value === "boolean") return value;
      if (value === "on" || value === "open" || value === "true") return true;
      if (value === "off" || value === "closed" || value === "false") return false;
      throw new Error(`${field} must be true or false`);
  }
}

export interface WorldSnapshot {
  simMinute: number; // minutes processed so far
  rngState: number;
  env: EnvState;
  curtainStuckDay: number; // day number when the curtain failed to open, else -1
  doorOpenUntil: number; // simMinute at which the door closes, else -1
  overrides?: Overrides; // pinned values (absent in saves from before environment control)
  layoutId?: string; // which floor plan this world uses (absent: the original single room)
  doors?: Record<string, { open: boolean; closeAtSec: number }>; // the doors between rooms; absent means all shut
  locked?: string[]; // doors nobody can open until they are unlocked
  rooms?: Record<string, RoomEnv>; // lamp, heater, curtain and temperature of every room but the first (the first is `env`)
  roomOverrides?: Record<string, Partial<RoomEnv>>; // values pinned for one room
}

/** What can differ from room to room. The first room's values are the world's `env` fields, so older code and saves keep working. */
export interface RoomEnv { indoorTemp: number; heaterOn: boolean; lampOn: boolean; curtainOpen: boolean }
export const ROOM_FIELDS = ["indoorTemp", "heaterOn", "lampOn", "curtainOpen"] as const;
export type RoomField = (typeof ROOM_FIELDS)[number];

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

  constructor(seed: number, snapshot?: WorldSnapshot, readonly layout: Layout = LEGACY) {
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
            beaconOn: true,
          },
          curtainStuckDay: -1,
          doorOpenUntil: -1,
          overrides: {},
        };
    this.snap.overrides ??= {};
    this.snap.env.beaconOn ??= true; // saves from before the beacon
    this.snap.layoutId = layout.id;
    this.snap.doors ??= {};
    this.snap.locked ??= [];
    this.snap.rooms ??= {};
    this.snap.roomOverrides ??= {};
    for (const r of layout.rooms.slice(1)) this.snap.rooms[r.id] ??= { indoorTemp: this.snap.env.indoorTemp, heaterOn: false, lampOn: false, curtainOpen: false };
  }

  get overrides(): Overrides {
    return this.snap.overrides!;
  }

  /** Pin a field to a value, or release it back to the automatic schedule with `null`. Takes effect at once. */
  setOverride(field: string, value: unknown | null): { field: OverrideField; from: unknown; to: unknown; mode: "pin" | "auto" } {
    if (!(OVERRIDE_FIELDS as readonly string[]).includes(field)) throw new Error(`unknown field "${field}"`);
    const f = field as OverrideField;
    const e = this.snap.env as unknown as Record<string, unknown>;
    const from = e[f];
    if (value === null || value === "auto") {
      delete this.snap.overrides![f];
      if (f === "beaconOn") this.snap.env.beaconOn = true; // its normal state
      return { field: f, from, to: f === "beaconOn" ? true : from, mode: "auto" };
    }
    const v = parseOverride(f, value);
    (this.snap.overrides as Record<string, unknown>)[f] = v;
    e[f] = v;
    if (f === "weather") this.updateWeatherDerived(this.snap.simMinute % DAY);
    if (f === "doorOpen") this.snap.doorOpenUntil = -1;
    return { field: f, from, to: v, mode: "pin" };
  }

  /** Sun and outdoor temperature follow the weather and the time of day, unless pinned. */
  private updateWeatherDerived(tod: number) {
    const e = this.snap.env;
    const pin = this.snap.overrides!;
    const daylight = tod >= 360 && tod <= 1080 ? Math.sin((Math.PI * (tod - 360)) / 720) : 0;
    e.sunIntensity = pin.sunIntensity ?? round2(daylight * WEATHER_SUN[e.weather]);
    e.outdoorTemp = pin.outdoorTemp ?? round1(14 - 6 * Math.cos((2 * Math.PI * (tod - 240)) / DAY) + WEATHER_TEMP[e.weather]);
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
    const pin = s.overrides!;

    // Weather: re-evaluated every 3 hours.
    if (pin.weather === undefined && tod % 180 === 0 && this.rng.chance(0.4)) {
      const next = this.rng.pick<Weather>(["clear", "cloudy", "rain"]);
      if (next !== e.weather) {
        e.weather = next;
        this.emit(events, "weather_changed", next);
      }
    }

    // Sun: daylight 06:00-18:00 following a half sine, scaled by weather.
    // Outdoor temperature: coldest 04:00, warmest 16:00.
    this.updateWeatherDerived(tod);

    // Curtain schedule (later at weekends); occasionally it fails to open - a deliberate anomaly.
    const openAt = weekend ? 540 : 420;
    const closeAt = weekend ? 1200 : 1140;
    if (pin.curtainOpen === undefined && tod === openAt) {
      if (this.rng.chance(0.04)) {
        s.curtainStuckDay = day;
        this.emit(events, "curtain_stuck", "curtain stayed closed this morning");
      } else {
        e.curtainOpen = true;
        this.emit(events, "curtain_opened", weekend ? "weekend" : "weekday");
      }
    }
    if (pin.curtainOpen === undefined && tod === closeAt && e.curtainOpen) {
      e.curtainOpen = false;
      this.emit(events, "curtain_closed", "");
    }

    // Door: someone passes through now and then during waking hours.
    if (pin.doorOpen !== undefined) {
      /* pinned: stays as set */
    } else if (e.doorOpen && m >= s.doorOpenUntil) {
      e.doorOpen = false;
      this.emit(events, "door_closed", "");
    } else if (!e.doorOpen && tod >= 420 && tod <= 1320 && this.rng.chance(1 / 240)) {
      e.doorOpen = true;
      s.doorOpenUntil = m + this.rng.int(3, 10);
      this.emit(events, "door_opened", "");
    }

    // Lamp: on in the evening.
    const lampShouldBeOn = tod >= 1110 && tod < 1380;
    if (pin.lampOn === undefined && lampShouldBeOn !== e.lampOn) {
      e.lampOn = lampShouldBeOn;
      this.emit(events, lampShouldBeOn ? "lamp_on" : "lamp_off", "");
    }

    // Heater with hysteresis, only during waking hours.
    const awake = tod >= 360 && tod < 1380;
    if (pin.heaterOn !== undefined) {
      /* pinned: stays as set */
    } else if (!e.heaterOn && awake && e.indoorTemp < 19) {
      e.heaterOn = true;
      this.emit(events, "heater_on", `indoor ${e.indoorTemp}°C`);
    } else if (e.heaterOn && (!awake || e.indoorTemp > 21)) {
      e.heaterOn = false;
      this.emit(events, "heater_off", `indoor ${e.indoorTemp}°C`);
    }

    // Indoor temperature drifts toward a target set by outdoors, sun through the window and heater.
    const target =
      e.outdoorTemp + 4 + (e.curtainOpen ? e.sunIntensity * 3 : 0) + (e.heaterOn ? 5 : 0) + (e.doorOpen ? -2 : 0);
    e.indoorTemp = pin.indoorTemp ?? round2(e.indoorTemp + (target - e.indoorTemp) * 0.01);

    // The charger's hum is simply on, unless someone has switched it off.
    if (pin.beaconOn === undefined) e.beaconOn = true;

    this.stepRooms(tod, weekend, events);

    // Occasional ambient noise from outside (for the hearing sensor later).
    if (this.rng.chance(1 / 600)) this.emit(events, "noise", this.rng.pick(["footsteps", "car", "voices", "knock"]));
  }

  // ---- rooms and doors ----
  private _ac?: Acoustics;
  get acoustics(): Acoustics { return (this._ac ??= new Acoustics(this.layout)); }

  get primaryRoom(): string { return this.layout.rooms[0].id; }

  /** Lamp, heater, curtain and temperature of one room. */
  roomEnv(roomId: string): RoomEnv {
    if (roomId === this.primaryRoom) { const e = this.snap.env; return { indoorTemp: e.indoorTemp, heaterOn: e.heaterOn, lampOn: e.lampOn, curtainOpen: e.curtainOpen }; }
    return this.snap.rooms![roomId] ?? this.roomEnv(this.primaryRoom);
  }

  roomIdAt(x: number, y: number): string { return roomAt(this.layout, x, y)?.id ?? this.primaryRoom; }

  /** Pin one room's value (or release it with null). The first room's pins are the world's own pins. */
  setRoomOverride(roomId: string, field: string, value: unknown | null) {
    if (!this.layout.rooms.some((r) => r.id === roomId)) throw new Error(`unknown room "${roomId}"`);
    if (!(ROOM_FIELDS as readonly string[]).includes(field)) throw new Error(`"${field}" is not something a single room has`);
    if (roomId === this.primaryRoom) return this.setOverride(field, value);
    const f = field as RoomField;
    const room = this.snap.rooms![roomId] as unknown as Record<string, unknown>;
    const pins = (this.snap.roomOverrides![roomId] ??= {}) as Record<string, unknown>;
    const from = room[f];
    if (value === null || value === "auto") { delete pins[f]; return { field: f, from, to: from, mode: "auto" as const }; }
    const v = parseOverride(f, value);
    pins[f] = v;
    room[f] = v;
    return { field: f, from, to: v, mode: "pin" as const };
  }

  isDoorOpen(id: string): boolean { return !!this.snap.doors![id]?.open; }
  isLocked(id: string): boolean { return this.snap.locked!.includes(id); }
  /** Doors that are closed right now: bodies and sight cannot pass them. */
  shutDoors(): string[] { return this.layout.doors.filter((d) => !this.isDoorOpen(d.id)).map((d) => d.id); }

  /** Someone opens a door. It stays open for `holdSec`, then closes by itself once nobody is in the way. */
  openDoor(id: string, nowSec: number, holdSec = 120): "opened" | "already" | "locked" | "unknown" {
    if (!this.layout.doorRects[id]) return "unknown";
    if (this.isLocked(id)) return "locked";
    const d = (this.snap.doors![id] ??= { open: false, closeAtSec: 0 });
    const was = d.open;
    d.open = true;
    d.closeAtSec = Math.max(d.closeAtSec, nowSec + holdSec);
    return was ? "already" : "opened";
  }

  closeDoor(id: string): void { const d = this.snap.doors![id]; if (d) d.open = false; }

  setLocked(id: string, locked: boolean): void {
    if (!this.layout.doorRects[id]) throw new Error(`unknown door "${id}"`);
    const set = new Set(this.snap.locked);
    if (locked) { set.add(id); this.closeDoor(id); } else set.delete(id);
    this.snap.locked = [...set];
  }

  /** Doors whose time is up close, unless a body is standing in the doorway. `inDoorway` says whether one is. */
  tickDoors(nowSec: number, inDoorway: (id: string) => boolean): string[] {
    const closed: string[] = [];
    for (const [id, d] of Object.entries(this.snap.doors!)) {
      if (d.open && nowSec >= d.closeAtSec) {
        if (inDoorway(id)) d.closeAtSec = nowSec + 10;
        else { d.open = false; closed.push(id); }
      }
    }
    return closed;
  }

  /** The other rooms follow the same weather and the same kind of day, with their own temperature, lamp, heater and curtain. */
  private stepRooms(tod: number, weekend: boolean, events: WorldEvent[]) {
    const s = this.snap, e = s.env;
    const rooms = this.layout.rooms;
    const exteriorRoom = this.layout.objects.find((o) => o.kind === "door")?.room ?? rooms[0].id;
    for (let i = 1; i < rooms.length; i++) {
      const id = rooms[i].id, r = s.rooms![id], pin = s.roomOverrides![id] ?? {};
      const hasWindow = this.layout.objects.some((o) => o.room === id && o.kind === "window");
      // Curtain: opens a little later in each room.
      const openAt = (weekend ? 540 : 420) + 20 * i, closeAt = (weekend ? 1200 : 1140) - 10 * i;
      if (pin.curtainOpen === undefined) {
        const want = hasWindow && tod >= openAt && tod < closeAt;
        if (want !== r.curtainOpen) { r.curtainOpen = want; this.emit(events, want ? "curtain_opened" : "curtain_closed", id); }
      }
      // Lamp: the evening, shifted so the rooms are not all switched at once.
      if (pin.lampOn === undefined) {
        const want = tod >= 1110 + 20 * i && tod < 1380 - 15 * i;
        if (want !== r.lampOn) { r.lampOn = want; this.emit(events, want ? "lamp_on" : "lamp_off", id); }
      }
      // Heater: the same thermostat, on this room's temperature.
      const awake = tod >= 360 && tod < 1380;
      if (pin.heaterOn === undefined) {
        if (!r.heaterOn && awake && r.indoorTemp < 19) { r.heaterOn = true; this.emit(events, "heater_on", `${id} ${r.indoorTemp}°C`); }
        else if (r.heaterOn && (!awake || r.indoorTemp > 21)) { r.heaterOn = false; this.emit(events, "heater_off", `${id} ${r.indoorTemp}°C`); }
      }
      // Temperature: toward what outdoors, sun through its window and its heater would make it, and a little toward whatever room an open door joins it to.
      let target = e.outdoorTemp + 4 + (r.curtainOpen ? e.sunIntensity * 3 : 0) + (r.heaterOn ? 5 : 0) + (id === exteriorRoom && e.doorOpen ? -2 : 0);
      for (const d of this.layout.doors) {
        if (!this.isDoorOpen(d.id) || (d.a !== id && d.b !== id)) continue;
        target += (this.roomEnv(d.a === id ? d.b : d.a).indoorTemp - r.indoorTemp) * 0.5;
      }
      if (pin.indoorTemp === undefined) r.indoorTemp = round2(r.indoorTemp + (target - r.indoorTemp) * 0.01);
    }
  }

  /** Light level (0..100) at a point: daylight through its room's window, a moving sun patch on the floor, and its room's lamp. */
  lightAt(x: number, y: number): number {
    const e = this.snap.env;
    const room = this.roomIdAt(x, y);
    const re = this.roomEnv(room);
    const windows = this.layout.objects.filter((o) => o.room === room && o.kind === "window");
    let light = 2 + (windows.length ? 18 * e.sunIntensity * (re.curtainOpen ? 1 : 0.1) : 0);
    if (windows.length && re.curtainOpen && e.sunIntensity > 0) {
      const p = this.sunPatch(room);
      if (Math.hypot(x - p.x, y - p.y) < p.r) light += 70 * e.sunIntensity;
    }
    if (re.lampOn) {
      for (const lamp of this.layout.objects.filter((o) => o.room === room && o.kind === "lamp")) {
        light += Math.max(0, 1 - Math.hypot(x - lamp.x, y - lamp.y) / 260) * 55;
      }
    }
    return Math.min(100, Math.round(light));
  }

  /** Sun patch on a room's floor; it slides across as the day goes on, in from that room's window. */
  sunPatch(roomId: string = this.primaryRoom): { x: number; y: number; r: number } {
    const tod = this.snap.simMinute % DAY;
    const f = Math.max(-1, Math.min(1, (tod - 720) / 360));
    const room = this.layout.rooms.find((r) => r.id === roomId) ?? this.layout.rooms[0];
    const win = this.layout.objects.find((o) => o.room === room.id && o.kind === "window");
    const wx = win ? win.x + win.w / 2 - room.x : 750; // how far along its wall the window is
    const depth = 150 + (1 - Math.sin((Math.PI * Math.max(0, tod - 360)) / 720)) * 150; // how far in from the window's wall
    const fromBottom = !!win && win.y > room.y + room.h / 2;
    return { x: room.x + wx + 30 - f * 200, y: fromBottom ? room.y + room.h - depth : room.y + depth, r: 110 };
  }
}
