import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { HOUSE } from "./layout.js";
import type { PetDef, PetState } from "./pet.js";
import type { Observation } from "./sensors.js";
import { noteRoute, repairPassage, routeSettings, routeSteer } from "./route.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const pet = (): PetState => { const p = new Simulation(new World(1, undefined, HOUSE), 1, roster).pets[0]; p.odo = { x: 0, y: 0 }; p.places = undefined; p.energy = 100; p.heading = 0; return p; };
const CLOSED = ["#########", "#########", "#########", "####^####", "#########", "#########", "#########", "#########", "#########"];
const obs = { grid: CLOSED } as unknown as Observation;
/** Walk the pet's reckoning along a list of points, one tick each. */
const walk = (p: PetState, pts: [number, number][], t0: number, doorwayAtEnd = false) => {
  let t = t0;
  pts.forEach(([x, y], i) => {
    const mx = x - p.odo.x, my = y - p.odo.y;
    p.odo = { x, y }; p.moved = { x: mx, y: my }; p.moveTrace = [{ x: mx, y: my }];
    t += 5;
    noteRoute(p, obs, t, doorwayAtEnd && i === pts.length - 1);
  });
  return t;
};
const line = (x0: number, y0: number, x1: number, y1: number, step = 35): [number, number][] => {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step);
  return Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * (i + 1)) / n, y0 + ((y1 - y0) * (i + 1)) / n]);
};

test("the track cuts out loops: wandering back to where it was leaves only the way it went", () => {
  const p = pet();
  let t = walk(p, [[0, 0]], 0);
  t = walk(p, line(0, 0, 300, 0), t);
  t = walk(p, line(300, 0, 300, 200), t); // off round a block...
  t = walk(p, line(300, 200, 0, 200), t);
  t = walk(p, line(0, 200, 0, 0), t); // ...and back to the start: the loop is forgotten
  const track = p.places!.passage!.track;
  assert.ok(track.length <= 3, `the track after a full loop has ${track.length} points: ${JSON.stringify(track)}`);
});

test("going through a doorway makes the track a way out it remembers, and a shorter one replaces a longer", () => {
  const p = pet();
  let t = walk(p, [[0, 0]], 0);
  t = walk(p, [...line(0, 0, 400, 0), ...line(400, 0, 400, 300), ...line(400, 300, 100, 300)], t, true);
  const pg = p.places!.passage!;
  assert.equal(pg.escapes.length, 1);
  assert.ok(pg.track.length <= 1, "a new passage starts at the doorway");
  const long = pg.escapes[0].path.length;
  // another time, a more direct way out from the same place
  p.odo = { x: 0, y: 0 }; t = walk(p, [[0, 0]], t + 400);
  t = walk(p, [...line(0, 0, 100, 300)], t, true);
  assert.equal(pg.escapes.length, 1, "the same way out, not a second one");
  assert.ok(pg.escapes[0].path.length < long);
  assert.equal(pg.escapes[0].n, 2);
});

test("restless in a passage, it walks back along its own track to a remembered way out and follows it", () => {
  routeSettings.on = true;
  const p = pet();
  let t = walk(p, [[0, 0]], 0);
  t = walk(p, [...line(0, 0, 300, 0), ...line(300, 0, 300, 300)], t, true); // the way out: east, then south
  // next time: in at the same place, wanders off north and back a way, and has been in a passage for a while
  p.odo = { x: 0, y: 0 }; t = walk(p, [[0, 0]], t + 400);
  t = walk(p, line(0, 0, 0, -150), t);
  assert.equal(routeSteer(p, t), null, "not yet restless");
  t = walk(p, line(0, -150, 0, -150).concat([[0, -150]]), t + 150);
  const s = routeSteer(p, t);
  assert.ok(s, "restless, it recalls the way out");
  assert.match(s!.reason, /remember the way I got out/);
  const pts = p.places!.passage!.home!.pts;
  assert.ok(Math.hypot(pts[pts.length - 1].x - 300, pts[pts.length - 1].y - 300) < 40, "and the plan ends at the way out's end");
  routeSettings.on = false;
});

test("leaving through an emergency door is not remembered as a way out", () => {
  const p = pet();
  let t = walk(p, [[0, 0]], 0);
  t = walk(p, line(0, 0, 400, 0), t);
  const mx = 400 - p.odo.x;
  p.odo = { x: 400, y: 0 }; p.moved = { x: mx, y: 0 }; p.moveTrace = [{ x: mx, y: 0 }];
  noteRoute(p, obs, t + 5, true, true);
  const pg = p.places!.passage!;
  assert.equal(pg.escapes.length, 0, "the emergency door locks again, so that path is not a way out");
  assert.ok(pg.track.length <= 1, "and the passage ends there");
  p.odo = { x: 0, y: 0 };
  walk(p, [[0, 0], ...line(0, 0, 400, 0)], t + 400, true);
  assert.equal(pg.escapes.length, 1, "an ordinary doorway still is");
});

test("switched off it never steers, and old saves without a passage record still run", () => {
  routeSettings.on = false;
  const p = pet();
  assert.equal(routeSteer(p, 100), null);
  const pg = repairPassage(undefined);
  assert.deepEqual(pg.escapes, []);
  assert.equal(repairPassage({ track: undefined } as any).track.length, 0);
});
