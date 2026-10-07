import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { HOUSE } from "./layout.js";
import { decide } from "./system1.js";
import { Rng } from "./rng.js";
import { sense } from "./sensors.js";
import { buildNotes } from "./system2.js";
import { checkStatement } from "./verify.js";
import type { PetDef, PetState } from "./pet.js";
import { chooseTarget, describePlaces, keyHz, newPlaces, observePlaces, placeSettings, placeSteer, planRoute, visit } from "./places.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const pet = (): PetState => new Simulation(new World(1, undefined, HOUSE), 1, roster).pets[0];
const at = (p: PetState, x: number, y: number) => { p.odo = { x, y }; };
/** Walk the pet's reckoning from where it is to (x, y) in steps, leaving breadcrumbs as it would. */
const walk = (p: PetState, x: number, y: number, now: number) => {
  const n = Math.ceil(Math.hypot(x - p.odo.x, y - p.odo.y) / 30);
  const sx = (x - p.odo.x) / n, sy = (y - p.odo.y) / n;
  for (let i = 0; i < n; i++) { p.odo = { x: p.odo.x + sx, y: p.odo.y + sy }; p.moved = { x: sx, y: sy }; p.touch = null; observePlaces(p, { tone: null }, now, false); }
};

test("reaching the same pad or doorway again is the same place; a different pad is a new one", () => {
  const p = pet();
  at(p, 100, 100); const a = visit(p, "pad", 0, "tone:29");
  at(p, 130, 90); const again = visit(p, "pad", 100, "tone:29");
  assert.equal(a.id, again.id);
  assert.equal(again.visits, 2);
  at(p, 900, 100); const other = visit(p, "pad", 200, "tone:26");
  assert.notEqual(other.id, a.id);
  at(p, 400, 400); const door = visit(p, "door", 300);
  at(p, 520, 380); assert.equal(visit(p, "door", 400).id, door.id, "a doorway crossed a little off to one side is the same doorway");
});

test("a run between two landmarks is remembered with the turns it really took", () => {
  const p = pet();
  at(p, 0, 0); visit(p, "pad", 0, "tone:29");
  walk(p, 300, 0, 10); walk(p, 300, 300, 20); // an L-shaped way
  visit(p, "door", 30);
  const pm = p.places!;
  assert.equal(pm.edges.length, 1);
  const e = pm.edges[0];
  assert.ok(e.len > 550 && e.len < 650, `walked about 600 (${e.len})`);
  assert.ok(e.via.length >= 1 && e.via.some((q) => Math.abs(q.x - 300) < 80 && Math.abs(q.y) < 80), "the corner is remembered");
});

test("a way that wandered far beyond the distance between them, or took too long, is not remembered", () => {
  const p = pet();
  at(p, 0, 0); visit(p, "pad", 0, "tone:29");
  for (let i = 0; i < 10; i++) { walk(p, 200, 0, i * 10); walk(p, 0, 0, i * 10 + 5); }
  walk(p, 100, 0, 200); visit(p, "door", 210);
  assert.equal(p.places!.edges.length, 0, "wandered, so no run");
  const q = pet();
  at(q, 0, 0); visit(q, "pad", 0, "tone:29"); walk(q, 300, 0, 10);
  visit(q, "door", 5000); // three quarters of an hour later
  assert.equal(q.places!.edges.length, 0, "too long ago");
});

test("the shortest known way is found, and the pad worth walking to favours one it has charged at", () => {
  const p = pet();
  const pm = (p.places = newPlaces());
  const node = (id: string, kind: "pad" | "door", x: number, y: number, charged = 0) => { pm.nodes[id] = { id, kind, x, y, visits: 1, charged, firstSec: 0, lastSec: 0, ...(kind === "pad" ? { key: "tone:29" } : {}) }; };
  node("p1", "pad", 0, 0, 5); node("d1", "door", 300, 0); node("p2", "pad", 600, 0, 0); node("d2", "door", 0, 300); node("p3", "pad", 0, 600, 0);
  const edge = (a: string, b: string, len: number) => pm.edges.push({ a, b, len, n: 1, lastSec: 0, via: [] });
  edge("p1", "d1", 300); edge("d1", "p2", 300); edge("p1", "d2", 300); edge("d2", "p3", 300);
  pm.last = "d1";
  assert.deepEqual(planRoute(pm, "d1", "p3")!.path, ["d1", "p1", "d2", "p3"]);
  assert.equal(planRoute(pm, "p2", "p3")!.cost, 1200);
  const t = chooseTarget(p, 0)!;
  assert.equal(t.to, "p1", "equally near as p2, but it has charged at p1 five times");
  pm.avoid.p1 = 1000;
  assert.equal(chooseTarget(p, 0)!.to, "p2", "p1 was given up on");
  pm.edges = [];
  assert.equal(chooseTarget(p, 0), null, "no way it knows");
});

