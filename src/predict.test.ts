import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Rng } from "./rng.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { buildNotes } from "./system2.js";
import { captureSurpriseScene, surpriseKind } from "./scenes.js";
import { newCue, startGoal, updateCues } from "./cues.js";
import { MAX_RECENT, MIN_N, describeExpectations, describeSurprises, learn, predictView, recordSurprise, scoreOf, updatePredictions, type Surprise } from "./predict.js";
import type { PetDef, PetState } from "./pet.js";
import type { Observation } from "./sensors.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const pet = () => new Simulation(new World(1), 1, roster).pets[0];

// The few fields the predictor reads from an observation.
type O = { light?: number; temperature?: number; energy?: number; chargeRate?: number; tone?: number | null };
const obs = (o: O = {}): Observation => {
  const { tone, ...rest } = o;
  return { light: 30, temperature: 20, energy: 60, chargeRate: 0, near: [], vision: [], tone: tone == null ? null : { volume: tone, bearing: 0, pitch: 534 }, ...rest } as any as Observation;
};
const prevTick = (o: Partial<{ light: number; tone: number | null; moving: boolean; following: boolean }> = {}) => ({ light: 30, temperature: 20, energy: 60, tone: null as number | null, moving: false, following: false, mode: "idle", charging: false, ...o });
const jitter = (rng: Rng, s: number) => (rng.next() - 0.5) * 2 * s;

/** Feed n quiet ticks so the pet learns what normal looks like. */
function settle(p: PetState, n: number, make: (i: number) => O, t0 = 0) {
  for (let i = 0; i < n; i++) updatePredictions(p, obs(make(i)), t0 + i * 5);
  return t0 + n * 5;
}

test("an expectation is a running average and spread of what actually happened, and forgets slowly", () => {
  const s = { n: 0, mean: 0, var: 0, up: 0 };
  const rng = new Rng(1);
  for (let i = 0; i < 400; i++) learn(s, 2 + jitter(rng, 1));
  assert.ok(Math.abs(s.mean - 2) < 0.4, `mean ${s.mean}`);
  assert.ok(Math.sqrt(s.var) > 0.3 && Math.sqrt(s.var) < 1, `sd ${Math.sqrt(s.var)}`);
  assert.equal(s.up, 400);
  for (let i = 0; i < 1500; i++) learn(s, -5 + jitter(rng, 1));
  assert.ok(s.mean < -4, "follows a lasting change, over a few hundred observations");
  assert.equal(scoreOf(2.9), 0);
  assert.equal(scoreOf(3), 0);
  assert.ok(scoreOf(5.5) > 0.4 && scoreOf(5.5) < 0.6);
  assert.equal(scoreOf(-9), 1, "either direction");
});

test("a pet cannot be surprised until it knows what normal is; then a sudden jump is, once per five minutes", () => {
  const p = pet();
  const rng = new Rng(2);
  let t = 0;
  // before it has learned anything a big jump is just a number
  updatePredictions(p, obs({ light: 20 }), t); t += 5;
  assert.deepEqual(updatePredictions(p, obs({ light: 90 }), t), []);
  t = settle(p, MIN_N + 20, () => ({ light: 30 + jitter(rng, 0.4) }), t + 5);
  p.predict!.prev = prevTick();
  const s = updatePredictions(p, obs({ light: 75 }), t);
  assert.equal(s.length, 1);
  assert.equal(s[0].channel, "light");
  assert.equal(s[0].score, 1);
  assert.match(s[0].why, /the light jumped up by 45 in a moment/);
  assert.equal(p.predict!.recent.length, 1);
  // another jump straight away is not recorded again
  assert.deepEqual(updatePredictions(p, obs({ light: 20 }), t + 5), []);
  // once the cooldown has passed it is
  settle(p, 5, () => ({ light: 20 }), t + 10);
  p.predict!.prev = prevTick({ light: 20 });
  assert.equal(updatePredictions(p, obs({ light: 80 }), t + 400).length, 1);
});

