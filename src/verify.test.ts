import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { buildNotes, applyThought, parseThought } from "./system2.js";
import { Teacher } from "./teacher.js";
import { newPredict } from "./predict.js";
import { Store } from "./store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PetDef, PetState } from "./pet.js";
import type { Scene } from "./scenes.js";
import { adjustBeliefs, consolidate, describeGists, reviseGists, verifyClaims, type Gist } from "./sleep.js";
import { MAX_REFUTED, REFUTED_FOR_SEC, addRefuted, checkStatement, conflicts, copiesRefuted, duplicates, similarity } from "./verify.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const H = 3600;
const pet = (): PetState => new Simulation(new World(1), 1, roster).pets[0];

const scene = (id: string, kind: string, tSec: number, over: Partial<Scene> = {}): Scene => ({
  id, tSec, kind, why: `a ${kind} moment`, importance: 0.5, pose: { x: 0, y: 0 }, seen: [], near: [], view: "...........|....", tone: null,
  light: 20, temperature: 18, battery: 60, action: "wander", uses: 0, lastUsedSec: -1, ...over,
});
const withTone = { pitch: 534, volume: 0.9 };
const claim = (text: string, tSec = 0, from = "the Teacher (ahead of me, about 90 away)") => ({ text, from, tSec, status: "unverified" as const });
const gist = (id: string, text: string, over: Partial<Gist> = {}): Gist => ({ id, text, confidence: 0.5, kinds: ["charger"], sources: [], createdSec: 0, checkedSec: 0, lastUsedSec: -1, uses: 0, ...over });

test("a claim about the tone leading to the pad is judged by how often following it ended at the pad", () => {
  const p = pet();
  const text = "The steady tone always leads you to the charging pad";
  assert.equal(checkStatement(p, text, 0, 1000)!.state, "unclear", "no experience yet");
  p.mind.scenes = [scene("a", "charger", 100, { tone: withTone, count: 8 }), scene("b", "nocharge", 200, { count: 1 })];
  assert.equal(checkStatement(p, text, 0, 1000)!.state, "supported", "1 failure in 9 (11%) is within what counts as reliable");
  p.mind.scenes = [scene("a", "charger", 100, { tone: withTone, count: 6 }), scene("b", "nocharge", 200, { count: 2 })];
  assert.equal(checkStatement(p, text, 0, 1000)!.state, "unclear", "25% failures: not reliable enough to bear out 'always', not bad enough to refute it");
  p.mind.scenes = [scene("a", "charger", 100, { tone: withTone, count: 10 })];
  const clean = checkStatement(p, text, 0, 1000)!;
  assert.equal(clean.state, "supported");
  assert.match(clean.why, /ended at the pad 10 times, and 0 times I reached its loud end and was not charged/);
  p.mind.scenes = [scene("a", "charger", 100, { tone: withTone, count: 2 }), scene("b", "nocharge", 200, { count: 3 })];
  assert.equal(checkStatement(p, text, 0, 1000)!.state, "contradicted");
  assert.equal(checkStatement(p, "The tone sometimes leads to the pad", 0, 1000)!.state, "contradicted", "3 of 5 failures contradicts even a loose claim");
  p.mind.scenes = [scene("a", "charger", 100, { tone: withTone, count: 7 }), scene("b", "nocharge", 200, { count: 3 })];
  assert.equal(checkStatement(p, text, 0, 1000)!.state, "contradicted", "'always' is held to a stricter standard (30% failures)");
  assert.equal(checkStatement(p, "The tone usually leads to the pad", 0, 1000)!.state, "unclear", "30% failures do not contradict 'usually'");
  assert.equal(checkStatement(p, text, 250, 1000)!.state, "unclear", "only experience after the statement was made counts");
  assert.equal(checkStatement(p, text, 150, 1000)!.state, "contradicted", "the three failures at t=200 count, the successes at t=100 do not");
});

