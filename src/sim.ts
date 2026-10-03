// Simulation: advances the world and every pet in fixed 5-second chunks of simulated time,
// so results do not depend on tick rate or clock speed.
import { clamp, normAngle } from "./geometry.js";
import { HUMAN_RADIUS, PET_RADIUS, newMind, spawnPet, type HumanState, type PetDef, type PetState } from "./pet.js";
import { Rng } from "./rng.js";
import { sense, type Observation, type Sound } from "./sensors.js";
import { decide, updateDrives, type Decision } from "./system1.js";
import { OBJECTS, ROOM, SOLIDS, centerOf, circleHitsShape, type World, type WorldEvent } from "./world.js";

export const DT = 5; // simulated seconds per chunk
export const WALK_SPEED = 30; // units per simulated second at full speed
export const HUMAN_SPEED = 90; // units per real second; the human moves in real time, not simulated time

export interface SimSnapshot { simSec: number; pets: PetState[]; human?: HumanState }

export interface Thought {
  system: 1;
  pet: string;
  tSec: number;
  day: number;
  hour: number;
  minute: number;
  action: string;
  reason: string;
  drives: PetState["drives"];
  energy: number;
  light: number;
  seen: { category: string; distance: number; bearing: number }[];
}

export interface StepResult { events: WorldEvent[]; thoughts: Thought[] }

const SOUND_SOURCES: Record<string, string> = { footsteps: "door", knock: "door", car: "window", voices: "window" };

export class Simulation {
  simSec: number;
  pets: PetState[];
  human: HumanState;
  private sounds: Sound[] = [];

  constructor(readonly world: World, private seed: number, roster: PetDef[], snap?: SimSnapshot) {
    this.simSec = snap?.simSec ?? world.snap.simMinute * 60;
    this.pets = snap?.pets ? structuredClone(snap.pets) : roster.map((def, i) => spawnPet(def, seed, i));
    for (const p of this.pets) {
      p.mind ??= newMind(); // saves from before System 2 had no mind
      p.mind.claims ??= [];
    }
    this.human = snap?.human ? structuredClone(snap.human) : { x: 820, y: 620, heading: -Math.PI / 2, moving: false };
  }

  snapshot(): SimSnapshot {
    return { simSec: this.simSec, pets: this.pets, human: this.human };
  }

  addPet(def: PetDef): PetState {
    if (this.pets.some((p) => p.id === def.id)) throw new Error(`pet ${def.id} already exists`);
    const pet = spawnPet(def, this.seed, this.pets.length);
    this.pets.push(pet);
    return pet;
  }

  /** Move the human by a joystick vector (each component -1..1) for dtSec of real time, sliding along obstacles. */
  moveHuman(dx: number, dy: number, dtSec: number): void {
    const len = Math.hypot(dx, dy);
    const h = this.human;
    h.moving = false;
    if (len < 0.05 || !Number.isFinite(len)) return;
    const f = Math.min(1, len) / len;
    const step = HUMAN_SPEED * dtSec;
    const tryMove = (nx: number, ny: number) => {
      if (this.humanBlocked(nx, ny)) return false;
      h.x = nx;
      h.y = ny;
      return true;
    };
    const mx = dx * f * step, my = dy * f * step;
    const movedX = tryMove(h.x + mx, h.y);
    const movedY = tryMove(h.x, h.y + my);
    if (movedX || movedY) {
      h.moving = true;
      h.heading = Math.atan2(dy, dx);
    }
  }

  private humanBlocked(x: number, y: number): boolean {
    if (x < HUMAN_RADIUS || y < HUMAN_RADIUS || x > ROOM.width - HUMAN_RADIUS || y > ROOM.height - HUMAN_RADIUS) return true;
    if (SOLIDS.some((s) => circleHitsShape(x, y, HUMAN_RADIUS, s))) return true;
    return this.pets.some((p) => Math.hypot(x - p.x, y - p.y) < PET_RADIUS + HUMAN_RADIUS);
  }

