// System 1: fast, rule-based decisions made every tick from sensors and drives only.
// No model calls. Every decision carries a human-readable reason so behaviour is explainable.
import { clamp, normAngle } from "./geometry.js";
import type { PetState } from "./pet.js";
import { Rng } from "./rng.js";
import type { Observation } from "./sensors.js";
import { cueFor, cueTrust, novelty, startGoal } from "./cues.js";
import { pickCompany } from "./relations.js";
import { placeSteer } from "./places.js";
import { ruleValue, type KnobName } from "./rules.js";

export type Action =
  | "dormant" | "avoid" | "sleep" | "charge" | "seek_light"
  | "approach_pet" | "socialize" | "approach_object" | "inspect" | "follow_tone" | "wander" | "pause" | "explore_door" | "open_door" | "go_to_place";

export interface Decision {
  action: Action;
  reason: string;
  forward: number; // 0..1 fraction of walking speed
  turn: number; // radians to rotate this tick
}

const MAX_TURN = 1.5;
const TONE_STOP = 0.96; // on top of the source: nothing more to follow

const NO_PROGRESS_SEC = 240; // following a tone without getting any louder for this long means something is in the way
const GIVE_UP_SEC = 180; // explore on its own for this long before trying the tone again
const DETOUR_SEC = 14; // after turning away from an obstacle while following, keep going straight this long

/** Steer toward a tone. Steering straight at it is not enough: furniture can be in the way, so a recent obstacle makes the pet carry on round it first. */
function followTone(p: PetState, nowSec: number, bearing: number, reason: string, forward: number): Decision {
  p.s1.followedAt = nowSec;
  if (nowSec < (p.s1.detourUntil ?? 0)) return { action: "follow_tone", reason: "going round something in the way to the tone", forward: 0.7, turn: 0 };
  return { action: "follow_tone", reason, forward, turn: clamp(bearing, -MAX_TURN, MAX_TURN) };
}

