import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Store } from "./store.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { buildNotes } from "./system2.js";
import type { PetDef, PetState } from "./pet.js";
import type { Scene } from "./scenes.js";
import {
  Consolidator, MAX_GISTS, SLEEP_MIN_SEC, addGists, adjustBeliefs, buildGistPrompt, consolidate, describeGists, forgetScenes, kindsFor, markGistsUsed,
  mergeScenes, parseGists, reviseGists, sleepTick, verifyClaims, type Gist, type SleepLlm,
} from "./sleep.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const H = 3600;

const scene = (id: string, kind: string, tSec: number, over: Partial<Scene> = {}): Scene => ({
  id, tSec, kind, why: `a ${kind} moment`, importance: 0.3, pose: { x: 0, y: 0 }, seen: [], near: [], view: "...........|....", tone: null,
  light: 20, temperature: 18, battery: 60, action: "wander", uses: 0, lastUsedSec: -1, ...over,
});
const gist = (id: string, text: string, over: Partial<Gist> = {}): Gist => ({ id, text, confidence: 0.4, kinds: ["charger"], sources: [], createdSec: 0, checkedSec: 0, lastUsedSec: -1, uses: 0, ...over });

function pet(): { sim: Simulation; p: PetState } {
  const sim = new Simulation(new World(1), 1, roster);
  return { sim, p: sim.pets[0] };
}

test("words in a statement point at the kinds of experience that would bear it out", () => {
  assert.deepEqual(kindsFor("standing on the yellow pad fills my battery"), ["charger"]);
  assert.deepEqual(kindsFor("the lamp makes the corner bright and warm").sort(), ["brighter", "warmer"]);
  assert.deepEqual(kindsFor("the window lets sunlight in").sort(), ["brighter", "sunpatch"]);
  assert.deepEqual(kindsFor("I wonder what is behind the door"), [], "not checkable: left alone");
});

test("repeats are folded into a few examples that remember how often it happened; fresh moments are left alone", () => {
  const { p } = pet();
  const now = 10 * H;
  p.mind.scenes = [
    ...Array.from({ length: 6 }, (_, i) => scene(`c${i}`, "company", i * 600, { importance: 0.3 + i * 0.01, pose: { x: i * 10, y: 0 } })),
    scene("fresh", "company", now - 100),
    scene("bump1", "bump", 0),
  ];
  p.mind.gists = [gist("g1", "x", { sources: ["c0"], confidence: 0.9 })]; // proven: no longer protects c0
  const merged = mergeScenes(p, now);
  assert.equal(merged, 4);
  const companies = p.mind.scenes.filter((s) => s.kind === "company");
  assert.equal(companies.length, 3, "two examples plus the fresh one");
  assert.equal(companies.reduce((n, s) => n + (s.count ?? 1), 0), 7, "nothing was lost from the count");
  assert.ok(companies.find((s) => s.id === "fresh")!.count === undefined);
  const top = companies.find((s) => (s.count ?? 1) > 1)!;
  assert.ok(top.importance > 0.35, "being repeated makes it matter a little more");
  assert.ok(top.lastSec! > 0);
  assert.equal(p.mind.scenes.filter((s) => s.kind === "bump").length, 1);
});

test("moments backing a young unproven gist are not merged away, and merges keep the gist's provenance", () => {
  const { p } = pet();
  const now = 10 * H;
  p.mind.scenes = Array.from({ length: 5 }, (_, i) => scene(`c${i}`, "charger", i * 100, { importance: 0.9 - i * 0.1 }));
  p.mind.gists = [gist("g1", "x", { sources: ["c4", "c0"], confidence: 0.3, createdSec: now - 100 })];
  mergeScenes(p, now);
  assert.ok(p.mind.scenes.some((s) => s.id === "c4"), "c4 backs a young gist so it stays");
  p.mind.gists[0].confidence = 0.9;
  p.mind.scenes = Array.from({ length: 5 }, (_, i) => scene(`d${i}`, "charger", i * 100, { importance: 0.9 - i * 0.1 }));
  p.mind.gists[0].sources = ["d4"];
  mergeScenes(p, now);
  assert.ok(!p.mind.gists[0].sources.includes("d4") || p.mind.scenes.some((s) => s.id === "d4"), "the citation follows the merge");
});

