// Habits: the soft thresholds in System 1 that a pet may tune for itself, safely.
//
// System 1 is fast and rule-based. Most of it is fixed reflex (do not walk into things, power down at zero, never sleep through
// a critical battery) and none of that can be touched here. But a handful of soft thresholds ("how lonely before I look for
// company", "how tired before I sleep by day") are just habits, and a pet may try changing them within hard limits.
//
// How a change happens:
//   1. A pet proposes a small step on one habit. Two sources: its slow thinking (System 2) may suggest one, and a plain
//      homeostatic rule proposes one when a need has stayed unmet for about a day (e.g. social need high all day: go to others sooner).
//   2. The proposal is a trial, not a change. For 24 simulated hours the habit alternates between its new and old value every two
//      hours, so day and night are shared fairly between them. Each block records how well the pet did (needs met, battery, never dormant).
//   3. At the end the evidence decides: the new value is kept only if it won at least 5 of the 6 paired blocks by a clear margin
//      and was no less safe. Otherwise it is undone. Any dormancy while the new value is in force aborts the trial at once.
//   4. Everything is logged, shown on the pet's card, and can be reset in one click.
// The language model never decides whether a change is good: only how the pet actually fared does.
import type { PetState } from "./pet.js";

/** Which measure a habit is judged by: the one it mainly affects (overall wellbeing is too blunt to show a small habit's effect). */
export type Target = "social" | "curiosity" | "rest" | "battery" | "overall";

export interface Knob { def: number; min: number; max: number; step: number; label: string; plain: string; target: Target }

export const KNOBS = {
  sleepRest: { def: 0.85, min: 0.6, max: 0.95, step: 0.05, label: "tiredness before sleeping by day", plain: "how tired I must be before I sleep during the day", target: "rest" },
  sleepRestNight: { def: 0.35, min: 0.2, max: 0.6, step: 0.05, label: "tiredness before sleeping at night", plain: "how tired I must be before I sleep at night", target: "rest" },
  batteryLow: { def: 0.55, min: 0.35, max: 0.65, step: 0.05, label: "how drained before seeking charge", plain: "how drained my battery must be before I go looking for charge", target: "battery" },
  socialAt: { def: 0.55, min: 0.35, max: 0.8, step: 0.05, label: "loneliness before seeking company", plain: "how much I need company before I go to another pet", target: "social" },
  curiousAt: { def: 0.5, min: 0.3, max: 0.8, step: 0.05, label: "curiosity before inspecting", plain: "how curious I must be before I go and look at something", target: "curiosity" },
  inspectCooldown: { def: 600, min: 200, max: 1800, step: 100, label: "pause between inspections (s)", plain: "how long I wait after inspecting something before I look at another", target: "curiosity" },
  noveltyPull: { def: 0.55, min: 0.35, max: 0.8, step: 0.05, label: "pull needed to follow an unfamiliar tone", plain: "how strongly an unfamiliar sound must pull at me before I follow it", target: "overall" },
} as const satisfies Record<string, Knob>;

export type KnobName = keyof typeof KNOBS;
export const KNOB_NAMES = Object.keys(KNOBS) as KnobName[];

export const BLOCK_SEC = 2 * 3600; // the habit swaps between new and old value every two hours
export const TRIAL_BLOCKS = 12; // 24 hours: six paired blocks
export const COOLDOWN_SEC = 6 * 3600; // rest between trials
export const MIN_AGE_SEC = 24 * 3600; // a pet watches itself for a day before it proposes anything
const UNSAFE_SEC = 3 * 86400; // after a trial is aborted or clearly worse, that direction is off the table for three days
const MAX_MULT = 4; // the biggest step is four of the usual steps
const WIN_MARGIN = 0.004; // the new value must be better by at least this much on average
const MIN_WINS = 5; // ... win at least this many of the six pairs
const MIN_T = 2.0; // ... and the paired difference must be clearly more than noise (a paired t-statistic of at least 2, about a 5% one-sided chance by luck)
const LOW_BATTERY = 25;
export const MAX_HISTORY = 20;

const TARGET_WORDS: Record<Target, string> = { social: "my need for company", curiosity: "my curiosity", rest: "my tiredness", battery: "my battery", overall: "how well I am doing" };

export type Direction = "up" | "down";
export type Source = "need" | "thinking";

