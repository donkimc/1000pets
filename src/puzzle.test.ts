import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { ANNEX, HOUSE, LAYOUTS, PUZZLE, BEDROOM_MAZE, STUDY_MAZE, blockedAt, centerOf, chargersOf, makeMaze, roomAt, wallAt, type Maze } from "./layout.js";
import { findPath } from "./nav.js";
import { crossings } from "./acoustics.js";
import { decide } from "./system1.js";
import { sense } from "./sensors.js";
import { Rng } from "./rng.js";
import type { PetDef, PetState } from "./pet.js";
import { benchMaze, runMaze } from "../scripts/maze-bench.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const puzzle = (seed = 1) => new Simulation(new World(seed, undefined, PUZZLE), seed, roster);
const place = (p: PetState, x: number, y: number, h = 0) => { p.x = x; p.y = y; p.heading = h; };
const away = (sim: Simulation) => { sim.human.x = 300; sim.human.y = 300; sim.teacher.x = 300; sim.teacher.y = 500; };

test("a maze is perfect: one way between any two cells, every cell reachable, the same maze for the same seed", () => {
  const spec = { x: 0, y: 0, cols: 8, rows: 6, cell: 100, seed: 5, minRoute: 20, entrance: { side: "top" as const, index: 0 }, exit: { side: "right" as const, index: 5 } };
  const m = makeMaze(spec);
  const cells = spec.cols * spec.rows;
  assert.equal(m.passages.length, cells - 1, "a spanning tree has one fewer passage than cells");
  const adjacent = (spec.cols - 1) * spec.rows + spec.cols * (spec.rows - 1);
  assert.equal(m.walls.length, adjacent - (cells - 1), "a wall wherever two neighbouring cells are not joined");
  const reach = new Set<number>([0]), q = [0];
  while (q.length) { const u = q.pop()!; for (const [a, b] of m.passages) { const v = a === u ? b : b === u ? a : -1; if (v >= 0 && !reach.has(v)) { reach.add(v); q.push(v); } } }
  assert.equal(reach.size, cells);
  assert.equal(m.route[0], m.entrance);
  assert.equal(m.route[m.route.length - 1], m.exit);
  assert.ok(m.route.length >= 20, `the way through is ${m.route.length} cells`);
  assert.deepEqual(makeMaze(spec).walls, m.walls, "deterministic");
  assert.notDeepEqual(makeMaze({ ...spec, seed: 6 }).walls, m.walls, "another seed, another maze");
});

test("walls are found quickly and correctly, however many there are", () => {
  const w = PUZZLE.walls.length;
  assert.ok(w > 100, `the puzzle house has ${w} walls`);
  // a point in the middle of a corridor is free, a point in a maze wall is not
  const wall = BEDROOM_MAZE.walls[0];
  assert.ok(wallAt(PUZZLE, wall.x + wall.w / 2, wall.y + wall.h / 2));
  assert.equal(blockedAt(PUZZLE, 50, 750, 18), null, "the entrance cell is open floor");
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) crossings(PUZZLE, { x: 60, y: 760 }, { x: 940, y: 1340 }, []);
  assert.ok(Date.now() - t0 < 1500, `3000 sight lines through a maze took ${Date.now() - t0} ms`);
});

test("the puzzle house: two mazes with no charger, chargers in the other two rooms, and the doors set as one-way", () => {
  assert.ok(LAYOUTS.puzzle === PUZZLE);
  assert.deepEqual(PUZZLE.rooms.filter((r) => r.puzzle).map((r) => r.id), ["bedroom", "study"]);
  assert.deepEqual(chargersOf(PUZZLE).map((c) => c.room).sort(), ["kitchen", "living"], "no charger inside a maze");
  assert.ok(!PUZZLE.objects.some((o) => (o.room === "bedroom" || o.room === "study") && o.kind !== "window"), "nothing stands in a corridor");
  const door = (id: string) => PUZZLE.doors.find((d) => d.id === id)!;
  assert.deepEqual(door("door-living-bedroom").oneWay, { from: "living" });
  assert.deepEqual(door("door-bedroom-study").oneWay, { from: "bedroom" });
  assert.deepEqual(door("door-kitchen-study").oneWay, { from: "study" });
  assert.ok(door("door-bedroom-emergency").emergency && door("door-study-emergency").emergency);
  assert.equal(door("door-living-kitchen").oneWay, undefined, "the other door is an ordinary one");
  const w = new World(1, undefined, PUZZLE);
  assert.ok(w.isLocked("door-bedroom-emergency") && w.isLocked("door-study-emergency"), "the emergency doors start locked");
  assert.ok(!w.isLocked("door-living-bedroom"));
});