test("unused moments fade and the faint old ones are forgotten; important, used, fresh and gist-backed ones are not", () => {
  const { p } = pet();
  const now = 100 * H;
  p.mind.scenes = [
    scene("faint", "bump", 0, { importance: 0.13 }),
    scene("vital", "dormant", 0, { importance: 0.95 }),
    scene("used", "bump", 0, { importance: 0.13, uses: 2 }),
    scene("fresh", "bump", now - H, { importance: 0.13 }),
    scene("backed", "bump", 0, { importance: 0.13 }),
    scene("mid", "bump", 0, { importance: 0.5 }),
  ];
  p.mind.gists = [gist("g", "x", { sources: ["backed"], confidence: 0.3, createdSec: now - H })];
  const forgotten = forgetScenes(p, now);
  const ids = p.mind.scenes.map((s) => s.id);
  assert.equal(forgotten, 1);
  assert.ok(!ids.includes("faint"));
  for (const keep of ["vital", "used", "fresh", "backed", "mid"]) assert.ok(ids.includes(keep), keep);
  assert.equal(p.mind.scenes.find((s) => s.id === "vital")!.importance, 0.931, "important ones fade very slowly");
  assert.equal(p.mind.scenes.find((s) => s.id === "mid")!.importance, 0.45);
});

test("what the pet was told is borne out only by experience that came after it", () => {
  const { p } = pet();
  p.mind.scenes = [scene("early", "charger", 100, { count: 3 }), scene("late", "warmer", 1000, { count: 2 })];
  p.mind.claims = [
    { text: "the yellow pad charges your battery", from: "the Teacher", tSec: 500, status: "unverified" },
    { text: "the heater makes the corner warm", from: "the Teacher", tSec: 500, status: "unverified" },
    { text: "there is a secret room", from: "a voice", tSec: 500, status: "unverified" },
    { text: "the lamp is bright", from: "a voice", tSec: 500, status: "contradicted" },
  ];
  assert.deepEqual(verifyClaims(p, 2000), { supported: 1, contradicted: 0 }, "the charger experience was before the claim, so it does not count; the warmth since, twice, does");
  assert.deepEqual(p.mind.claims.map((c) => c.status), ["unverified", "supported", "unverified", "contradicted"]);
});

test("belief confidence follows counted evidence once, and weak unsupported beliefs fade away", () => {
  const { p } = pet();
  const now = 100 * H;
  p.mind.scenes = [scene("a", "charger", 50 * H, { count: 3 })];
  p.mind.beliefs = [
    { text: "the pad charges me", confidence: 0.4, updatedSec: 10 * H },
    { text: "the heater warms the room", confidence: 0.3, updatedSec: 10 * H },
    { text: "the heater warms the corner", confidence: 0.5, updatedSec: 10 * H },
    { text: "I wonder about the door", confidence: 0.3, updatedSec: 0 },
  ];
  const r = adjustBeliefs(p, now);
  assert.equal(r.strengthened, 1);
  assert.equal(p.mind.beliefs[0].confidence, 0.55, "three occasions add 0.15");
  assert.equal(r.faded, 0);
  assert.equal(p.mind.beliefs.find((b) => b.text.includes("warms the room"))!.confidence, 0.2, "weak and unsupported: fades");
  assert.equal(p.mind.beliefs.find((b) => b.text.includes("corner"))!.confidence, 0.5, "moderate confidence is left alone");
  assert.equal(p.mind.beliefs.find((b) => b.text.includes("door"))!.confidence, 0.3, "not checkable: untouched");
  adjustBeliefs(p, now + H);
  assert.equal(p.mind.beliefs[0].confidence, 0.55, "the same evidence is not counted twice");
  p.mind.beliefs[1].checkedSec = 0;
  adjustBeliefs(p, now + 100 * H);
  assert.ok(!p.mind.beliefs.some((b) => b.text.includes("warms the room")), "faded below the line and let go");
});

test("a gist gains confidence only from later experience, and unsupported ones fade", () => {
  const { p } = pet();
  p.mind.gists = [gist("g1", "standing on the pad fills my battery", { createdSec: 1000, checkedSec: 1000, kinds: ["charger"] }), gist("g2", "the lamp warms me", { kinds: ["warmer"], checkedSec: 0, confidence: 0.2 })];
  p.mind.scenes = [scene("before", "charger", 500), scene("after", "charger", 5000, { count: 2 })];
  const r = reviseGists(p, 6000);
  assert.equal(r.strengthened, 1);
  assert.equal(p.mind.gists[0].confidence, 0.55, "only the later moments count, and a statement about the pad charging is borne out by two of them");
  reviseGists(p, 7000);
  assert.equal(p.mind.gists[0].confidence, 0.55, "not counted twice");
  const r2 = reviseGists(p, 7000 + 49 * H);
  assert.equal(r2.dropped, 1, "the unsupported low-confidence gist is gone");
  assert.ok(p.mind.gists.some((g) => g.id === "g1"));
});

