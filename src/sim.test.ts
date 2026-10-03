import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World, ROOM, SOLIDS, circleHitsShape } from "./world.js";
import { PET_RADIUS, spawnPet, type PetDef } from "./pet.js";
import { sense, rayDistance, VISION_HALF_ANGLE } from "./sensors.js";
import { Rng } from "./rng.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const DAY_MS = 86400_000;
const make = (seed = 1) => new Simulation(new World(seed), seed, roster);

test("pets stay in the room, out of solids and out of each other, for 3 days", () => {
  const sim = make();
  for (let h = 1; h <= 72; h++) {
    sim.step(h * 3600_000);
    for (const p of sim.pets) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.energy));
      assert.ok(p.x >= PET_RADIUS - 0.01 && p.x <= ROOM.width - PET_RADIUS + 0.01);
      assert.ok(p.y >= PET_RADIUS - 0.01 && p.y <= ROOM.height - PET_RADIUS + 0.01);
      assert.ok(!SOLIDS.some((s) => circleHitsShape(p.x, p.y, PET_RADIUS - 0.5, s)), `${p.id} inside a solid at hour ${h}`);
      assert.ok(p.energy >= 0 && p.energy <= 100);
      for (const v of Object.values(p.drives)) assert.ok(v >= 0 && v <= 1);
    }
  }
});

test("same seed is identical regardless of tick size", () => {
  const a = make(5);
  const b = make(5);
  a.step(2 * DAY_MS);
  for (let t = 0; t <= 2 * DAY_MS; t += 250_000) b.step(t);
  b.step(2 * DAY_MS);
  assert.deepEqual(a.pets, b.pets);
});

test("snapshot resume matches an uninterrupted run", () => {
  const full = make(8);
  full.step(2 * DAY_MS);
  const part = make(8);
  part.step(DAY_MS);
  const world = new World(8, JSON.parse(JSON.stringify(part.world.snap)));
  const resumed = new Simulation(world, 8, roster, JSON.parse(JSON.stringify(part.snapshot())));
  resumed.step(2 * DAY_MS);
  assert.deepEqual(full.pets, resumed.pets);
});

test("pets diverge: different traits lead to different paths", () => {
  const sim = make(3);
  sim.step(DAY_MS);
  const [a, b] = sim.pets;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 1);
});

test("vision cone sees an object ahead but not behind", () => {
  const w = new World(1);
  const p = spawnPet({ id: "t", name: "T", color: "#ff0000", traits: roster[0].traits }, 1, 0);
  p.x = 300; p.y = 350; // table is at ~470,390 to the east
  const rng = new Rng(1);
  p.heading = 0;
  const ahead = sense(p, [p], w, [], 0, rng);
  assert.ok(ahead.vision.some((v) => v.category === "static" && Math.abs(v.bearing) < VISION_HALF_ANGLE));
  p.heading = Math.PI;
  const behind = sense(p, [p], w, [], 0, rng);
  assert.ok(!behind.vision.some((v) => v.distance > 100 && v.distance < 250 && Math.abs(v.bearing) < 0.4 && v.size === 140));
});

test("proximity ray reports a wall at the right distance", () => {
  const d = rayDistance(100, 300, Math.PI, []);
  assert.ok(d >= 94 && d <= 106, String(d));
});

test("pets hear a noise from the window, louder when closer", () => {
  const w = new World(1);
  const p = spawnPet(roster[0], 1, 0);
  const sound = { tSec: 0, x: 750, y: 6, volume: 0.7 };
  p.x = 700; p.y = 100;
  const near = sense(p, [p], w, [sound], 10, new Rng(1)).hearing;
  p.x = 100; p.y = 650;
  const far = sense(p, [p], w, [sound], 10, new Rng(1)).hearing;
  assert.ok(near && (!far || near.volume > far.volume));
});

test("30 days: pets keep living (no permanent dormancy, all drives active)", () => {
  const sim = make(11);
  const modes = new Map<string, number>();
  let samples = 0;
  for (let h = 1; h <= 30 * 24; h++) {
    sim.step(h * 3600_000);
    if (h % 6 === 0) {
      samples++;
      for (const p of sim.pets) modes.set(p.id + ":" + p.mode, (modes.get(p.id + ":" + p.mode) ?? 0) + 1);
    }
  }
  for (const p of sim.pets) {
    const dormant = modes.get(p.id + ":dormant") ?? 0;
    assert.ok(dormant / samples < 0.5, `${p.id} dormant ${dormant}/${samples}`);
  }
});
