import { Rng } from "./rng.js";
import type { Scene, SceneWatch } from "./scenes.js";
import type { Cue, CueState } from "./cues.js";
import type { Gist, SleepSummary } from "./sleep.js";
import type { Dream } from "./dreams.js";
import type { PredictState } from "./predict.js";
import type { RuleState } from "./rules.js";
import type { Relation } from "./relations.js";

export interface Traits { curiosity: number; social: number; caution: number; patience: number }
/** How a creature sounds when it speaks aloud: a Kokoro voice, a speed, and a pitch for the browser's own voices. Every pet and the Teacher get a different one. */
export interface VoiceDef { id: string; speed?: number; pitch?: number }
export const VOICES: readonly VoiceDef[] = [
  { id: "af_sky", speed: 1.08, pitch: 1.35 }, { id: "bm_george", speed: 0.92, pitch: 0.7 }, { id: "af_bella", speed: 1.0, pitch: 1.1 },
  { id: "am_michael", speed: 1.0, pitch: 0.85 }, { id: "bf_isabella", speed: 1.05, pitch: 1.25 }, { id: "am_adam", speed: 0.95, pitch: 0.6 },
  { id: "af_nicole", speed: 1.0, pitch: 1.0 }, { id: "bm_lewis", speed: 1.0, pitch: 0.8 },
];
export const TEACHER_VOICE: VoiceDef = { id: "bf_emma", speed: 0.95, pitch: 0.95 };

export interface PetDef { id: string; name: string; color: string; traits: Traits; start?: { x: number; y: number }; voice?: VoiceDef }

/** Drive levels are need levels: 0 = satisfied, 1 = urgent. Energy need is derived from the battery. */
export interface Drives { energy: number; curiosity: number; social: number; rest: number }

export type PetMode = "idle" | "moving" | "sleeping" | "charging" | "dormant";

/** Small working state System 1 keeps between ticks (no world knowledge, only its own recent history). */
export interface S1State {
  action: string;
  prevLight: number;
  holdUntil: number; // sim seconds; while now < holdUntil the pet stays put doing holdAction
  holdAction: string;
  inspectCooldownUntil: number;
  tumbleUntil: number;
  lastThoughtSec: number;
  lastReason?: string; // why System 1 chose its current action
  followedAt?: number; // sim seconds of the last tick spent following a tone
  detourUntil?: number; // after steering round an obstacle, keep going straight until then instead of turning straight back
  giveUpUntil?: number; // a tone attempt made no progress: explore instead until then
  doorGoalUntil?: number; // heading for a doorway on purpose until then
  doorCooldownUntil?: number; // not curious about doorways again before this
  passUntil?: number; // walking straight through a doorway until then
}

export interface PetState {
  id: string;
  voice?: VoiceDef; // how it sounds aloud (see VOICES)
  name: string;
  color: string;
  traits: Traits;
  x: number;
  y: number;
  heading: number; // radians, 0 = east, y grows downward
  speed: number; // units per sim second actually achieved last tick
  turnRate: number;
  energy: number; // 0..100
  mode: PetMode;
  drives: Drives;
  bumped: boolean;
  anchors?: Record<string, { x: number; y: number }>; // where it reckoned each charger pad to be (by its hum), to correct drift
  room?: string; // the room it was in at the last tick (to count crossings)
  inDoorway?: boolean; // standing in a doorway right now (to note each passing once)
  moved?: { x: number; y: number }; // how far the body actually moved in the last tick (what its odometry measures)
  touch: "wall" | "door" | "object" | "pet" | "human" | "teacher" | "pad" | null;
  chargeRate: number; // %/min being taken in right now (solar or charger)
  lastPetSeenSec: number;
  rngState: number;
  s1: S1State;
  mind: Mind;
  stats: PetStats;
  odo: { x: number; y: number }; // dead-reckoned position in the pet's own frame, starting at (0,0) where it woke up; never world coordinates
  watch?: SceneWatch; // running averages used to notice surprises
  cueState?: CueState; // charge edge detection and the tone currently being followed
  predict?: PredictState; // what it has learned to expect, and what has surprised it (see predict.ts)
  rules?: RuleState; // habits it has tuned, and the trial in progress (see rules.ts)
  sleep?: { since: number | null; done: boolean }; // the current sleep, and whether it has been consolidated yet
  brainTraits?: boolean; // traits (and name/colour) came from a restored brain, so config/pets.json must not overwrite them
}

export type Suggestion = "none" | "seek_light" | "find_pet" | "inspect_object" | "rest" | "follow_tone";
export const SUGGESTIONS: readonly Suggestion[] = ["none", "seek_light", "find_pet", "inspect_object", "rest", "follow_tone"];