test("a claim that the tone is always there is contradicted by it stopping, supported by a long time without that", () => {
  const p = pet();
  const NOW = 8 * H;
  p.mind.cues["tone:29"] = { key: "tone:29", pitch: 534, firstHeardSec: 0, lastHeardSec: NOW - 100, exposureSec: 4000, support: 1, contra: 0, peakVolume: 0.9, peakAtSec: NOW - 100, lastVolume: 0.9, lastSupportSec: 0 } as any;
  const text = "The humming never stops";
  assert.equal(checkStatement(p, text, NOW - 600, NOW)!.state, "unclear", "not enough time to tell");
  assert.equal(checkStatement(p, text, NOW - 2 * H, NOW)!.state, "unclear", "'never' needs hours of listening, not two");
  assert.equal(checkStatement(p, text, 0, NOW)!.state, "supported");
  assert.equal(checkStatement(p, "The tone is steady", NOW - 2 * H, NOW)!.state, "supported", "a milder claim needs less");
  p.mind.scenes = [scene("lost", "tonelost", 2000)];
  const v = checkStatement(p, text, 0, NOW)!;
  assert.equal(v.state, "contradicted", "once is enough to contradict 'never'");
  assert.match(v.why, /suddenly stopped 1 time/);
  assert.equal(checkStatement(p, "The tone usually keeps going", 0, NOW)!.state, "unclear", "a loose claim needs more than one stop to be contradicted");
});

test("a claim that walking toward the tone makes it louder is checked against what the pet learned", () => {
  const p = pet();
  const text = "When you walk toward the tone it gets louder";
  assert.equal(checkStatement(p, text, 0, 1)!.state, "unclear");
  p.predict = { ...newPredict(), stats: { "toneVolume:following": { n: 100, mean: 0.02, var: 0.001, up: 85 } } };
  assert.equal(checkStatement(p, text, 0, 1)!.state, "supported");
  p.predict.stats["toneVolume:following"].up = 20;
  const v = checkStatement(p, text, 0, 1)!;
  assert.equal(v.state, "contradicted");
  assert.match(v.why, /got louder 20% of the time/);
  p.predict.stats["toneVolume:following"].up = 50;
  assert.equal(checkStatement(p, text, 0, 1)!.state, "unclear");
});

test("whether the pad stays in one place is judged from where the pet found it, comparing only moments close in time", () => {
  const p = pet();
  const stays = "The charging pad always stays in the same place";
  const moves = "The charging pad moves around";
  p.mind.scenes = [scene("a", "charger", 100, { pose: { x: 900, y: 80 } }), scene("b", "charger", 5000, { pose: { x: 940, y: 110 } })];
  assert.equal(checkStatement(p, stays, 0, 6000)!.state, "supported");
  assert.equal(checkStatement(p, moves, 0, 6000)!.state, "contradicted", "the same evidence, the opposite claim");
  assert.match(checkStatement(p, stays, 0, 6000)!.why, /within 50 steps/);
  p.mind.scenes = [scene("a", "charger", 100, { pose: { x: 900, y: 80 } }), scene("b", "charger", 5000, { pose: { x: 100, y: 600 } })];
  assert.equal(checkStatement(p, stays, 0, 6000)!.state, "contradicted");
  assert.equal(checkStatement(p, moves, 0, 6000)!.state, "supported");
  p.mind.scenes = [scene("a", "charger", 100, { pose: { x: 900, y: 80 } }), scene("b", "charger", 100 + 20 * H, { pose: { x: 100, y: 600 } })];
  assert.equal(checkStatement(p, stays, 0, 25 * H)!.state, "unclear", "far apart in time: dead reckoning may have drifted, so no verdict");
  p.mind.scenes = [scene("a", "charger", 100, { pose: null }), scene("b", "charger", 200, { pose: { x: 5, y: 5 } })];
  assert.equal(checkStatement(p, stays, 0, 6000)!.state, "unclear");
});