test("the annex adds two maze rooms under the house and leaves the four rooms alone", () => {
  assert.ok(LAYOUTS.annex === ANNEX);
  assert.deepEqual(ANNEX.rooms.filter((r) => r.puzzle).map((r) => r.id), ["cellar", "vault"]);
  assert.deepEqual(ANNEX.rooms.filter((r) => !r.puzzle).map((r) => r.id), HOUSE.rooms.map((r) => r.id));
  assert.deepEqual(chargersOf(ANNEX).map((c) => c.id).sort(), chargersOf(HOUSE).map((c) => c.id).sort(), "the new rooms have no charger");
  assert.ok(ANNEX.objects.some((o) => o.id === "bed-bedroom"), "the bedroom keeps its furniture");
  assert.equal(blockedAt(ANNEX, 150, 1450, 18), null, "the cellar entrance cell is open floor");
  assert.ok(findPath(ANNEX, { x: 150, y: 1350 }, { x: 950, y: 2050 }, 22), "the bedroom leads into the cellar maze");
  assert.ok(findPath(ANNEX, { x: 1050, y: 2050 }, { x: 1850, y: 1350 }, 22), "the vault maze leads out to the study");
  const house = new World(1, undefined, HOUSE);
  const moved = new World(1, JSON.parse(JSON.stringify(house.snap)), ANNEX);
  assert.ok(moved.isLocked("door-cellar-emergency") && moved.isLocked("door-vault-emergency"), "emergency doors lock when an old house save gains the mazes");
  assert.equal(moved.snap.rooms.cellar.indoorTemp, house.snap.env.indoorTemp);
});

test("a way through exists, from the living room through both mazes to the kitchen, for a body the size of the Teacher", () => {
  const from = { x: 650 - 600, y: 690 }; // just inside the living room by the bedroom's entrance door
  const leg1 = findPath(PUZZLE, { x: 50, y: 660 }, { x: 960, y: 1350 }, 22); // living room, through the bedroom maze to its exit
  assert.ok(leg1, "the bedroom maze can be crossed");
  const leg2 = findPath(PUZZLE, { x: 1050, y: 1350 }, { x: 1950, y: 660 }, 22); // study entrance to the study exit
  assert.ok(leg2, "the study maze can be crossed");
  assert.ok(findPath(PUZZLE, { x: 1950, y: 660 }, { x: 600, y: 300 }, 22), "and the kitchen leads back to the living room");
  void from;
  const len = (p: { x: number; y: number }[], s: { x: number; y: number }) => { let a = s, n = 0; for (const q of p) { n += Math.hypot(q.x - a.x, q.y - a.y); a = q; } return n; };
  assert.ok(len(leg1!, { x: 50, y: 660 }) > 1500, "it is a long way, not a straight line");
  void BEDROOM_MAZE as Maze; void STUDY_MAZE;
});

test("a one-way door opens for a pet only from its near side, and swings shut soon after", () => {
  const w = new World(1, undefined, PUZZLE);
  assert.equal(w.openDoor("door-living-bedroom", 0, 120, "bedroom"), "locked", "from inside the maze it will not open");
  assert.equal(w.openDoor("door-living-bedroom", 0, 120, "living"), "opened", "from the living room it does");
  assert.equal(w.openDoor("door-living-bedroom", 1, 8), "already", "a person, who gives no room, may open it from either side");
  const closed: string[] = [];
  w.tickDoors(5, () => false); assert.ok(w.isDoorOpen("door-living-bedroom"), "still open after 5 s");
  closed.push(...w.tickDoors(9, () => false));
  assert.deepEqual(closed, ["door-living-bedroom"], "closed itself after about 8 s, not 2 minutes");
  const keep = new World(1, undefined, PUZZLE);
  keep.openDoor("door-living-bedroom", 0, 120, "living");
  keep.tickDoors(10, () => true); assert.ok(keep.isDoorOpen("door-living-bedroom"), "not on someone standing in the doorway");
  assert.equal(new World(1, undefined, PUZZLE).openDoor("door-bedroom-emergency", 0, 120, "bedroom"), "locked", "an emergency door is locked to pets");
});

