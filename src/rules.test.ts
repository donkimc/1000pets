import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Rng } from "./rng.js";
import { Store } from "./store.js";
import { sense } from "./sensors.js";
import { decide } from "./system1.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { System2, buildNotes, buildPrompt, parseThought } from "./system2.js";
import type { PetDef, PetState } from "./pet.js";
import {
  BLOCK_SEC, COOLDOWN_SEC, KNOBS, KNOB_NAMES, MIN_AGE_SEC, TRIAL_BLOCKS, describeHabits, judge, newRules, proposeTune, refusal, resetRules, ruleValue, ruleView, targetScore, tickRules,
  type Block, type RuleEvent,
} from "./rules.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const DAY = 86400;
const pet = (): PetState => {
  const p = new Simulation(new World(1), 1, roster).pets[0];
  p.rules = newRules(0);
  return p;
};

type Fx = Partial<{ social: number; curiosity: number; rest: number; energy: number; mode: PetState["mode"] }>;
const jit = (rng: Rng, s = 0.01) => (rng.next() - 0.5) * 2 * s;

/** Run a whole trial in 5-second ticks, feeding the pet whatever state f says for the value in force. Returns what happened. */
function runTrial(p: PetState, start: number, f: (cond: "new" | "old", rng: Rng) => Fx, seed = 1) {
  const rng = new Rng(seed);
  const events: RuleEvent[] = [];
  let t = start;
  for (let i = 0; i < TRIAL_BLOCKS * BLOCK_SEC / 5 + 10 && p.rules!.trial; i++, t += 5) {
    const tr = p.rules!.trial!;
    const cond = Math.floor((t - tr.startSec) / BLOCK_SEC) % 2 === 0 ? "new" : "old";
    const fx = f(cond, rng);
    p.drives.curiosity = fx.curiosity ?? 0.5; p.drives.social = fx.social ?? 0.5; p.drives.rest = fx.rest ?? 0.4;
    p.energy = fx.energy ?? 80; p.mode = fx.mode ?? "idle";
    const ev = tickRules(p, t, 5, false);
    if (ev) events.push(ev);
  }
  return { events, end: t };
}

test("the habits start exactly at the thresholds System 1 always used, inside their limits, each judged by what it mainly affects", () => {
  const defaults = { sleepRest: 0.85, sleepRestNight: 0.35, batteryLow: 0.55, socialAt: 0.55, curiousAt: 0.5, inspectCooldown: 600, noveltyPull: 0.55 };
  for (const [k, v] of Object.entries(defaults)) assert.equal(KNOBS[k as keyof typeof KNOBS].def, v, k);
  for (const k of KNOB_NAMES) { const kb = KNOBS[k]; assert.ok(kb.min < kb.def && kb.def < kb.max, k); assert.ok(kb.step > 0 && kb.plain.length > 10); }
  assert.deepEqual(KNOB_NAMES.map((k) => KNOBS[k].target), ["rest", "rest", "battery", "social", "curiosity", "curiosity", "overall"]);
  for (const protectedName of ["avoid", "avoidClearance", "dormant", "criticalBattery", "wake"]) assert.ok(!(KNOB_NAMES as string[]).includes(protectedName), `${protectedName} is a reflex and cannot be tuned`);
  assert.ok(KNOBS.batteryLow.max < 0.7, "however it is tuned, it can never reach the critical-battery override at 0.7");
});

test("a habit's value is the default, the adopted value, or, during a trial, the new and old value in alternating two-hour blocks", () => {
  const p = pet();
  assert.equal(ruleValue(p, 0, "socialAt"), 0.55);
  assert.equal(ruleValue({ rules: undefined }, 0, "socialAt"), 0.55, "pets from before habits");
  p.rules!.values.socialAt = 0.6;
  assert.equal(ruleValue(p, 0, "socialAt"), 0.6);
  const t0 = 3 * DAY;
  proposeTune(p, t0, "socialAt", "down", "x", "need");
  assert.equal(ruleValue(p, t0, "socialAt"), 0.55, "block 0 uses the new value");
  assert.equal(ruleValue(p, t0 + BLOCK_SEC - 1, "socialAt"), 0.55);
  assert.equal(ruleValue(p, t0 + BLOCK_SEC, "socialAt"), 0.6, "block 1 uses the old one");
  assert.equal(ruleValue(p, t0 + 2 * BLOCK_SEC, "socialAt"), 0.55);
  assert.equal(ruleValue(p, t0 + BLOCK_SEC, "curiousAt"), 0.5, "other habits are unaffected by the trial");
});

