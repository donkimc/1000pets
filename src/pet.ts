import { Rng } from "./rng.js";

export interface Traits { curiosity: number; social: number; caution: number; patience: number }
export interface PetDef { id: string; name: string; color: string; traits: Traits; start?: { x: number; y: number } }

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
}

export interface PetState {
  id: string;
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
  touch: "wall" | "object" | "pet" | "human" | "pad" | null;
  chargeRate: number; // %/min being taken in right now (solar or charger)
  lastPetSeenSec: number;
  rngState: number;
  s1: S1State;
}

export const PET_RADIUS = 18;
export const HUMAN_RADIUS = 16;

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
    rngState: rng.state,
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