test("the wrong claim 'the pad is in the heater corner' is contradicted once the pet has found the pad and felt the warmth far apart", () => {
  const p = pet();
  const text = "The charging pad is in the heater corner";
  assert.equal(checkStatement(p, text, 0, 10)!.state, "unclear");
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 920, y: 90 } })];
  assert.equal(checkStatement(p, text, 0, 2000)!.state, "unclear", "has not felt the warmth yet");
  p.mind.scenes.push(scene("w", "warmer", 1500, { pose: { x: 60, y: 80 } }));
  assert.equal(checkStatement(p, text, 0, 2000)!.state, "unclear", "one warm moment is not a pattern: stepping away from a cold window also feels warmer");
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 920, y: 90 } }), scene("w", "warmer", 1500, { pose: { x: 60, y: 80 }, count: 3 })];
  const v = checkStatement(p, text, 0, 2000)!;
  assert.equal(v.state, "contradicted");
  assert.match(v.why, /3 of the 3 times it got suddenly warm I was at least 450 steps from where I found the pad/);
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 900, y: 90 } }), scene("w", "warmer", 1500, { pose: { x: 840, y: 130 }, count: 4 })];
  assert.equal(checkStatement(p, text, 0, 2000)!.state, "supported", "if they really were together it would be borne out");
  // a mixed picture is not decided either way
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 900, y: 90 } }), scene("w1", "warmer", 1500, { pose: { x: 840, y: 130 }, count: 2 }), scene("w2", "warmer", 1600, { pose: { x: 60, y: 80 }, count: 2 })];
  assert.equal(checkStatement(p, text, 0, 2000)!.state, "unclear");
});

test("statements it does not know how to test are left alone", () => {
  const p = pet();
  for (const t of ["I wonder what is behind the door", "Moss is cautious", "The Teacher is kind", "Pip, Moss and Coco should come close to the pad", "The toy might need its batteries checked"]) assert.equal(checkStatement(p, t, 0, 100), null, t);
});

test("a wrong claim from the Teacher is marked contradicted after the pet tests it, and the claim keeps the reason", () => {
  const p = pet();
  p.mind.claims = [claim("The charging pad is right next to the heater corner", 100), claim("Stand on the yellow pad to charge", 100)];
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 920, y: 90 }, count: 2 }), scene("w", "warmer", 1500, { pose: { x: 60, y: 80 }, count: 3 })];
  const r = verifyClaims(p, 3000);
  assert.deepEqual(r, { supported: 1, contradicted: 1 });
  assert.equal(p.mind.claims[0].status, "contradicted");
  assert.match(p.mind.claims[0].why!, /at least 450 steps from where I found the pad/);
  assert.equal(p.mind.claims[1].status, "supported", "standing on the pad to charge: the pet has been charged there twice since");
  assert.equal(p.mind.refuted[0].text, "The charging pad is right next to the heater corner");
  assert.deepEqual(verifyClaims(p, 4000), { supported: 0, contradicted: 0 }, "already decided: nothing new to report");
  // evidence can swing it back
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 900, y: 90 } }), scene("w", "warmer", 1500, { pose: { x: 850, y: 120 }, count: 3 })];
  assert.equal(verifyClaims(p, 5000).supported, 1);
  assert.equal(p.mind.claims[0].status, "supported");
});

test("a belief that experience contradicts loses most of its confidence at once, and is let go if it is still wrong hours later", () => {
  const p = pet();
  p.mind.beliefs = [
    { text: "The charging pad is in the heater corner", confidence: 0.8, updatedSec: 100 },
    { text: "The pad fills my battery", confidence: 0.6, updatedSec: 100 },
  ];
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 920, y: 90 } }), scene("w", "warmer", 1500, { pose: { x: 60, y: 80 }, count: 3 })];
  const r = adjustBeliefs(p, 3000);
  assert.equal(r.refuted, 1);
  const b = p.mind.beliefs[0];
  assert.equal(b.confidence, 0.32, "80% became 32%");
  assert.equal(b.verdict, "contradicted");
  assert.match(b.why!, /at least 450 steps from where I found the pad/);
  assert.equal(p.mind.beliefs[1].confidence > 0.6 || p.mind.beliefs[1].confidence === 0.6, true, "the unrelated belief is untouched or helped");
  adjustBeliefs(p, 3000 + H);
  assert.equal(p.mind.beliefs[0].confidence, 0.32, "not cut again every night");
  assert.ok(p.mind.beliefs.some((x) => x.text.includes("heater corner")), "kept, flagged, for now");
  adjustBeliefs(p, 3000 + 5 * H);
  assert.ok(!p.mind.beliefs.some((x) => x.text.includes("heater corner")), "let go");
  assert.match(p.mind.refuted.find((x) => x.text.includes("heater corner"))!.why, /at least 450 steps/);
});