test("it walks its remembered way, landmark by landmark, and gives up a pad it cannot get to", () => {
  const p = pet();
  at(p, 0, 0); p.heading = 0; visit(p, "pad", 0, "tone:29");
  walk(p, 300, 0, 10); visit(p, "door", 20);
  walk(p, 600, 0, 30); visit(p, "pad", 40, "tone:26");
  walk(p, 300, 0, 50); // now back at the doorway, and the first pad is the one it wants
  p.places!.nodes[p.places!.last!].lastSec = 60;
  p.places!.avoid[Object.values(p.places!.nodes).find((n) => n.key === "tone:26")!.id] = 1e9; // it won't go back to the far pad
  const s = placeSteer(p, 100)!;
  assert.ok(s, "there is a way");
  assert.ok(Math.abs(s.bearing) > 2.5, "behind it, back toward the first pad");
  at(p, 10, 0);
  assert.equal(placeSteer(p, 120), null, "it has arrived");
  // stuck: no progress for a long time gives that pad up
  const q = pet();
  at(q, 0, 0); q.heading = 0; visit(q, "pad", 0, "tone:29"); walk(q, 400, 0, 10); visit(q, "pad", 20, "tone:26");
  at(q, 400, 0);
  const first = placeSteer(q, 100)!;
  assert.ok(first);
  assert.equal(placeSteer(q, 100 + 200), null, "no progress for 200 s: given up");
  assert.ok(Object.values(q.places!.avoid).length >= 1);
});

test("a pad that charges is counted, and one that does not charge is given up on", () => {
  const p = pet();
  at(p, 0, 0); p.touch = "pad"; p.chargeRate = 1; p.energy = 40;
  observePlaces(p, { tone: { pitch: 534, volume: 0.9 } }, 0, false);
  observePlaces(p, { tone: { pitch: 534, volume: 0.9 } }, 5, false);
  const n = Object.values(p.places!.nodes)[0];
  assert.equal(n.charged, 1, "counted once per visit");
  const q = pet();
  at(q, 0, 0); q.touch = "pad"; q.chargeRate = 0; q.energy = 40;
  for (let t = 0; t <= 80; t += 5) observePlaces(q, { tone: null }, t, false);
  const qn = Object.values(q.places!.nodes)[0];
  assert.ok((q.places!.avoid[qn.id] ?? 0) > 80, "standing on it with no charge: do not come back for a while");
});

test("with a map, a low battery and no hum, System 1 walks to a remembered charger instead of searching for light", () => {
  const sim = new Simulation(new World(1, undefined, HOUSE), 1, roster);
  const p = sim.pets[0];
  sim.world.setOverride("beaconOn", false);
  sim.human.x = 100; sim.human.y = 1300; sim.teacher.x = 300; sim.teacher.y = 1300;
  p.x = 700; p.y = 520; p.heading = 0; p.energy = 15; p.drives.rest = 0;
  p.odo = { x: 0, y: 0 };
  visit(p, "pad", 0, "tone:29");
  p.odo = { x: 800, y: 0 };
  p.places!.nodes.p1.x = -600; p.places!.nodes.p1.y = 0; p.places!.nodes.p1.charged = 3;
  visit(p, "door", 5); // somewhere to have come from, east of the pad
  p.places!.edges.push({ a: "d2", b: "p1", len: 1400, n: 1, lastSec: 0, via: [] });
  const obs = sense(p, sim.pets, sim.world, [], 0, new Rng(1), sim.human, sim.teacher);
  const d = decide(p, obs, new Rng(2), 100);
  assert.equal(d.action, "go_to_place", d.reason);
  assert.match(d.reason, /remember a pad where I charged/);
  placeSettings.on = false;
  p.places!.route = null;
  const d2 = decide(p, obs, new Rng(2), 100);
  placeSettings.on = true;
  assert.notEqual(d2.action, "go_to_place", "with the map switched off it searches as before");
});

test("its notes say which chargers it remembers; and a claim that there is more than one is borne out once it has found two", () => {
  const p = pet();
  assert.match(buildNotes(p, 1, 600, 0, 1000), /Pads where my battery filled up[^\n]*\n- \(none yet\)/);
  at(p, 0, 0); p.touch = "pad"; p.chargeRate = 1; p.energy = 50;
  observePlaces(p, { tone: { pitch: 534, volume: 0.9 } }, 0, false);
  const text = "There is another charger in a different room";
  assert.equal(checkStatement(p, text, 0, 100)!.state, "unclear", "only one pad so far");
  p.touch = null; observePlaces(p, { tone: null }, 5, false);
  at(p, 900, 900); p.touch = "pad"; observePlaces(p, { tone: { pitch: 449, volume: 0.9 } }, 400, false);
  const v = checkStatement(p, text, 0, 500)!;
  assert.equal(v.state, "supported");
  assert.match(v.why, /2 different pads.*534 Hz.*449 Hz|2 different pads/);
  const lines = describePlaces(p, 500);
  assert.equal(lines.filter((l) => /^- a pad/.test(l)).length, 2);
  assert.equal(keyHz("tone:29"), 534);
});
