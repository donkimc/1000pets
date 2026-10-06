// Simulation: advances the world and every pet in fixed 5-second chunks of simulated time,
// so results do not depend on tick rate or clock speed.
import { clamp, normAngle } from "./geometry.js";
import { HUMAN_RADIUS, PET_PALETTE, PET_RADIUS, TEACHER_RADIUS, newMind, newStats, spawnPet, type HumanState, type PetDef, type PetState } from "./pet.js";
import { Rng } from "./rng.js";
import { sense, type NearThing, type Observation, type Sound } from "./sensors.js";
import { decide, updateDrives, type Decision } from "./system1.js";
import { captureSurpriseScene, updateOdometry, watchScenes } from "./scenes.js";
import { takePeak, updatePredictions, type Surprise } from "./predict.js";
import { tickRules, type RuleEvent } from "./rules.js";
import { describeTone, toneKey, updateCues } from "./cues.js";
import { sleepTick, type SleepSummary } from "./sleep.js";
import { addDream, makeDream, type Dream } from "./dreams.js";
import { cleanBeliefs } from "./system2.js";
import { OBJECTS, ROOM, SOLIDS, centerOf, circleHitsShape, type World, type WorldEvent } from "./world.js";

const nearSide = (b: number) => (Math.abs(b) < 0.6 ? "in front of me" : Math.abs(b) > 2.5 ? "behind me" : b > 0 ? "on my right" : "on my left");
/** How a pet perceives something within reach: what kind of thing, how close, and on which side. */
export function describeNear(n: NearThing): string {
  const how = n.gap < 8 ? "touching me" : n.gap < 40 ? "very close" : "close";
  return `${n.category === "moving" ? "a moving thing" : "a still object"} ${how}, ${nearSide(n.bearing)}`;
}

export const DT = 5; // simulated seconds per chunk
export const WALK_SPEED = 30; // units per simulated second at full speed
export const TEACHER_SPEED = 38; // units per simulated second
export const HUMAN_SPEED = 90; // units per real second; the human moves in real time, not simulated time

export interface SimSnapshot { simSec: number; pets: PetState[]; human?: HumanState; teacher?: HumanState; ruleLearning?: boolean }

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

/** A night's consolidation, recorded in the pet's thought log next to its other thoughts. */
export interface SleepThought { system: 3; stage: "sleep"; pet: string; tSec: number; day: number; hour: number; minute: number; summary: SleepSummary }

/** A habit trial starting, or being kept, undone or aborted, recorded in the pet's thought log. */
export interface HabitThought { system: 3; stage: "habit"; pet: string; tSec: number; day: number; hour: number; minute: number; event: RuleEvent }

/** A dream, recorded in the pet's thought log. It is tagged as a dream and never mixed into what the pet believes happened. */
export interface DreamThought { system: 3; stage: "dream"; pet: string; tSec: number; day: number; hour: number; minute: number; dream: Pick<Dream, "id" | "theme" | "narrative" | "worry" | "twists" | "kinds"> }

/** Something the pet expected did not happen, recorded in its thought log. */
export interface SurpriseThought { system: 3; stage: "surprise"; pet: string; tSec: number; day: number; hour: number; minute: number; surprise: Surprise }

export interface StepResult { events: WorldEvent[]; thoughts: (Thought | SleepThought | DreamThought | SurpriseThought | HabitThought)[] }

const SOUND_SOURCES: Record<string, string> = { footsteps: "door", knock: "door", car: "window", voices: "window" };
// Pitches (Hz) sit on semitone-bin centres, so each kind of noise stays in its own bin; the beacon's is 534 Hz.
const SOUND_PITCH: Record<string, number> = { car: 100, footsteps: 126, knock: 178, voices: 252 };

export class Simulation {
  simSec: number;
  pets: PetState[];
  human: HumanState;
  teacher: HumanState; // the AI teacher's body; it walks wherever its plan says, whatever the environment
  teacherGoal: { x: number; y: number } | null = null;
  ruleLearning = false; // may pets try tuning their own habits? Off unless switched on (and saved with the simulation)
  private sounds: Sound[] = [];

