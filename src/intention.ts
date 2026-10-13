// An intention is a concern that holds what the pet does, for hours, when the notes support it.
// Reflexes (empty battery, a wall, deep sleep, being led out) are decided before this is asked.
// INTENTION_DOING=off leaves the old drive ladder in charge.
import { clamp, normAngle } from "./geometry.js";
import type { Doing, PetState } from "./pet.js";
import { DOINGS } from "./pet.js";
import { placeSteer } from "./places.js";
import { pickCompany } from "./relations.js";
import type { Observation } from "./sensors.js";

export const intentionSettings = { on: process.env.INTENTION_DOING !== "off" };

const MAX_SEC = 3 * 3600; // a concern lasts at most this long
const STUCK_SEC = 180; // no progress for this long and the concern is dropped
const BESIDE = 75;
const STAY_FOR = 120;
const WATCH_FOR = 60;
const MAX_TURN = 1.5;

export interface IntentionStep { action: "approach_pet" | "socialize" | "explore_door" | "go_to_place" | "inspect" | "pause"; reason: string; forward: number; turn: number }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length >= 4);

/** A spoken line counts when it shares a real word with the intention. */
export function speechAboutIntention(goal: string, meaning: string): boolean {
  const g = words(goal);
  if (!g.length) return true;
  const m = new Set(words(meaning));
  return g.some((w) => m.has(w));
}

function seen(p: PetState): string {
  return (p.mind.sensed?.seen ?? []).join(" ").toLowerCase();
}
function episodes(p: PetState): string {
  return (p.mind.episodes ?? []).join(" ").toLowerCase();
}
function knowsSomeone(p: PetState): boolean {
  return seen(p).includes("moving") || /pet|creature|another|bumped/.test(episodes(p)) || Object.keys(p.mind.others ?? {}).length > 0;
}
function knowsDoor(p: PetState): boolean {
  return seen(p).includes("door") || /door/.test(episodes(p)) || Object.values(p.places?.nodes ?? {}).some((n) => n.kind === "door");
}
function knowsPad(p: PetState): boolean {
  return Object.values(p.places?.nodes ?? {}).some((n) => n.kind === "pad" && (n.charged > 0 || n.visits > 0));
}
function sawSomething(p: PetState): boolean {
  return (p.mind.sensed?.seen?.length ?? 0) > 0 || (p.predict?.recent?.length ?? 0) > 0;
}

/** The notes have to already contain a reason for this doing. */
export function doingSupported(p: PetState, doing: Doing): boolean {
  if (doing === "stay_with" || doing === "rest_near") return knowsSomeone(p);
  if (doing === "go_to_door") return knowsDoor(p);
  if (doing === "go_to_pad") return knowsPad(p);
  return sawSomething(p);
}

export function isDoing(v: unknown): v is Doing {
  return typeof v === "string" && (DOINGS as readonly string[]).includes(v);
}

function clear(p: PetState): void {
  p.mind.intention = null;
}

function stuck(p: PetState, nowSec: number): boolean {
  const it = p.mind.intention;
  if (!it) return false;
  const since = it.progressSec ?? it.sinceSec;
  return nowSec - since > STUCK_SEC;
}

/** What to do about the current intention, or null to let the old ladder decide (including after the concern ends). */
export function followIntention(p: PetState, obs: Observation, nowSec: number): IntentionStep | null {
  if (!intentionSettings.on) return null;
  const it = p.mind.intention;
  if (!it?.doing) return null;
  if (nowSec - it.sinceSec > MAX_SEC || stuck(p, nowSec)) { clear(p); return null; }
  const goal = it.goal;

  if (it.doing === "stay_with" || it.doing === "rest_near") {
    const who = pickCompany(p, obs.vision, nowSec);
    if (who && who.distance <= BESIDE) {
      it.heldSince ??= nowSec;
      it.progressSec = nowSec;
      if (nowSec - it.heldSince >= STAY_FOR) { clear(p); return null; }
      return { action: it.doing === "rest_near" ? "pause" : "socialize", reason: `${goal}: staying with them`, forward: 0, turn: 0 };
    }
    it.heldSince = undefined;
    if (who) {
      if (it.mark === undefined || who.distance < it.mark - 8) { it.mark = who.distance; it.progressSec = nowSec; }
      return { action: "approach_pet", reason: `${goal}: going to them`, forward: 0.7, turn: clamp(who.bearing, -MAX_TURN, MAX_TURN) };
    }
    return { action: "pause", reason: `${goal}: looking for them`, forward: 0, turn: 0.4 };
  }

  if (it.doing === "go_to_door") {
    if (p.inDoorway) { clear(p); return null; }
    const door = obs.vision.find((v) => v.door);
    if (door) {
      if (door.door === "shut" && door.distance < 140) p.s1.doorGoalUntil = nowSec + 30;
      if (it.mark === undefined || door.distance < it.mark - 8) { it.mark = door.distance; it.progressSec = nowSec; }
      return { action: "explore_door", reason: `${goal}: heading for the doorway`, forward: 0.7, turn: clamp(door.bearing, -MAX_TURN, MAX_TURN) };
    }
    return { action: "pause", reason: `${goal}: looking for a doorway`, forward: 0.2, turn: 0.5 };
  }

  if (it.doing === "go_to_pad") {
    if (obs.touch === "pad" || obs.chargeRate > 0.05) { clear(p); return null; }
    const way = placeSteer(p, nowSec);
    if (way) {
      if (it.mark === undefined || way.distance < it.mark - 8) { it.mark = way.distance; it.progressSec = nowSec; }
      if (way.toDoor && way.distance < 140) p.s1.doorGoalUntil = nowSec + 30;
      const bearing = normAngle(way.bearing);
      return { action: "go_to_place", reason: `${goal}: ${way.reason}`, forward: Math.abs(bearing) > 1.2 ? 0.3 : 0.85, turn: clamp(bearing, -MAX_TURN, MAX_TURN) };
    }
    return { action: "pause", reason: `${goal}: I cannot find the way to a pad`, forward: 0, turn: 0.3 };
  }

  it.heldSince ??= nowSec;
  it.progressSec = nowSec; // standing here is the task, so it is not "stuck"
  if (nowSec - it.heldSince >= WATCH_FOR) { clear(p); return null; }
  const thing = obs.vision.find((v) => v.category === "static" && !v.door);
  if (thing && thing.distance > 95) return { action: "inspect", reason: `${goal}: going closer to look`, forward: 0.5, turn: clamp(thing.bearing, -MAX_TURN, MAX_TURN) };
  return { action: "inspect", reason: `${goal}: watching`, forward: 0, turn: thing ? clamp(thing.bearing, -0.4, 0.4) : 0 };
}