test("a belief that experience bears out gains confidence once", () => {
  const p = pet();
  p.mind.beliefs = [{ text: "The steady tone leads me to the charging pad", confidence: 0.5, updatedSec: 0 }];
  p.mind.scenes = [scene("a", "charger", 100, { tone: withTone, count: 6 })];
  const r = adjustBeliefs(p, 1000);
  assert.equal(r.strengthened, 1);
  assert.equal(p.mind.beliefs[0].confidence, 0.65);
  assert.equal(p.mind.beliefs[0].verdict, "supported");
  adjustBeliefs(p, 2000);
  assert.equal(p.mind.beliefs[0].confidence, 0.65, "not boosted again for the same evidence");
});

test("a belief found wrong cannot be taken up again for a day, and repeating it does not revive the flagged one", () => {
  const p = pet();
  addRefuted(p, "The charging pad is in the heater corner", "far apart", 1000);
  assert.equal(copiesRefuted(p, "the charging pad is in the heater corner!", 2000), true);
  assert.equal(copiesRefuted(p, "The pad fills my battery", 2000), false);
  assert.equal(copiesRefuted(p, "the charging pad is in the heater corner", 1000 + REFUTED_FOR_SEC + 1), false, "a day later it may be considered again, and will be checked again");
  const think = (text: string, at: number) => applyThought(p, parseThought(JSON.stringify({ thought: "x", question: "q" + at, beliefs: [{ text, confidence: 0.9 }], suggestion: "none" }))!, at);
  think("The charging pad is in the heater corner", 2000);
  assert.equal(p.mind.beliefs.length, 0, "not taken up again");
  p.mind.beliefs = [{ text: "The pad is by the heater", confidence: 0.3, updatedSec: 0, verdict: "contradicted", why: "x" }];
  think("The pad is by the heater", 9000 + REFUTED_FOR_SEC);
  assert.equal(p.mind.beliefs[0].confidence, 0.3, "repeating a contradicted belief does not raise it");
  assert.equal(p.mind.beliefs[0].updatedSec, 0);
  for (let i = 0; i < MAX_REFUTED + 4; i++) addRefuted(p, `statement number ${i} was wrong`, "w", 3000 + i);
  assert.equal(p.mind.refuted.length, MAX_REFUTED);
});

test("gists: duplicates merge, a statement and its denial weaken the weaker, and testable gists are checked against experience", () => {
  const p = pet();
  p.mind.gists = [
    gist("a", "The steady tone leads me to the charging pad", { confidence: 0.6, sources: ["s1"], uses: 1 }),
    gist("b", "the steady tone leads me to the charging pad", { confidence: 0.4, sources: ["s2"], uses: 2 }),
    gist("c", "The steady tone does not lead me to the charging pad", { confidence: 0.3 }),
    gist("d", "Walls hurt when I bump into them", { confidence: 0.4, kinds: ["bump"] }),
  ];
  const r = reviseGists(p, 100);
  const byId = Object.fromEntries(p.mind.gists.map((g) => [g.id, g]));
  assert.ok(!byId.b, "the duplicate merged into the stronger one");
  assert.deepEqual(byId.a.sources.sort(), ["s1", "s2"]);
  assert.equal(byId.a.uses, 3);
  assert.equal(byId.c.verdict, "conflict");
  assert.equal(byId.c.confidence, 0.15);
  assert.match(byId.c.why!, /conflicts with: "The steady tone leads me to the charging pad"/);
  assert.equal(byId.d.verdict, undefined);
  assert.ok(r.conflicted >= 2);
  // and by evidence: the pad gist is contradicted
  p.mind.scenes = [scene("a", "charger", 50, { tone: withTone }), scene("n", "nocharge", 60, { count: 4 })];
  p.mind.gists = [gist("a", "The steady tone leads me to the charging pad", { confidence: 0.6, createdSec: 0 })];
  reviseGists(p, 200);
  assert.equal(p.mind.gists[0].verdict, "contradicted");
  assert.equal(p.mind.gists[0].confidence, 0.24);
  reviseGists(p, 200 + 5 * H);
  assert.equal(p.mind.gists.length, 0, "dropped when still contradicted hours later");
  assert.ok(p.mind.refuted.length >= 1);
});