  step(toSimMs: number, maxChunks = Infinity): StepResult {
    const targetSec = toSimMs / 1000;
    const result: StepResult = { events: [], thoughts: [] };
    let n = 0;
    while (this.simSec + DT <= targetSec && n++ < maxChunks) {
      this.simSec += DT;
      for (const ev of this.world.step(this.simSec * 1000)) {
        result.events.push(ev);
        this.recordSound(ev);
      }
      for (const p of this.pets) this.tickPet(p, result);
    }
    this.sounds = this.sounds.filter((s) => this.simSec - s.tSec <= 240);
    return result;
  }

  private recordSound(ev: WorldEvent) {
    if (ev.type !== "noise") return;
    const src = OBJECTS.find((o) => o.id === (SOUND_SOURCES[ev.detail] ?? "window"))!;
    const c = centerOf(src);
    this.sounds.push({ tSec: this.simSec, x: c.x, y: c.y, volume: 0.7 });
  }

  private tickPet(p: PetState, out: StepResult) {
    const rng = new Rng(p.rngState);
    const obs = sense(p, this.pets, this.world, this.sounds, this.simSec, rng, this.human);
    updateDrives(p, obs, DT, this.simSec);
    this.noteSensed(p, obs);
    const decision = decide(p, obs, rng, this.simSec);
    this.act(p, decision, obs, out);
    p.rngState = rng.state;
  }

  private noteSensed(p: PetState, obs: Observation) {
    const side = (b: number) => (Math.abs(b) < 0.25 ? "ahead" : b > 0 ? "to the right" : "to the left");
    const m = p.mind;
    m.sensed = {
      light: obs.light,
      temperature: obs.temperature,
      seen: obs.vision.slice(0, 4).map((v) => `${v.category === "moving" ? "a moving thing" : "a still object"} (${v.size > 100 ? "large" : "small"}) ${side(v.bearing)}, ${Math.round(v.distance)} away`),
      heard: obs.hearing ? `a sound ${side(obs.hearing.bearing)}, volume ${obs.hearing.volume}` : "",
      touch: obs.touch ?? "",
    };
    if (obs.hearing && obs.hearing.volume > 0.3) this.note(p, `heard a sound ${side(obs.hearing.bearing)}`);
    if (obs.touch === "human") this.note(p, "touched the human");
    if (obs.touch === "pet") this.note(p, "bumped into another pet");
    if (obs.touch === "pad") this.note(p, "stood on the charging pad");
  }

  private note(p: PetState, text: string) {
    const t = Math.floor(this.simSec / 60) % 1440;
    const line = `D${Math.floor(this.simSec / 86400) + 1} ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} ${text}`;
    const eps = p.mind.episodes;
    const strip = (l: string) => l.replace(/^D\d+ \d\d:\d\d /, "");
    if (eps.length && strip(eps[eps.length - 1]) === strip(line)) return; // skip immediate repeats
    eps.push(line);
    if (eps.length > 14) eps.shift();
  }