  constructor(readonly world: World, private seed: number, roster: PetDef[], snap?: SimSnapshot) {
    this.simSec = snap?.simSec ?? world.snap.simMinute * 60;
    this.pets = snap?.pets ? structuredClone(snap.pets) : roster.map((def, i) => spawnPet(def, seed, i));
    for (const p of this.pets) {
      p.mind ??= newMind(); // saves from before System 2 had no mind
      p.mind.claims ??= [];
      p.mind.scenes ??= []; // saves from before scene memory
      p.mind.cues ??= {}; // ... and before tone learning
      p.mind.gists ??= []; // ... and before sleep consolidation
      p.mind.gistDue ??= false;
      p.mind.lastSleep ??= null;
      p.mind.dreams ??= []; // ... and before dreams
      p.mind.recentQuestions ??= []; // ... and before anti-repetition
      p.mind.refuted ??= []; // ... and before verification
      p.mind.recentThoughts ??= [];
      p.mind.repeatStreak ??= 0;
      cleanBeliefs(p.mind); // old saves hold beliefs with a copied "(0.98)" on the end
      for (const c of Object.values(p.mind.cues)) c.lastSupportSec ??= -1e9;
      p.mind.sensed.tone ??= "";
      p.odo ??= { x: 0, y: 0 };
      p.mind.sensed.near ??= []; // saves from before the near-field sense
      p.stats ??= newStats();
      // The config file is the source of truth for names, colours and traits of the default pets.
      const def = roster.find((d) => d.id === p.id);
      if (def && !p.brainTraits) Object.assign(p, { name: def.name, color: def.color, traits: def.traits });
    }
    this.human = snap?.human ? structuredClone(snap.human) : { x: 820, y: 620, heading: -Math.PI / 2, moving: false };
    this.ruleLearning = snap?.ruleLearning ?? false;
    this.teacher = snap?.teacher ? structuredClone(snap.teacher) : { x: 480, y: 600, heading: -Math.PI / 2, moving: false };
  }