test("one night: a summary is recorded, and a gist is only due with enough to go on and not every sleep", () => {
  const { p } = pet();
  p.mind.scenes = [scene("a", "bump", 0), scene("b", "bump", 10)];
  assert.equal(consolidate(p, 100 * H).scenesAfter, 2);
  assert.equal(p.mind.gistDue, false, "too little to look back on");
  p.mind.scenes.push(scene("c", "charger", 20));
  const s = consolidate(p, 100 * H);
  assert.equal(p.mind.gistDue, true);
  assert.equal(p.mind.lastSleep, s);
  p.mind.lastGistSec = 100 * H;
  consolidate(p, 102 * H);
  assert.equal(p.mind.gistDue, false, "asked for a gist only a couple of hours ago");
  consolidate(p, 105 * H);
  assert.equal(p.mind.gistDue, true);
});

test("consolidation runs once per sleep, after the pet has slept a while; naps and waking reset it", () => {
  const { p } = pet();
  p.mind.scenes = [scene("a", "bump", 0), scene("b", "bump", 10), scene("c", "bump", 20)];
  p.mode = "sleeping";
  assert.equal(sleepTick(p, 1000), null);
  assert.equal(sleepTick(p, 1000 + SLEEP_MIN_SEC - 5), null, "still too short");
  p.mode = "idle";
  assert.equal(sleepTick(p, 1000 + SLEEP_MIN_SEC), null, "woke up: a nap does not count");
  p.mode = "sleeping";
  sleepTick(p, 5000);
  const first = sleepTick(p, 5000 + SLEEP_MIN_SEC);
  assert.ok(first);
  assert.equal(sleepTick(p, 5000 + SLEEP_MIN_SEC + 3000), null, "once per sleep");
  p.mode = "idle"; sleepTick(p, 20000);
  p.mode = "sleeping"; sleepTick(p, 30000);
  assert.ok(sleepTick(p, 30000 + SLEEP_MIN_SEC), "the next night is consolidated again");
});

test("in the running simulation pets consolidate each night, record it, and stay deterministic", () => {
  const a = new Simulation(new World(5), 5, roster), b = new Simulation(new World(5), 5, roster);
  const nights: any[] = [];
  for (let h = 1; h <= 48; h++) {
    const r = a.step(h * 3600_000);
    b.step(h * 3600_000);
    nights.push(...r.thoughts.filter((t: any) => t.system === 3 && t.stage === "sleep"));
  }
  assert.ok(nights.length >= 3, `expected several nights across 3 pets over 2 days, saw ${nights.length}`);
  assert.equal(nights[0].stage, "sleep");
  assert.ok(nights[0].summary.scenesAfter <= nights[0].summary.scenesBefore);
  assert.ok(a.pets.every((p) => p.mind.lastSleep));
  assert.deepEqual(a.pets.map((p) => p.mind.scenes), b.pets.map((p) => p.mind.scenes));
  assert.deepEqual(a.pets.map((p) => p.mind.beliefs), b.pets.map((p) => p.mind.beliefs));
});

test("a model reply becomes gists only if they cite real moments; confidence is capped; duplicates and extras are dropped", () => {
  const valid = new Map([["s1", scene("s1", "charger", 0)], ["s2", scene("s2", "bump", 0)]]);
  const existing = [gist("old", "I get charged on the pad")];
  const reply = '```json\n' + JSON.stringify({ gists: [
    { text: "When I reach the yellow square my battery fills", from: ["s1", "nope"], confidence: 0.99 },
    { text: "I made this up with no moments", from: ["zzz"], confidence: 0.4 },
    { text: "no citation at all", confidence: 0.4 },
    { text: "I get charged on the pad!", from: ["s1"], confidence: 0.4 },
    { text: "short", from: ["s1"] },
    { text: "Walls hurt when I bump into them", from: ["s2", "s1"], confidence: "high" },
    { text: "A third valid one about the pad again", from: ["s1"] },
    { text: "A fourth valid one that must be cut", from: ["s1"] },
  ] }) + "\n```";
  const g = parseGists(reply, valid, existing, 1000);
  assert.equal(g.length, 3);
  assert.equal(g[0].confidence, 0.5, "provisional whatever the model says");
  assert.deepEqual(g[0].sources, ["s1"]);
  assert.deepEqual(g[0].kinds, ["charger"]);
  assert.deepEqual(g[1].kinds.sort(), ["bump", "charger"]);
  assert.ok(g[1].confidence >= 0.1 && g[1].confidence <= 0.5);
  assert.equal(parseGists("no json", valid, [], 0).length, 0);
  assert.equal(parseGists('{"gists": []}', valid, [], 0).length, 0);
});