  private act(p: PetState, dec: Decision, obs: Observation, out: StepResult) {
    const prevMode = p.mode;
    const prevAction = p.s1.action;

    // Turn, then walk in small increments so nothing tunnels through an obstacle.
    const turn = clamp(dec.turn, -1.5, 1.5);
    p.heading = normAngle(p.heading + turn);
    p.turnRate = turn / DT;
    p.bumped = false;
    p.touch = null;
    let moved = 0;
    const dist = WALK_SPEED * clamp(dec.forward, 0, 1) * DT;
    const steps = Math.ceil(dist / 6);
    for (let i = 0; i < steps; i++) {
      const step = dist / steps;
      const nx = p.x + Math.cos(p.heading) * step;
      const ny = p.y + Math.sin(p.heading) * step;
      const hit = this.collision(p, nx, ny);
      if (hit) {
        p.bumped = true;
        p.touch = hit;
        break;
      }
      p.x = nx;
      p.y = ny;
      moved += step;
    }
    p.speed = moved / DT;

    // Charger pad contact is a touch the pet can feel.
    const charger = centerOf(OBJECTS.find((o) => o.kind === "charger")!);
    const onPad = Math.hypot(p.x - charger.x, p.y - charger.y) < 36;
    if (onPad && !p.touch) p.touch = "pad";

    // Mode.
    if (p.energy <= 0) p.mode = "dormant";
    else if (p.mode === "dormant" && p.energy < 10) p.mode = "dormant";
    else if (dec.action === "sleep") p.mode = "sleeping";
    else if (dec.action === "charge") p.mode = "charging";
    else p.mode = moved > 0.1 ? "moving" : "idle";

    // Energy: drain by activity, gain from the charger pad or sunlight patch.
    const drainPerMin = p.mode === "moving" ? 0.12 : p.mode === "sleeping" ? 0.01 : p.mode === "dormant" ? -0.01 : 0.03;
    const patch = this.world.sunPatch();
    const env = this.world.env;
    const inSun = env.curtainOpen && env.sunIntensity > 0 && Math.hypot(p.x - patch.x, p.y - patch.y) < patch.r;
    p.chargeRate = Math.round(((onPad ? 1 : 0) + (inSun ? 0.2 * env.sunIntensity : 0)) * 1000) / 1000;
    p.energy = clamp(p.energy + ((p.chargeRate - drainPerMin) * DT) / 60, 0, 100);

    p.s1.action = dec.action;
    p.s1.lastReason = dec.reason;

    const tod = obs.timeOfDay;
    if (p.mode !== prevMode && (p.mode === "dormant" || prevMode === "dormant" || p.mode === "sleeping" || prevMode === "sleeping")) {
      const type = p.mode === "dormant" ? "pet_dormant" : prevMode === "dormant" ? "pet_recovered" : p.mode === "sleeping" ? "pet_sleep" : "pet_wake";
      out.events.push({ type, detail: p.name, simMinute: Math.floor(this.simSec / 60), day: Math.floor(this.simSec / 86400) + 1, hour: Math.floor(tod / 60), minute: tod % 60 });
    }

    if (dec.action !== prevAction && !["avoid", "pause"].includes(dec.action)) this.note(p, `${dec.reason} (light ${obs.light}, battery ${Math.round(p.energy)}%)`);

    // Record a thought when the action changes (not more than once every 15 simulated seconds).
    if (dec.action !== prevAction && this.simSec - p.s1.lastThoughtSec >= 15) {
      p.s1.lastThoughtSec = this.simSec;
      out.thoughts.push({
        system: 1,
        pet: p.id,
        tSec: this.simSec,
        day: Math.floor(this.simSec / 86400) + 1,
        hour: Math.floor(tod / 60),
        minute: tod % 60,
        action: dec.action,
        reason: dec.reason,
        drives: { ...p.drives },
        energy: Math.round(p.energy),
        light: obs.light,
        seen: obs.vision.slice(0, 3).map((v) => ({ category: v.category, distance: v.distance, bearing: v.bearing })),
      });
    }
  }

  private collision(p: PetState, x: number, y: number): PetState["touch"] {
    if (x < PET_RADIUS || y < PET_RADIUS || x > ROOM.width - PET_RADIUS || y > ROOM.height - PET_RADIUS) return "wall";
    if (SOLIDS.some((s) => circleHitsShape(x, y, PET_RADIUS, s))) return "object";
    if (this.pets.some((o) => o.id !== p.id && Math.hypot(x - o.x, y - o.y) < PET_RADIUS * 2)) return "pet";
    if (Math.hypot(x - this.human.x, y - this.human.y) < PET_RADIUS + HUMAN_RADIUS) return "human";
    return null;
  }
}
