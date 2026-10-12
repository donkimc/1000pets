import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation, describeNear } from "./sim.js";
import { World } from "./world.js";
import { sense, NEAR_RANGE } from "./sensors.js";
import { Rng } from "./rng.js";
import { describeSource, type Speaker } from "./speech.js";
import { buildNotes } from "./system2.js";
import type { PetDef } from "./pet.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));

function scene() {
  const sim = new Simulation(new World(1), 1, roster);
  const [pip, moss, coco] = sim.pets;
  pip.x = 800; pip.y = 300; pip.heading = 0; // facing east, in open floor
  moss.x = 100; moss.y = 100; coco.x = 100; coco.y = 650;
  sim.human.x = 100; sim.human.y = 680; sim.teacher.x = 150; sim.teacher.y = 350;
  const obs = () => sense(pip, sim.pets, sim.world, [], 0, new Rng(1), sim.human, sim.teacher);
  return { sim, pip, obs };
}

test("someone right behind a pet is invisible to vision but felt by the near-field sense", () => {
  const { sim, pip, obs } = scene();
  sim.human.x = pip.x - 50; sim.human.y = pip.y; // directly behind, 50 units centre to centre
  const o = obs();
  assert.ok(!o.vision.some((v) => v.category === "moving"), "outside the cone, so not seen");
  assert.equal(o.near.length >= 1, true);
  const n = o.near[0];
  assert.equal(n.category, "moving");
  assert.ok(Math.abs(Math.abs(n.bearing) - Math.PI) < 0.1, "behind");
  assert.ok(n.gap < 40);
  assert.match(describeNear(n), /a moving thing (very close|touching me), behind me/);
});

test("the near field sees all around, ignores faraway things, and carries no identity", () => {
  const { sim, pip, obs } = scene();
  assert.deepEqual(obs().near, [], "nothing within reach in the open");
  sim.pets[1].x = pip.x; sim.pets[1].y = pip.y - 60; // a pet to the left (north when facing east)
  sim.teacher.x = pip.x; sim.teacher.y = pip.y + 70; // the teacher to the right
  const near = obs().near;
  assert.equal(near.length, 2);
  assert.ok(near.every((n) => n.category === "moving" && n.gap <= NEAR_RANGE));
  assert.deepEqual(Object.keys(near[0]).sort(), ["bearing", "category", "gap"], "no name, id or colour");
  assert.ok(near[0].bearing * near[1].bearing < 0, "one on each side");
});

test("objects count too, measured from their edge", () => {
  const { pip, obs } = scene();
  pip.x = 470; pip.y = 460; // just below the table (x 400-540, y 350-430)
  const o = obs().near.find((n) => n.category === "static");
  assert.ok(o && o.gap < 30, `table gap ${o?.gap}`);
});

test("a close speaker outside the vision cone is not described as unseen", () => {
  const { sim, pip } = scene();
  const spk = (x: number, y: number): Speaker => ({ kind: "human", id: "human", name: "Human", x, y });
  const behindClose = describeSource(pip, spk(pip.x - 60, pip.y));
  assert.match(behindClose, /very close, behind me/);
  assert.match(behindClose, /right next to me/);
  assert.doesNotMatch(behindClose, /cannot see/);
  assert.match(describeSource(pip, spk(pip.x - 300, pip.y)), /cannot see who it is/, "far and behind is still unseen");
  assert.match(describeSource(pip, { ...spk(pip.x - 60, pip.y), kind: "teacher", id: "teacher", name: "Teacher" }), /the Teacher \(very close/);
  void sim;
});

test("the pet's notes include what is within reach, and old saves without it still work", () => {
  const { sim, pip } = scene();
  sim.human.x = pip.x - 50; sim.human.y = pip.y;
  sim.step(5000);
  assert.ok(pip.mind.sensed.near.length >= 1);
  assert.match(buildNotes(pip, 1, 600), /Within reach, in any direction.*moving thing/);
  const snap: any = JSON.parse(JSON.stringify(sim.snapshot()));
  delete snap.pets[0].mind.sensed.near;
  const old = new Simulation(sim.world, 1, roster, snap);
  assert.deepEqual(old.pets[0].mind.sensed.near, []);
  assert.match(buildNotes(old.pets[0], 1, 600), /Within reach.*nothing/);
});