  /** Compact picture of every pet and the environment, logged every 15 simulated minutes for the dashboard charts.
   *  `surprise` is the biggest surprise since the last sample (sampling a running average would miss short spikes), so reading it resets it. */
  metrics() {
    const m = Math.floor(this.simSec / 60);
    const env = this.world.env;
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      simMinute: m, day: Math.floor(m / 1440) + 1, hour: Math.floor((m % 1440) / 60), minute: m % 60,
      pets: this.pets.map((p) => ({ id: p.id, surprise: takePeak(p), energy: r(p.energy), curiosity: r(p.drives.curiosity), social: r(p.drives.social), rest: r(p.drives.rest), mode: p.mode })),
      env: { indoorTemp: env.indoorTemp, outdoorTemp: env.outdoorTemp, sun: env.sunIntensity, weather: env.weather },
      cum: this.pets.reduce((a, p) => ({ s1: a.s1 + p.stats.s1Thoughts, s2: a.s2 + p.stats.s2Thoughts, spoke: a.spoke + p.stats.spoke }), { s1: 0, s2: 0, spoke: 0 }),
    };
  }

  snapshot(): SimSnapshot {
    return { simSec: this.simSec, pets: this.pets, human: this.human, teacher: this.teacher, ruleLearning: this.ruleLearning };
  }

  addPet(def: PetDef): PetState {
    if (this.pets.some((p) => p.id === def.id)) throw new Error(`pet ${def.id} already exists`);
    const pet = spawnPet({ ...def, color: def.color || PET_PALETTE[this.pets.length % PET_PALETTE.length] }, this.seed, this.pets.length);
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
    if (Math.hypot(x - this.teacher.x, y - this.teacher.y) < TEACHER_RADIUS + HUMAN_RADIUS) return true;
    return this.pets.some((p) => Math.hypot(x - p.x, y - p.y) < PET_RADIUS + HUMAN_RADIUS);
  }

  private teacherBlocked(x: number, y: number): boolean {
    if (x < TEACHER_RADIUS || y < TEACHER_RADIUS || x > ROOM.width - TEACHER_RADIUS || y > ROOM.height - TEACHER_RADIUS) return true;
    if (SOLIDS.some((s) => circleHitsShape(x, y, TEACHER_RADIUS, s))) return true;
    if (Math.hypot(x - this.human.x, y - this.human.y) < TEACHER_RADIUS + HUMAN_RADIUS) return true;
    return this.pets.some((p) => Math.hypot(x - p.x, y - p.y) < PET_RADIUS + TEACHER_RADIUS);
  }

  /** Walk the teacher toward its goal for dt simulated seconds, sliding along obstacles. Returns true once it has arrived. */
  private moveTeacher(dt: number): boolean {
    const t = this.teacher;
    const g = this.teacherGoal;
    t.moving = false;
    if (!g) return true;
    const dx = g.x - t.x, dy = g.y - t.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 12) return true;
    const step = Math.min(dist, TEACHER_SPEED * dt);
    const mx = (dx / dist) * step, my = (dy / dist) * step;
    const ok = (nx: number, ny: number) => !this.teacherBlocked(nx, ny);
    let moved = false;
    if (ok(t.x + mx, t.y + my)) { t.x += mx; t.y += my; moved = true; }
    else {
      if (ok(t.x + mx, t.y)) { t.x += mx; moved = true; }
      if (ok(t.x, t.y + my)) { t.y += my; moved = true; }
    }
    if (moved) { t.moving = true; t.heading = Math.atan2(dy, dx); }
    return false;
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
      this.moveTeacher(DT);
      for (const p of this.pets) this.tickPet(p, result);
    }
    this.sounds = this.sounds.filter((s) => this.simSec - s.tSec <= 240);
    return result;
  }

  private recordSound(ev: WorldEvent) {
    if (ev.type !== "noise") return;
    const src = OBJECTS.find((o) => o.id === (SOUND_SOURCES[ev.detail] ?? "window"))!;
    const c = centerOf(src);
    this.sounds.push({ tSec: this.simSec, x: c.x, y: c.y, volume: 0.7, pitch: SOUND_PITCH[ev.detail] ?? 150 });
  }

  private tickPet(p: PetState, out: StepResult) {
    const rng = new Rng(p.rngState);
    const obs = sense(p, this.pets, this.world, this.sounds, this.simSec, rng, this.human, this.teacher);
    updateDrives(p, obs, DT, this.simSec);
    this.noteSensed(p, obs);
    const decision = decide(p, obs, rng, this.simSec);
    this.act(p, decision, obs, out);
    updateOdometry(p, DT, rng);
    const surprises = [...updateCues(p, obs, this.simSec, DT), ...updatePredictions(p, obs, this.simSec)];
    for (const sur of surprises) captureSurpriseScene(p, obs, this.simSec, rng, sur); // a broken expectation is worth remembering
    watchScenes(p, obs, this.simSec, rng);
    for (const sur of surprises.filter((x) => x.score >= 0.5)) {
      const t = Math.floor(this.simSec / 60) % 1440;
      out.thoughts.push({ system: 3, stage: "surprise", pet: p.id, tSec: this.simSec, day: Math.floor(this.simSec / 86400) + 1, hour: Math.floor(t / 60), minute: t % 60, surprise: sur });
    }
    const habit = tickRules(p, this.simSec, DT, this.ruleLearning); // keeps the day-long averages and any habit trial going
    if (habit) {
      const t = Math.floor(this.simSec / 60) % 1440;
      out.thoughts.push({ system: 3, stage: "habit", pet: p.id, tSec: this.simSec, day: Math.floor(this.simSec / 86400) + 1, hour: Math.floor(t / 60), minute: t % 60, event: habit });
    }
    const night = sleepTick(p, this.simSec); // once per sleep, after it has lasted a while
    if (night) {
      const tod = Math.floor(this.simSec / 60) % 1440;
      const stamp = { pet: p.id, tSec: this.simSec, day: Math.floor(this.simSec / 86400) + 1, hour: Math.floor(tod / 60), minute: tod % 60 };
      out.thoughts.push({ system: 3, stage: "sleep", ...stamp, summary: night });
      const dream = makeDream(p, this.simSec); // after the memories have been tidied, the pet dreams from what is left
      if (dream) {
        addDream(p, dream);
        out.thoughts.push({ system: 3, stage: "dream", ...stamp, dream: { id: dream.id, theme: dream.theme, narrative: dream.narrative, worry: dream.worry, twists: dream.twists, kinds: dream.kinds } });
      }
    }
    p.rngState = rng.state;
  }

  private noteSensed(p: PetState, obs: Observation) {
    const side = (b: number) => (Math.abs(b) < 0.25 ? "ahead" : b > 0 ? "to the right" : "to the left");
    const m = p.mind;
    m.sensed = {
      light: obs.light,
      temperature: obs.temperature,
      seen: obs.vision.slice(0, 4).map((v) => `${v.category === "moving" ? "a moving thing" : "a still object"} (${v.size > 100 ? "large" : "small"}) ${side(v.bearing)}, ${Math.round(v.distance)} away`),
      near: obs.near.slice(0, 4).map((n) => describeNear(n)),
      tone: obs.tone ? describeTone(obs.tone, p.mind.cues?.[toneKey(obs.tone)]?.lastVolume) : "",
      heard: obs.hearing ? `a sound ${side(obs.hearing.bearing)}, volume ${obs.hearing.volume}` : "",
      touch: obs.touch ?? "",
    };
    if (obs.hearing && obs.hearing.volume > 0.3) this.note(p, `heard a sound ${side(obs.hearing.bearing)}`);
    if (obs.touch === "human") this.note(p, "touched the human");
    if (obs.touch === "teacher") this.note(p, "touched the Teacher");
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
        // Slide along whatever is in the way instead of pushing into it: try a little to either side.
        let slid = false;
        for (const a of [0.6, -0.6, 1.2, -1.2]) {
          const sx = p.x + Math.cos(p.heading + a) * step, sy = p.y + Math.sin(p.heading + a) * step;
          if (!this.collision(p, sx, sy)) {
            p.x = sx;
            p.y = sy;
            moved += step;
            slid = true;
            break;
          }
        }
        if (!slid) break;
        continue;
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
    p.stats.actionSec[dec.action] = (p.stats.actionSec[dec.action] ?? 0) + DT;

    const tod = obs.timeOfDay;
    if (p.mode !== prevMode && (p.mode === "dormant" || prevMode === "dormant" || p.mode === "sleeping" || prevMode === "sleeping")) {
      const type = p.mode === "dormant" ? "pet_dormant" : prevMode === "dormant" ? "pet_recovered" : p.mode === "sleeping" ? "pet_sleep" : "pet_wake";
      out.events.push({ type, detail: p.name, simMinute: Math.floor(this.simSec / 60), day: Math.floor(this.simSec / 86400) + 1, hour: Math.floor(tod / 60), minute: tod % 60 });
    }

    if (dec.action !== prevAction && !["avoid", "pause"].includes(dec.action)) this.note(p, `${dec.reason} (light ${obs.light}, battery ${Math.round(p.energy)}%)`);

    // Record a thought when the action changes (not more than once every 15 simulated seconds).
    const quiet = ["avoid", "pause", "wander"].includes(dec.action) ? 180 : 15; // reflexes repeat a lot; log them sparingly
    if (dec.action !== prevAction && this.simSec - p.s1.lastThoughtSec >= quiet) {
      p.s1.lastThoughtSec = this.simSec;
      p.stats.s1Thoughts++;
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
    if (Math.hypot(x - this.teacher.x, y - this.teacher.y) < PET_RADIUS + TEACHER_RADIUS) return "teacher";
    return null;
  }
}
