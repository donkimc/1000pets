import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUSE, LEGACY, WALL_T, blockedAt, centerOf, chargersOf, pointInRect, roomAt, shapeOf, type Layout } from "./layout.js";
import { findPath } from "./nav.js";

test("the legacy room is exactly the original: no walls, same furniture", () => {
  assert.equal(LEGACY.walls.length, 0);
  assert.equal(LEGACY.width, 1000);
  assert.equal(LEGACY.objects.length, 8);
  assert.equal(blockedAt(LEGACY, 5, 300, 18), "wall");
  assert.equal(blockedAt(LEGACY, 470, 390, 18), "object");
  assert.equal(blockedAt(LEGACY, 700, 500, 18), null);
});

test("the house has four rooms that tile it, each with a charger, window, heater and lamp", () => {
  assert.equal(HOUSE.rooms.length, 4);
  const area = HOUSE.rooms.reduce((a, r) => a + r.w * r.h, 0);
  assert.equal(area, HOUSE.width * HOUSE.height, "rooms leave no gaps and do not overlap");
  for (const r of HOUSE.rooms) {
    for (const kind of ["charger", "window", "heater", "lamp"]) {
      assert.ok(HOUSE.objects.some((o) => o.room === r.id && o.kind === kind), `${r.id} has a ${kind}`);
    }
  }
  assert.equal(chargersOf(HOUSE).length, 4);
});

test("every object stands wholly inside its own room", () => {
  for (const o of HOUSE.objects) {
    const room = HOUSE.rooms.find((r) => r.id === o.room)!;
    const s = shapeOf(o);
    const [x0, y0, x1, y1] = s.type === "circle" ? [s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r] : [s.x, s.y, s.x + s.w, s.y + s.h];
    assert.ok(x0 >= room.x && y0 >= room.y && x1 <= room.x + room.w && y1 <= room.y + room.h, `${o.id} in ${o.room}`);
  }
});

test("charger hums are each their own pitch, one per semitone bin, none sharing a bin with a noise", () => {
  const bins = chargersOf(HOUSE).map((c) => Math.round(12 * Math.log2(c.pitch! / 100)));
  assert.equal(new Set(bins).size, 4);
  for (const c of chargersOf(HOUSE)) assert.ok(Math.abs(c.pitch! - 100 * 2 ** (Math.round(12 * Math.log2(c.pitch! / 100)) / 12)) < 1.5, `${c.id} sits on a bin centre`);
});

test("interior walls block, door gaps do not, and a shut door blocks its gap", () => {
  assert.equal(blockedAt(HOUSE, 1000, 200, 18), "wall", "the wall between living room and kitchen");
  assert.equal(blockedAt(HOUSE, 1000, 450, 18), null, "its door gap");
  assert.equal(blockedAt(HOUSE, 1000, 450, 18, ["door-living-kitchen"]), "door", "shut");
  assert.equal(blockedAt(HOUSE, 700, 700, 18), null, "gap of the door to the bedroom is open ground");
  assert.equal(blockedAt(HOUSE, 400, 700, 18), "wall");
  const d = HOUSE.doorRects["door-living-bedroom"];
  assert.equal(d.h, WALL_T);
  assert.ok(!HOUSE.walls.some((w) => pointInRect(700, 700, w)), "no wall inside a door gap");
});

test("a point belongs to exactly one room", () => {
  assert.equal(roomAt(HOUSE, 100, 100)!.id, "living");
  assert.equal(roomAt(HOUSE, 1500, 100)!.id, "kitchen");
  assert.equal(roomAt(HOUSE, 100, 1000)!.id, "bedroom");
  assert.equal(roomAt(HOUSE, 1500, 1000)!.id, "study");
});

test("every charger can be walked to from every other, through the doors", () => {
  const cs = chargersOf(HOUSE).map(centerOf);
  for (const a of cs) for (const b of cs) {
    if (a === b) continue;
    const path = findPath(HOUSE, a, b, 22);
    assert.ok(path, `route from (${a.x},${a.y}) to (${b.x},${b.y})`);
    let at = a, len = 0;
    for (const p of path!) { len += Math.hypot(p.x - at.x, p.y - at.y); at = p; }
    assert.ok(len < 3500, `route length ${Math.round(len)}`);
  }
});

test("with every door shut, rooms are sealed off from each other", () => {
  const all = Object.keys(HOUSE.doorRects);
  const [a, b] = chargersOf(HOUSE).map(centerOf);
  assert.equal(findPath(HOUSE, a, b, 22, all), null);
  const living = chargersOf(HOUSE)[0];
  assert.ok(findPath(HOUSE, centerOf(living), { x: 600, y: 600 }, 22, all), "still free to move inside a room");
});

test("walls survive the builder for any custom plan: a gap is exactly the door width", () => {
  const L: Layout = HOUSE;
  const wallsOnLine = L.walls.filter((w) => w.x === 1000 - WALL_T / 2 && w.y < 700).sort((p, q) => p.y - q.y);
  assert.equal(wallsOnLine.length, 2);
  assert.equal(wallsOnLine[1].y - (wallsOnLine[0].y + wallsOnLine[0].h), 120);
});