test("conflict and duplicate detection need the same subject, not just the same words", () => {
  assert.equal(conflicts("The tone leads me to the pad", "The tone does not lead me to the pad"), false, "'lead' vs 'lead': similar but not identical words still count");
  assert.equal(similarity("The tone leads me to the pad", "The tone leads me to the pad"), 1);
  assert.equal(conflicts("The tone leads me to the pad", "The tone never leads me to the pad"), true);
  assert.equal(conflicts("The tone leads me to the pad", "Walls never hurt me at all"), false);
  assert.equal(duplicates("The tone leads me to the charging pad", "the tone leads me to the charging pad."), true);
  assert.equal(duplicates("The tone leads me to the pad", "The tone never leads me to the pad"), false, "opposites are not duplicates");
});

test("the notes show what experience said about each thing, and what was found wrong, so System 2 can let it go", () => {
  const p = pet();
  p.mind.claims = [{ ...claim("The pad is in the heater corner", 100), status: "contradicted", why: "the places are far apart" }, claim("The lamp is bright")];
  p.mind.beliefs = [{ text: "The pad is by the heater", confidence: 0.32, updatedSec: 0, verdict: "contradicted", why: "far apart" }, { text: "The tone leads to the pad", confidence: 0.65, updatedSec: 0, verdict: "supported" }];
  addRefuted(p, "The pad is by the heater", "far apart", 5000);
  const notes = buildNotes(p, 1, 600, 0, 6000);
  assert.match(notes, /- The pad is in the heater corner \[contradicted: the places are far apart\]/);
  assert.match(notes, /- The lamp is bright \[unverified\]/);
  assert.match(notes, /- The pad is by the heater \[how sure: 0\.32; my own experience disagrees: far apart\]/);
  assert.match(notes, /- The tone leads to the pad \[how sure: 0\.65; borne out by my experience\]/);
  assert.match(notes, /showed to be WRONG \(do not take them up again\):\n- The pad is by the heater \(far apart\)/);
  assert.match(buildNotes(pet(), 1, 600, 0, 6000), /showed to be WRONG[^\n]*\n- \(none\)/);
  p.mind.gists = [gist("g", "The pad is by the heater", { confidence: 0.2, verdict: "contradicted", why: "far apart" })];
  assert.match(describeGists(p)[0], /my experience disagrees: far apart/);
});

