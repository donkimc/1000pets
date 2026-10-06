// Scene memory: a pet remembers salient moments as small structured "pictures" of what it perceived,
// not just a line of text. A scene holds the things it saw in front and felt around it, a text-art view,
// its body state, and where it was by its own dead reckoning (never world coordinates).
// Scenes are captured when something salient happens (found the charger, bumped, the light changed, ...),
// kept in a small store that forgets the least important and oldest first, and the best few are shown to
// System 2. They also record how often they were used, which the later sleep consolidation relies on.
import { normAngle } from "./geometry.js";
import type { PetState } from "./pet.js";
import { Rng } from "./rng.js";
import { VISION_HALF_ANGLE, type Observation } from "./sensors.js";

export const MAX_SCENES = 24;
export const SCENES_IN_PROMPT = 3;
const SLICES = 11; // columns of the text-art view across the vision cone
const LARGE = 100; // size at which a thing counts as large

export interface SceneThing { category: "moving" | "static"; size: "small" | "large"; colour: string; distance: number; bearing: number }
export interface SceneNear { category: "moving" | "static"; gap: number; bearing: number }

export interface Scene {
  id: string;
  tSec: number;
  kind: string; // what made it memorable, e.g. "charger"
  why: string; // in the pet's own words
  importance: number; // 0..1; protects a scene from being forgotten
  pose: { x: number; y: number } | null; // where, in the pet's own dead-reckoned frame; null if the frame is lost
  seen: SceneThing[]; // in front, nearest first
  near: SceneNear[]; // within reach, any direction
  view: string; // text art, see renderView
  tone: { pitch: number; volume: number } | null; // a steady tone that was audible at the time
  light: number;
  temperature: number;
  battery: number;
  action: string;
  uses: number; // times shown to System 2
  lastUsedSec: number;
  count?: number; // how many similar moments this one stands for, after sleep merged repeats into it
  lastSec?: number; // when the most recent of those happened
}

/** Bookkeeping the pet keeps between ticks to notice change. */
export interface SceneWatch {
  light: number; // slow running averages: a sudden jump away from them is a surprise
  temperature: number;
  charge: number;
  touch: PetState["touch"];
  mode: PetState["mode"];
  hadCompany: boolean;
  heardTone: boolean; // has ever heard a steady tone
  last: Record<string, number>; // per kind: when a scene was last captured
  seq: number;
}

export function newWatch(obs?: Observation): SceneWatch {
  return { light: obs?.light ?? 0, temperature: obs?.temperature ?? 0, charge: 0, touch: null, mode: "idle", hadCompany: false, heardTone: false, last: {}, seq: 0 };
}

// ---- colours: a pet perceives hue, so it can say "a green moving thing" but not whose colour that is ----

export function colourWord(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 195) return "teal";
  if (h < 255) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

// ---- the text-art view ----

const glyph = (category: "moving" | "static", large: boolean) => (category === "moving" ? "@" : large ? "#" : "o");

/**
 * Left-to-right across the vision cone (11 columns), then "|" and the four sectors around the body
 * (front, right, back, left). "." empty, "o" small still thing, "#" large still thing, "@" something moving.
 * The nearest thing in a column wins.
 */
export function renderView(seen: { category: "moving" | "static"; size: number | "small" | "large"; distance: number; bearing: number }[], near: SceneNear[]): string {
  const cols: string[] = Array(SLICES).fill(".");
  const sorted = [...seen].sort((a, b) => b.distance - a.distance); // draw far first so near overwrites
  for (const s of sorted) {
    const i = Math.min(SLICES - 1, Math.max(0, Math.floor(((s.bearing + VISION_HALF_ANGLE) / (2 * VISION_HALF_ANGLE)) * SLICES)));
    const large = typeof s.size === "number" ? s.size >= LARGE : s.size === "large";
    cols[i] = glyph(s.category, large);
  }
  const ring = [".", ".", ".", "."]; // front, right, back, left
  for (const n of [...near].sort((a, b) => b.gap - a.gap)) {
    const b = normAngle(n.bearing);
    const sector = Math.abs(b) < Math.PI / 4 ? 0 : Math.abs(b) > (3 * Math.PI) / 4 ? 2 : b > 0 ? 1 : 3;
    ring[sector] = n.category === "moving" ? "@" : "o";
  }
  return `${cols.join("")}|${ring.join("")}`;
}

// ---- describing a scene in words, from where the pet is now ----

const DIR = (b: number) => (Math.abs(b) < 0.5 ? "ahead of me" : Math.abs(b) > 2.6 ? "behind me" : b > 0 ? "to my right" : "to my left");

