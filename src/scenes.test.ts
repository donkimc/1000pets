import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Rng } from "./rng.js";
import { sense, type Observation } from "./sensors.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { buildNotes } from "./system2.js";
import { MAX_SCENES, colourWord, describeScene, markUsed, renderView, selectScenes, storeScene, updateOdometry, watchScenes, type Scene } from "./scenes.js";
import type { PetDef, PetState } from "./pet.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));

function pet() {
  const sim = new Simulation(new World(1), 1, roster);
  const p = sim.pets[0];
  p.x = 800; p.y = 300; p.heading = 0;
  sim.pets[1].x = 100; sim.pets[1].y = 100; sim.pets[2].x = 100; sim.pets[2].y = 650;
  sim.human.x = 100; sim.human.y = 680; sim.teacher.x = 150; sim.teacher.y = 400;
  const obs = (): Observation => sense(p, sim.pets, sim.world, [], 0, new Rng(1), sim.human, sim.teacher);
  return { sim, p, obs };
}

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: "s", tSec: 0, kind: "bump", why: "bumped into a wall", importance: 0.3, pose: { x: 0, y: 0 }, seen: [], near: [], view: "...........|....",
  light: 20, temperature: 18, battery: 60, action: "wander", uses: 0, lastUsedSec: -1, ...over,
});

test("colours are named from hue", () => {
  assert.deepEqual([0, 30, 55, 120, 170, 230, 280, 330, 359].map(colourWord), ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "red"]);
});

test("the text-art view places things across the cone and around the body", () => {
  const half = (55 * Math.PI) / 180;
  const v = renderView(
    [
      { category: "static", size: 150, distance: 200, bearing: -half + 0.01 }, // far left, large
      { category: "moving", size: 36, distance: 100, bearing: 0 }, // dead ahead
      { category: "static", size: 40, distance: 300, bearing: half - 0.01 }, // far right, small
    ],
    [{ category: "moving", gap: 10, bearing: Math.PI }, { category: "static", gap: 20, bearing: -1.5 }],
  );
  assert.equal(v, "#....@....o|..@o");
  assert.equal(v.length, 16);
  assert.equal(renderView([], []), "...........|....");
});

test("in the same column the nearest thing wins", () => {
  const v = renderView([{ category: "static", size: 150, distance: 300, bearing: 0 }, { category: "moving", size: 36, distance: 90, bearing: 0.01 }], []);
  assert.equal(v[5], "@");
});

test("finding the charger is remembered once, not every tick", () => {
  const { p, obs } = pet();
  const o = obs();
  assert.equal(watchScenes(p, o, 100, new Rng(1))!.kind, "tonefirst", "the first time it hears the charger's hum is itself memorable");
  assert.equal(watchScenes(p, o, 101, new Rng(1)), null, "nothing else salient");
  p.chargeRate = 1;
  const s = watchScenes(p, o, 105, new Rng(1))!;
  assert.equal(s.kind, "charger");
  assert.ok(s.importance >= 0.75);
  assert.equal(s.pose!.x, 0);
  assert.equal(watchScenes(p, o, 110, new Rng(1)), null, "still charging: not a new moment");
  p.chargeRate = 0;
  watchScenes(p, o, 200, new Rng(1));
  p.chargeRate = 1;
  assert.equal(watchScenes(p, o, 300, new Rng(1)), null, "found it again within the cooldown: no duplicate");
  p.chargeRate = 0;
  watchScenes(p, o, 1000, new Rng(1));
  p.chargeRate = 1;
  assert.equal(watchScenes(p, o, 1100, new Rng(1))!.kind, "charger", "after the cooldown it is worth remembering again");
});

