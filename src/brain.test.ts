import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { readFileSync } from "node:fs";
import type { PetDef } from "./pet.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));

function pet() {
  const sim = new Simulation(new World(1), 1, roster);
  const p = sim.pets[0];
  sim.simSec = 10_000;
  p.mind.beliefs.push({ text: "the lamp makes the corner warm", confidence: 0.8, updatedSec: 9_000 });
  p.mind.claims.push({ text: "the heater is safe", from: "the Teacher", tSec: 9_500, status: "unverified" });
  p.mind.intention = { goal: "find the warm corner", sinceSec: 8_000 };
  p.mind.episodes.push("D1 02:00 sat by the lamp");
  p.stats.s2Thoughts = 7;
  return { sim, p };
}

test("a brain round-trips through JSON and keeps ages, not clock times", () => {
  const { sim, p } = pet();
  const file = JSON.parse(JSON.stringify(exportBrain(p, sim.simSec, { label: "early Pip" })));
  assert.equal(file.mind.beliefs[0].ageSec, 1000);
  assert.equal(file.mind.intention.ageSec, 2000);
  const parsed = parseBrain(file);
  assert.equal(parsed.label, "early Pip");
  assert.deepEqual(parsed.mind.claims[0], { text: "the heater is safe", from: "the Teacher", status: "unverified", ageSec: 500 });
});

test("applying a brain in a simulation with a different clock rebases times and restores personality", () => {
  const { sim, p } = pet();
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, sim.simSec))));
  const other = new Simulation(new World(2), 2, roster);
  other.simSec = 500; // a much younger world
  const target = other.pets[1];
  const bodyBefore = { x: target.x, y: target.y, energy: target.energy };
  applyBrain(target, file, other.simSec);
  assert.deepEqual(target.traits, p.traits);
  assert.equal(target.mind.beliefs[0].text, "the lamp makes the corner warm");
  assert.equal(target.mind.beliefs[0].updatedSec, 500 - 1000);
  assert.equal(target.mind.intention!.goal, "find the warm corner");
  assert.equal(target.stats.s2Thoughts, 7);
  assert.equal(target.name, "Moss", "name stays unless identity is adopted");
  assert.deepEqual({ x: target.x, y: target.y, energy: target.energy }, bodyBefore, "body stays unless asked");
  assert.equal(target.brainTraits, true);
});

test("restored traits survive a restart that re-reads config/pets.json", () => {
  const { sim, p } = pet();
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, sim.simSec))));
  const target = sim.pets[1];
  applyBrain(target, file, sim.simSec);
  const reloaded = new Simulation(sim.world, 1, roster, JSON.parse(JSON.stringify(sim.snapshot())));
  assert.deepEqual(reloaded.pets[1].traits, p.traits);
});

test("adopting identity takes the name and colour; body only when asked", () => {
  const { sim, p } = pet();
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, sim.simSec, { includeBody: true }))));
  const target = sim.pets[2];
  p.x = 123;
  applyBrain(target, { ...file, body: { x: 123, y: 321, heading: 0, energy: 40 } }, sim.simSec, { adoptIdentity: true, includeBody: true });
  assert.equal(target.name, "Pip");
  assert.equal(target.x, 123);
  assert.equal(target.energy, 40);
});

test("untrusted brain files are validated and clamped", () => {
  assert.throws(() => parseBrain(null), /not a 1000pets brain/);
  assert.throws(() => parseBrain({ kind: "1000pets-brain", v: 2, id: "x", name: "x" }), /version/);
  assert.throws(() => parseBrain({ kind: "1000pets-brain", v: 1, id: "!!", name: "" }), /no id or name/);
  const b = parseBrain({
    kind: "1000pets-brain", v: 1, id: "Evil/../Pet", name: "N".repeat(100), color: "red", traits: { curiosity: 9, social: "x" },
    mind: { beliefs: Array.from({ length: 100 }, (_, i) => ({ text: "b" + i, confidence: 7, ageSec: -5 })), claims: [{ text: "c", status: "bogus" }], episodes: [1, "ok"] },
    drives: { curiosity: -3 }, stats: { s2Thoughts: -4 },
  });
  assert.equal(b.id, "evilpet");
  assert.equal(b.name.length, 24);
  assert.equal(b.color, "");
  assert.equal(b.traits.curiosity, 1);
  assert.equal(b.traits.social, 0.5);
  assert.equal(b.mind.beliefs.length, 20);
  assert.equal(b.mind.beliefs[0].confidence, 1);
  assert.equal(b.mind.beliefs[0].ageSec, 0);
  assert.equal(b.mind.claims[0].status, "unverified");
  assert.deepEqual(b.mind.episodes, ["ok"]);
  assert.equal(b.drives.curiosity, 0);
  assert.equal(b.stats.s2Thoughts, 0);
});