export interface Block { cond: "new" | "old"; n: number; sum: number; tgt: number; low: number; dormant: number } // sum: overall wellbeing; tgt: the measure the habit is judged by
export interface Trial { knob: KnobName; from: number; to: number; startSec: number; reason: string; source: Source; blocks: Block[] }
export interface HistoryEntry { knob: KnobName; from: number; to: number; tSec: number; outcome: "adopted" | "reverted" | "aborted"; reason: string; why: string; gain: number; wins: number }
export interface RuleState {
  values: Partial<Record<KnobName, number>>; // adopted habits; anything missing is the default
  trial: Trial | null;
  history: HistoryEntry[]; // newest last
  cooldownUntil: number;
  unsafeUntil: Record<string, number>; // "knob:direction" to when it may be tried again: set after an unsafe abort or a trial that was clearly worse
  mult: Record<string, number>; // "knob:direction" to how many steps the next try takes: doubles after a flat, inconclusive trial, so it can cross a region where a small change makes no difference
  chronic: { curiosity: number; social: number; rest: number; lowBattery: number }; // running averages over about a day
  seen: boolean; // chronic averages have been started
  born: number; // sim seconds when it began watching itself
}

/** Fill in anything habit state saved by an older version lacks (the step multipliers, the chronic counters, ...), so an old save keeps running. */
export function repairRules(r: RuleState, nowSec = 0): RuleState {
  const d = newRules(nowSec) as unknown as Record<string, unknown>, x = r as unknown as Record<string, unknown>;
  for (const k of Object.keys(d)) if (x[k] === undefined) x[k] = d[k];
  r.chronic = { ...newRules(nowSec).chronic, ...r.chronic };
  return r;
}

export const newRules = (nowSec = 0): RuleState => ({ values: {}, trial: null, history: [], cooldownUntil: 0, unsafeUntil: {}, mult: {}, chronic: { curiosity: 0, social: 0, rest: 0, lowBattery: 0 }, seen: false, born: nowSec });

export type RuleEvent =
  | { type: "trial_started"; knob: KnobName; from: number; to: number; reason: string; source: Source }
  | { type: "adopted" | "reverted" | "aborted"; knob: KnobName; from: number; to: number; reason: string; why: string; gain: number; wins: number };

const clampTo = (knob: KnobName, v: number) => Math.round(Math.min(KNOBS[knob].max, Math.max(KNOBS[knob].min, v)) * 1000) / 1000;

/** Which value of the habit under trial is in force right now. */
function condition(trial: Trial, nowSec: number): "new" | "old" {
  return Math.floor((nowSec - trial.startSec) / BLOCK_SEC) % 2 === 0 ? "new" : "old";
}

/** The value of a habit right now: the trial's new or old value (alternating), else the adopted value, else the default. */
export function ruleValue(p: Pick<PetState, "rules">, nowSec: number, knob: KnobName): number {
  const r = p.rules;
  if (r?.trial && r.trial.knob === knob) return condition(r.trial, nowSec) === "new" ? r.trial.to : r.trial.from;
  return r?.values[knob] ?? KNOBS[knob].def;
}

/** How well the pet is doing this moment, 0..1: needs met, battery not low, never dormant. */
export function wellbeing(p: Pick<PetState, "drives" | "energy" | "mode">): { x: number; low: boolean; dormant: boolean } {
  const low = p.energy < LOW_BATTERY, dormant = p.mode === "dormant";
  const needs = (p.drives.curiosity + p.drives.social + p.drives.rest) / 3;
  return { x: 1 - (0.5 * needs + 1.5 * (low ? 1 : 0) + 4 * (dormant ? 1 : 0)), low, dormant };
}

/** How well the pet is doing on the one measure a habit mainly affects, 0..1. */
export function targetScore(p: Pick<PetState, "drives" | "energy" | "mode">, target: Target): number {
  switch (target) {
    case "social": return 1 - p.drives.social;
    case "curiosity": return 1 - p.drives.curiosity;
    case "rest": return 1 - p.drives.rest;
    case "battery": return 0.5 * (p.energy / 100) + 0.5 * (p.energy >= LOW_BATTERY ? 1 : 0);
    default: return wellbeing(p).x;
  }
}

const stepOf = (knob: KnobName, dir: Direction, mult = 1) => (dir === "up" ? 1 : -1) * KNOBS[knob].step * mult;