test("the gist store is bounded and drops the least confident first", () => {
  const { p } = pet();
  addGists(p, Array.from({ length: MAX_GISTS + 3 }, (_, i) => gist(`g${i}`, `statement ${i}`, { confidence: 0.2 + i * 0.01 })));
  assert.equal(p.mind.gists.length, MAX_GISTS);
  assert.ok(!p.mind.gists.some((g) => g.id === "g0"));
});

function fakeLlm(reply: (sys: string, user: string) => string, calls: any[] = []): SleepLlm & { calls: any[] } {
  return { enabled: true, calls, async complete(messages, opts) { calls.push({ messages, opts }); return { text: reply(messages[0].content, messages[1].content), provider: "local", model: "m", tokensIn: 5, tokensOut: 5 }; } };
}

async function nightSetup(llm: SleepLlm, paused = false) {
  const { sim, p } = pet();
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "sleep-")), "t");
  p.mind.scenes = [scene("s1", "charger", 100, { importance: 0.8, why: "found the charging pad" }), scene("s2", "bump", 200), scene("s3", "charger", 300, { importance: 0.7 })];
  p.mode = "sleeping";
  p.mind.gistDue = true;
  sim.simSec = 5000;
  const c = new Consolidator(sim, llm, store, { isPaused: () => paused });
  return { sim, p, store, c };
}

test("while a pet sleeps, one slow call writes provisional gists, logged as its own kind of thought", async () => {
  const llm = fakeLlm(() => JSON.stringify({ gists: [{ text: "Whenever I reach the yellow square my battery fills up", from: ["s1", "s3"], confidence: 0.9 }] }));
  const { p, store, c } = await nightSetup(llm);
  c.tick();
  c.tick(); // a second tick must not start a second call
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0].opts.providers, ["groq", "deepseek"], "cloud only: the small local models cannot write gists; spend counts toward the pets' ceiling");
  assert.equal(llm.calls[0].opts.patienceMs, undefined, "no queueing for the local model");
  assert.equal(llm.calls[0].opts.account, undefined, "not the teacher: it is the pets' own budget");
  assert.equal(llm.calls[0].opts.json, true);
  assert.ok(llm.calls[0].opts.timeoutMs >= 120_000, "it is allowed to be slow");
  assert.match(llm.calls[0].messages[1].content, /\[s1\].*found the charging pad/);
  assert.equal(p.mind.gists.length, 1);
  assert.equal(p.mind.gists[0].confidence, 0.5);
  assert.equal(p.mind.gistDue, false);
  const log = await store.readLog<any>(`thoughts/${p.id}`);
  assert.equal(log[0].system, 3);
  assert.equal(log[0].stage, "gist");
  assert.deepEqual(log[0].gists[0].sources, ["s1", "s3"]);
  c.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(llm.calls.length, 1, "one attempt per night");
});

test("no call when the pet is awake, the sim is paused, or there is no model; a failed or useless reply costs only that night", async () => {
  const llm = fakeLlm(() => "I cannot do that");
  const a = await nightSetup(llm);
  a.p.mode = "idle";
  a.c.tick();
  assert.equal(llm.calls.length, 0, "only while asleep");
  const b = await nightSetup(fakeLlm(() => "{}"), true);
  b.c.tick();
  const off = { ...fakeLlm(() => "{}"), enabled: false };
  const c2 = await nightSetup(off);
  c2.c.tick();
  assert.equal(off.calls.length, 0);
  const bad = fakeLlm(() => "I cannot do that");
  const d = await nightSetup(bad);
  d.c.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(d.p.mind.gists.length, 0);
  assert.equal(d.p.mind.gistDue, false);
  const boom: SleepLlm = { enabled: true, async complete() { throw new Error("network down"); } };
  const e = await nightSetup(boom);
  e.c.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(e.p.mind.gists.length, 0);
});

