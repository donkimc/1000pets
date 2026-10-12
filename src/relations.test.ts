import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { buildNotes } from "./system2.js";
import { verifyClaims } from "./sleep.js";
import type { PetDef, PetState } from "./pet.js";
import type { Detection } from "./sensors.js";
import { KNOWN_SEC, affinityOf, creditClaim, describeOthers, learnTeacherLook, observeOthers, pickCompany, relationFor, sourceOf, trustOf } from "./relations.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const pet = (): PetState => new Simulation(new World(1), 1, roster).pets[0];
const mover = (hue: number, distance = 60): Detection => ({ category: "moving", distance, bearing: 0, size: 30, hue, confidence: 1 });

test("the same look is the same individual; a different look is someone new", () => {
  const p = pet();
  const a = relationFor(p.mind, 140, 0), again = relationFor(p.mind, 143, 10), b = relationFor(p.mind, 220, 20);
  assert.equal(a.key, again.key, "a few degrees of difference is still the same one");
  assert.notEqual(a.key, b.key);
  assert.match(a.label, /green/);
});

test("time with someone who is in view, and lonely company being good, builds affinity; bumps cost it", () => {
  const p = pet();
  for (let i = 0; i < 100; i++) observeOthers(p, [mover(160, 60)], "", i * 5, 5, 0.6); // 500 s near, lonely
  const r = Object.values(p.mind.others)[0];
  assert.equal(r.seenSec, 500);
  assert.ok(affinityOf(r) > 0.5, `affinity ${affinityOf(r)}`);
  for (let i = 0; i < 30; i++) observeOthers(p, [mover(160, 40)], "pet", 1000 + i * 30, 5, 0.6);
  assert.equal(r.bumps, 30);
  assert.ok(affinityOf(r) < 0.5);
  const q = pet();
  for (let i = 0; i < 100; i++) observeOthers(q, [mover(160, 60)], "", i * 5, 5, 0.1); // not lonely: company did nothing for it
  assert.ok(affinityOf(Object.values(q.mind.others)[0]) <= 0, "no credit when the company was not needed");
});

test("a bump continuing over several ticks counts once, and is not put down to someone out of sight", () => {
  const p = pet();
  for (let i = 0; i < 4; i++) observeOthers(p, [mover(160, 40)], "pet", i * 5, 5, 0.5);
  assert.equal(Object.values(p.mind.others)[0].bumps, 1);
  const q = pet();
  observeOthers(q, [], "pet", 0, 5, 0.5);
  assert.equal(Object.keys(q.mind.others).length, 0);
});

test("what a seen speaker says is theirs; an unseen voice is nobody's", () => {
  const p = pet();
  assert.equal(sourceOf(p.mind, { hue: 160 }, false, 0), null);
  const k = sourceOf(p.mind, { hue: 160 }, true, 0);
  assert.ok(k && p.mind.others[k]);
});

test("trust follows how a person's claims turned out, once each, and recounts a flipped verdict", () => {
  const p = pet();
  const k = sourceOf(p.mind, { hue: 160 }, true, 0)!;
  const mk = (status: "supported" | "contradicted" | "unverified") => ({ text: "x", from: "a voice", tSec: 0, status, fromKey: k } as any);
  const r = p.mind.others[k];
  assert.equal(trustOf(r), 0.5);
  const c1 = mk("supported"), c2 = mk("contradicted");
  creditClaim(p.mind, c1); creditClaim(p.mind, c1); creditClaim(p.mind, c2);
  assert.deepEqual([r.told, r.right, r.wrong], [2, 1, 1]);
  assert.ok(trustOf(r) < 0.5, "a wrong claim weighs more than a right one");
  c2.status = "supported"; creditClaim(p.mind, c2);
  assert.deepEqual([r.told, r.right, r.wrong], [2, 2, 0]);
  assert.ok(trustOf(r) > 0.7);
});