test("proposals are refused when they are not a real habit, not a real direction, too soon, too frequent, blocked, or at the limit", () => {
  const p = pet();
  const day2 = 2 * DAY;
  assert.match(refusal(p, day2, "avoidClearance", "up")!, /not a habit that can be tuned/);
  assert.match(refusal(p, day2, "socialAt", "sideways")!, /up or down/);
  assert.match(refusal(p, 100, "socialAt", "down")!, /too soon/);
  assert.equal(refusal(p, day2, "socialAt", "down"), null);
  p.rules!.values.socialAt = KNOBS.socialAt.min;
  assert.match(refusal(p, day2, "socialAt", "down")!, /at the limit/);
  p.rules!.values.socialAt = KNOBS.socialAt.max;
  assert.match(refusal(p, day2, "socialAt", "up")!, /at the limit/);
  p.rules!.values = {};
  p.rules!.unsafeUntil["socialAt:down"] = day2 + 100;
  assert.match(refusal(p, day2, "socialAt", "down")!, /clearly worse/);
  assert.equal(refusal(p, day2, "socialAt", "up"), null, "the other direction is still open");
  assert.equal(refusal(p, day2 + 200, "socialAt", "down"), null, "and the block expires");
  p.rules!.cooldownUntil = day2 + 1000;
  assert.match(refusal(p, day2, "socialAt", "up")!, /resting/);
  p.rules!.cooldownUntil = 0;
  assert.ok(proposeTune(p, day2, "socialAt", "up", "x", "need").event);
  assert.match(refusal(p, day2 + 10, "curiousAt", "down")!, /another trial/);
});

test("a proposal starts a trial with a small step, within limits; nothing changes until the evidence is in", () => {
  const p = pet();
  const { event, why } = proposeTune(p, 2 * DAY, "socialAt", "down", "I want company".repeat(30), "thinking");
  assert.equal(why, null);
  assert.equal(event!.type, "trial_started");
  assert.deepEqual([(event as any).from, (event as any).to, (event as any).source], [0.55, 0.5, "thinking"]);
  assert.ok(p.rules!.trial!.reason.length <= 160);
  assert.deepEqual(p.rules!.values, {}, "not adopted yet");
  const q = pet();
  q.rules!.values.inspectCooldown = 250;
  assert.equal((proposeTune(q, 2 * DAY, "inspectCooldown", "down", "x", "need").event as any).to, 200, "clamped to the limit");
  const r = pet();
  assert.equal((proposeTune(r, 2 * DAY, "inspectCooldown", "up", "x", "need").event as any).to, 700);
  assert.equal(proposeTune(pet(), 100, "socialAt", "down", "x", "need").event, null);
});

test("a habit that clearly improves what it is for, without costing overall wellbeing, is adopted", () => {
  const p = pet();
  const t0 = 2 * DAY;
  proposeTune(p, t0, "socialAt", "down", "my need for company has been high", "need");
  const { events } = runTrial(p, t0, (cond, rng) => ({ social: (cond === "new" ? 0.35 : 0.55) + jit(rng) }));
  assert.equal(events.length, 1);
  const e = events[0] as any;
  assert.equal(e.type, "adopted");
  assert.match(e.why, /improved my need for company in 6 of 6 paired blocks.*without costing my overall wellbeing/);
  assert.equal(p.rules!.values.socialAt, 0.5);
  assert.equal(p.rules!.trial, null);
  assert.equal(p.rules!.history.at(-1)!.outcome, "adopted");
  assert.ok(p.rules!.cooldownUntil > t0 + TRIAL_BLOCKS * BLOCK_SEC, "rests after a trial");
  assert.equal(ruleValue(p, t0 + 30 * DAY, "socialAt"), 0.5, "and the new value is simply the habit now");
});