test("a pet pushes in through the one-way door and cannot push its way back out", () => {
  const sim = puzzle();
  away(sim);
  const [pip, moss, coco] = sim.pets;
  place(moss, 800, 100); place(coco, 900, 100);
  place(pip, 50, 650, Math.PI / 2); // living room, just above the door at the top of the bedroom maze
  pip.s1.doorGoalUntil = 1e9; pip.drives.rest = 0; pip.drives.curiosity = 0; pip.drives.social = 0; pip.energy = 90;
  for (let s = 5; s <= 120 && roomAt(PUZZLE, pip.x, pip.y)?.id !== "bedroom"; s += 5) { pip.heading = Math.PI / 2; pip.s1.doorGoalUntil = 1e9; sim.step(s * 1000); }
  assert.equal(roomAt(PUZZLE, pip.x, pip.y)?.id, "bedroom", `it went in (at ${Math.round(pip.x)}, ${Math.round(pip.y)})`);
  for (let s = 130; s <= 160; s += 5) sim.step(s * 1000); // the door swings shut behind it
  assert.ok(!sim.world.isDoorOpen("door-living-bedroom"));
  place(pip, 50, 750, -Math.PI / 2); // back inside, at the door, facing it
  const before = pip.stats.doorsOpened ?? 0;
  for (let s = 165; s <= 300; s += 5) { pip.heading = -Math.PI / 2; pip.s1.doorGoalUntil = 1e9; pip.x = 50; pip.y = Math.max(pip.y, 740); sim.step(s * 1000); }
  assert.ok(!sim.world.isDoorOpen("door-living-bedroom"), "from inside it does not open");
  assert.equal(pip.stats.doorsOpened ?? 0, before, "and no door was opened by the pet");
  assert.match(pip.mind.episodes.join(" "), /would not open/);
});

test("a pet stuck in a maze for too long, or with a low battery, is led out by the Teacher through the emergency door, which is then locked again", async () => {
  const sim = puzzle(2);
  const events: string[] = [];
  const Teacher = (await import("./teacher.js")).Teacher;
  const said: string[] = [];
  const teacher = new Teacher(sim, { enabled: false, complete: async () => { throw new Error("no model"); } } as any, { append: async () => {}, readLog: async () => [], readJson: async () => null, writeJson: async () => {}, dir: "" } as any,
    { set: async (f: string, v: unknown, _s: string, reason: string, scope?: { door?: string }) => { events.push(`${f} ${scope?.door} ${v} (${reason})`); return { field: f, from: null, to: v, mode: "pin" as const }; }, recent: async () => [] },
    { teacherSays: async (_to: any, text: string) => { said.push(text); return {} as any; } }, { isPaused: () => false }, null, 1);
  const [pip, moss, coco] = sim.pets;
  place(moss, 800, 100); place(coco, 900, 100);
  sim.human.x = 100; sim.human.y = 100; sim.teacher.x = 400; sim.teacher.y = 300;
  place(pip, 450, 1050, 0); pip.energy = 22; pip.mode = "sleeping"; pip.drives.rest = 0.95; pip.drives.curiosity = 0; pip.drives.social = 0; // asleep in the bedroom maze, battery low: a corner must not end the rescue
  pip.roomSince = 0;
  let t = 0;
  for (; t < 40 * 60 && roomAt(PUZZLE, pip.x, pip.y)?.puzzle; t += 5) { sim.step((t + 5) * 1000); teacher.tick(); pip.energy = Math.max(pip.energy, 22); }
  assert.equal(teacher.rescue.history.length, 1);
  assert.match(teacher.rescue.history[0].why, /battery/);
  assert.match(events[0], /doorLocked door-bedroom-emergency false/);
  assert.ok(said.some((s) => /Follow me/.test(s)), "it told the pet to follow");
  assert.ok(roomAt(PUZZLE, pip.x, pip.y) && !roomAt(PUZZLE, pip.x, pip.y)!.puzzle, `the pet was led out (it is in ${roomAt(PUZZLE, pip.x, pip.y)?.id} after ${Math.round(t / 60)} min)`);
  for (let k = 0; k < 40 && teacher.rescue.active; k++) { sim.step((t += 5) * 1000); teacher.tick(); }
  assert.equal(teacher.rescue.history[0].outcome, "out");
  assert.ok(sim.world.isLocked("door-bedroom-emergency"), "the way out is locked again for the next pet");
  assert.ok(events.some((e) => /doorLocked door-bedroom-emergency true/.test(e)));
  teacher.dispose();
});