test("nightly claim checking credits the one who said it", () => {
  const p = pet();
  const k = sourceOf(p.mind, { hue: 160 }, true, 0)!;
  p.mind.claims = [{ text: "The pet pad charges you when you stand on it", from: "x", tSec: 0, status: "unverified", fromKey: k }];
  p.mind.scenes = [{ id: "a", tSec: 100, kind: "charger", count: 4, why: "found it", importance: 0.5, pose: null, seen: [], near: [], view: "", tone: null, light: 20, temperature: 18, battery: 30, action: "wander", uses: 0, lastUsedSec: -1 } as any];
  verifyClaims(p, 3600);
  assert.equal(p.mind.claims[0].status, "supported");
  assert.equal(p.mind.others[k].right, 1);
});

test("the Teacher is known by name, and once seen speaking its look is named and earlier history moves to it", () => {
  const p = pet();
  const ghost = sourceOf(p.mind, "teacher", false, 0)!;
  assert.equal(ghost, "teacher");
  p.mind.others.teacher.told = 2; p.mind.others.teacher.right = 2;
  p.mind.claims = [{ text: "x", from: "t", tSec: 0, status: "supported", fromKey: "teacher", counted: "supported" }];
  const k = learnTeacherLook(p.mind, 170, 100);
  assert.equal(p.mind.others[k].label, "the Teacher");
  assert.equal(p.mind.others.teacher, undefined);
  assert.equal(p.mind.others[k].right, 2);
  assert.equal(p.mind.claims[0].fromKey, k);
  assert.equal(sourceOf(p.mind, "teacher", false, 200), k, "not in view: still the same Teacher");
});

test("when lonely it prefers better company at a longer walk, and never refuses anyone", () => {
  const p = pet();
  const good = relationFor(p.mind, 100, 0), bad = relationFor(p.mind, 200, 0);
  good.seenSec = 2 * KNOWN_SEC; good.goodSec = 2 * KNOWN_SEC * 0.5;
  bad.seenSec = 3600; bad.bumps = 60;
  assert.equal(pickCompany(p, [mover(200, 60), mover(100, 80)], 0)!.hue, 100, "farther, but better company");
  assert.equal(pickCompany(p, [mover(200, 60)], 0)!.hue, 200, "the only one in view is still company");
  assert.equal(pickCompany(p, [mover(200, 60), mover(100, 200)], 0)!.hue, 200, "not worth a much longer walk");
});

test("the notes list who it knows with a plain account of the record", () => {
  const p = pet();
  const r = relationFor(p.mind, 160, 0);
  r.seenSec = 4000; r.told = 3; r.right = 0; r.wrong = 3; r.bumps = 2;
  const lines = describeOthers(p, 4000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /often wrong: 0 of 3/);
  assert.match(lines[0], /bumped into them 2x/);
  assert.match(buildNotes(p, 1, 600, 0, 4000), /The others I know/);
});

test("who it knows travels in a brain file and survives a bad one", () => {
  const p = pet();
  const k = sourceOf(p.mind, { hue: 160 }, true, 0)!;
  Object.assign(p.mind.others[k], { seenSec: 900, told: 2, right: 2 });
  p.mind.claims = [{ text: "x", from: "v", tSec: 0, status: "supported", fromKey: k, counted: "supported" }];
  const b = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, 1000, "t"))));
  const q = new Simulation(new World(1), 1, roster).pets[1];
  applyBrain(q, b, 5000);
  assert.equal(q.mind.others[k].right, 2);
  assert.equal(q.mind.claims[0].fromKey, k);
  const raw = JSON.parse(JSON.stringify(exportBrain(p, 1000, "t")));
  raw.others = [{ key: "bad key!", hue: 5 }, null, { key: "ok1", hue: "x", seenSec: -5 }];
  const clean = parseBrain(raw);
  assert.deepEqual(clean.others!.map((o) => o.key), ["ok1"]);
  assert.equal(clean.others![0].seenSec, 0);
});
