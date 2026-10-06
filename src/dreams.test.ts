import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Store } from "./store.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { applyThought, buildNotes, buildPrompt, parseThought } from "./system2.js";
import { Teacher } from "./teacher.js";
import type { PetDef, PetState } from "./pet.js";
import type { Scene } from "./scenes.js";
import { Dreamer, MAX_DREAMS, addDream, buildDreamPrompt, copiesDream, dreamLine, makeDream, plainNarrative, type Dream, type DreamLlm } from "./dreams.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const H = 3600;

const scene = (id: string, kind: string, tSec = 0, over: Partial<Scene> = {}): Scene => ({
  id, tSec, kind, why: `${kind === "charger" ? "found the charging pad" : kind === "dormant" ? "ran out of battery" : "bumped into a wall"}`, importance: 0.5, pose: { x: 0, y: 0 },
  seen: [{ category: "static", size: "small", colour: "yellow", distance: 100, bearing: 0 }], near: [], view: "...........|....", tone: null, light: 20, temperature: 18, battery: 50, action: "wander", uses: 0, lastUsedSec: -1, ...over,
});
function pet(): { sim: Simulation; p: PetState } {
  const sim = new Simulation(new World(1), 1, roster);
  return { sim, p: sim.pets[0] };
}
const plainDream = (over: Partial<Dream> = {}): Dream => ({ id: "d1", tSec: 1000, theme: "swap_place", ingredients: ["a"], kinds: ["charger"], twists: [{ kind: "swap_place", text: "it all happened in a long dark corridor" }], worry: "the charging pad might not always be where I found it", narrative: "I found the pad. It all happened in a long dark corridor.", source: "rules", pending: true, ...over });

test("a dream needs at least two moments, and is the same every time for the same pet and night", () => {
  const { p } = pet();
  p.mind.scenes = [scene("a", "charger")];
  assert.equal(makeDream(p, 5000), null);
  p.mind.scenes.push(scene("b", "bump"));
  const d = makeDream(p, 5000)!;
  assert.deepEqual(makeDream(p, 5000), d, "deterministic");
  assert.notDeepEqual(makeDream(p, 5000 + 86400)!.id, d.id);
  assert.deepEqual([...d.ingredients].sort(), ["a", "b"]);
  assert.ok(d.twists.length >= 1 && d.twists.length <= 2);
  assert.ok(d.worry.length > 10);
  assert.equal(d.source, "rules");
  assert.equal(d.pending, true, "waiting for a model to narrate it");
  assert.match(d.narrative, /^I (found the charging pad|bumped into a wall)\./);
  assert.ok(d.narrative.length <= 320);
  assert.ok(d.twists.every((t) => d.narrative.toLowerCase().includes(t.text.toLowerCase().slice(0, 15))));
});

test("dreams lean toward trouble: unresolved problems are rehearsed more often than calm moments", () => {
  const { p } = pet();
  p.mind.scenes = [scene("t", "dormant"), ...["c1", "c2", "c3", "c4"].map((id) => scene(id, "company"))];
  let withTrouble = 0;
  const N = 600;
  for (let i = 0; i < N; i++) if (makeDream(p, 1000 + i * 60)!.ingredients.includes("t")) withTrouble++;
  const share = withTrouble / N;
  assert.ok(share > 0.5, `trouble in ${(share * 100).toFixed(0)}% of dreams; an even draw of 2 from 5 would be 40%`);
});

test("twists only appear where they make sense, and every dream carries a concrete worry", () => {
  const { p } = pet();
  const kinds = new Set<string>();
  for (let i = 0; i < 80; i++) {
    p.mind.scenes = [scene("a", "bump", 0, { seen: [], near: [] }), scene("b", "bump", 0, { seen: [], near: [] })];
    for (const t of makeDream(p, 100 + i * 997)!.twists) kinds.add(t.kind);
  }
  assert.ok(!kinds.has("missing_source") && !kinds.has("swap_thing") && !kinds.has("other_pet"), `only ${[...kinds]} are possible for two plain bumps`);
  p.mind.scenes = [scene("a", "charger"), scene("b", "company", 0, { near: [{ category: "moving", gap: 5, bearing: 0 }] })];
  const all = new Set<string>();
  const worries = new Set<string>();
  for (let i = 0; i < 120; i++) { const d = makeDream(p, 100 + i * 997)!; d.twists.forEach((t) => all.add(t.kind)); worries.add(d.worry); }
  for (const k of ["missing_source", "other_pet", "swap_thing", "exaggerate", "swap_place", "blend"]) assert.ok(all.has(k), `expected ${k} to be possible`);
  assert.ok(worries.size >= 2);
  assert.ok([...worries].every((w) => w.length > 15));
});