/** Why a proposal would be refused, or null if it is acceptable. */
export function refusal(p: Pick<PetState, "rules">, nowSec: number, knob: string, dir: string): string | null {
  if (!KNOB_NAMES.includes(knob as KnobName)) return `"${knob}" is not a habit that can be tuned`;
  if (dir !== "up" && dir !== "down") return "direction must be up or down";
  const r = p.rules;
  const k = knob as KnobName;
  if (r?.trial) return "another trial is running";
  if (r && nowSec < r.cooldownUntil) return "resting after the last trial";
  if (r && nowSec - r.born < MIN_AGE_SEC) return "too soon: it has not watched itself for a day";
  if (r && nowSec < (r.unsafeUntil[`${k}:${dir}`] ?? 0)) return "that direction was clearly worse (or unsafe) recently";
  const cur = ruleValue(p, nowSec, k);
  if (clampTo(k, cur + stepOf(k, dir as Direction, r?.mult?.[`${k}:${dir}`] ?? 1)) === cur) return "already at the limit";
  return null;
}

/** Start a trial of a small step on one habit. Returns the event, or null if it was refused (with the reason in `why`). */
export function proposeTune(p: PetState, nowSec: number, knob: string, dir: string, reason: string, source: Source): { event: RuleEvent | null; why: string | null } {
  const rules = (p.rules = repairRules(p.rules ?? newRules(nowSec), nowSec));
  const why = refusal(p, nowSec, knob, dir);
  if (why) return { event: null, why };
  const k = knob as KnobName;
  const from = ruleValue(p, nowSec, k);
  const to = clampTo(k, from + stepOf(k, dir as Direction, rules.mult[`${k}:${dir}`] ?? 1));
  rules.trial = { knob: k, from, to, startSec: nowSec, reason: reason.slice(0, 160), source, blocks: [] };
  return { event: { type: "trial_started", knob: k, from, to, reason: rules.trial.reason, source }, why: null };
}

/** Undo every adopted habit and cancel any trial. */
export function resetRules(p: PetState, nowSec: number): void {
  const old = p.rules;
  p.rules = { ...newRules(nowSec), born: old?.born ?? nowSec, history: old?.history ?? [], cooldownUntil: nowSec + COOLDOWN_SEC };
}

function finish(p: PetState, nowSec: number, outcome: "adopted" | "reverted" | "aborted", why: string, gain: number, wins: number): RuleEvent {
  const r = p.rules!, t = r.trial!;
  if (outcome === "adopted") r.values[t.knob] = t.to;
  r.history.push({ knob: t.knob, from: t.from, to: t.to, tSec: nowSec, outcome, reason: t.reason, why, gain: Math.round(gain * 1000) / 1000, wins });
  if (r.history.length > MAX_HISTORY) r.history.shift();
  const key = `${t.knob}:${t.to > t.from ? "up" : "down"}`;
  if (outcome === "adopted") delete r.mult[key];
  else if (outcome === "aborted" || gain <= -WIN_MARGIN) { r.unsafeUntil[key] = nowSec + UNSAFE_SEC; delete r.mult[key]; } // clearly worse, or unsafe: leave it alone for a while
  else r.mult[key] = Math.min(MAX_MULT, (r.mult[key] ?? 1) * 2); // flat and inconclusive: the step was probably too small to matter, so try a bigger one
  r.cooldownUntil = nowSec + COOLDOWN_SEC;
  r.trial = null;
  return { type: outcome, knob: t.knob, from: t.from, to: t.to, reason: t.reason, why, gain: Math.round(gain * 1000) / 1000, wins };
}