/** True while a pet that has been following a tone without getting anywhere is exploring instead. */
function givingUp(p: PetState, nowSec: number): boolean {
  const g = p.cueState?.goal;
  if (g && nowSec - g.lastProgressSec > NO_PROGRESS_SEC) {
    p.s1.giveUpUntil = nowSec + GIVE_UP_SEC;
    p.cueState!.goal = null;
  }
  return nowSec < (p.s1.giveUpUntil ?? 0);
}

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

  // System 2 may suggest something; System 1 treats it as a nudge on the matching drive, never an order.
  const sug = p.mind.suggestion && nowSec < p.mind.suggestion.untilSec ? p.mind.suggestion.kind : "none";
  const boost = (kind: string) => (sug === kind ? 0.3 : 0);
  const tag = (kind: string) => (sug === kind ? " (System 2 suggested it)" : "");
  // The soft thresholds are habits the pet may have tuned (see rules.ts); the reflexes below never are.
  const rv = (k: KnobName) => ruleValue(p, nowSec, k);

  // 0. Out of energy: nothing but a slow trickle of recovery.
  if (p.mode === "dormant") return stay("dormant", "battery empty, powered down");

  // 1. Sleep keeps going until rested (or morning and mostly rested).
  const night = isNight(obs.timeOfDay);
  const wantSleep = d.rest + boost("rest") > rv("sleepRest") || (night && d.rest + boost("rest") > rv("sleepRestNight"));
  if (p.mode === "sleeping") {
    if (d.rest < 0.05 || (!night && d.rest < 0.25)) return { action: "wander", reason: "rested, waking up", forward: 0.3, turn: 0 };
    return stay("sleep", "resting");
  }

  // 2. Hold a chosen stationary behaviour (inspecting, socialising, pausing) until its timer ends.
  if (nowSec < s1.holdUntil) return stay(s1.holdAction as Action, "staying with it a little longer");

  // 2b. A doorway the pet is heading through on purpose (after a tone, or out of curiosity). A shut door is pushed open instead of avoided.
  const door = obs.vision.find((v) => v.door && Math.abs(v.bearing) < (v.distance < 70 ? 1 : 0.5) && v.distance < 110); // up close a doorway is seen off to one side
  let heading = nowSec - (s1.followedAt ?? -1e9) < 15 || nowSec < (s1.doorGoalUntil ?? 0);
  // A pet that finds itself walking up to a shut door usually pushes it open rather than turning away, curious ones more often.
  if (door && !heading && door.door === "shut" && Math.abs(door.bearing) < (door.distance < 70 ? 0.9 : 0.35) && door.distance < 80 && rng.chance(0.6 + 0.35 * t.curiosity - 0.3 * t.caution)) { s1.doorGoalUntil = nowSec + 30; heading = true; }
  if (door && heading) {
    if (door.door === "shut") {
      if (door.distance > 42) return { action: "explore_door", reason: "heading for a shut door", forward: 0.5, turn: clamp(door.bearing, -MAX_TURN, MAX_TURN) };
      return { action: "open_door", reason: "pushing the shut door open", forward: 0, turn: clamp(door.bearing, -0.3, 0.3) };
    }
    if (door.distance < 70) s1.passUntil = nowSec + 20;
  }

  // 3. Reflex: do not walk into things.
  const clearance = 30 + 30 * t.caution;
  if (obs.proximity.front < clearance) {
    if (nowSec - (s1.followedAt ?? -1e9) < 15) s1.detourUntil = nowSec + DETOUR_SEC; // was heading for a tone: go round, do not turn straight back
    const dir = obs.proximity.left > obs.proximity.right ? -1 : 1;
    return { action: "avoid", reason: `obstacle ${Math.round(obs.proximity.front)} ahead`, forward: obs.proximity.front < 22 ? 0 : 0.3, turn: dir * (0.9 + rng.next() * 0.6) };
  }

  // Through a doorway: carry straight on, whatever the pet was steering toward, until it is well past.
  if (nowSec < (s1.passUntil ?? 0)) return { action: "explore_door", reason: "going through the doorway", forward: 0.8, turn: 0 };

  const needEnergy = 1 - obs.energy / 100;

  // 4. Sleepy, and the battery is not critical.
  if (wantSleep && needEnergy < 0.7) return stay("sleep", night ? "night and tired" : "very tired");

  // 5. Low battery: stay where charge comes in, otherwise move toward brighter light.
  if (needEnergy + boost("seek_light") > rv("batteryLow")) {
    if (obs.chargeRate > 0.05 && needEnergy > 0.2) return stay("charge", `charging at ${obs.chargeRate.toFixed(2)}%/min`);
    // A tone the pet has learned leads to charge: follow it. A hunch is followed by bolder pets, or when System 2 urges it.
    if (obs.tone && obs.tone.volume < TONE_STOP && !givingUp(p, nowSec)) {
      const trust = cueTrust(cueFor(p, obs.tone));
      if (trust.trusted || (trust.tentative && (t.caution < 0.7 || boost("follow_tone") > 0)) || boost("follow_tone") > 0) {
        startGoal(p, obs.tone, nowSec);
        return followTone(p, nowSec, obs.tone.bearing, trust.trusted ? `battery low and this tone has led me to charge before` : trust.tentative ? `battery low and I suspect this tone leads to charge` : `battery low and System 2 thinks the tone may help`, 0.9);
      }
    }
    // No hum to follow: use its own map. It remembers where it has charged, and walks there through the doorways it knows.
    const way = placeSteer(p, nowSec);
    if (way) {
      p.s1.followedAt = nowSec; // so that being turned away by an obstacle makes it go round, as when following a tone
      if (way.toDoor && way.distance < 140) s1.doorGoalUntil = nowSec + 30; // a shut door on the way gets pushed open
      if (nowSec < (s1.detourUntil ?? 0)) return { action: "go_to_place", reason: "going round something in the way to a place I remember", forward: 0.7, turn: 0 };
      return { action: "go_to_place", reason: way.reason, forward: Math.abs(way.bearing) > 1.2 ? 0.3 : 0.85, turn: clamp(way.bearing, -MAX_TURN, MAX_TURN) };
    }
    const worse = obs.light < prevLight - 1 || rng.chance(0.03);
    if (worse) return { action: "seek_light", reason: "light is dropping, trying another direction", forward: 0.6, turn: (rng.next() < 0.5 ? -1 : 1) * (1.2 + rng.next() * 1.4) };
    return { action: "seek_light", reason: "battery low, following the light" + tag("seek_light"), forward: 1, turn: 0 };
  }

  // 6. Lonely: head for another pet, then stay near it for a while.
  const pet = pickCompany(p, obs.vision, nowSec); // better company is worth a longer walk
  if (d.social + boost("find_pet") > rv("socialAt") && pet) {
    if (pet.distance > 75) return { action: "approach_pet", reason: `social need ${d.social.toFixed(2)}, another pet ahead` + tag("find_pet"), forward: 0.7, turn: clamp(pet.bearing, -MAX_TURN, MAX_TURN) };
    s1.holdUntil = nowSec + 60 + 240 * t.patience;
    s1.holdAction = "socialize";
    return stay("socialize", "staying close to another pet");
  }

  // 6b. An unfamiliar steady tone: curiosity pulls toward it, caution holds back, and getting used to it fades the pull.
  if (obs.tone && obs.tone.volume < TONE_STOP && !givingUp(p, nowSec)) {
    const nov = novelty(cueFor(p, obs.tone));
    const pull = d.curiosity * 0.7 + nov * 0.5 + boost("follow_tone") - t.caution * 0.5;
    if (nov > 0.3 && pull > rv("noveltyPull")) {
      startGoal(p, obs.tone, nowSec);
      return followTone(p, nowSec, obs.tone.bearing, `an unfamiliar steady tone, curious about it (novelty ${nov.toFixed(2)})` + tag("follow_tone"), 0.6);
    }
  }

  // 7. Curious: go and look at something unfamiliar-looking, then lose interest for a while.
  const thing = obs.vision.find((v) => v.category === "static" && v.size < 200 && !v.door);
  if (d.curiosity + boost("inspect_object") > rv("curiousAt") && thing && nowSec >= s1.inspectCooldownUntil) {
    if (thing.distance > 95) return { action: "approach_object", reason: `curiosity ${d.curiosity.toFixed(2)}, something to look at` + tag("inspect_object"), forward: 0.8 - 0.4 * t.caution, turn: clamp(thing.bearing, -MAX_TURN, MAX_TURN) };
    s1.holdUntil = nowSec + 15 + 45 * t.patience;
    s1.holdAction = "inspect";
    s1.inspectCooldownUntil = s1.holdUntil + rv("inspectCooldown");
    return stay("inspect", "looking closely at an object");
  }

  // 7b. Curious about a doorway: go and see what is on the other side. Once in a while, not all the time.
  const doorSeen = obs.vision.find((v) => v.door);
  const goalOn = nowSec < (s1.doorGoalUntil ?? 0);
  if (doorSeen && (goalOn || (d.curiosity > rv("curiousAt") && nowSec >= (s1.doorCooldownUntil ?? 0) && t.caution < 0.9))) {
    if (!goalOn) { s1.doorGoalUntil = nowSec + 120; s1.doorCooldownUntil = nowSec + 1200 - 600 * t.curiosity; }
    return { action: "explore_door", reason: `curious about the ${doorSeen.door} doorway`, forward: 0.7 - 0.3 * t.caution, turn: clamp(doorSeen.bearing, -MAX_TURN, MAX_TURN) };
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