test("nobody is rescued who is not stuck: a pet in an ordinary room, or only just inside a maze", () => {
  const sim = puzzle();
  const hooks = { setLocked: () => { throw new Error("should not unlock"); }, say: () => { throw new Error("should not speak"); } };
  return import("./rescue.js").then(({ Rescue }) => {
    const r = new Rescue(sim, hooks);
    place(sim.pets[0], 300, 300); place(sim.pets[1], 500, 400); place(sim.pets[2], 1500, 300);
    assert.equal(r.tick(), undefined);
    place(sim.pets[0], 450, 1050); sim.pets[0].roomSince = sim.simSec - 20 * 60; sim.pets[0].energy = 80;
    assert.equal(r.tick(), undefined, "20 minutes inside with a good battery is no cause for worry");
    assert.equal(r.trapped().length, 1);
  });
});

test("a pet being led keeps to the nearest moving thing in sight, and looks for it when it is lost", () => {
  const sim = puzzle();
  away(sim);
  const [pip, moss, coco] = sim.pets;
  place(coco, 1900, 100); place(moss, 1800, 100);
  place(pip, 1600, 200, 0); pip.energy = 90; pip.s1.holdUntil = 0; pip.drives.rest = 0;
  sim.teacher.x = 1720; sim.teacher.y = 200; // ahead of it, in view
  pip.s1.guidedUntil = 1e9;
  pip.mode = "sleeping"; pip.drives.rest = 0.95;
  pip.s1.guidePath = [{ x: 1900, y: 200 }, { x: 2100, y: 200 }];
  let now = 100;
  const led = decide(pip, sense(pip, sim.pets, sim.world, [], now, new Rng(1), sim.human, sim.teacher), new Rng(2), now);
  assert.equal(led.action, "follow_guide");
  assert.match(led.reason, /way the Teacher is leading/);
  assert.ok(led.forward > 0.5, "a sleeping pet still walks the path");
  pip.mode = "idle"; pip.drives.rest = 0; pip.s1.guidePath = undefined; pip.s1.guideStep = undefined;
  const look = () => decide(pip, sense(pip, sim.pets, sim.world, [], now, new Rng(1), sim.human, sim.teacher), new Rng(2), now);
  const d = look();
  assert.equal(d.action, "follow_guide");
  assert.match(d.reason, /following the Teacher/);
  assert.ok(d.forward > 0.5 && Math.abs(d.turn) < 0.3, "walks toward it");
  sim.teacher.x = 1640; // right beside it: waits for it to go on
  assert.equal(look().forward, 0);
  sim.teacher.x = 450; sim.teacher.y = 1050; // out of sight, deep in a maze
  place(coco, 450, 1050); place(moss, 450, 1250); // the others are out of sight too
  const lately = look();
  assert.equal(lately.action, "follow_guide");
  assert.match(lately.reason, /where the Teacher was last seen/);
  assert.ok(lately.forward > 0, "just lost (round a corner, say): goes on the way it was going");
  now += 20;
  const lost = look();
  assert.equal(lost.action, "follow_guide");
  assert.match(lost.reason, /looking for the Teacher/);
  assert.ok(lost.turn !== 0 && lost.forward < 0.2, "and then turns about to look for it");
  pip.s1.guidedUntil = 0;
  assert.notEqual(look().action, "follow_guide", "and once the guiding is over it is itself again");
});

test("the maze benchmark builds a maze the pet can leave, and a pet can solve a small one", () => {
  const { layout, maze } = benchMaze(4, 3, 1);
  assert.ok(findPath(layout, { x: 50, y: 50 }, { x: 4 * 100 + 100, y: 250 }, 22), "there is a way from the start cell to the lobby");
  assert.equal(maze.route.length >= 5, true);
  const r = runMaze(4, 3, 1, 1, 90, "open");
  assert.equal(r.shortest, maze.route.length);
  assert.ok(r.trials[0].solvedSec !== null, "a pet gets out of a 4x3 maze within 90 minutes");
  assert.ok(r.trials[0].walked > 0);
});