test("a flat, inconclusive trial is undone, and the next try in that direction takes a bigger step", () => {
  const p = pet();
  let t = 2 * DAY;
  proposeTune(p, t, "socialAt", "down", "x", "need");
  const r1 = runTrial(p, t, (_c, rng) => ({ social: 0.5 + jit(rng, 0.002) }));
  assert.equal((r1.events[0] as any).type, "reverted");
  assert.deepEqual(p.rules!.values, {});
  assert.equal(p.rules!.mult["socialAt:down"], 2);
  t = r1.end + COOLDOWN_SEC + 10;
  const second = proposeTune(p, t, "socialAt", "down", "x", "need").event as any;
  assert.deepEqual([second.from, second.to], [0.55, 0.45], "twice the step");
  const r2 = runTrial(p, t, (_c, rng) => ({ social: 0.5 + jit(rng, 0.002) }), 2);
  assert.equal((r2.events[0] as any).type, "reverted");
  assert.equal(p.rules!.mult["socialAt:down"], 4);
  t = r2.end + COOLDOWN_SEC + 10;
  runTrial(p, t, () => ({}), 3); // nothing running: no-op
  proposeTune(p, t, "socialAt", "down", "x", "need");
  runTrial(p, t, (_c, rng) => ({ social: 0.5 + jit(rng, 0.002) }), 3);
  assert.equal(p.rules!.mult["socialAt:down"], 4, "never more than four steps");
});

test("a clearly worse trial is undone and that direction is left alone for three days; a fresh start resets the step", () => {
  const p = pet();
  const t = 2 * DAY;
  proposeTune(p, t, "socialAt", "down", "x", "need");
  const r = runTrial(p, t, (cond, rng) => ({ social: (cond === "new" ? 0.75 : 0.55) + jit(rng) }));
  assert.equal((r.events[0] as any).type, "reverted");
  assert.ok((r.events[0] as any).gain < -0.1);
  assert.ok(p.rules!.unsafeUntil["socialAt:down"] >= r.end + 3 * DAY - 10);
  assert.equal(p.rules!.mult["socialAt:down"], undefined);
  assert.match(refusal(p, r.end + COOLDOWN_SEC + 10, "socialAt", "down")!, /clearly worse/);
});

test("overall wellbeing and the battery are guards: improving one need at their cost is refused", () => {
  const a = pet();
  proposeTune(a, 2 * DAY, "socialAt", "down", "x", "need");
  const costly = runTrial(a, 2 * DAY, (cond, rng) => ({ social: (cond === "new" ? 0.35 : 0.55) + jit(rng), rest: (cond === "new" ? 0.9 : 0.3) + jit(rng) }));
  const e = costly.events[0] as any;
  assert.equal(e.type, "reverted");
  assert.match(e.why, /it cost my overall wellbeing .* even though it changed my need for company/);
  assert.deepEqual(a.rules!.values, {});
  const b = pet();
  proposeTune(b, 2 * DAY, "socialAt", "down", "x", "need");
  const drained = runTrial(b, 2 * DAY, (cond, rng) => ({ social: (cond === "new" ? 0.35 : 0.55) + jit(rng), energy: cond === "new" && rng.chance(0.4) ? 20 : 80 }));
  assert.match((drained.events[0] as any).why, /battery was low more often with the new value/);
  assert.deepEqual(b.rules!.values, {});
});

