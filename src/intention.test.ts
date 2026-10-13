import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./system1.js";
import { applyThought, parseThought } from "./system2.js";
import { speechAboutIntention } from "./intention.js";
import { spawnPet } from "./pet.js";
import { Rng } from "./rng.js";
import type { Observation } from "./sensors.js";

const pet = () => {
  const p = spawnPet({ id: "pip", name: "Pip", color: "#fff", traits: { curiosity: 0.2, social: 0.2, caution: 0.2, patience: 0.2 } }, 1, 0);
  p.drives = { energy: 0, curiosity: 0, social: 0, rest: 0 };
  p.energy = 100;
  p.mode = "idle";
  p.heading = 0;
  return p;
};
const thought = (over: Record<string, unknown> = {}) => ({
  question: "q", thought: "t", beliefs: [] as { text: string; confidence: number }[], intention: null as string | null, doing: null, dropIntention: false, suggestion: "none" as const, say: null, askTeacher: null, retract: [] as string[], tune: null, ...over,
});
const obs = (over: Partial<Observation> = {}): Observation => ({
  timeOfDay: 600, light: 60, temperature: 21, energy: 100, chargeRate: 0, heading: 0, speed: 0, turnRate: 0, bumped: false, touch: null,
  proximity: { left: 200, front: 200, right: 200 }, vision: [], near: [], hearing: null, tone: null, grid: [], ...over,
});
const moving = { category: "moving" as const, distance: 120, bearing: 0.2, size: 40, hue: 10, confidence: 1 };

test("a doing with nothing in the notes is rejected and the previous intention stays", () => {
  const p = pet();
  p.mind.intention = { goal: "stay with the one I know", sinceSec: 0, doing: "stay_with", progressSec: 0 };
  p.mind.episodes = ["bumped into another pet"];
  applyThought(p, thought({ intention: "find a pad", doing: "go_to_pad" }), 50);
  assert.equal(p.mind.intention?.goal, "stay with the one I know");
  assert.equal(p.mind.intention?.doing, "stay_with");
});

test("a supported doing is kept, and a sentence alone does not steer", () => {
  const p = pet();
  p.mind.episodes = ["bumped into another pet"];
  applyThought(p, thought({ intention: "stay with the one I know", doing: "stay_with" }), 10);
  assert.equal(p.mind.intention?.doing, "stay_with");
  applyThought(p, thought({ intention: "wonder about the light" }), 20);
  assert.equal(p.mind.intention?.goal, "wonder about the light");
  assert.equal(p.mind.intention?.doing, undefined);
});

test("stay_with walks toward a visible creature even when the social need is zero", () => {
  const p = pet();
  p.mind.intention = { goal: "stay with the one I know", sinceSec: 0, doing: "stay_with", progressSec: 0 };
  const d = decide(p, obs({ vision: [moving] }), new Rng(1), 10);
  assert.equal(d.action, "approach_pet");
  assert.match(d.reason, /stay with the one I know/);
});

test("a wall, deep sleep, and an empty battery still come before the intention", () => {
  const p = pet();
  p.mind.intention = { goal: "stay with the one I know", sinceSec: 0, doing: "stay_with", progressSec: 0 };
  assert.equal(decide(p, obs({ vision: [moving], proximity: { left: 200, front: 10, right: 200 } }), new Rng(1), 10).action, "avoid");
  p.mode = "sleeping"; p.drives.rest = 0.9;
  assert.equal(decide(p, obs({ vision: [moving] }), new Rng(1), 10).action, "sleep");
  p.mode = "dormant";
  assert.equal(decide(p, obs({ vision: [moving] }), new Rng(1), 10).action, "dormant");
});

test("standing beside them for two minutes ends the concern, and no progress for three minutes drops it", () => {
  const p = pet();
  p.mind.intention = { goal: "stay with the one I know", sinceSec: 0, doing: "stay_with", progressSec: 0, heldSince: 0 };
  const beside = { ...moving, distance: 40 };
  assert.equal(decide(p, obs({ vision: [beside] }), new Rng(1), 130).action, "wander");
  assert.equal(p.mind.intention, null);
  p.mind.intention = { goal: "stay with the one I know", sinceSec: 0, doing: "stay_with", progressSec: 0, mark: 100 };
  decide(p, obs({ vision: [moving] }), new Rng(1), 200);
  assert.equal(p.mind.intention, null);
});

test("a doorway intention heads for the door, and stepping through ends it", () => {
  const p = pet();
  p.mind.sensed.seen = ["an open doorway ahead"];
  p.mind.intention = { goal: "see what is through the doorway", sinceSec: 0, doing: "go_to_door", progressSec: 0 };
  const door = { category: "static" as const, distance: 90, bearing: 0, size: 80, hue: 0, confidence: 1, door: "open" as const };
  assert.equal(decide(p, obs({ vision: [door] }), new Rng(1), 10).action, "explore_door");
  p.inDoorway = true;
  decide(p, obs({ vision: [door] }), new Rng(1), 20);
  assert.equal(p.mind.intention, null);
});

test("a line about something else is not about the intention", () => {
  assert.equal(speechAboutIntention("stay with the one I know", "I will stay with them"), true);
  assert.equal(speechAboutIntention("stay with the one I know", "the lamp is bright"), false);
  const t = parseThought('{"thought":"I should stay.","question":"where","doing":"stay_with","intention":"stay with them","suggestion":"none"}');
  assert.equal(t?.doing, "stay_with");
});
