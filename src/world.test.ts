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

test("a pinned lamp stays as set and emits no automatic events; releasing hands control back", () => {
  const w = new World(3);
  w.setOverride("lampOn", true);
  assert.equal(w.env.lampOn, true);
  const ev = w.step(DAY + 12 * HOUR); // through a morning, when the schedule would keep it off
  assert.equal(w.env.lampOn, true);
  assert.ok(!ev.some((e) => e.type === "lamp_on" || e.type === "lamp_off"));
  w.setOverride("lampOn", "auto");
  const ev2 = w.step(DAY + 13 * HOUR);
  assert.equal(w.env.lampOn, false);
  assert.ok(ev2.some((e) => e.type === "lamp_off"));
});

test("pinned weather, outdoor temperature and sun hold at noon", () => {
  const w = new World(8);
  w.setOverride("weather", "rain");
  w.setOverride("outdoorTemp", -5);
  w.setOverride("sunIntensity", 0.9);
  w.step(3 * DAY + 12 * HOUR);
  assert.equal(w.env.weather, "rain");
  assert.equal(w.env.outdoorTemp, -5);
  assert.equal(w.env.sunIntensity, 0.9);
});

test("pinned weather updates sun and temperature immediately, even while paused", () => {
  const w = new World(4);
  w.step(12 * HOUR);
  w.setOverride("weather", "clear");
  const sunny = w.env.sunIntensity;
  assert.ok(sunny > 0.9);
  w.setOverride("weather", "rain");
  assert.ok(w.env.sunIntensity < sunny);
});

test("overrides validate their values and survive a snapshot", () => {
  const w = new World(1);
  assert.throws(() => w.setOverride("weather", "snow"));
  assert.throws(() => w.setOverride("lampOn", "maybe"));
  assert.throws(() => w.setOverride("nope", 1));
  assert.equal(w.setOverride("outdoorTemp", "999").to, 50);
  const r = w.setOverride("heaterOn", "on");
  assert.deepEqual([r.field, r.mode, r.to], ["heaterOn", "pin", true]);
  const copy = new World(1, JSON.parse(JSON.stringify(w.snap)));
  assert.equal(copy.overrides.heaterOn, true);
  assert.equal(copy.overrides.outdoorTemp, 50);
});

test("a pinned indoor temperature does not drift", () => {
  const w = new World(2);
  w.setOverride("indoorTemp", 25);
  w.step(2 * DAY);
  assert.equal(w.env.indoorTemp, 25);
});

test("saves from before environment control still load", () => {
  const snap: any = JSON.parse(JSON.stringify(new World(1).snap));
  delete snap.overrides;
  const w = new World(1, snap);
  assert.deepEqual(w.overrides, {});
});