test("a pet that goes dormant while the new value is in force aborts the trial at once; dormancy under the old value does not", () => {
  const p = pet();
  const t0 = 2 * DAY;
  proposeTune(p, t0, "socialAt", "down", "x", "need");
  const r = runTrial(p, t0, (cond) => (cond === "new" && 0 === 0 ? { mode: "dormant", energy: 0 } : {}));
  assert.equal((r.events[0] as any).type, "aborted");
  assert.match((r.events[0] as any).why, /went dormant while the new value was in force/);
  assert.ok(r.end < t0 + 10, "stopped on the first tick");
  assert.deepEqual(p.rules!.values, {});
  assert.ok(p.rules!.unsafeUntil["socialAt:down"] > r.end);
  const q = pet();
  proposeTune(q, t0, "socialAt", "down", "x", "need");
  const r2 = runTrial(q, t0, (cond) => (cond === "old" ? { mode: "dormant", energy: 0 } : {}));
  assert.equal((r2.events[0] as any).type, "reverted", "dormant under the OLD value is not the new value's fault, and it finished");
});

test("judging a trial: too little data, a lucky streak that is not clearly more than noise, and a clear win", () => {
  const blk = (cond: "new" | "old", tgt: number, sum = 0.6): Block => ({ cond, n: 100, sum: sum * 100, tgt: tgt * 100, low: 0, dormant: 0 });
  assert.match(judge([blk("new", 0.6), blk("old", 0.5)]).why, /too little data/);
  const noisy: Block[] = [];
  for (const [n, o] of [[0.53, 0.50], [0.50, 0.55], [0.54, 0.50], [0.53, 0.50], [0.52, 0.50], [0.52, 0.50]]) noisy.push(blk("new", n), blk("old", o));
  const j1 = judge(noisy);
  assert.equal(j1.wins, 5);
  assert.equal(j1.adopt, false, "5 of 6 wins and a small average gain, but the one loss makes it too uncertain to call");
  assert.match(j1.why, /not clearly better than chance/);
  const clear: Block[] = [];
  for (const [n, o] of [[0.62, 0.50], [0.60, 0.52], [0.65, 0.51], [0.61, 0.52], [0.66, 0.54], [0.63, 0.53]]) clear.push(blk("new", n), blk("old", o));
  const j2 = judge(clear, "my need for company");
  assert.equal(j2.adopt, true);
  assert.match(j2.why, /improved my need for company in 6 of 6 paired blocks/);
});

test("what each habit is judged by", () => {
  const base = { drives: { energy: 0.2, curiosity: 0.3, social: 0.6, rest: 0.1 }, energy: 80, mode: "idle" as const };
  assert.ok(Math.abs(targetScore(base, "social") - 0.4) < 1e-9);
  assert.ok(Math.abs(targetScore(base, "curiosity") - 0.7) < 1e-9);
  assert.ok(Math.abs(targetScore(base, "rest") - 0.9) < 1e-9);
  assert.ok(targetScore({ ...base, energy: 10 }, "battery") < targetScore(base, "battery"));
  assert.ok(targetScore({ ...base, mode: "dormant", energy: 0 }, "overall") < targetScore(base, "overall"));
});

test("an unmet need proposes a habit that can actually help: lower a trigger the need hovers under, not one it is already above", () => {
  const prop = (set: (c: any) => void, at = 3 * DAY, enabled = true) => {
    const p = pet();
    tickRules(p, 0, 5, false); // start watching
    p.rules!.chronic = { curiosity: 0.1, social: 0.1, rest: 0.1, lowBattery: 0 }; // everything comfortable, then one thing is not
    set(p.rules!.chronic);
    const ev = tickRules(p, at, 5, enabled);
    return { p, ev: ev as any };
  };
  const hover = prop((c) => (c.social = 0.45));
  assert.equal(hover.ev.type, "trial_started");
  assert.deepEqual([hover.ev.knob, hover.ev.from, hover.ev.to, hover.ev.source], ["socialAt", 0.55, 0.5, "need"]);
  assert.match(hover.ev.reason, /hovers just below .*going sooner/);
  assert.equal(prop((c) => (c.social = 0.9)).ev, null, "already above the trigger: a lower trigger changes nothing, so no proposal");
  assert.equal(prop((c) => (c.social = 0.2)).ev, null, "far below it: nothing to fix");
  assert.equal(prop((c) => (c.curiosity = 0.42)).ev.knob, "curiousAt");
  assert.equal(prop((c) => (c.curiosity = 1)).ev.knob, "inspectCooldown", "curiosity high and already acted on: the pause between looks is the limit");
  assert.equal(prop((c) => { c.lowBattery = 0.2; c.social = 0.45; }).ev.knob, "batteryLow", "a drained battery comes first");
  assert.equal(prop((c) => (c.social = 0.45), 3 * DAY, false).ev, null, "nothing happens when learning is off");
  assert.equal(prop((c) => (c.social = 0.45), 3600).ev, null, "nothing in the first day");
  const blocked = pet();
  tickRules(blocked, 0, 5, false);
  blocked.rules!.chronic.social = 0.45; blocked.rules!.chronic.curiosity = 1;
  blocked.rules!.unsafeUntil["socialAt:down"] = 9 * DAY;
  assert.equal((tickRules(blocked, 3 * DAY, 5, true) as any).knob, "inspectCooldown", "a blocked habit is skipped for the next candidate");
  const resting = pet();
  tickRules(resting, 0, 5, false);
  resting.rules!.chronic.social = 0.45; resting.rules!.cooldownUntil = 5 * DAY;
  assert.equal(tickRules(resting, 3 * DAY, 5, true), null);
});