test("the Teacher is shown what the pets found wrong in what it told them, and is asked to correct it", async () => {
  const sim = new Simulation(new World(1), 1, roster);
  const p = sim.pets[0];
  p.mind.claims = [{ ...claim("The pad is in the heater corner", 100), status: "contradicted", why: "the places are far apart" }, { ...claim("Someone said the door is red", 100, "a voice to my left"), status: "contradicted", why: "x" }];
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "verify-")), "t");
  const prompts: string[] = [];
  const llm = { enabled: true, async complete(m: any[]) { prompts.push(m[0].content + "\n" + m[1].content); return { text: JSON.stringify({ summary: "s", long_term: [], pet_notes: {}, agenda: [{ in_minutes: 1, kind: "observe", target: "all", topic: "watch", outline: "" }] }), provider: "x", model: "m", tokensIn: 1, tokensOut: 1 }; } };
  const teacher = new Teacher(sim, llm as any, store, { set: async () => ({}) as any, recent: async () => [] }, { teacherSays: async () => ({ heardBy: [] }) as any }, { isPaused: () => false }, null, 1);
  await (teacher as any).makePlan("review");
  const sent = prompts[0];
  assert.match(sent, /Things you told the pets that their OWN experience has shown to be wrong: Pip: "The pad is in the heater corner" \(the places are far apart\)/);
  const line = sent.split("\n").find((l) => l.startsWith("Things you told the pets that their OWN experience"))!;
  assert.doesNotMatch(line, /door is red/, "only what the Teacher said counts as the Teacher's mistake");
  assert.match(sent, /say so honestly and correct it in a lesson/);
});

test("one night's consolidation reports what verification found, and it all survives a brain file; bad data is cleaned", () => {
  const p = pet();
  p.mind.claims = [claim("The charging pad is in the heater corner", 100)];
  p.mind.beliefs = [{ text: "The pad is in the heater corner", confidence: 0.7, updatedSec: 100 }];
  p.mind.gists = [gist("g", "The tone leads me to the charging pad", { kinds: ["charger"] }), gist("h", "The tone does not lead me to the charging pad", { confidence: 0.2 })];
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 920, y: 90 }, tone: withTone }), scene("w", "warmer", 1500, { pose: { x: 60, y: 80 }, count: 3 })];
  const s = consolidate(p, 3000);
  assert.equal(s.claimsContradicted, 1);
  assert.equal(s.beliefsRefuted, 1);
  assert.ok(s.gistsConflicted >= 1);
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, 3000))));
  assert.equal(file.mind.claims[0].why!.length > 0, true);
  assert.equal(file.mind.beliefs[0].verdict, "contradicted");
  assert.equal(file.mind.refuted!.length >= 1, true);
  const other = new Simulation(new World(2), 2, roster).pets[1];
  applyBrain(other, file, 100);
  assert.equal(other.mind.claims[0].status, "contradicted");
  assert.equal(other.mind.beliefs[0].verdict, "contradicted");
  assert.equal(copiesRefuted(other, "The charging pad is in the heater corner", 100), true, "a pet restored elsewhere still will not take it up");
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), mind: { ...file.mind, beliefs: [{ text: "x", verdict: "evil", why: 5 }, { text: "ok", confidence: 0.5, verdict: "contradicted", why: "w".repeat(500) }], refuted: [{ text: "", why: "x" }, { text: "r".repeat(500), why: "y", ageSec: -3 }, ...Array(30).fill({ text: "filler statement", why: "z" })] } });
  assert.equal(dirty.mind.beliefs[0].verdict, undefined);
  assert.equal(dirty.mind.beliefs[1].why!.length, 160);
  assert.equal(dirty.mind.refuted!.length, MAX_REFUTED - 1);
  assert.equal(dirty.mind.refuted![0].text.length, 160);
  const old = parseBrain({ ...JSON.parse(JSON.stringify(file)), mind: { ...file.mind, refuted: undefined } });
  assert.deepEqual(old.mind.refuted, []);
  const snap: any = JSON.parse(JSON.stringify(new Simulation(new World(3), 3, roster).snapshot()));
  for (const q of snap.pets) delete q.mind.refuted;
  assert.deepEqual(new Simulation(new World(3), 3, roster, snap).pets[0].mind.refuted, []);
});

