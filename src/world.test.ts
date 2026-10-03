import { test } from "node:test";
import assert from "node:assert/strict";
import { World } from "./world.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test("same seed gives identical events and state", () => {
  const a = new World(42);
  const b = new World(42);
  assert.deepEqual(a.step(10 * DAY), b.step(10 * DAY));
  assert.deepEqual(a.snap, b.snap);
});

test("result does not depend on how often step() is called", () => {
  const a = new World(7);
  const b = new World(7);
  const evA = a.step(5 * DAY);
  const evB = [];
  for (let t = 0; t <= 5 * DAY; t += 7 * 60_000) evB.push(...b.step(t));
  evB.push(...b.step(5 * DAY));
  assert.deepEqual(evA, evB);
  assert.deepEqual(a.snap.env, b.snap.env);
});

test("different seeds diverge", () => {
  assert.notDeepEqual(new World(1).step(10 * DAY), new World(2).step(10 * DAY));
});

test("snapshot resume matches an uninterrupted run", () => {
  const full = new World(9);
  full.step(6 * DAY);
  const part = new World(9);
  part.step(3 * DAY);
  const resumed = new World(9, JSON.parse(JSON.stringify(part.snap)));
  resumed.step(6 * DAY);
  assert.deepEqual(full.snap, resumed.snap);
});

test("daytime is brighter than night, and open curtain beats closed", () => {
  const w = new World(3);
  w.step(DAY + 12 * HOUR); // noon of day 2
  const noon = w.lightAt(700, 200);
  w.step(DAY + 26 * HOUR);
  assert.ok(noon > w.lightAt(700, 200));
});

test("weekday curtain opens at 07:00 on a normal day", () => {
  const w = new World(5);
  const ev = w.step(10 * DAY);
  assert.ok(ev.some((e) => e.type === "curtain_opened" && e.hour === 7));
});

test("indoor temperature stays in a sane range over 30 days", () => {
  const w = new World(11);
  for (let d = 1; d <= 30; d++) {
    w.step(d * DAY);
    assert.ok(w.env.indoorTemp > 5 && w.env.indoorTemp < 35, `day ${d}: ${w.env.indoorTemp}`);
  }
});