// ---- System 1 reads the habits ----
function scene1(over: (p: PetState, sim: Simulation) => void) {
  const sim = new Simulation(new World(1), 1, roster);
  const [p, other, third] = sim.pets;
  p.x = 600; p.y = 500; p.heading = 0; other.x = 800; other.y = 500; third.x = 100; third.y = 650;
  sim.human.x = 100; sim.human.y = 300; sim.teacher.x = 200; sim.teacher.y = 450;
  sim.world.setOverride("beaconOn", false); // keep the tone out of the way
  sim.world.snap.simMinute = 600; // daytime
  p.energy = 80; p.drives.curiosity = 0; p.drives.social = 0; p.drives.rest = 0.1;
  over(p, sim);
  const obs = sense(p, sim.pets, sim.world, [], 0, new Rng(1), sim.human, sim.teacher);
  const act = (nowSec: number) => decide(p, obs, new Rng(1), nowSec).action;
  return { p, sim, obs, act };
}

test("System 1 uses the pet's own habits: the same state gives a different choice once a habit has changed", () => {
  const social = (v?: number) => scene1((p) => { p.drives.social = 0.5; if (v !== undefined) p.rules = { ...newRules(0), values: { socialAt: v } }; }).act(1000);
  assert.notEqual(social(), "approach_pet");
  assert.equal(social(0.45), "approach_pet");
  const seek = (v?: number) => scene1((p) => { p.energy = 50; if (v !== undefined) p.rules = { ...newRules(0), values: { batteryLow: v } }; }).act(1000);
  assert.notEqual(seek(), "seek_light");
  assert.equal(seek(0.45), "seek_light");
  const sleep = (v?: number) => scene1((p) => { p.drives.rest = 0.7; if (v !== undefined) p.rules = { ...newRules(0), values: { sleepRest: v } }; }).act(1000);
  assert.notEqual(sleep(), "sleep");
  assert.equal(sleep(0.6), "sleep");
  const night = (v?: number) => scene1((p, sim) => { sim.world.snap.simMinute = 60; p.drives.rest = 0.3; if (v !== undefined) p.rules = { ...newRules(0), values: { sleepRestNight: v } }; }).act(1000);
  assert.notEqual(night(), "sleep");
  assert.equal(night(0.25), "sleep");
});

test("curiosity habits: the trigger and the pause after inspecting", () => {
  const place = (p: PetState) => { p.x = 500; p.y = 330; p.heading = -Math.PI / 2; p.drives.curiosity = 0.45; }; // the plant is ahead, well clear of the table behind
  const look = (v?: number) => scene1((p) => { place(p); if (v !== undefined) p.rules = { ...newRules(0), values: { curiousAt: v } }; }).act(1000);
  assert.notEqual(look(), "approach_object");
  assert.equal(look(0.4), "approach_object");
  const s = scene1((p) => { place(p); p.drives.curiosity = 0.9; p.x = 500; p.y = 275; p.rules = { ...newRules(0), values: { inspectCooldown: 1800 } }; });
  const d = decide(s.p, s.obs, new Rng(1), 1000);
  assert.equal(d.action, "inspect");
  assert.equal(s.p.s1.inspectCooldownUntil, s.p.s1.holdUntil + 1800, "the pause after looking is the habit");
});