test("moving and standing still have separate expectations, and a change that lasts stops being surprising", () => {
  const p = pet();
  const rng = new Rng(3);
  let t = 0;
  p.speed = 20; // walking through bright and dim patches: the light changes a lot
  t = settle(p, 80, () => ({ light: 30 + jitter(rng, 25) }), t);
  p.speed = 0;
  t = settle(p, 80, () => ({ light: 30 + jitter(rng, 0.4) }), t);
  p.predict!.prev = prevTick();
  assert.equal(updatePredictions(p, obs({ light: 50 }), t).length, 1, "a 20 jump while standing still is a shock");
  p.predict!.lastAt = {};
  p.speed = 20;
  p.predict!.prev = prevTick({ moving: true }); // it was walking during the interval being measured
  assert.equal(updatePredictions(p, obs({ light: 50 }), t + 10).length, 0, "the same jump while walking is normal for it");
  // the lamp stays on: after the jump the new level is just how things are
  p.speed = 0;
  p.predict!.lastAt = {};
  settle(p, 40, () => ({ light: 50 + jitter(rng, 0.4) }), t + 20);
  p.predict!.prev = prevTick({ light: 50 });
  assert.equal(updatePredictions(p, obs({ light: 50.5 }), t + 1000).length, 0);
});

test("a tone that was being heard and suddenly stops is a surprise; fading out at the edge of hearing is not; coming back loud is", () => {
  const p = pet();
  let t = settle(p, MIN_N + 40, () => ({ tone: 0.5 }));
  const lost = updatePredictions(p, obs({ tone: null }), t);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].channel, "tonePresence");
  assert.equal(lost[0].ctx, "vanished");
  assert.match(lost[0].why, /steady tone I was hearing suddenly stopped/);
  assert.ok(lost[0].score > 0.4);
  assert.equal(surpriseKind(lost[0].channel, lost[0].ctx), "tonelost");
  // silent for a long while, then loud again at once
  t = settle(p, MIN_N + 40, () => ({ tone: null }), t + 5);
  const back = updatePredictions(p, obs({ tone: 0.5 }), t);
  assert.equal(back.length, 1);
  assert.equal(back[0].ctx, "appeared");
  assert.match(back[0].why, /came back, loud/);
  assert.equal(surpriseKind(back[0].channel, back[0].ctx), "toneback");
  // walking out of range: quieter and quieter, then nothing. That is how hearing works, not a surprise.
  const q = pet();
  q.speed = 20; // walking away: how loud it is changes a lot from one moment to the next
  const rng = new Rng(8);
  let u = settle(q, MIN_N + 40, () => ({ tone: 0.5 + jitter(rng, 0.12) }));
  for (const v of [0.4, 0.3, 0.2, 0.1, 0.06]) { assert.deepEqual(updatePredictions(q, obs({ tone: v }), u), []); u += 5; }
  assert.deepEqual(updatePredictions(q, obs({ tone: null }), u), [], "it was already faint, so losing it is expected");
});

test("how surprising a vanishing tone is depends on how often it has stopped before", () => {
  const steady = pet(), flaky = pet();
  let a = settle(steady, 200, () => ({ tone: 0.5 }));
  let b = 0;
  for (let i = 0; i < 20; i++) { b = settle(flaky, 10, () => ({ tone: 0.5 }), b); updatePredictions(flaky, obs({ tone: null }), b); b += 5; b = settle(flaky, 3, () => ({ tone: null }), b); }
  b = settle(flaky, 10, () => ({ tone: 0.5 }), b + 1000);
  const s1 = updatePredictions(steady, obs({ tone: null }), a)[0];
  flaky.predict!.lastAt = {};
  const s2 = updatePredictions(flaky, obs({ tone: null }), b);
  assert.ok(s1.score > 0.5);
  assert.ok(s2.length === 0 || s2[0].score < s1.score, "a tone that keeps cutting out is no shock when it does");
});

