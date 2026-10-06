// A pet's brain as a portable file: personality, beliefs, claims, intention, recent experience and counters.
// Times inside a brain are stored as ages (seconds before the moment it was saved), so the brain can be
// restored into a simulation whose clock reads something completely different.
import type { Belief, Claim, PetState, Traits } from "./pet.js";
import { newMind, newStats } from "./pet.js";
import { MAX_GISTS } from "./sleep.js";
import { MAX_REFUTED } from "./verify.js";
import { KNOBS, KNOB_NAMES, newRules, type KnobName } from "./rules.js";
import { MAX_DREAMS, type Dream, type TwistKind } from "./dreams.js";
import { MAX_SCENES, type Scene, type SceneNear, type SceneThing } from "./scenes.js";
import { newCue, type Cue } from "./cues.js";
import type { Gist } from "./sleep.js";
import { newPredict, type PredictState, type Stat } from "./predict.js";

/** A remembered scene as it travels in a brain file: ages instead of clock times, and no place (the pet's frame does not carry over). */
export interface BrainScene extends Omit<Scene, "id" | "tSec" | "pose" | "lastUsedSec" | "lastSec"> {
  ageSec: number;
  usedAgeSec: number | null;
  lastAgeSec: number | null; // age of the most recent of the moments merged into this one
}

/** A gist as it travels in a brain file; the moments it cites are not carried, only the kinds that count as evidence for it. */
export interface BrainGist { text: string; confidence: number; kinds: string[]; uses: number; ageSec: number }

/** What a pet has learned about one steady tone, as it travels in a brain file. */
export interface BrainCue { key: string; pitch: number; exposureSec: number; support: number; contra: number; ageSec: number }

/** A dream as it travels: remembered as a dream, with its invented parts and its worry, but not the moments it was made from. */
export interface BrainDream { theme: TwistKind; narrative: string; worry: string; twists: { kind: TwistKind; text: string }[]; ageSec: number }

/** What a pet has learned to expect on each channel, and how a tone usually behaves. Recent surprises do not travel. */
export interface BrainExpect { stats: ({ key: string } & Stat)[]; presence: PredictState["presence"] }

export interface BrainFile {
  v: 1;
  kind: "1000pets-brain";
  id: string;
  name: string;
  color: string;
  label: string; // what the person called this save
  savedAt: string; // ISO wall-clock time
  simDay: number; // the sim day it was saved on, for reference only
  traits: Traits;
  mind: {
    question: string;
    intention: { goal: string; ageSec: number } | null;
    beliefs: { text: string; confidence: number; ageSec: number; verdict?: "supported" | "contradicted"; why?: string }[];
    claims: { text: string; from: string; status: Claim["status"]; ageSec: number; why?: string }[];
    refuted?: { text: string; why: string; ageSec: number }[]; // things found to be wrong, so a pet restored elsewhere does not take them up again
    episodes: string[];
  };
  scenes?: BrainScene[]; // absent in brains saved before scene memory
  cues?: BrainCue[]; // what it has learned about steady tones; absent in older brains
  gists?: BrainGist[]; // patterns written up while asleep; absent in older brains
  dreams?: BrainDream[]; // recent dreams; absent in older brains
  expect?: BrainExpect; // learned expectations; absent in older brains
  habits?: Partial<Record<KnobName, number>>; // habits the pet has tuned and kept; absent in older brains
  drives: { energy: number; curiosity: number; social: number; rest: number };
  stats: PetState["stats"];
  body?: { x: number; y: number; heading: number; energy: number };
  thoughts: { ageSec: number; [k: string]: unknown }[]; // recent thoughts, newest last
}

export const MAX_BRAIN_BYTES = 2_000_000;
const MAX_THOUGHTS = 60;