test("bumps, sudden light, battery trouble and visitors become scenes", () => {
  const { sim, p, obs } = pet();
  watchScenes(p, obs(), 0, new Rng(1)); // the first hearing of the hum
  p.mind.scenes = [];
  p.touch = "wall";
  assert.equal(watchScenes(p, obs(), 10, new Rng(1))!.kind, "bump");
  p.touch = null;
  watchScenes(p, obs(), 20, new Rng(1));
  const dark = { ...obs(), light: 0 };
  const bright = { ...dark, light: 80 };
  assert.equal(watchScenes(p, bright, 30, new Rng(1))!.kind, "brighter");
  p.energy = 20;
  assert.equal(watchScenes(p, { ...obs(), energy: 20 }, 40, new Rng(1))!.kind, "lowbattery");
  sim.human.x = p.x - 50; sim.human.y = p.y;
  assert.equal(watchScenes(p, obs(), 5000, new Rng(1))!.kind, "company");
  assert.equal(p.mind.scenes.length, 4);
  p.mode = "dormant";
  assert.equal(watchScenes(p, obs(), 9000, new Rng(1))!.kind, "dormant");
  assert.equal(p.mind.scenes.length, 5);
});

test("the store forgets the least important and oldest first, and never the newest", () => {
  const { p } = pet();
  p.mind.scenes = [];
  for (let i = 0; i < MAX_SCENES; i++) storeScene(p, scene({ id: `n${i}`, tSec: i * 60, importance: 0.3 }), i * 60);
  storeScene(p, scene({ id: "vital", tSec: 2000, importance: 1 }), 2000);
  storeScene(p, scene({ id: "newest", tSec: 2100, importance: 0.05 }), 2100);
  assert.equal(p.mind.scenes.length, MAX_SCENES);
  const ids = p.mind.scenes.map((s) => s.id);
  assert.ok(ids.includes("vital"), "important memories survive");
  assert.ok(ids.includes("newest"), "the scene just added is never the one dropped");
  assert.ok(!ids.includes("n0"), "the oldest ordinary memory went first");
});

test("an old important memory outranks a fresh trivial one, and use is counted only for what is shown", () => {
  const { p } = pet();
  p.mind.scenes = [scene({ id: "old-vital", tSec: 0, importance: 1 }), ...Array.from({ length: 6 }, (_, i) => scene({ id: `t${i}`, tSec: 3 * 3600 + i, importance: 0.1 }))];
  const now = 3 * 3600 + 100;
  assert.equal(selectScenes(p, now)[0].id, "old-vital");
  markUsed(p, now);
  assert.equal(p.mind.scenes.filter((s) => s.uses === 1).length, 3);
  assert.equal(p.mind.scenes.filter((s) => s.uses === 0).length, 4);
  assert.equal(p.mind.scenes.find((s) => s.id === "old-vital")!.lastUsedSec, now);
});

test("a scene is described from where the pet stands now", () => {
  const { p } = pet();
  p.heading = 0; // facing +x
  p.odo = { x: 300, y: 0 };
  const behind = describeScene(scene({ pose: { x: 0, y: 0 }, kind: "charger", why: "found the charging pad", seen: [{ category: "static", size: "large", colour: "yellow", distance: 50, bearing: 0 }] }), p, "D1 06:30");
  assert.match(behind, /D1 06:30 found the charging pad/);
  assert.match(behind, /a large yellow still object ahead of me/);
  assert.match(behind, /about 300 units behind me/);
  p.odo = { x: 10, y: 0 };
  assert.match(describeScene(scene({ pose: { x: 0, y: 0 } }), p, "D1 07:00"), /right here/);
  assert.match(describeScene(scene({ pose: null }), p, "D1 07:00"), /no longer know where/);
});

test("dead reckoning tracks real movement within a few percent and never uses world coordinates", () => {
  const { p } = pet();
  const rng = new Rng(7);
  const start = { x: p.x, y: p.y };
  let travelled = 0;
  for (let i = 0; i < 200; i++) { p.speed = 20; p.heading = 0; travelled += 20 * 5; updateOdometry(p, 5, rng); }
  assert.ok(Math.abs(p.odo.x - travelled) / travelled < 0.05, `odo x ${p.odo.x} vs ${travelled}`);
  assert.ok(Math.abs(p.odo.y) < travelled * 0.05);
  assert.equal(start.x, 800, "world position was never read or changed by the sensor");
});