test("a dream changes nothing the pet believes or remembers as real", () => {
  const { p } = pet();
  p.mind.scenes = [scene("a", "charger"), scene("b", "dormant")];
  p.mind.beliefs = [{ text: "the pad charges me", confidence: 0.6, updatedSec: 0 }];
  p.mind.claims = [{ text: "the lamp is warm", from: "a voice", tSec: 0, status: "unverified" }];
  p.mind.episodes = ["D1 01:00 sat still"];
  p.mind.gists = [];
  const before = JSON.stringify({ ...p.mind, dreams: undefined });
  for (let i = 0; i < 10; i++) addDream(p, makeDream(p, 5000 + i * 100000)!);
  assert.equal(JSON.stringify({ ...p.mind, dreams: undefined }), before, "scenes, beliefs, claims, episodes and gists are untouched");
  assert.equal(p.mind.dreams.length, MAX_DREAMS, "only the latest few dreams are kept");
});

test("while a dream is on the pet's mind System 2 is told plainly that it is not real; later it fades from view", () => {
  const { p } = pet();
  assert.equal(dreamLine(p, 2000), null);
  assert.match(buildNotes(p, 1, 600, 0, 2000), /No recent dream\./);
  p.mind.dreams = [plainDream({ tSec: 1000 })];
  const line = dreamLine(p, 1000 + 3600)!;
  assert.match(line, /A DREAM you had \(it is NOT something that happened/);
  assert.match(line, /only a possibility you could look out for/);
  assert.match(buildNotes(p, 1, 600, 0, 1000 + 3600), /A DREAM you had/);
  assert.equal(dreamLine(p, 1000 + 13 * H), null);
  assert.match(buildPrompt(p, 1, 600, 0, 2000).system, /nothing in a dream happened, so never put anything from a dream in "beliefs"/);
});

test("a belief that only repeats what a dream invented is refused; real things the dream was built from are not", () => {
  const { p } = pet();
  p.mind.dreams = [plainDream({ twists: [{ kind: "swap_place", text: "it all happened in a long dark corridor" }, { kind: "missing_source", text: "the hum was gone, and the place where the pad should be was empty" }] })];
  assert.equal(copiesDream(p, "There is a long dark corridor where everything happens"), true);
  assert.equal(copiesDream(p, "the hum was gone and the place for the pad was empty"), true);
  assert.equal(copiesDream(p, "the charging pad fills my battery"), false, "a real belief that shares a word with the dream");
  assert.equal(copiesDream(p, "corridor"), false);
  assert.equal(copiesDream(p, "I like the window light"), false);
  const t = parseThought(JSON.stringify({ thought: "x", beliefs: [{ text: "A long dark corridor is where it all happens", confidence: 0.9 }, { text: "The charging pad fills my battery", confidence: 0.7 }], suggestion: "none" }))!;
  applyThought(p, t, 5000);
  assert.deepEqual(p.mind.beliefs.map((b) => b.text), ["The charging pad fills my battery"]);
});

test("in the running simulation every pet dreams each night, dreams never leak into beliefs, and it is deterministic", () => {
  const a = new Simulation(new World(5), 5, roster), b = new Simulation(new World(5), 5, roster);
  const stages: string[] = [];
  for (let h = 1; h <= 72; h++) {
    for (const t of a.step(h * 3600_000).thoughts as any[]) if (t.system === 3) stages.push(t.stage);
    b.step(h * 3600_000);
  }
  const sleeps = stages.filter((s) => s === "sleep").length, dreams = stages.filter((s) => s === "dream").length;
  assert.ok(sleeps >= 6 && dreams === sleeps, `${sleeps} nights, ${dreams} dreams: one dream per night`);
  for (const p of a.pets) {
    assert.ok(p.mind.dreams.length > 0 && p.mind.dreams.length <= MAX_DREAMS);
    for (const d of p.mind.dreams) for (const t of d.twists) assert.ok(!p.mind.beliefs.some((x) => x.text.includes(t.text)), "no belief contains a dream's twist");
  }
  assert.deepEqual(a.pets.map((p) => p.mind.dreams), b.pets.map((p) => p.mind.dreams));
});

function fakeLlm(reply: string | (() => string), calls: any[] = []): DreamLlm & { calls: any[] } {
  return { enabled: true, calls, async complete(messages, opts) { calls.push({ messages, opts }); return { text: typeof reply === "function" ? reply() : reply, provider: "local", model: "qwen", tokensIn: 5, tokensOut: 5 }; } };
}
async function dreamSetup(llm: DreamLlm, paused = false) {
  const { sim, p } = pet();
  p.mind.scenes = [scene("a", "charger"), scene("b", "dormant")];
  p.mode = "sleeping";
  p.mind.dreams = [makeDream(p, 5000)!];
  sim.simSec = 5000;
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "dream-")), "t");
  return { sim, p, store, dr: new Dreamer(sim, llm, store, { isPaused: () => paused }) };
}
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("a model narrates tonight's dream once; the plain version stands if it fails or says something unusable", async () => {
  const llm = fakeLlm('"The pad turned into a river of light and I swam toward a hum that was not there."');
  const { p, store, dr } = await dreamSetup(llm);
  const plain = p.mind.dreams[0].narrative;
  dr.tick();
  dr.tick();
  await wait();
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0].opts.providers, ["groq", "deepseek"], "cloud only");
  const d = p.mind.dreams[0];
  assert.match(d.narrative, /^The pad turned into a river of light/, "quotation marks stripped");
  assert.notEqual(d.narrative, plain);
  assert.equal(d.source, "qwen");
  assert.equal(d.pending, false);
  const log = await store.readLog<any>(`thoughts/${p.id}`);
  assert.equal(log[0].stage, "dream_narration");
  dr.tick();
  await wait();
  assert.equal(llm.calls.length, 1, "one attempt per dream");
  for (const bad of ["{\"dream\": \"x\"}", "too short", "x".repeat(700), "I set my phone on the pad and the screen glowed as the hum faded away.", "Books fell from the lamp and I was unplugged from the long dark corridor."]) {
    const s = await dreamSetup(fakeLlm(bad));
    const keep = s.p.mind.dreams[0].narrative;
    s.dr.tick();
    await wait();
    assert.equal(s.p.mind.dreams[0].narrative, keep, `kept the plain dream for ${bad.slice(0, 12)}`);
  }
  const boom: DreamLlm = { enabled: true, async complete() { throw new Error("offline"); } };
  const e = await dreamSetup(boom);
  e.dr.tick();
  await wait();
  assert.equal(e.p.mind.dreams[0].pending, false);
});