const clamp01 = (n: unknown, d = 0.5) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function exportBrain(p: PetState, simSec: number, opts: { label?: string; thoughts?: any[]; includeBody?: boolean } = {}): BrainFile {
  const m = p.mind;
  const age = (t: number) => Math.max(0, Math.round(simSec - t));
  const thoughts = (opts.thoughts ?? []).slice(-MAX_THOUGHTS).map((t) => ({ ...t, ageSec: age(num(t.tSec, simSec)) }));
  return {
    v: 1,
    kind: "1000pets-brain",
    id: p.id,
    name: p.name,
    color: p.color,
    label: opts.label ?? p.name,
    savedAt: new Date().toISOString(),
    simDay: Math.floor(simSec / 86400) + 1,
    traits: { ...p.traits },
    mind: {
      question: m.question,
      intention: m.intention ? { goal: m.intention.goal, ageSec: age(m.intention.sinceSec) } : null,
      beliefs: m.beliefs.map((b) => ({ text: b.text, confidence: b.confidence, ageSec: age(b.updatedSec), ...(b.verdict ? { verdict: b.verdict, why: b.why } : {}) })),
      claims: m.claims.map((c) => ({ text: c.text, from: c.from, status: c.status, ageSec: age(c.tSec), ...(c.why ? { why: c.why } : {}) })),
      refuted: (m.refuted ?? []).map((r) => ({ text: r.text, why: r.why, ageSec: age(r.tSec) })),
      episodes: [...m.episodes],
    },
    cues: Object.values(m.cues ?? {}).map((c) => ({ key: c.key, pitch: c.pitch, exposureSec: c.exposureSec, support: c.support, contra: c.contra, ageSec: age(c.lastHeardSec) })),
    ...(p.rules && Object.keys(p.rules.values).length ? { habits: { ...p.rules.values } } : {}),
    ...(p.predict ? { expect: { stats: Object.entries(p.predict.stats).map(([key, st]) => ({ key, ...st })), presence: { ...p.predict.presence } } } : {}),
    dreams: (m.dreams ?? []).map((d) => ({ theme: d.theme, narrative: d.narrative, worry: d.worry, twists: d.twists.map((t) => ({ ...t })), ageSec: age(d.tSec) })),
    gists: (m.gists ?? []).map((g) => ({ text: g.text, confidence: g.confidence, kinds: [...g.kinds], uses: g.uses, ageSec: age(g.createdSec) })),
    scenes: (m.scenes ?? []).map(({ id: _id, tSec, pose: _pose, lastUsedSec, lastSec, ...rest }) => ({ ...structuredClone(rest), ageSec: age(tSec), usedAgeSec: lastUsedSec < 0 ? null : age(lastUsedSec), lastAgeSec: lastSec === undefined ? null : age(lastSec) })),
    drives: { ...p.drives },
    stats: structuredClone(p.stats),
    ...(opts.includeBody ? { body: { x: p.x, y: p.y, heading: p.heading, energy: p.energy } } : {}),
    thoughts,
  };
}

const TWISTS: TwistKind[] = ["exaggerate", "missing_source", "swap_place", "swap_thing", "other_pet", "blend"];
const cat = (v: unknown): "moving" | "static" => (v === "moving" ? "moving" : "static");
const bearing = (v: unknown) => Math.max(-Math.PI, Math.min(Math.PI, num(v)));

/** Only known habits, held within their limits. */
function parseHabits(x: any): Partial<Record<KnobName, number>> {
  const out: Partial<Record<KnobName, number>> = {};
  for (const k of KNOB_NAMES) if (x && typeof x[k] === "number" && Number.isFinite(x[k])) out[k] = Math.round(Math.min(KNOBS[k].max, Math.max(KNOBS[k].min, x[k])) * 1000) / 1000;
  return out;
}

const count = (v: unknown) => Math.min(1_000_000, Math.max(0, Math.round(num(v))));
function parseExpect(x: any): BrainExpect {
  const stats = (Array.isArray(x?.stats) ? x.stats : []).slice(0, 16)
    .filter((st: any) => st && /^[a-zA-Z]{1,20}:[a-zA-Z]{1,20}$/.test(String(st.key)))
    .map((st: any) => { const n = count(st.n); return { key: String(st.key), n, mean: Math.max(-10_000, Math.min(10_000, num(st.mean))), var: Math.max(0, Math.min(100_000_000, num(st.var))), up: Math.min(n, count(st.up)) }; });
  const pr = x?.presence ?? {};
  return { stats, presence: { present: count(pr.present), vanished: Math.min(count(pr.present), count(pr.vanished)), absent: count(pr.absent), appeared: Math.min(count(pr.absent), count(pr.appeared)) } };
}