test("during a trial the pet's choice follows the block: new value, then old, then new again", () => {
  const { p, obs } = scene1((q) => { q.drives.social = 0.5; });
  p.rules = newRules(0);
  p.rules.trial = { knob: "socialAt", from: 0.55, to: 0.45, startSec: 1000, reason: "x", source: "need", blocks: [] };
  const at = (t: number) => decide(p, obs, new Rng(1), t).action;
  assert.equal(at(1000 + 60), "approach_pet", "block 0: new value");
  assert.notEqual(at(1000 + BLOCK_SEC + 60), "approach_pet", "block 1: old value");
  assert.equal(at(1000 + 2 * BLOCK_SEC + 60), "approach_pet", "block 2: new again");
});

test("reflexes cannot be tuned away: a critical battery still wins over any sleepiness habit, and no habit touches avoiding or dormancy", () => {
  const { act } = scene1((p) => { p.energy = 20; p.drives.rest = 0.95; p.rules = { ...newRules(0), values: { sleepRest: 0.6, sleepRestNight: 0.2 } }; });
  assert.notEqual(act(1000), "sleep", "battery at 20% is critical: the pet looks for charge however sleepy it is");
  const avoid = scene1((p, sim) => { sim.pets[1].x = p.x + 40; sim.pets[1].y = p.y; p.rules = { ...newRules(0), values: { socialAt: 0.35, curiousAt: 0.3 } }; });
  assert.equal(avoid.act(1000), "avoid", "an obstacle right ahead is avoided whatever the habits");
  const dorm = scene1((p) => { p.mode = "dormant"; p.energy = 0; p.drives.social = 0.9; p.rules = { ...newRules(0), values: { socialAt: 0.35 } }; });
  assert.equal(dorm.act(1000), "dormant");
});

// ---- System 2 ----
test("System 2 may suggest a habit change, but only when learning is on; the prompt only mentions habits then", () => {
  const p = pet();
  const off = buildPrompt(p, 1, 600, 0, 600, false, false), on = buildPrompt(p, 1, 600, 0, 600, false, true);
  assert.doesNotMatch(off.system, /"tune"/);
  assert.doesNotMatch(off.user, /My habits/);
  assert.match(on.system, /"tune": null or \{"habit": one of "sleepRest", "sleepRestNight", "batteryLow", "socialAt", "curiousAt", "inspectCooldown", "noveltyPull"/);
  assert.match(on.system, /almost always null[\s\S]*kept only if it truly helps/);
  assert.match(on.user, /My habits \(small things about how I live[\s\S]*Habits I have changed: none\.[\s\S]*I am not trying any change right now\./);
  assert.match(on.user, /socialAt \(how much I need company before I go to another pet, now 0\.55\)/);
  const t = parseThought(JSON.stringify({ thought: "x", question: "q", beliefs: [], suggestion: "none", tune: { habit: "socialAt", direction: "down", why: "I am lonely" } }))!;
  assert.deepEqual(t.tune, { habit: "socialAt", direction: "down", why: "I am lonely" });
  for (const bad of [{ habit: "avoid", direction: "down" }, { habit: "socialAt", direction: "sideways" }, "socialAt", null]) assert.equal(parseThought(JSON.stringify({ thought: "x", tune: bad }))!.tune, null);
});

test("a suggested habit change starts a trial and is logged, only when learning is on and the proposal is allowed", async () => {
  const sim = new Simulation(new World(1), 1, roster);
  sim.simSec = 3 * DAY;
  const p = sim.pets[0];
  p.rules = newRules(0);
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "habits-")), "t");
  let reply = { habit: "socialAt", direction: "down", why: "I want company sooner" };
  const llm: any = { enabled: true, async complete() { return { text: JSON.stringify({ thought: "A thought.", question: "q" + Math.random(), beliefs: [], suggestion: "none", tune: reply }), provider: "x", model: "m", tokensIn: 1, tokensOut: 1 }; } };
  const s2 = new System2(sim, llm, store, { intervalSec: 1, isPaused: () => false });
  await s2.think(p);
  assert.equal(p.rules!.trial, null, "learning is off: ignored");
  sim.ruleLearning = true;
  await s2.think(p);
  assert.equal(p.rules!.trial!.knob, "socialAt");
  assert.equal(p.rules!.trial!.source, "thinking");
  assert.equal(p.rules!.trial!.reason, "I want company sooner");
  const log = await store.readLog<any>(`thoughts/${p.id}`);
  assert.equal(log.find((t) => t.stage === "habit").event.type, "trial_started");
  assert.deepEqual(log.at(-2)?.tune ?? log.find((t) => t.system === 2 && t.tune)?.tune, { habit: "socialAt", direction: "down", why: "I want company sooner" });
  const before = p.rules!.trial;
  reply = { habit: "curiousAt", direction: "down", why: "x" };
  await s2.think(p);
  assert.equal(p.rules!.trial, before, "one trial at a time: the second suggestion is refused, not queued");
});