function placeWords(scene: Scene, now: { odo: { x: number; y: number }; heading: number }): string {
  if (!scene.pose) return "I no longer know where this was";
  const dx = scene.pose.x - now.odo.x, dy = scene.pose.y - now.odo.y;
  const d = Math.hypot(dx, dy);
  if (d < 40) return "this was right here";
  return `about ${Math.round(d / 10) * 10} units ${DIR(normAngle(Math.atan2(dy, dx) - now.heading))}`;
}

function thingWords(t: SceneThing): string {
  return `${t.size} ${t.colour} ${t.category === "moving" ? "moving thing" : "still object"}`;
}

/** One memory as a line for System 2's notes. The text-art view is kept out of prompts (a small model cannot read it) and shown in the dashboard instead. */
export function describeScene(scene: Scene, p: Pick<PetState, "odo" | "heading">, clockLabel: string): string {
  const front = scene.seen.slice(0, 2).map((t) => `a ${thingWords(t)} ${DIR(t.bearing)}`);
  const around = scene.near.slice(0, 2).map((n) => `a ${n.category === "moving" ? "moving thing" : "still object"} ${n.gap < 8 ? "touching me" : "close"}`);
  const hum = scene.tone ? [`a steady tone at ${scene.tone.pitch} Hz`] : [];
  const saw = [...front, ...around, ...hum].join(", ") || "nothing near";
  const times = (scene.count ?? 1) > 1 ? ` (this has happened ${scene.count} times)` : "";
  return `${clockLabel} ${scene.why}${times} (battery ${scene.battery}%, light ${scene.light}, ${scene.action}). I noticed ${saw}. ${placeWords(scene, { odo: p.odo, heading: p.heading })}.`;
}

// ---- which scenes to show, and which to forget ----

/** Importance, softened by age and boosted a little by use. Used to rank scenes for forgetting and for the prompt. */
export function sceneScore(s: Scene, nowSec: number): number {
  const ageH = Math.max(0, nowSec - Math.max(s.tSec, s.lastSec ?? 0)) / 3600;
  return s.importance * Math.pow(0.5, ageH / 6) + Math.min(0.2, s.uses * 0.02);
}

export function selectScenes(p: Pick<PetState, "mind">, nowSec: number, n = SCENES_IN_PROMPT): Scene[] {
  return [...(p.mind.scenes ?? [])].sort((a, b) => sceneScore(b, nowSec) - sceneScore(a, nowSec)).slice(0, n);
}

/** Record that these scenes were shown to System 2 (so unused memories can be told apart later). */
export function markUsed(p: Pick<PetState, "mind">, nowSec: number, n = SCENES_IN_PROMPT): void {
  for (const s of selectScenes(p, nowSec, n)) {
    s.uses++;
    s.lastUsedSec = nowSec;
  }
}

export function storeScene(p: Pick<PetState, "mind">, scene: Scene, nowSec: number): void {
  const list = (p.mind.scenes ??= []);
  list.push(scene);
  if (list.length > MAX_SCENES) {
    let worst = 0;
    for (let i = 1; i < list.length - 1; i++) if (sceneScore(list[i], nowSec) < sceneScore(list[worst], nowSec)) worst = i;
    if (sceneScore(list[0], nowSec) <= sceneScore(list[worst], nowSec)) worst = 0;
    list.splice(worst, 1); // never the scene just added
  }
}

// ---- capturing: what is salient? ----

interface Trigger { kind: string; why: string; importance: number; cooldownSec: number }

function triggers(p: PetState, obs: Observation, w: SceneWatch): Trigger[] {
  const out: Trigger[] = [];
  const t = (kind: string, why: string, importance: number, cooldownSec: number) => out.push({ kind, why, importance, cooldownSec });
  if (w.charge < 0.5 && p.chargeRate >= 0.9) t("charger", "found the charging pad and my battery started filling quickly", 0.8, 900);
  else if (w.charge <= 0.01 && p.chargeRate > 0.01 && p.chargeRate < 0.5) t("sunpatch", "stood in a patch of sunlight that slowly charged me", 0.5, 900);
  if (p.mode === "dormant" && w.mode !== "dormant") t("dormant", "my battery ran out and I powered down", 1, 3600);
  else if (obs.energy < 25 && w.mode !== "dormant") t("lowbattery", "my battery was getting low", 0.7, 7200);
  if (p.touch && p.touch !== "pad" && w.touch === null) t("bump", p.touch === "wall" ? "bumped into a wall" : p.touch === "object" ? "bumped into something still" : "bumped into something that moves", 0.3, 900);
  if (Math.abs(obs.light - w.light) >= 25) t(obs.light > w.light ? "brighter" : "darker", obs.light > w.light ? "the light suddenly got much brighter" : "the light suddenly got much darker", 0.6, 1200);
  if (obs.temperature - w.temperature >= 1.5) t("warmer", "it suddenly got warmer", 0.5, 900);
  else if (w.temperature - obs.temperature >= 1.5) t("colder", "it suddenly got colder", 0.4, 900);
  if (obs.hearing && obs.hearing.volume > 0.5) t("loud", "heard a loud sound", 0.3, 900);
  const company = obs.near.some((n) => n.category === "moving");
  if (obs.tone && !w.heardTone) t("tonefirst", "heard a steady tone I had never heard before", 0.45, 1e9);
  if (company && !w.hadCompany) t("company", "something that moves came right up to me", 0.35, 1800);
  return out;
}