test("walking toward a tone it learns the tone gets louder; if it gets quieter instead, that is a surprise", () => {
  const p = pet();
  const rng = new Rng(4);
  p.s1.action = "follow_tone";
  let v = 0.2, t = 0;
  for (let i = 0; i < MIN_N + 20; i++) { v = Math.min(0.9, v + 0.01 + jitter(rng, 0.004)); if (v >= 0.9) v = 0.2; updatePredictions(p, obs({ tone: v }), t); t += 5; }
  assert.match(describeExpectations(p), /When I walk toward a steady tone it has got louder \d{2,3}% of the time\./);
  p.predict!.prev = prevTick({ tone: 0.5, following: true });
  const s = updatePredictions(p, obs({ tone: 0.3 }), t);
  const drift = s.find((x) => x.channel === "toneVolume");
  assert.ok(drift, "got quieter while following");
  assert.match(drift!.why, /walking toward the steady tone but it got quieter, not louder/);
  assert.equal(surpriseKind("toneVolume", "following"), "tonedrift");
  assert.equal(surpriseKind("toneVolume", "moving"), null);
  assert.equal(surpriseKind("toneVolume", "still"), null);
});

test("reaching the loud end of the tone and not being charged is a surprise, scaled by how much the pet trusted it", () => {
  const p = pet();
  const near = (extra: Record<string, unknown> = {}) => ({ ...obs({ tone: 0.95 }), near: [], ...extra }) as Observation;
  p.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 9000, support: 40, contra: 0 };
  p.chargeRate = 0;
  updateCues(p, near(), 0, 5);
  startGoal(p, near().tone!, 0);
  p.s1.action = "follow_tone";
  let found: Surprise[] = [];
  for (let t = 5; t <= 140; t += 5) found = found.concat(updateCues(p, near(), t, 5));
  assert.equal(found.length, 1);
  assert.equal(found[0].channel, "charge");
  assert.ok(found[0].score > 0.9, `a tone that has never failed it failing is a big surprise (${found[0].score})`);
  assert.match(found[0].why, /expected to be charged, but it did not happen/);
  assert.equal(surpriseKind("charge", "nocharge"), "nocharge");
  // someone else on the pad: not counted against the tone, but still not what the pet expected
  const q = pet();
  q.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 9000, support: 85, contra: 15 }; // works about 85% of the time
  const crowded = near({ near: [{ category: "moving", gap: 5, bearing: 0 }] });
  updateCues(q, crowded, 0, 5);
  startGoal(q, crowded.tone!, 0);
  q.s1.action = "follow_tone";
  let more: Surprise[] = [];
  for (let t = 5; t <= 140; t += 5) more = more.concat(updateCues(q, crowded, t, 5));
  assert.equal(more.length, 1);
  assert.equal(q.mind.cues["tone:29"].contra, 15, "not counted against the tone");
  assert.ok(more[0].score < 0.4 && more[0].score >= 0.25, `failing now and then is no shock to a pet that knows it works 85% of the time (${more[0].score})`);
  // too few tries to know how reliable it is
  const r = pet();
  r.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 9000, support: 3, contra: 0 };
  updateCues(r, near(), 0, 5); startGoal(r, near().tone!, 0); r.s1.action = "follow_tone";
  let few: Surprise[] = [];
  for (let t = 5; t <= 140; t += 5) few = few.concat(updateCues(r, near(), t, 5));
  assert.equal(few[0].score, 0.3);
});

test("a surprise lifts curiosity a little, never past the top, and is only kept if it is real and not a repeat", () => {
  const p = pet();
  p.drives.curiosity = 0.3;
  const s = (score: number, t: number, channel = "light"): Surprise => ({ tSec: t, channel, ctx: "still", expected: 0, actual: 9, score, why: "x" });
  assert.equal(recordSurprise(p, s(0.1, 0)), false, "too faint to count");
  assert.equal(p.drives.curiosity, 0.3);
  assert.equal(recordSurprise(p, s(1, 0)), true);
  assert.ok(Math.abs(p.drives.curiosity - 0.4) < 1e-9);
  assert.equal(recordSurprise(p, s(1, 100)), false, "same channel inside five minutes");
  p.drives.curiosity = 0.98;
  recordSurprise(p, s(1, 1000));
  assert.equal(p.drives.curiosity, 1);
  for (let i = 0; i < 40; i++) recordSurprise(p, s(0.9, 2000 + i * 400));
  assert.equal(p.predict!.recent.length, MAX_RECENT);
});