test("a pet's habits can be reset, and are described in its own words", () => {
  const p = pet();
  p.rules!.values.socialAt = 0.5;
  p.rules!.history.push({ knob: "socialAt", from: 0.55, to: 0.5, tSec: 10, outcome: "adopted", reason: "x", why: "it improved my need for company in 6 of 6 paired blocks", gain: 0.1, wins: 6 });
  proposeTune(p, 3 * DAY, "curiousAt", "down", "I want to look at things", "need");
  const text = describeHabits(p, 3 * DAY);
  assert.match(text, /Habits I have changed: how much I need company before I go to another pet: 0\.5 \(usual 0\.55\)/);
  assert.match(text, /I am trying out a change: how curious I must be before I go and look at something, from 0\.5 to 0\.45/);
  assert.match(text, /The last change I tried .* was adopted: it improved my need for company/);
  const v = ruleView(p, 3 * DAY);
  assert.equal(v.habits.find((h) => h.name === "socialAt")!.value, 0.5);
  assert.equal(v.trial!.knob, "curiousAt");
  assert.equal(v.trial!.hoursLeft, 24);
  resetRules(p, 3 * DAY);
  assert.deepEqual(p.rules!.values, {});
  assert.equal(p.rules!.trial, null);
  assert.equal(p.rules!.history.length, 1, "what was tried stays on record");
  assert.ok(p.rules!.cooldownUntil > 3 * DAY);
  assert.equal(ruleValue(p, 3 * DAY, "socialAt"), 0.55);
});

test("kept habits travel in a brain file, held within their limits; a trial in progress does not; older brains are fine", () => {
  const sim = new Simulation(new World(2), 2, roster);
  const p = sim.pets[0];
  p.rules = { ...newRules(0), values: { socialAt: 0.5, inspectCooldown: 400 } };
  proposeTune(p, 3 * DAY, "curiousAt", "down", "x", "need");
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, 3 * DAY))));
  assert.deepEqual(file.habits, { socialAt: 0.5, inspectCooldown: 400 });
  const other = new Simulation(new World(3), 3, roster).pets[1];
  applyBrain(other, file, 100);
  assert.deepEqual(other.rules!.values, { socialAt: 0.5, inspectCooldown: 400 });
  assert.equal(other.rules!.trial, null);
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), habits: { socialAt: 99, inspectCooldown: -5, avoid: 0.1, curiousAt: "x", sleepRest: 0.7 } });
  assert.deepEqual(dirty.habits, { socialAt: 0.8, inspectCooldown: 200, sleepRest: 0.7 });
  assert.deepEqual(parseBrain({ ...JSON.parse(JSON.stringify(file)), habits: undefined }).habits, {});
});

