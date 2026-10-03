import { test } from "node:test";
import assert from "node:assert/strict";
import { SimClock } from "./clock.js";

test("1x speed advances one simulated second per real second", () => {
  const c = new SimClock(0, 0);
  assert.equal(c.advance(1000), 1000);
  assert.equal(c.simTimeMs, 1000);
});

test("1000x speed: 30 simulated days in 43.2 real minutes", () => {
  const c = new SimClock(0, 0);
  c.speed = 1000;
  c.advance(43.2 * 60 * 1000);
  assert.equal(c.parts.day, 31);
});

test("paused clock does not advance", () => {
  const c = new SimClock(0, 0);
  c.paused = true;
  assert.equal(c.advance(5000), 0);
});

test("rejects invalid speed", () => {
  assert.throws(() => new SimClock().setSpeed(7));
});

test("parts include seconds", () => {
  const c = new SimClock((86400 + 3600 * 2 + 60 * 3 + 4) * 1000, 0);
  assert.deepEqual(c.parts, { day: 2, hour: 2, minute: 3, second: 4 });
});