test("a broken expectation becomes a memorable moment, the more important the more surprising; ordinary channels do not", () => {
  const p = pet();
  const o = obs({ tone: 0.6 });
  const rng = new Rng(5);
  const s = captureSurpriseScene(p, o, 1000, rng, { channel: "tonePresence", ctx: "vanished", score: 1, why: "the steady tone I was hearing suddenly stopped" })!;
  assert.equal(s.kind, "tonelost");
  assert.ok(s.importance >= 0.88 && s.importance <= 0.92);
  assert.equal(s.why, "the steady tone I was hearing suddenly stopped");
  assert.deepEqual(s.tone, { pitch: 534, volume: 0.6 });
  assert.ok(p.mind.scenes.includes(s));
  assert.equal(captureSurpriseScene(p, o, 1100, rng, { channel: "tonePresence", ctx: "vanished", score: 1, why: "again" }), null, "same kind inside ten minutes");
  const mild = captureSurpriseScene(p, o, 3000, rng, { channel: "charge", ctx: "nocharge", score: 0.3, why: "no charge" })!;
  assert.ok(mild.importance < 0.7 && mild.importance > 0.55);
  assert.equal(captureSurpriseScene(p, o, 4000, rng, { channel: "light", ctx: "still", score: 1, why: "bright" }), null, "light is already covered by its own trigger");
});

test("System 2's notes say how well the pet can predict things and what surprised it lately, and nothing about what the tone is", () => {
  const p = pet();
  assert.match(buildNotes(p, 1, 600, 0, 600), /How well I can predict things: I have not been watching long enough/);
  assert.match(buildNotes(p, 1, 600, 0, 600), /What has surprised me lately \(something I expected did not happen\):\n- \(nothing\)/);
  recordSurprise(p, { tSec: 1000, channel: "tonePresence", ctx: "vanished", expected: 1, actual: 0, score: 0.9, why: "the steady tone I was hearing suddenly stopped" });
  recordSurprise(p, { tSec: 2000, channel: "light", ctx: "still", expected: 0, actual: 40, score: 0.4, why: "the light jumped up by 40 in a moment; I expected a change of about 0" });
  const lines = describeSurprises(p, 3000);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- D1 00:16 the steady tone I was hearing suddenly stopped \(very surprising\)$/, "the bigger surprise comes first");
  assert.match(lines[1], /\(somewhat surprising\)/);
  assert.deepEqual(describeSurprises(p, 3000 + 7 * 3600), [], "old surprises drop out of the notes");
  const notes = buildNotes(p, 1, 600, 0, 3000);
  assert.match(notes, /- D1 00:16 the steady tone I was hearing suddenly stopped/);
  assert.doesNotMatch(notes.split("What has surprised me lately")[1].split("What I have worked out")[0], /charger|beacon/i);
});

test("what a pet has learned to expect travels in its brain file; what surprised it yesterday does not; bad data is cleaned", () => {
  const sim = new Simulation(new World(2), 2, roster);
  const p = sim.pets[0];
  const rng = new Rng(6);
  settle(p, 120, () => ({ light: 30 + jitter(rng, 1), tone: 0.5 }));
  recordSurprise(p, { tSec: 1, channel: "light", ctx: "still", expected: 0, actual: 40, score: 1, why: "x" });
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, 500))));
  assert.ok(file.expect!.stats.some((st) => st.key === "light:still" && st.n >= 100));
  assert.equal(file.expect!.presence.present, p.predict!.presence.present);
  const other = new Simulation(new World(3), 3, roster).pets[1];
  applyBrain(other, file, 100);
  assert.deepEqual(other.predict!.stats["light:still"], p.predict!.stats["light:still"]);
  assert.equal(other.predict!.recent.length, 0, "yesterday's surprises stay behind");
  assert.equal(other.predict!.level, 0);
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), expect: { stats: [{ key: "<b>", n: 5 }, { key: "light:still", n: -4, mean: 1e12, var: -3, up: 9e9 }, ...Array(30).fill({ key: "temperature:still", n: 3 })], presence: { present: 5, vanished: 99, absent: -1, appeared: 7 } } });
  assert.equal(dirty.expect!.stats.length, 15, "first 16 looked at, the unsafe key dropped");
  const st = dirty.expect!.stats[0];
  assert.deepEqual([st.n, st.mean, st.var, st.up], [0, 10000, 0, 0]);
  assert.deepEqual(dirty.expect!.presence, { present: 5, vanished: 5, absent: 0, appeared: 0 });
  assert.deepEqual(parseBrain({ ...JSON.parse(JSON.stringify(file)), expect: undefined }).expect!.stats, []);
  assert.deepEqual(predictView({ predict: undefined }), { level: 0, byChannel: {}, recent: [], learned: [] });
});