test("regression: a statement with its own evidence rule is never 'supported' by a keyword while the evidence is thin", () => {
  const p = pet();
  // the pad has been found, but nothing has been felt near the heater: the heater claim cannot be judged yet
  p.mind.claims = [claim("The charging pad is right next to the heater corner", 100)];
  p.mind.beliefs = [{ text: "The charging pad is next to the heater corner", confidence: 0.5, updatedSec: 100 }];
  p.mind.gists = [gist("g", "The charging pad is next to the heater corner", { createdSec: 100, checkedSec: 100, kinds: ["charger"] })];
  p.mind.scenes = [scene("c", "charger", 1000, { pose: { x: 920, y: 90 }, count: 5 })];
  verifyClaims(p, 3000);
  adjustBeliefs(p, 3000);
  reviseGists(p, 3000);
  assert.equal(p.mind.claims[0].status, "unverified", "left alone, not guessed at");
  assert.equal(p.mind.beliefs[0].confidence, 0.5);
  assert.equal(p.mind.beliefs[0].verdict, undefined);
  assert.equal(p.mind.gists[0].confidence, 0.5);
});

test("regression: a claim about the tone is not borne out just because some tone-related moment happened", () => {
  const p = pet();
  p.mind.claims = [claim("The tone is pretty and tastes of apples", 100), claim("When you walk toward the tone it gets quieter", 100)];
  p.mind.scenes = [scene("t", "tonefirst", 500), scene("c", "charger", 600, { tone: withTone, count: 9 })];
  verifyClaims(p, 3000);
  assert.deepEqual(p.mind.claims.map((c) => c.status), ["unverified", "unverified"]);
});

test("regression: 'gets quieter' and 'gets louder' are judged in opposite directions from the same experience", () => {
  const p = pet();
  p.predict = { ...newPredict(), stats: { "toneVolume:following": { n: 100, mean: 0.02, var: 0.001, up: 85 } } };
  const louder = "When you walk toward the tone it gets louder", quieter = "When you walk toward the tone it gets quieter";
  assert.equal(checkStatement(p, louder, 0, 1)!.state, "supported");
  assert.equal(checkStatement(p, quieter, 0, 1)!.state, "contradicted");
  p.predict.stats["toneVolume:following"].up = 15;
  assert.equal(checkStatement(p, louder, 0, 1)!.state, "contradicted");
  assert.equal(checkStatement(p, quieter, 0, 1)!.state, "supported");
  assert.equal(checkStatement(p, "Walking toward the sound makes it softer", 0, 1)!.state, "supported", "other words for quieter");
  p.mind.claims = [claim(quieter, 0)];
  p.predict.stats["toneVolume:following"].up = 85;
  assert.deepEqual(verifyClaims(p, 100), { supported: 0, contradicted: 1 });
});

test("regression: a verdict outlives the evidence. Once found wrong, a claim, belief or gist stays wrong after the moments fade", () => {
  const p = pet();
  const text = "The humming never stops";
  p.mind.cues["tone:29"] = { key: "tone:29", pitch: 534, firstHeardSec: 0, lastHeardSec: 40 * H, exposureSec: 9000, support: 1, contra: 0, peakVolume: 0.9, peakAtSec: 40 * H, lastVolume: 0.9, lastSupportSec: 0 } as any;
  p.mind.claims = [claim(text, 0)];
  p.mind.beliefs = [{ text, confidence: 0.7, updatedSec: 0 }];
  p.mind.gists = [gist("g", text, { confidence: 0.6, createdSec: 0, checkedSec: 0, kinds: ["tonelost"] })];
  p.mind.scenes = [scene("lost", "tonelost", 10 * H)];
  consolidate(p, 11 * H);
  assert.equal(p.mind.claims[0].status, "contradicted");
  assert.equal(p.mind.beliefs[0].verdict, "contradicted");
  assert.equal(p.mind.gists[0].verdict, "contradicted");
  assert.equal(p.mind.beliefs[0].confidence, 0.28);
  p.mind.scenes = []; // the moment of the tone stopping has been forgotten
  consolidate(p, 20 * H);
  assert.equal(p.mind.claims[0].status, "contradicted", "forgetting the counterexample does not bring the claim back");
  consolidate(p, 40 * H);
  assert.equal(p.mind.claims[0].status, "contradicted", "and neither does a long quiet stretch: nothing going wrong is not evidence for 'never stops'");
  assert.equal(p.mind.beliefs.length, 0, "the flagged belief is let go a few hours later, whether or not the evidence is still around");
  assert.equal(p.mind.gists.length, 0);
  assert.ok(p.mind.refuted.some((r) => r.text === text));
});