/** Paired new-versus-old differences of one measure across the blocks: mean, wins, and a paired t-statistic. */
function pairedStats(blocks: Block[], pick: (b: Block) => number) {
  const d: number[] = [];
  for (let i = 0; i + 1 < blocks.length; i += 2) if (blocks[i].n && blocks[i + 1].n) d.push(pick(blocks[i]) - pick(blocks[i + 1]));
  const n = d.length;
  const gain = n ? d.reduce((a, x) => a + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(d.reduce((a, x) => a + (x - gain) ** 2, 0) / (n - 1)) : 0;
  return { n, gain, wins: d.filter((x) => x > 0).length, t: gain / Math.max(1e-6, sd / Math.sqrt(Math.max(1, n))) };
}

/**
 * Judge a finished trial from its blocks. A habit is kept only if it clearly improved the one measure it mainly affects (at least
 * 5 of 6 paired blocks, a small average gain, and a paired t of at least 2), while overall wellbeing did not get worse and the
 * battery was not low more often.
 */
export function judge(blocks: Block[], label = "the thing it is meant to improve"): { adopt: boolean; gain: number; wins: number; why: string } {
  const mean = (b: Block, f: "sum" | "tgt") => b[f] / b.n;
  const target = pairedStats(blocks, (b) => mean(b, "tgt"));
  if (target.n < 4) return { adopt: false, gain: 0, wins: 0, why: "too little data to tell" };
  const overall = pairedStats(blocks, (b) => mean(b, "sum"));
  const lowOf = (key: "newB" | "oldB") => { let low = 0, n = 0; for (let i = 0; i + 1 < blocks.length; i += 2) { const b = blocks[key === "newB" ? i : i + 1]; low += b.low; n += b.n; } return n ? low / n : 0; };
  const lowNew = lowOf("newB"), lowOld = lowOf("oldB");
  if (lowNew > lowOld + 0.02) return { adopt: false, gain: target.gain, wins: target.wins, why: `the battery was low more often with the new value (${Math.round(lowNew * 100)}% against ${Math.round(lowOld * 100)}%)` };
  if (overall.gain < -0.005) return { adopt: false, gain: target.gain, wins: target.wins, why: `it cost my overall wellbeing (${overall.gain.toFixed(3)} on average) even though it changed ${label}` };
  if (target.gain >= WIN_MARGIN && target.wins >= MIN_WINS && target.t >= MIN_T) return { adopt: true, gain: target.gain, wins: target.wins, why: `it improved ${label} in ${target.wins} of ${target.n} paired blocks, by ${target.gain.toFixed(3)} on average (t = ${target.t.toFixed(1)}), without costing my overall wellbeing` };
  return { adopt: false, gain: target.gain, wins: target.wins, why: `${label} was better in only ${target.wins} of ${target.n} paired blocks (average ${target.gain >= 0 ? "+" : ""}${target.gain.toFixed(3)}, t = ${target.t.toFixed(1)}), not clearly better than chance` };
}

/**
 * What a chronically unmet need suggests trying (the homeostatic proposer). It aims at the habit that actually limits the need:
 * a need that hovers just under the level that makes the pet act suggests lowering that level; a need that is already above it means
 * the limit is something else (for curiosity, the pause between inspections); and a battery that is often low suggests looking for charge sooner.
 * Habits that were tried without benefit, or unsafely, are skipped for a few days.
 */
function needProposal(p: Pick<PetState, "rules">, nowSec: number, r: RuleState): { knob: KnobName; dir: Direction; reason: string } | null {
  const c = r.chronic;
  const cur = (k: KnobName) => ruleValue(p, nowSec, k);
  const hovering = (need: number, trigger: number) => need < trigger && need >= trigger - 0.2;
  const options: { knob: KnobName; dir: Direction; reason: string; when: boolean }[] = [
    { knob: "batteryLow", dir: "down", reason: "my battery has been low a lot, so I will try going to find charge sooner", when: c.lowBattery > 0.08 },
    { knob: "socialAt", dir: "down", reason: "my need for company hovers just below the point where I go to others, so I will try going sooner", when: hovering(c.social, cur("socialAt")) },
    { knob: "curiousAt", dir: "down", reason: "my curiosity hovers just below the point where I go and look at things, so I will try going sooner", when: hovering(c.curiosity, cur("curiousAt")) },
    { knob: "inspectCooldown", dir: "down", reason: "my curiosity stays high all day even though I act on it, so I will try pausing less between looks", when: c.curiosity >= 0.8 },
  ];
  for (const o of options) if (o.when && !refusal(p, nowSec, o.knob, o.dir)) return o;
  return null;
}

/**
 * Called once per pet tick (after it has acted). Keeps the day-long averages, records how the pet is faring in the current
 * block of any trial, ends the trial when its time is up (or at once if the pet goes dormant under the new value), and, when
 * learning is enabled and nothing is running, lets an unmet need propose a trial. Returns an event when something happened.
 */
export function tickRules(p: PetState, nowSec: number, dt: number, enabled: boolean): RuleEvent | null {
  const r = (p.rules = repairRules(p.rules ?? newRules(nowSec), nowSec));
  const alpha = dt / 86400;
  const w = wellbeing(p);
  if (!r.seen) {
    r.chronic = { curiosity: p.drives.curiosity, social: p.drives.social, rest: p.drives.rest, lowBattery: w.low ? 1 : 0 };
    r.seen = true;
  } else {
    r.chronic.curiosity += (p.drives.curiosity - r.chronic.curiosity) * alpha;
    r.chronic.social += (p.drives.social - r.chronic.social) * alpha;
    r.chronic.rest += (p.drives.rest - r.chronic.rest) * alpha;
    r.chronic.lowBattery += ((w.low ? 1 : 0) - r.chronic.lowBattery) * alpha;
  }
  const t = r.trial;
  if (t) {
    const idx = Math.floor((nowSec - t.startSec) / BLOCK_SEC);
    if (idx >= TRIAL_BLOCKS) {
      const j = judge(t.blocks, TARGET_WORDS[KNOBS[t.knob].target]);
      return finish(p, nowSec, j.adopt ? "adopted" : "reverted", j.why, j.gain, j.wins);
    }
    const cond = condition(t, nowSec);
    while (t.blocks.length <= idx) t.blocks.push({ cond: t.blocks.length % 2 === 0 ? "new" : "old", n: 0, sum: 0, tgt: 0, low: 0, dormant: 0 });
    const b = t.blocks[idx];
    b.n++;
    b.sum += w.x;
    b.tgt += targetScore(p, KNOBS[t.knob].target);
    if (w.low) b.low++;
    if (w.dormant) b.dormant++;
    if (w.dormant && cond === "new") return finish(p, nowSec, "aborted", "the pet went dormant while the new value was in force", -1, 0);
    return null;
  }
  if (!enabled || nowSec < r.cooldownUntil || nowSec - r.born < MIN_AGE_SEC) return null;
  const prop = needProposal(p, nowSec, r);
  return prop ? proposeTune(p, nowSec, prop.knob, prop.dir, prop.reason, "need").event : null;
}

/** For the dashboard: each habit against its default, the trial in progress, and what has been tried. */
export function ruleView(p: Pick<PetState, "rules">, nowSec: number) {
  const r = p.rules;
  return {
    habits: KNOB_NAMES.map((k) => ({ name: k, label: KNOBS[k].label, plain: KNOBS[k].plain, default: KNOBS[k].def, value: r?.values[k] ?? KNOBS[k].def, min: KNOBS[k].min, max: KNOBS[k].max })),
    trial: r?.trial ? { knob: r.trial.knob, from: r.trial.from, to: r.trial.to, reason: r.trial.reason, source: r.trial.source, hoursLeft: Math.max(0, Math.round(((r.trial.startSec + TRIAL_BLOCKS * BLOCK_SEC - nowSec) / 3600) * 10) / 10), using: condition(r.trial, nowSec) } : null,
    history: [...(r?.history ?? [])].reverse(),
    chronic: r ? Object.fromEntries(Object.entries(r.chronic).map(([k, v]) => [k, Math.round(v * 100) / 100])) : null,
  };
}

/** The pet's habits in its own words, for System 2's notes (only when learning is enabled). */
export function describeHabits(p: Pick<PetState, "rules">, nowSec: number): string {
  const r = p.rules;
  const changed = KNOB_NAMES.filter((k) => (r?.values[k] ?? KNOBS[k].def) !== KNOBS[k].def).map((k) => `${KNOBS[k].plain}: ${r!.values[k]} (usual ${KNOBS[k].def})`);
  const t = r?.trial;
  const last = r?.history.at(-1);
  return [
    `Habits I have changed: ${changed.length ? changed.join("; ") : "none"}.`,
    t ? `I am trying out a change: ${KNOBS[t.knob].plain}, from ${t.from} to ${t.to}, to see whether it helps (${t.reason}).` : "I am not trying any change right now.",
    last ? `The last change I tried (${KNOBS[last.knob].plain}, ${last.from} to ${last.to}) was ${last.outcome}: ${last.why}.` : "",
    `Habits I could try changing a little: ${KNOB_NAMES.map((k) => `${k} (${KNOBS[k].plain}, now ${ruleValue(p, nowSec, k)})`).join("; ")}.`,
  ].filter(Boolean).join("\n");
}