function parseScene(x: any): BrainScene {
  const seen: SceneThing[] = (Array.isArray(x.seen) ? x.seen : []).slice(0, 5).map((t: any) => ({ category: cat(t?.category), size: t?.size === "large" ? "large" : "small", colour: str(t?.colour, 12), distance: Math.max(0, num(t?.distance)), bearing: bearing(t?.bearing) }));
  const near: SceneNear[] = (Array.isArray(x.near) ? x.near : []).slice(0, 5).map((n: any) => ({ category: cat(n?.category), gap: Math.max(0, num(n?.gap)), bearing: bearing(n?.bearing) }));
  return {
    kind: str(x.kind, 20) || "moment",
    why: str(x.why, 160),
    importance: clamp01(x.importance, 0.3),
    seen,
    near,
    tone: x.tone && Number.isFinite(x.tone.pitch) ? { pitch: Math.round(num(x.tone.pitch)), volume: clamp01(x.tone.volume, 0) } : null,
    view: str(x.view, 24).replace(/[^.o#@|]/g, "."),
    light: Math.round(Math.min(100, Math.max(0, num(x.light)))),
    temperature: num(x.temperature),
    battery: Math.round(Math.min(100, Math.max(0, num(x.battery)))),
    action: str(x.action, 30),
    uses: Math.max(0, Math.round(num(x.uses))),
    ageSec: Math.max(0, num(x.ageSec)),
    count: Math.min(9999, Math.max(1, Math.round(num(x.count, 1)))),
    lastAgeSec: x.lastAgeSec === null || x.lastAgeSec === undefined ? null : Math.max(0, num(x.lastAgeSec)),
    usedAgeSec: x.usedAgeSec === null || x.usedAgeSec === undefined ? null : Math.max(0, num(x.usedAgeSec)),
  };
}

/** Validate and normalise an untrusted brain file (uploaded, or read from disk). Throws a readable error. */
export function parseBrain(raw: unknown): BrainFile {
  const r = raw as any;
  if (!r || typeof r !== "object" || r.kind !== "1000pets-brain") throw new Error("this is not a 1000pets brain file");
  if (r.v !== 1) throw new Error(`unsupported brain version ${String(r.v)}`);
  const id = str(r.id, 32).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = str(r.name, 24).trim();
  if (!id || !name) throw new Error("brain has no id or name");
  const mind = r.mind ?? {};
  const list = (v: unknown, max: number): any[] => (Array.isArray(v) ? v.slice(0, max) : []);
  const statuses = ["unverified", "supported", "contradicted"];
  const stats = r.stats ?? {};
  const actionSec: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats.actionSec ?? {}).slice(0, 30)) actionSec[str(k, 30)] = Math.max(0, num(v));
  return {
    v: 1,
    kind: "1000pets-brain",
    id,
    name,
    color: /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : "",
    label: str(r.label, 60) || name,
    savedAt: str(r.savedAt, 40),
    simDay: Math.max(1, Math.round(num(r.simDay, 1))),
    traits: { curiosity: clamp01(r.traits?.curiosity), social: clamp01(r.traits?.social), caution: clamp01(r.traits?.caution), patience: clamp01(r.traits?.patience) },
    mind: {
      question: str(mind.question, 100),
      intention: mind.intention && typeof mind.intention.goal === "string" ? { goal: str(mind.intention.goal, 80), ageSec: Math.max(0, num(mind.intention.ageSec)) } : null,
      beliefs: list(mind.beliefs, 20).filter((b) => typeof b?.text === "string").map((b) => ({ text: str(b.text, 80), confidence: clamp01(b.confidence), ageSec: Math.max(0, num(b.ageSec)), ...(b.verdict === "supported" || b.verdict === "contradicted" ? { verdict: b.verdict as "supported" | "contradicted", why: str(b.why, 160) } : {}) })),
      claims: list(mind.claims, 20).filter((c) => typeof c?.text === "string").map((c) => ({ text: str(c.text, 160), from: str(c.from, 120), status: statuses.includes(c.status) ? c.status : "unverified", ageSec: Math.max(0, num(c.ageSec)), ...(typeof c.why === "string" && c.why ? { why: str(c.why, 160) } : {}) })),
      refuted: list(mind.refuted, MAX_REFUTED).filter((r) => typeof r?.text === "string" && r.text.trim()).map((r) => ({ text: str(r.text, 160), why: str(r.why, 160), ageSec: Math.max(0, num(r.ageSec)) })),
      episodes: list(mind.episodes, 30).filter((e) => typeof e === "string").map((e) => str(e, 200)),
    },
    cues: list(r.cues, 12).filter((c) => c && /^tone:-?\d{1,3}$/.test(String(c.key))).map((c): BrainCue => ({ key: String(c.key), pitch: Math.round(Math.min(5000, Math.max(20, num(c.pitch, 534)))), exposureSec: Math.max(0, num(c.exposureSec)), support: Math.max(0, Math.round(num(c.support))), contra: Math.max(0, Math.round(num(c.contra))), ageSec: Math.max(0, num(c.ageSec)) })),
    habits: parseHabits(r.habits),
    expect: parseExpect(r.expect),
    dreams: list(r.dreams, MAX_DREAMS).filter((d) => d && typeof d.narrative === "string" && d.narrative.trim().length >= 10).map((d): BrainDream => ({
      theme: TWISTS.includes(d.theme) ? d.theme : "exaggerate", narrative: str(d.narrative, 320), worry: str(d.worry, 160),
      twists: (Array.isArray(d.twists) ? d.twists : []).slice(0, 3).filter((t: any) => t && typeof t.text === "string").map((t: any) => ({ kind: TWISTS.includes(t.kind) ? t.kind : "exaggerate", text: str(t.text, 160) })), ageSec: Math.max(0, num(d.ageSec)),
    })),
    gists: list(r.gists, MAX_GISTS).filter((g) => g && typeof g.text === "string" && g.text.trim().length >= 4).map((g): BrainGist => ({ text: str(g.text, 120), confidence: clamp01(g.confidence, 0.3), kinds: (Array.isArray(g.kinds) ? g.kinds : []).filter((k: unknown) => typeof k === "string").slice(0, 8).map((k: string) => k.replace(/[^a-z]/g, "").slice(0, 20)), uses: Math.max(0, Math.round(num(g.uses))), ageSec: Math.max(0, num(g.ageSec)) })),
    scenes: list(r.scenes, MAX_SCENES).filter((x) => x && typeof x === "object").map(parseScene),
    drives: { energy: clamp01(r.drives?.energy, 0.2), curiosity: clamp01(r.drives?.curiosity, 0.4), social: clamp01(r.drives?.social, 0.3), rest: clamp01(r.drives?.rest, 0.1) },
    stats: {
      actionSec,
      s1Thoughts: Math.max(0, Math.round(num(stats.s1Thoughts))),
      s2Thoughts: Math.max(0, Math.round(num(stats.s2Thoughts))),
      spoke: Math.max(0, Math.round(num(stats.spoke))),
      heard: Math.max(0, Math.round(num(stats.heard))),
    },
    ...(r.body && Number.isFinite(r.body.x) && Number.isFinite(r.body.y)
      ? { body: { x: num(r.body.x), y: num(r.body.y), heading: num(r.body.heading), energy: Math.min(100, Math.max(0, num(r.body.energy, 80))) } }
      : {}),
    thoughts: list(r.thoughts, MAX_THOUGHTS).filter((t) => t && typeof t === "object").map((t) => ({ ...t, ageSec: Math.max(0, num(t.ageSec)) })),
  };
}

