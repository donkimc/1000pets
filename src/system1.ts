// System 1: fast, rule-based decisions made every tick from sensors and drives only.
// No model calls. Every decision carries a human-readable reason so behaviour is explainable.
import { clamp, normAngle } from "./geometry.js";
import type { PetState } from "./pet.js";
import { Rng } from "./rng.js";
import type { Observation } from "./sensors.js";

export type Action =
  | "dormant" | "avoid" | "sleep" | "charge" | "seek_light"
  | "approach_pet" | "socialize" | "approach_object" | "inspect" | "wander" | "pause";

export interface Decision {
  action: Action;
  reason: string;
  forward: number; // 0..1 fraction of walking speed
  turn: number; // radians to rotate this tick
}

const MAX_TURN = 1.5;

const stay = (action: Action, reason: string): Decision => ({ action, reason, forward: 0, turn: 0 });

export function isNight(timeOfDay: number): boolean {
  return timeOfDay < 360 || timeOfDay >= 1320;
}

export function decide(p: PetState, obs: Observation, rng: Rng, nowSec: number): Decision {
  const s1 = p.s1;
  const d = p.drives;
  const t = p.traits;
  const prevLight = s1.prevLight;
  s1.prevLight = obs.light;

  // 0. Out of energy: nothing but a slow trickle of recovery.
  if (p.mode === "dormant") return stay("dormant", "battery empty, powered down");

  // 1. Sleep keeps going until rested (or morning and mostly rested).
  const night = isNight(obs.timeOfDay);
  const wantSleep = d.rest > 0.85 || (night && d.rest > 0.35);
  if (p.mode === "sleeping") {
    if (d.rest < 0.05 || (!night && d.rest < 0.25)) return { action: "wander", reason: "rested, waking up", forward: 0.3, turn: 0 };
    return stay("sleep", "resting");
  }

  // 2. Hold a chosen stationary behaviour (inspecting, socialising, pausing) until its timer ends.
  if (nowSec < s1.holdUntil) return stay(s1.holdAction as Action, "staying with it a little longer");

  // 3. Reflex: do not walk into things.
  const clearance = 30 + 30 * t.caution;
  if (obs.proximity.front < clearance) {
    const dir = obs.proximity.left > obs.proximity.right ? -1 : 1;
    return { action: "avoid", reason: `obstacle ${Math.round(obs.proximity.front)} ahead`, forward: obs.proximity.front < 22 ? 0 : 0.3, turn: dir * (0.9 + rng.next() * 0.6) };
  }

  const needEnergy = 1 - obs.energy / 100;

  // 4. Sleepy, and the battery is not critical.
  if (wantSleep && needEnergy < 0.7) return stay("sleep", night ? "night and tired" : "very tired");

  // 5. Low battery: stay where charge comes in, otherwise move toward brighter light.
  if (needEnergy > 0.55) {
    if (obs.chargeRate > 0.05 && needEnergy > 0.2) return stay("charge", `charging at ${obs.chargeRate.toFixed(2)}%/min`);
    const worse = obs.light < prevLight - 1 || rng.chance(0.03);
    if (worse) return { action: "seek_light", reason: "light is dropping, trying another direction", forward: 0.6, turn: (rng.next() < 0.5 ? -1 : 1) * (1.2 + rng.next() * 1.4) };
    return { action: "seek_light", reason: "battery low, following the light", forward: 1, turn: 0 };
  }

  // 6. Lonely: head for another pet, then stay near it for a while.
  const pet = obs.vision.find((v) => v.category === "moving");
  if (d.social > 0.55 && pet) {
    if (pet.distance > 75) return { action: "approach_pet", reason: `social need ${d.social.toFixed(2)}, another pet ahead`, forward: 0.7, turn: clamp(pet.bearing, -MAX_TURN, MAX_TURN) };
    s1.holdUntil = nowSec + 60 + 240 * t.patience;
    s1.holdAction = "socialize";
    return stay("socialize", "staying close to another pet");
  }

  // 7. Curious: go and look at something unfamiliar-looking, then lose interest for a while.
  const thing = obs.vision.find((v) => v.category === "static" && v.size < 200);
  if (d.curiosity > 0.5 && thing && nowSec >= s1.inspectCooldownUntil) {
    if (thing.distance > 95) return { action: "approach_object", reason: `curiosity ${d.curiosity.toFixed(2)}, something to look at`, forward: 0.8 - 0.4 * t.caution, turn: clamp(thing.bearing, -MAX_TURN, MAX_TURN) };
    s1.holdUntil = nowSec + 15 + 45 * t.patience;
    s1.holdAction = "inspect";
    s1.inspectCooldownUntil = s1.holdUntil + 600;
    return stay("inspect", "looking closely at an object");
  }

  // 8. Default: wander, with the occasional pause.
  if (rng.chance(0.01)) {
    s1.holdUntil = nowSec + 5 + rng.next() * 20;
    s1.holdAction = "pause";
    return stay("pause", "stopping for a moment");
  }
  return { action: "wander", reason: "nothing pressing, wandering", forward: 0.6, turn: (rng.next() - 0.5) * 0.5 };
}

/** Evolve drive levels over dt simulated seconds. Rates are per-hour fractions scaled by traits. */
export function updateDrives(p: PetState, obs: Observation, dt: number, nowSec: number): void {
  const d = p.drives;
  const h = dt / 3600;
  const sleeping = p.mode === "sleeping";
  d.energy = clamp(1 - p.energy / 100, 0, 1);
  d.rest = clamp(d.rest + (sleeping ? -h / 7 : (h / 16) * (p.speed > 1 ? 1.3 : 1)), 0, 1);

  const exploring = p.s1.action === "inspect" || p.s1.action === "approach_object";
  d.curiosity = clamp(d.curiosity + (exploring ? -h / 1.5 : (h / 3) * (0.5 + p.traits.curiosity)), 0, 1);

  const nearPet = obs.vision.some((v) => v.category === "moving" && v.distance < 90) || obs.touch === "pet";
  if (nearPet) p.lastPetSeenSec = nowSec;
  d.social = clamp(d.social + (nearPet ? -h * 2 : (h / 4) * (0.5 + p.traits.social)), 0, 1);
}

void normAngle;