/** A scene from the pet's current perception and body. */
function buildScene(p: PetState, obs: Observation, nowSec: number, rng: Rng, kind: string, why: string, importance: number): Scene {
  const w = (p.watch ??= newWatch(obs));
  const seen: SceneThing[] = obs.vision.slice(0, 5).map((v) => ({ category: v.category, size: v.size >= LARGE ? "large" : "small", colour: colourWord(v.hue), distance: v.distance, bearing: v.bearing }));
  const near: SceneNear[] = obs.near.slice(0, 5).map((n) => ({ category: n.category, gap: n.gap, bearing: n.bearing }));
  return {
    id: `s${nowSec}-${++w.seq}`,
    tSec: nowSec,
    kind,
    why,
    importance: Math.round(Math.min(1, importance + (rng.next() - 0.5) * 0.04) * 100) / 100,
    pose: { x: Math.round(p.odo.x), y: Math.round(p.odo.y) },
    seen,
    near,
    view: renderView(obs.vision, obs.near),
    tone: obs.tone ? { pitch: obs.tone.pitch, volume: obs.tone.volume } : null,
    light: obs.light,
    temperature: obs.temperature,
    battery: Math.round(p.energy),
    action: p.s1.action,
    uses: 0,
    lastUsedSec: -1,
  };
}

/** Which kind of memorable moment a broken expectation becomes. Light, temperature and battery surprises are not scenes (the fixed triggers already catch the big ones). */
export function surpriseKind(channel: string, ctx: string): string | null {
  if (channel === "tonePresence") return ctx === "appeared" ? "toneback" : "tonelost";
  if (channel === "toneVolume") return ctx === "following" ? "tonedrift" : null;
  if (channel === "charge") return "nocharge";
  return null;
}

/** Remember a surprise as a scene: the more surprising, the more it matters. Returns the scene, or null if its kind is on cooldown or is not kept as a scene. */
export function captureSurpriseScene(p: PetState, obs: Observation, nowSec: number, rng: Rng, sur: { channel: string; ctx: string; score: number; why: string }): Scene | null {
  const kind = surpriseKind(sur.channel, sur.ctx);
  if (!kind) return null;
  const w = (p.watch ??= newWatch(obs));
  if (nowSec - (w.last[kind] ?? -1e9) < 600) return null;
  w.last[kind] = nowSec;
  const scene = buildScene(p, obs, nowSec, rng, kind, sur.why, 0.5 + 0.4 * sur.score);
  storeScene(p, scene, nowSec);
  return scene;
}

/**
 * Called once per pet tick, after the pet has acted. Updates the running averages and, when something
 * salient just happened and its kind is not on cooldown, stores a scene. Returns the scene if one was stored.
 */
export function watchScenes(p: PetState, obs: Observation, nowSec: number, rng: Rng): Scene | null {
  const w = (p.watch ??= newWatch(obs));
  let stored: Scene | null = null;
  for (const tr of triggers(p, obs, w)) {
    if (nowSec - (w.last[tr.kind] ?? -1e9) < tr.cooldownSec) continue;
    w.last[tr.kind] = nowSec;
    stored = buildScene(p, obs, nowSec, rng, tr.kind, tr.why, tr.importance);
    storeScene(p, stored, nowSec);
  }
  const slow = 0.05; // time constant of about 100 simulated seconds at 5 s ticks
  w.light += (obs.light - w.light) * slow;
  w.temperature += (obs.temperature - w.temperature) * slow;
  w.charge = p.chargeRate;
  w.touch = p.touch;
  w.mode = p.mode;
  w.hadCompany = obs.near.some((n) => n.category === "moving");
  if (obs.tone) w.heardTone = true;
  return stored;
}

/** Dead reckoning: the pet integrates the distance it actually moved along its compass heading, with a little noise. */
export function updateOdometry(p: PetState, dtSec: number, rng: Rng): void {
  const stride = p.speed * dtSec * (1 + (rng.next() - 0.5) * 0.06);
  const heading = p.heading + (rng.next() - 0.5) * 0.04;
  p.odo.x += Math.cos(heading) * stride;
  p.odo.y += Math.sin(heading) * stride;
}