/**
 * Put a brain into a pet. The pet keeps its own body (position, battery) unless `includeBody` is set.
 * Personality and memory always come from the brain; with `adoptIdentity` the pet takes its name and colour too.
 */
export function applyBrain(p: PetState, b: BrainFile, simSec: number, opts: { includeBody?: boolean; adoptIdentity?: boolean } = {}): void {
  const at = (ageSec: number) => simSec - ageSec;
  p.traits = { ...b.traits };
  p.brainTraits = true;
  if (opts.adoptIdentity) {
    p.name = b.name;
    if (b.color) p.color = b.color;
  }
  const mind = newMind();
  mind.question = b.mind.question;
  mind.intention = b.mind.intention ? { goal: b.mind.intention.goal, sinceSec: at(b.mind.intention.ageSec) } : null;
  mind.beliefs = b.mind.beliefs.map((x): Belief => ({ text: x.text, confidence: x.confidence, updatedSec: at(x.ageSec), ...(x.verdict ? { verdict: x.verdict, why: x.why } : {}) }));
  mind.claims = b.mind.claims.map((x): Claim => ({ text: x.text, from: x.from, status: x.status, tSec: at(x.ageSec), ...(x.why ? { why: x.why } : {}) }));
  mind.refuted = (b.mind.refuted ?? []).map((r) => ({ text: r.text, why: r.why, tSec: at(r.ageSec) }));
  mind.episodes = [...b.mind.episodes];
  mind.scenes = (b.scenes ?? []).map((x, i): Scene => {
    const { ageSec, usedAgeSec, lastAgeSec, ...rest } = x;
    return { ...structuredClone(rest), id: `s${Math.round(at(ageSec))}-b${i}`, tSec: at(ageSec), pose: null, lastUsedSec: usedAgeSec === null ? -1 : at(usedAgeSec), ...(lastAgeSec === null ? {} : { lastSec: at(lastAgeSec) }) };
  });
  for (const c of b.cues ?? []) {
    const cue: Cue = { ...newCue(c.key, c.pitch, at(c.ageSec)), exposureSec: c.exposureSec, support: c.support, contra: c.contra, lastHeardSec: at(c.ageSec) };
    mind.cues[c.key] = cue;
  }
  mind.gists = (b.gists ?? []).map((g, i): Gist => ({ id: `g${Math.round(at(g.ageSec))}-b${i}`, text: g.text, confidence: g.confidence, kinds: g.kinds, sources: [], createdSec: at(g.ageSec), checkedSec: simSec, lastUsedSec: -1, uses: g.uses }));
  mind.dreams = (b.dreams ?? []).map((d, i): Dream => ({ id: `d${Math.round(at(d.ageSec))}-b${i}`, tSec: at(d.ageSec), theme: d.theme, ingredients: [], kinds: [], twists: d.twists, worry: d.worry, narrative: d.narrative, source: "brain", pending: false }));
  p.predict = { ...newPredict(), stats: Object.fromEntries((b.expect?.stats ?? []).map(({ key, ...st }) => [key, st])), presence: { ...(b.expect?.presence ?? newPredict().presence) } }; // what is normal travels; what surprised it yesterday does not
  p.rules = { ...newRules(simSec), values: { ...(b.habits ?? {}) } }; // the habits it settled on come with it; a trial in progress does not
  p.sleep = undefined; // the night's state belongs to the body
  p.cueState = undefined; // a tone being followed is working state, not memory
  mind.lastThoughtSec = simSec; // wait a normal interval before the next slow thought
  p.mind = mind;
  p.drives = { ...b.drives };
  p.stats = { ...newStats(), ...structuredClone(b.stats) };
  p.s1.holdUntil = 0;
  p.s1.lastReason = undefined;
  if (opts.includeBody && b.body) {
    p.x = b.body.x;
    p.y = b.body.y;
    p.heading = b.body.heading;
    p.energy = b.body.energy;
  }
}
