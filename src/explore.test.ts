import { test } from "node:test";
import assert from "node:assert/strict";
import { exploreSettings, exploreSteer, noteTread } from "./explore.js";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { HOUSE } from "./layout.js";
import type { PetDef, PetState } from "./pet.js";
import type { Observation } from "./sensors.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const pet = (): PetState => { const p = new Simulation(new World(1, undefined, HOUSE), 1, roster).pets[0]; p.odo = { x: 25, y: 25 }; p.heading = 0; p.places = undefined; return p; };
const GRID = ["#########", "#########", "#########", "#########", "...^.....", "####.####", "####.####", "####.####", "####.####"];
const obs = (grid: string[]): Observation => ({ grid, proximity: { left: 100, front: 100, right: 100 } } as unknown as Observation);

test("a patch of ground is counted once each time it is stepped onto, not every tick", () => {
  const p = pet();
  noteTread(p); noteTread(p); noteTread(p);
  assert.equal(Object.values(p.places!.tread!)[0], 1);
  p.odo = { x: 80, y: 25 }; noteTread(p);
  p.odo = { x: 25, y: 25 }; noteTread(p);
  assert.equal(Object.values(p.places!.tread!).reduce((a, b) => a + b, 0), 3);
});

test("it does nothing unless switched on, and nothing in the open", () => {
  const p = pet(); noteTread(p);
  exploreSettings.on = false;
  assert.equal(exploreSteer(p, obs(GRID), 100), null);
  exploreSettings.on = true;
  const room = Array.from({ length: 9 }, (_, r) => (r === 4 ? "....^...." : "........."));
  assert.equal(exploreSteer(p, obs(room), 100), null);
  exploreSettings.on = false;
});

test("in a passage it keeps on straight, and turns into the way it has trodden least when the straight way has been trodden", () => {
  exploreSettings.on = true;
  const p = pet(); noteTread(p);
  const g = ["####.####", "####.####", "####.####", "####.####", "####^####", "####.####", "####.####", "####.####", "####.####"];
  const s = exploreSteer(p, obs(g), 100)!;
  assert.match(s.reason, /keeping on/);
  assert.ok(s.forward > 0.5);
  // a dead end: wall ahead, the way back is open
  const dead = ["#########", "#########", "#########", "#########", "####^####", "####.####", "####.####", "####.####", "####.####"];
  const back = exploreSteer(p, obs(dead), 100)!;
  assert.match(back.reason, /dead end/);
  assert.ok(Math.abs(back.turn) > 1);
  exploreSettings.on = false;
});

test("at an opening it takes the side it has not trodden when the way on has been", () => {
  exploreSettings.on = true;
  const p = pet(); p.heading = 0; noteTread(p);
  const g = ["####.####", "####.####", "####.####", "####.####", ".....^...".replace(".....^...", "....^...."), "####.####", "####.####", "####.####", "####.####"];
  // heading east: the way on is well trodden, the opening to the right (south) is not
  for (const x of [75, 125, 175]) p.places!.tread![`${Math.floor(x / 50)},0`] = 4;
  const s = exploreSteer(p, obs(g), 100)!;
  assert.match(s.reason, /trodden least/);
  exploreSettings.on = false;
});