test("newer experience can still overturn a verdict", () => {
  const p = pet();
  const text = "The steady tone always leads you to the charging pad";
  p.mind.claims = [{ ...claim(text, 0), status: "contradicted", why: "x", checkedSec: 1000 }];
  p.mind.beliefs = [{ text, confidence: 0.2, updatedSec: 0, verdict: "contradicted", why: "x", checkedSec: 1000 }];
  p.mind.gists = [gist("g", text, { confidence: 0.2, verdict: "contradicted", why: "x", checkedSec: 1000, kinds: ["charger"] })];
  p.mind.scenes = [scene("old", "charger", 500, { tone: withTone, count: 10 })];
  consolidate(p, 2 * H);
  assert.equal(p.mind.claims[0].status, "contradicted", "experience from before the verdict does not overturn it");
  p.mind.scenes = [scene("new", "charger", 1500, { tone: withTone, count: 10 })];
  consolidate(p, 3 * H);
  assert.equal(p.mind.claims[0].status, "supported", "after it, ten clean successes do");
  assert.equal(p.mind.beliefs[0].verdict, "supported");
  assert.equal(p.mind.gists[0].verdict, "supported");
});

test("simple cause-and-effect claims are borne out by repeated experience since, and never contradicted by its absence", () => {
  const p = pet();
  p.mind.claims = [claim("Standing on the charging pad fills your battery", 100), claim("The heater makes the room warm", 100), claim("The lamp makes it brighter", 100), claim("The sunlight through the window makes it brighter", 100)];
  p.mind.scenes = [scene("c", "charger", 500, { count: 1 }), scene("w", "warmer", 500, { count: 5 }), scene("b", "brighter", 500, { count: 2 })];
  assert.deepEqual(verifyClaims(p, 1000), { supported: 3, contradicted: 0 }, "once is not enough for the pad; five warm moments, two bright ones are");
  assert.deepEqual(p.mind.claims.map((c) => c.status), ["unverified", "supported", "supported", "supported"]);
  assert.match(p.mind.claims[1].why!, /felt it get suddenly warm 5 times since/);
  p.mind.scenes = [];
  assert.deepEqual(verifyClaims(p, 2000), { supported: 0, contradicted: 0 }, "nothing happening is not a contradiction");
  assert.equal(p.mind.claims[1].status, "supported", "and a supported claim stays supported when the moments fade");
});

test("regression: loose remarks and instructions are never marked supported by a keyword that happened to match some moment", () => {
  const p = pet();
  p.mind.claims = [
    claim("Pip, Moss, and Coco should come close to the pad", 100),
    claim("The speaker should check their battery and charge it if needed", 100),
    claim("The toy might need its batteries checked", 100),
    claim("Moss is already on the pad", 100),
  ];
  p.mind.scenes = [scene("c", "charger", 500, { count: 20 }), scene("t", "tonefirst", 600)];
  verifyClaims(p, 3000);
  assert.ok(p.mind.claims.slice(0, 3).every((c) => c.status === "unverified"), "an instruction or a rambling remark proves nothing either way");
});

test("leftover 'supported' marks from the old keyword rule (no reason attached) are undone, while earned ones keep their reason", () => {
  const p = pet();
  p.mind.claims = [
    { ...claim("Pip, Moss, and Coco should come close to the pad", 100), status: "supported" },
    { ...claim("The heater makes the room warm", 100), status: "supported", why: "I have felt it get suddenly warm 5 times since" },
  ];
  p.mind.scenes = [scene("w", "warmer", 500, { count: 5 })];
  verifyClaims(p, 1000);
  assert.deepEqual(p.mind.claims.map((c) => c.status), ["unverified", "supported"]);
});