test("after a simulated day pets hold bounded, sensible memories, and their notes show them", () => {
  const sim = new Simulation(new World(3), 3, roster);
  sim.step(24 * 3600_000);
  const all = sim.pets.flatMap((p) => p.mind.scenes);
  assert.ok(all.length > 0, "something memorable happened in a day");
  for (const p of sim.pets) {
    assert.ok(p.mind.scenes.length <= MAX_SCENES);
    assert.ok(Number.isFinite(p.odo.x) && Number.isFinite(p.odo.y));
    for (const s of p.mind.scenes) {
      assert.match(s.view, /^[.o#@]{11}\|[.o@]{4}$/);
      assert.ok(s.importance >= 0 && s.importance <= 1);
    }
  }
  const withScenes = sim.pets.find((p) => p.mind.scenes.length)!;
  assert.match(buildNotes(withScenes, 2, 600, 0, sim.simSec), /Memorable moments[^\n]*\n- D\d+ \d\d:\d\d /);
});

test("scene memory is deterministic for a seed, and saves from before it still load", () => {
  const a = new Simulation(new World(5), 5, roster), b = new Simulation(new World(5), 5, roster);
  a.step(6 * 3600_000); b.step(6 * 3600_000);
  assert.deepEqual(a.pets.map((p) => p.mind.scenes), b.pets.map((p) => p.mind.scenes));
  const snap: any = JSON.parse(JSON.stringify(a.snapshot()));
  for (const p of snap.pets) { delete p.mind.scenes; delete p.odo; delete p.watch; }
  const old = new Simulation(a.world, 5, roster, snap);
  assert.deepEqual(old.pets[0].mind.scenes, []);
  assert.deepEqual(old.pets[0].odo, { x: 0, y: 0 });
  old.step(a.simSec * 1000 + 3600_000); // keeps running
});

test("scenes travel in a brain file with ages, lose their place, and bad data is cleaned", () => {
  const { sim, p } = pet();
  sim.simSec = 10_000;
  p.mind.scenes = [scene({ id: "x", tSec: 9_000, importance: 0.8, uses: 3, lastUsedSec: 9_500, pose: { x: 5, y: 5 }, view: "..#........|.@.." })];
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(p, sim.simSec))));
  assert.equal(file.scenes![0].ageSec, 1000);
  assert.equal(file.scenes![0].usedAgeSec, 500);
  const other = new Simulation(new World(2), 2, roster);
  other.simSec = 400;
  const target = other.pets[1] as PetState;
  applyBrain(target, file, other.simSec);
  const s = target.mind.scenes[0];
  assert.equal(s.tSec, 400 - 1000);
  assert.equal(s.pose, null);
  assert.equal(s.uses, 3);
  assert.equal(s.lastUsedSec, 400 - 500);
  assert.match(describeScene(s, target, "D1 00:00"), /no longer know where/);
  // brains saved before scene memory
  const legacy = parseBrain({ ...JSON.parse(JSON.stringify(file)), scenes: undefined });
  assert.deepEqual(legacy.scenes, []);
  // hostile scene data
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), scenes: [{ kind: "k".repeat(99), why: 5, importance: 9, view: "<script>", seen: [{ category: "x", size: "huge", bearing: 99 }], near: "no", light: 900, battery: -3, ageSec: -1 }, ...Array(60).fill({})] });
  assert.equal(dirty.scenes!.length, MAX_SCENES);
  const d = dirty.scenes![0];
  assert.equal(d.kind.length, 20);
  assert.equal(d.importance, 1);
  assert.match(d.view, /^[.o#@|]*$/);
  assert.equal(d.seen[0].size, "small");
  assert.ok(Math.abs(d.seen[0].bearing) <= Math.PI);
  assert.deepEqual(d.near, []);
  assert.equal(d.light, 100);
  assert.equal(d.battery, 0);
  assert.equal(d.ageSec, 0);
});