test("no narration when the pet is awake, the sim is paused, or there is no model; a late result is discarded", async () => {
  const awake = fakeLlm("A long strange dream about a corridor.");
  const a = await dreamSetup(awake);
  a.p.mode = "idle";
  a.dr.tick();
  const paused = fakeLlm("A long strange dream about a corridor.");
  (await dreamSetup(paused, true)).dr.tick();
  const off = { ...fakeLlm("A long strange dream about a corridor."), enabled: false };
  (await dreamSetup(off)).dr.tick();
  assert.equal(awake.calls.length + paused.calls.length + off.calls.length, 0);
  const slow: DreamLlm = { enabled: true, async complete() { await wait(40); return { text: "A late dream about a corridor of light.", provider: "local", model: "m", tokensIn: 1, tokensOut: 1 }; } };
  const s = await dreamSetup(slow);
  const keep = s.p.mind.dreams[0].narrative;
  s.dr.tick();
  s.dr.disposed = true;
  await wait(90);
  assert.equal(s.p.mind.dreams[0].narrative, keep);
});

test("the narration prompt asks for a dream, from the real moments and the twists, and never as something that happened", () => {
  const { p } = pet();
  p.mind.scenes = [scene("a", "charger"), scene("b", "dormant")];
  const d = makeDream(p, 5000)!;
  const { system, user } = buildDreamPrompt(p, d);
  assert.match(system, /ONE short dream/);
  assert.match(system, /do not say it really happened/);
  assert.match(system, /only things that exist in Pip's world are: the charging pad/);
  assert.match(system, /no phones, books, screens, machines, vehicles/);
  assert.match(user, /- I (found the charging pad|ran out of battery)/);
  for (const t of d.twists) assert.ok(user.includes(t.text));
  assert.doesNotMatch(user, /\(\d+,\s*\d+\)/, "no coordinates");
  assert.match(plainNarrative([scene("a", "charger"), scene("b", "dormant")], [{ kind: "exaggerate", text: "everything grew" }, { kind: "blend", text: "two things merged" }]), /^I found the charging pad\. Everything grew\. Then I ran out of battery, and two things merged\.$/);
});

test("dreams travel in a brain file as dreams, without the moments; hostile data is cleaned; older brains and saves load", () => {
  const { sim, p } = pet();
  sim.simSec = 10_000;
  p.mind.dreams = [plainDream({ tSec: 9_000 })];
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, sim.simSec))));
  assert.equal(file.dreams![0].ageSec, 1000);
  assert.equal(file.dreams![0].worry, plainDream().worry);
  const other = new Simulation(new World(2), 2, roster);
  other.simSec = 100;
  applyBrain(other.pets[1], file, other.simSec);
  const d = other.pets[1].mind.dreams[0];
  assert.equal(d.tSec, 100 - 1000);
  assert.deepEqual(d.ingredients, [], "the moments it was made from do not travel");
  assert.equal(d.pending, false);
  assert.equal(d.source, "brain");
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), dreams: [{ narrative: "short" }, { narrative: "n".repeat(900), worry: "w".repeat(900), theme: "evil", twists: [{ kind: "nope", text: "t".repeat(900) }, "x", ...Array(9).fill({ kind: "blend", text: "ok" })], ageSec: -4 }, ...Array(20).fill({ narrative: "a long enough dream text" })] });
  assert.equal(dirty.dreams!.length, MAX_DREAMS - 1, "only the first entries are looked at and the too-short one is dropped");
  const x = dirty.dreams![0];
  assert.equal(x.narrative.length, 320);
  assert.equal(x.worry.length, 160);
  assert.equal(x.theme, "exaggerate");
  assert.equal(x.twists.length, 2, "at most 3 looked at, junk removed");
  assert.equal(x.twists[0].kind, "exaggerate");
  assert.equal(x.ageSec, 0);
  assert.deepEqual(parseBrain({ ...JSON.parse(JSON.stringify(file)), dreams: undefined }).dreams, []);
  const snap: any = JSON.parse(JSON.stringify(sim.snapshot()));
  for (const q of snap.pets) delete q.mind.dreams;
  const old = new Simulation(sim.world, 1, roster, snap);
  assert.deepEqual(old.pets[0].mind.dreams, []);
  old.step(sim.simSec * 1000 + 1800_000);
});

test("the teacher can see that a pet has dreamed, and is told it was only a dream", async () => {
  const { sim, p } = pet();
  p.mind.dreams = [plainDream({ tSec: sim.simSec })];
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "t-dream-")), "t");
  const t = new Teacher(sim, { enabled: false, complete: async () => { throw new Error("x"); } }, store, { set: async () => ({}) as any, recent: async () => [] }, { teacherSays: async () => ({ heardBy: [] }) as any }, { isPaused: () => true });
  const brief = (t as any).petBrief(p) as string;
  assert.match(brief, /Dreamed recently \(a dream, not real\)/);
  assert.match(brief, /worries about: the charging pad might not always be where I found it/);
});