test("in the running simulation, switching the charger's hum off and on again surprises the pets, and a world left alone does not", () => {
  const run = (toggle: boolean) => {
    const sim = new Simulation(new World(5), 5, roster);
    for (let h = 1; h <= 10; h++) sim.step(h * 3600_000); // a long time to learn what normal is like
    // Put the pets where they can hear it well (a tone that was already faint is expected to fade out), keep them there a moment
    sim.pets.forEach((q, i) => { q.x = 800 + i * 55; q.y = 200 + i * 40; q.mode = "idle"; q.s1.holdUntil = sim.simSec + 600; q.s1.holdAction = "pause"; });
    sim.step(10 * 3600_000 + 60_000);
    const count = (ctx: string) => sim.pets.reduce((n, p) => n + (p.predict?.recent ?? []).filter((s) => s.channel === "tonePresence" && s.ctx === ctx && s.tSec > 10 * 3600).length, 0);
    const before = { v: count("vanished"), a: count("appeared") };
    if (toggle) sim.world.setOverride("beaconOn", false);
    sim.step(10 * 3600_000 + 10 * 60_000);
    const mid = { v: count("vanished"), a: count("appeared") };
    if (toggle) sim.world.setOverride("beaconOn", "auto");
    sim.step(10 * 3600_000 + 20 * 60_000);
    const end = { v: count("vanished"), a: count("appeared") };
    const scenes = sim.pets.flatMap((p) => p.mind.scenes.filter((s) => s.kind === "tonelost" || s.kind === "toneback"));
    return { before, mid, end, scenes: scenes.length, levels: sim.pets.map((p) => p.predict!.level) };
  };
  const quiet = run(false), toggled = run(true);
  assert.ok(toggled.mid.v - toggled.before.v >= 2, `switching it off: ${toggled.mid.v - toggled.before.v} of 3 pets lost the tone unexpectedly`);
  assert.ok(toggled.end.a - toggled.mid.a >= 2, `switching it back on: ${toggled.end.a - toggled.mid.a} pets noticed it return`);
  assert.ok(quiet.end.v - quiet.before.v <= 1 && quiet.end.a - quiet.before.a <= 1, "a world left alone rarely surprises them this way");
  assert.ok(toggled.scenes > quiet.scenes, "and the surprise is remembered as a moment");
});

test("surprising moments are written to the thought log, the run is deterministic, and old saves load", () => {
  const a = new Simulation(new World(7), 7, roster), b = new Simulation(new World(7), 7, roster);
  const logged: any[] = [];
  for (let h = 1; h <= 8; h++) {
    for (const t of a.step(h * 3600_000).thoughts as any[]) if (t.stage === "surprise") logged.push(t);
    b.step(h * 3600_000);
    if (h === 6) { a.world.setOverride("beaconOn", false); b.world.setOverride("beaconOn", false); }
    if (h === 7) { a.world.setOverride("beaconOn", "auto"); b.world.setOverride("beaconOn", "auto"); }
  }
  assert.ok(logged.length >= 1 && logged.every((t) => t.system === 3 && t.surprise.score >= 0.5 && typeof t.surprise.why === "string"));
  assert.deepEqual(a.pets.map((p) => p.predict), b.pets.map((p) => p.predict));
  const snap: any = JSON.parse(JSON.stringify(a.snapshot()));
  for (const q of snap.pets) delete q.predict;
  const old = new Simulation(a.world, 7, roster, snap);
  old.step(a.simSec * 1000 + 1800_000);
  assert.ok(old.pets.every((q) => q.predict));
  assert.ok(a.metrics().pets.every((q) => typeof q.surprise === "number"));
});