test("saves from before habits load: the setting defaults to off and pets have no habit state", () => {
  const sim = new Simulation(new World(4), 4, roster);
  sim.step(3600_000);
  const snap: any = JSON.parse(JSON.stringify(sim.snapshot()));
  delete snap.ruleLearning;
  for (const q of snap.pets) delete q.rules;
  const old = new Simulation(sim.world, 4, roster, snap);
  assert.equal(old.ruleLearning, false);
  old.step(sim.simSec * 1000 + 1800_000);
  assert.ok(old.pets.every((q) => q.rules && Object.keys(q.rules.values).length === 0));
  sim.ruleLearning = true;
  assert.equal(new Simulation(sim.world, 4, roster, JSON.parse(JSON.stringify(sim.snapshot()))).ruleLearning, true, "the setting is saved with the simulation");
});

test("in the running simulation: off means no habit activity at all and identical lives; on stays safe, in bounds, deterministic and logged", () => {
  const run = (learning: boolean | undefined) => {
    const sim = new Simulation(new World(5), 5, roster);
    if (learning !== undefined) sim.ruleLearning = learning;
    const habits: any[] = [];
    let dormant = 0;
    for (let h = 1; h <= 8 * 24; h++) {
      const r = sim.step(h * 3600_000);
      for (const t of r.thoughts as any[]) if (t.stage === "habit") habits.push(t);
      dormant += sim.pets.filter((p) => p.mode === "dormant").length;
    }
    return { sim, habits, dormant };
  };
  const offA = run(undefined), offB = run(false);
  assert.equal(offA.habits.length, 0);
  assert.deepEqual(offA.sim.pets.map((p) => [p.x, p.y, p.energy]), offB.sim.pets.map((p) => [p.x, p.y, p.energy]), "off: the same lives");
  assert.ok(offA.sim.pets.every((p) => Object.keys(p.rules?.values ?? {}).length === 0 && !p.rules?.trial));
  const a = run(true), b = run(true);
  assert.ok(a.habits.length >= 3, `learning on should start some trials in 8 days, saw ${a.habits.length}`);
  assert.ok(a.habits.some((t) => t.event.type === "trial_started"));
  assert.ok(a.habits.every((t) => t.system === 3 && KNOB_NAMES.includes(t.event.knob)));
  assert.equal(a.dormant, 0, "no pet went dormant");
  for (const p of a.sim.pets) for (const [k, v] of Object.entries(p.rules!.values)) assert.ok((v as number) >= KNOBS[k as keyof typeof KNOBS].min && (v as number) <= KNOBS[k as keyof typeof KNOBS].max, k);
  assert.deepEqual(a.sim.pets.map((p) => p.rules), b.sim.pets.map((p) => p.rules), "deterministic");
  assert.deepEqual(a.habits.map((t) => t.event), b.habits.map((t) => t.event));
});

test("the notes for System 2 include the habits block only when asked", () => {
  const p = pet();
  assert.doesNotMatch(buildNotes(p, 1, 600, 0, 600), /My habits/);
  assert.match(buildNotes(p, 1, 600, 0, 600, true), /My habits \(small things about how I live that I am allowed to try changing a little\):/);
  assert.ok(MIN_AGE_SEC === DAY, "a pet watches itself for a day first");
});

test("habit state saved by an older version (no step multipliers, no chronic counters) loads and keeps running", () => {
  const sim = new Simulation(new World(1), 1, roster);
  sim.ruleLearning = true;
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  snap.ruleLearning = true;
  snap.pets[0].rules = { values: {}, trial: null, history: [], cooldownUntil: 0, unsafeUntil: {}, seen: false, born: 0 }; // as an older version wrote it
  const again = new Simulation(new World(1), 1, roster, snap);
  assert.deepEqual(again.pets[0].rules!.mult, {}, "the missing step multipliers are filled in");
  assert.deepEqual(Object.keys(again.pets[0].rules!.chronic).sort(), ["curiosity", "lowBattery", "rest", "social"]);
  const r = proposeTune(again.pets[0], 100, "socialAt", "down", "test", "thinking"); // this is what used to throw
  assert.ok(r.event || r.why, "a proposal was considered without throwing");
  for (let s = 5; s <= 7200; s += 5) again.step(s * 1000);
});