/** Something another voice asserted. Speech is a claim, not a fact, until the pet verifies it itself. */
export interface Claim { text: string; from: string; tSec: number; status: "unverified" | "supported" | "contradicted"; why?: string; checkedSec?: number; fromKey?: string; counted?: "supported" | "contradicted" } // why: what the pet's own experience showed

export interface Belief { text: string; confidence: number; updatedSec: number; checkedSec?: number; verdict?: "supported" | "contradicted"; why?: string } // checkedSec: evidence up to here has already been counted

/** Slow, deliberate state owned by System 2: beliefs, the current question, a long-running intention. */
export interface Mind {
  beliefs: Belief[];
  question: string;
  intention: { goal: string; sinceSec: number } | null;
  suggestion: { kind: Suggestion; untilSec: number } | null;
  claims: Claim[]; // things heard from others, newest last
  episodes: string[]; // short notes of recent experience, newest last
  scenes: Scene[]; // salient moments kept as small structured pictures (see scenes.ts)
  cues: Record<string, Cue>; // what the pet has learned about steady tones, from counted evidence (see cues.ts)
  gists: Gist[]; // patterns written up while asleep (see sleep.ts): provisional, each linked to the moments it came from
  gistDue: boolean; // a night's consolidation has finished and a gist could be written
  lastSleep: SleepSummary | null; // what the last night's consolidation did, for the dashboard
  lastGistSec?: number; // when a gist was last asked for, so it is not every sleep
  refuted: { text: string; why: string; tSec: number }[]; // things it believed or was told that its own experience showed to be wrong
  recentQuestions: string[]; // what it asked itself lately, so it can be told to ask something new
  recentThoughts: string[]; // its last few thoughts, shown back to it in a deep reflection
  repeatStreak: number; // how many slow thoughts in a row asked a question it had already asked
  others: Record<string, Relation>; // the individuals it has come to know, by look (see relations.ts)
  dreams: Dream[]; // remembered as dreams: kept apart from beliefs, claims, moments and gists, and never treated as fact
  sensed: { light: number; temperature: number; seen: string[]; near: string[]; heard: string; tone: string; touch: string };
  lastThoughtSec: number;
}

export function newMind(): Mind {
  return { beliefs: [], question: "", intention: null, suggestion: null, claims: [], episodes: [], scenes: [], cues: {}, gists: [], gistDue: false, lastSleep: null, refuted: [], recentQuestions: [], recentThoughts: [], repeatStreak: 0, others: {}, dreams: [], sensed: { light: 0, temperature: 0, seen: [], near: [], heard: "", tone: "", touch: "" }, lastThoughtSec: -1e9 };
}

/** Running counters per pet, shown on the dashboard. */
export interface PetStats {
  actionSec: Record<string, number>; // simulated seconds spent in each System 1 action
  s1Thoughts: number;
  s2Thoughts: number;
  spoke: number;
  heard: number;
  roomSec?: Record<string, number>; // simulated seconds spent in each room
  chargeSec?: Record<string, number>; // ... of which charging, by room
  crossings?: number; // times it went from one room to another
  doorsOpened?: number; // doors it pushed open
}

export function newStats(): PetStats {
  return { actionSec: {}, s1Thoughts: 0, s2Thoughts: 0, spoke: 0, heard: 0, roomSec: {}, chargeSec: {}, crossings: 0, doorsOpened: 0 };
}

/** Series colours validated for dark charts (colour follows the entity: a pet keeps its colour everywhere). */
export const PET_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;

export const PET_RADIUS = 18;
export const HUMAN_RADIUS = 16;
export const TEACHER_RADIUS = 18;

/** The human participant: another body in the world, driven by the person using the site. */
export interface HumanState { x: number; y: number; heading: number; moving: boolean }

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function spawnPet(def: PetDef, seed: number, index: number): PetState {
  const rng = new Rng((seed ^ hashString(def.id)) >>> 0);
  const start = def.start ?? { x: 150 + index * 220, y: 350 };
  return {
    id: def.id,
    name: def.name,
    color: def.color,
    traits: def.traits,
    voice: def.voice ?? VOICES[index % VOICES.length],
    x: start.x,
    y: start.y,
    heading: rng.next() * Math.PI * 2 - Math.PI,
    speed: 0,
    turnRate: 0,
    energy: 80,
    mode: "idle",
    drives: { energy: 0.2, curiosity: 0.4, social: 0.3, rest: 0.1 },
    bumped: false,
    touch: null,
    chargeRate: 0,
    lastPetSeenSec: -1e9,
    odo: { x: 0, y: 0 },
    rngState: rng.state,
    mind: newMind(),
    stats: newStats(),
    s1: { action: "wander", prevLight: 0, holdUntil: 0, holdAction: "", inspectCooldownUntil: 0, tumbleUntil: 0, lastThoughtSec: -1e9 },
  };
}

/** Convert "#rrggbb" to a hue 0..360, which is all a pet can perceive about another pet's colour. */
export function hueOf(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