test("a gist that arrives after the session was replaced is discarded", async () => {
  const slow: SleepLlm = { enabled: true, async complete() { await new Promise((r) => setTimeout(r, 40)); return { text: JSON.stringify({ gists: [{ text: "I get charged at the pad every time", from: ["s1"] }] }), provider: "local", model: "m", tokensIn: 1, tokensOut: 1 }; } };
  const { p, c } = await nightSetup(slow);
  c.tick();
  c.disposed = true;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(p.mind.gists.length, 0);
});

test("the prompt shows the moments with their ids and what it already thinks, and never asks for facts", () => {
  const { p } = pet();
  p.mind.scenes = [scene("s9", "charger", 100, { importance: 0.9 })];
  p.mind.gists = [gist("g", "I get charged on the pad")];
  const { system, user, ids } = buildGistPrompt(p, 5000);
  assert.ok(ids.has("s9"));
  assert.match(user, /\[s9\]/);
  assert.match(user, /do not repeat them[\s\S]*I get charged on the pad/);
  assert.match(system, /never invent/);
  assert.match(system, /not a proven fact/);
});

test("gists appear in the pet's notes, count as used when shown, and are kept provisional", () => {
  const { p } = pet();
  p.mind.gists = [gist("a", "the pad fills my battery", { confidence: 0.7 }), gist("b", "walls hurt", { confidence: 0.3 })];
  assert.deepEqual(describeGists(p), ["- (70% sure) the pad fills my battery", "- (30% sure) walls hurt"]);
  assert.match(buildNotes(p, 1, 600, 0, 600), /provisional, from sleep\):\n- \(70% sure\) the pad fills my battery/);
  markGistsUsed(p, 999);
  assert.equal(p.mind.gists[0].uses, 1);
  assert.equal(p.mind.gists[0].lastUsedSec, 999);
});

test("gists and merged moments travel in a brain file; hostile data is cleaned; older brains and saves still load", () => {
  const { sim, p } = pet();
  sim.simSec = 10_000;
  p.mind.gists = [gist("g", "the pad fills my battery", { confidence: 0.66, uses: 3, createdSec: 9_000, kinds: ["charger"] })];
  p.mind.scenes = [scene("m", "charger", 8_000, { count: 5, lastSec: 9_500 })];
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, sim.simSec))));
  assert.deepEqual(file.gists, [{ text: "the pad fills my battery", confidence: 0.66, kinds: ["charger"], uses: 3, ageSec: 1000 }]);
  assert.equal(file.scenes![0].count, 5);
  assert.equal(file.scenes![0].lastAgeSec, 500);
  const other = new Simulation(new World(2), 2, roster);
  other.simSec = 100;
  applyBrain(other.pets[1], file, other.simSec);
  const g = other.pets[1].mind.gists[0];
  assert.equal(g.text, "the pad fills my battery");
  assert.equal(g.createdSec, 100 - 1000);
  assert.deepEqual(g.sources, [], "provenance does not travel; the kinds that count as evidence do");
  assert.equal(other.pets[1].mind.scenes[0].count, 5);
  assert.equal(other.pets[1].mind.scenes[0].lastSec, 100 - 500);
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), gists: [{ text: "x" }, { text: "y".repeat(500), confidence: 9, kinds: ["<b>charger</b>", 4], uses: -2, ageSec: -3 }, ...Array(40).fill({ text: "filler statement here" })] });
  assert.equal(dirty.gists!.length, MAX_GISTS - 1, "only the first 12 entries are looked at and the too-short one is dropped");
  const d = dirty.gists![0];
  assert.equal(d.text.length, 120);
  assert.equal(d.confidence, 1);
  assert.equal(d.kinds.length, 1, "the non-string kind is dropped");
  assert.ok(d.kinds.every((k) => /^[a-z]*$/.test(k)), "kinds are letters only");
  assert.equal(d.uses, 0);
  assert.equal(d.ageSec, 0);
  assert.deepEqual(parseBrain({ ...JSON.parse(JSON.stringify(file)), gists: undefined }).gists, []);
  const snap: any = JSON.parse(JSON.stringify(sim.snapshot()));
  for (const q of snap.pets) { delete q.mind.gists; delete q.mind.gistDue; delete q.mind.lastSleep; delete q.sleep; }
  const old = new Simulation(sim.world, 1, roster, snap);
  assert.deepEqual(old.pets[0].mind.gists, []);
  old.step(sim.simSec * 1000 + 1800_000);
});
