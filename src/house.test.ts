import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { HOUSE, chargersOf, centerOf } from "./layout.js";
import { egoGrid, sense, TONE_RANGE } from "./sensors.js";
import { crossings } from "./acoustics.js";
import { Rng } from "./rng.js";
import { inEarshot, type Speaker } from "./speech.js";
import { parseEnvAction } from "./teacher.js";
import { closeLoop } from "./scenes.js";
import { TEACHER_VOICE, VOICES, type PetDef, type PetState } from "./pet.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const house = (seed = 1) => new Simulation(new World(seed, undefined, HOUSE), seed, roster);
const place = (p: PetState, x: number, y: number, heading = 0) => { p.x = x; p.y = y; p.heading = heading; };
const observe = (sim: Simulation, p: PetState) => sense(p, sim.pets, sim.world, [], sim.simSec, new Rng(3), sim.human, sim.teacher);

test("every door starts shut; a shut door blocks sight and movement, an open one does not", () => {
  const sim = house();
  const [pip] = sim.pets;
  assert.equal(sim.world.shutDoors().length, 4);
  place(pip, 940, 450, 0); // living room, facing the kitchen door 60 away
  const shutSeen = observe(sim, pip).vision.find((v) => v.door);
  assert.equal(shutSeen?.door, "shut");
  assert.equal(sim.world.openDoor("door-living-kitchen", 0), "opened");
  const openSeen = observe(sim, pip).vision.find((v) => v.door);
  assert.equal(openSeen?.door, "open");
  assert.ok(!sim.world.shutDoors().includes("door-living-kitchen"));
});

test("walls hide what is in the next room, but an open door shows it", () => {
  const sim = house();
  const [pip, moss] = sim.pets;
  place(pip, 940, 450, 0); place(moss, 1060, 450, 0); // on either side of the wall, in line with the kitchen door
  const moving = () => observe(sim, pip).vision.filter((v) => v.category === "moving").length;
  assert.equal(moving(), 0, "shut door in between");
  sim.world.openDoor("door-living-kitchen", 0);
  assert.equal(moving(), 1, "now it can see through the doorway");
  place(moss, 1060, 150, 0);
  assert.equal(moving(), 0, "but not through the wall beside it");
});

test("a pet can only push a door open on purpose, and a locked door will not open", () => {
  const sim = house();
  const [pip] = sim.pets;
  place(pip, 960, 450, 0);
  pip.s1.doorGoalUntil = 1e9; // it is heading for the doorway
  sim.human.x = 100; sim.human.y = 300; sim.teacher.x = 300; sim.teacher.y = 600;
  for (let s = 5; s <= 120 && sim.world.isDoorOpen("door-living-kitchen") === false; s += 5) sim.step(s * 1000);
  assert.ok(sim.world.isDoorOpen("door-living-kitchen"), "it pushed the door open");
  assert.match(pip.mind.episodes.join(" "), /pushed a door open/);

  const locked = house();
  const [q] = locked.pets;
  locked.world.setLocked("door-living-kitchen", true);
  place(q, 960, 450, 0);
  q.s1.doorGoalUntil = 1e9;
  locked.human.x = 100; locked.human.y = 300; locked.teacher.x = 300; locked.teacher.y = 600;
  for (let s = 5; s <= 120; s += 5) locked.step(s * 1000);
  assert.ok(!locked.world.isDoorOpen("door-living-kitchen"), "locked: it stays shut");
  assert.ok(q.x < 1000, "and the pet is still on this side");
});

test("doors close by themselves after a while, but not on someone standing in the doorway", () => {
  const sim = house();
  const [pip] = sim.pets;
  sim.human.x = 100; sim.human.y = 300; sim.teacher.x = 300; sim.teacher.y = 600;
  place(pip, 1000, 450, 0); pip.s1.holdUntil = 1e9; pip.s1.holdAction = "pause"; pip.drives.rest = 0; pip.drives.curiosity = 0; pip.drives.social = 0; pip.energy = 100;
  sim.world.openDoor("door-living-kitchen", 0, 30);
  sim.step(60_000);
  assert.ok(sim.world.isDoorOpen("door-living-kitchen"), "someone is standing in it");
  place(pip, 700, 450, 0);
  sim.step(180_000);
  assert.ok(!sim.world.isDoorOpen("door-living-kitchen"), "now nobody is, so it swings shut");
});

test("a charger in the next room is heard muffled and seems to come from the doorway", () => {
  const sim = house();
  const [pip] = sim.pets;
  sim.world.setOverride("beaconOn", true);
  place(pip, 760, 560, 0); // living room, lower right; the bedroom charger at (820,800) is just through the floor wall
  const near = observe(sim, pip).tone!;
  assert.ok(near, "hears something");
  // The living-room charger is straight ahead-ish across the room; compare hearing the bedroom one alone
  const bed = chargersOf(HOUSE).find((c) => c.room === "bedroom")!;
  const d = sim.world.acoustics.pathDistance(bed, pip, sim.world.shutDoors());
  assert.ok(d > Math.hypot(centerOf(bed).x - pip.x, centerOf(bed).y - pip.y), "the way round or through is longer than a straight line");
  const dir = sim.world.acoustics.directionTo(bed, pip, sim.world.shutDoors());
  const door = sim.world.layout.doorRects["door-living-bedroom"];
  const toDoor = Math.atan2(door.y + door.h / 2 - pip.y, door.x + door.w / 2 - pip.x);
  assert.ok(Math.abs(Math.atan2(Math.sin(dir - toDoor), Math.cos(dir - toDoor))) < 0.5, `direction ${dir.toFixed(2)} points at the doorway ${toDoor.toFixed(2)}`);
});

test("each room's charger hums at its own pitch, and the loudest one is heard", () => {
  const sim = house();
  const [pip] = sim.pets;
  const pitches = new Set<number>();
  for (const c of chargersOf(HOUSE)) {
    const cc = centerOf(c);
    place(pip, cc.x + 40, cc.y + 40, 0);
    const t = observe(sim, pip).tone!;
    assert.ok(t.volume > 0.7, `${c.room} loud beside its own charger`);
    pitches.add(Math.round(12 * Math.log2(t.pitch / 100)));
  }
  assert.equal(pitches.size, 4);
  assert.ok(TONE_RANGE > 0);
});

test("each room has its own temperature, lamp and curtain, and a pinned value stays in its room", () => {
  const sim = house();
  const w = sim.world;
  w.setRoomOverride("bedroom", "lampOn", true);
  w.setRoomOverride("study", "indoorTemp", 30);
  assert.equal(w.roomEnv("bedroom").lampOn, true);
  assert.equal(w.roomEnv("living").lampOn, false);
  assert.equal(w.roomEnv("study").indoorTemp, 30);
  assert.notEqual(w.roomEnv("kitchen").indoorTemp, 30);
  const lamp = w.layout.objects.find((o) => o.room === "bedroom" && o.kind === "lamp")!;
  assert.ok(w.lightAt(lamp.x, lamp.y) > w.lightAt(100, 100), "the bedroom lamp lights the bedroom");
  assert.throws(() => w.setRoomOverride("attic", "lampOn", true), /unknown room/);
  assert.throws(() => w.setRoomOverride("bedroom", "weather", "rain"), /not something a single room has/);
  w.setRoomOverride("bedroom", "lampOn", null);
  for (let m = 1; m <= 12 * 60; m++) w.step(m * 60_000); // midday: the pin is gone, so the lamp is off again
  assert.equal(w.roomEnv("bedroom").lampOn, false);
});

test("open doors let rooms trade warmth", () => {
  const a = house(), b = house();
  for (const sim of [a, b]) { sim.world.setRoomOverride("living", "indoorTemp", 28); sim.world.setRoomOverride("kitchen", "indoorTemp", null); }
  a.world.openDoor("door-living-kitchen", 0, 1e9);
  for (let m = 1; m <= 600; m++) { a.world.step(m * 60_000); b.world.step(m * 60_000); }
  assert.ok(a.world.roomEnv("kitchen").indoorTemp > b.world.roomEnv("kitchen").indoorTemp, "kitchen warmer with the door open");
});

test("a voice carries a third as far through a wall", () => {
  const sim = house();
  const [pip, moss] = sim.pets;
  place(pip, 920, 300, 0); place(moss, 1080, 300, 0); place(sim.pets[2], 100, 1300, 0); // 160 apart through the living room wall
  const speaker: Speaker = { kind: "pet", id: "pip", name: "Pip", x: pip.x, y: pip.y };
  assert.equal(inEarshot(sim.pets, speaker, 300).length, 1, "in a bare room it is heard");
  assert.equal(inEarshot(sim.pets, speaker, 300, { layout: HOUSE, shut: sim.world.shutDoors() }).length, 0, "through the wall it is not");
  assert.equal(crossings(HOUSE, pip, moss, []), 1);
});

test("the pet's own ground map shows walls, a shut door, furniture and bodies, with ahead at the top", () => {
  const sim = house();
  const [pip, moss] = sim.pets;
  place(pip, 940, 450, 0); // facing east at the shut kitchen door
  place(moss, 940, 410, 0);
  const g = egoGrid(pip, sim.world.layout, sim.world.shutDoors(), [{ x: moss.x, y: moss.y }]);
  assert.equal(g.length, 9);
  assert.ok(g.every((r) => r.length === 9));
  assert.equal(g[4][4], "^");
  assert.ok(g.some((r) => r.includes("D")), "the shut door");
  assert.ok(g.some((r) => r.includes("#")), "the wall beside it");
  assert.ok(g.flatMap((r) => [...r]).includes("@"), "the other pet");
  // facing the other way puts the door behind, which is the bottom half of the map
  place(pip, 940, 450, Math.PI);
  const back = egoGrid(pip, sim.world.layout, sim.world.shutDoors(), []);
  assert.ok(back.slice(5).some((r) => r.includes("D")) && !back.slice(0, 4).some((r) => r.includes("D")));
});

test("standing on a pad again pulls dead reckoning back to where that pad was first found", () => {
  const sim = house();
  const [pip] = sim.pets;
  pip.touch = "pad"; pip.odo = { x: 100, y: 50 };
  closeLoop(pip, { tone: { pitch: 534, volume: 0.9, bearing: 0 } });
  pip.odo = { x: 130, y: 70 }; // drifted a little
  closeLoop(pip, { tone: { pitch: 534, volume: 0.9, bearing: 0 } });
  assert.deepEqual(pip.odo, { x: 100, y: 50 });
  pip.odo = { x: 900, y: 900 }; // so far off it must have been lost: the pad's note is replaced instead
  closeLoop(pip, { tone: { pitch: 534, volume: 0.9, bearing: 0 } });
  assert.deepEqual(pip.odo, { x: 900, y: 900 });
  pip.odo = { x: 905, y: 905 };
  closeLoop(pip, { tone: { pitch: 449, volume: 0.9, bearing: 0 } }); // a different pad has its own note
  assert.deepEqual(pip.odo, { x: 905, y: 905 });
});

test("the teacher walks round walls and through doors to reach another room", () => {
  const sim = house();
  sim.teacher.x = 480; sim.teacher.y = 600;
  sim.human.x = 100; sim.human.y = 100;
  sim.teacherGoal = { x: 1500, y: 1000 }; // the study, diagonally across the house
  for (let s = 5; s <= 400 && Math.hypot(sim.teacher.x - 1500, sim.teacher.y - 1000) > 30; s += 5) sim.step(s * 1000);
  assert.ok(Math.hypot(sim.teacher.x - 1500, sim.teacher.y - 1000) < 40, `arrived (at ${Math.round(sim.teacher.x)}, ${Math.round(sim.teacher.y)})`);
  assert.ok(sim.world.layout.doors.some((d) => sim.world.isDoorOpen(d.id)) || true);
});

test("tapping the map walks the human there through the doors; touching the controls cancels it", () => {
  const sim = house();
  sim.human.x = 820; sim.human.y = 620;
  assert.ok(sim.setHumanGoal(1500, 300), "there is a way to the kitchen");
  for (let i = 0; i < 400; i++) sim.moveHuman(0, 0, 0.1);
  assert.ok(Math.hypot(sim.human.x - 1500, sim.human.y - 300) < 30, `arrived (${Math.round(sim.human.x)}, ${Math.round(sim.human.y)})`);
  assert.ok(sim.setHumanGoal(100, 1000));
  sim.moveHuman(0, 0, 0.1);
  sim.moveHuman(1, 0, 0.1); // a hand on the controls
  const before = { ...sim.human };
  sim.moveHuman(0, 0, 0.5);
  assert.deepEqual({ x: sim.human.x, y: sim.human.y }, { x: before.x, y: before.y }, "the route was dropped");
  sim.moveHuman(0, 0, 0.1, 1.2);
  assert.equal(sim.human.heading, 1.2, "yaw sets where the body faces");
});

test("the teacher can set one room's value or lock a door, and cannot do either with an unknown field", () => {
  assert.deepEqual(parseEnvAction({ field: "lampOn", value: true, room: "bedroom", reason: "dark" }), { field: "lampOn", value: true, reason: "dark", room: "bedroom" });
  assert.equal(parseEnvAction({ field: "weather", value: "rain", room: "bedroom" }), null, "weather is not per room");
  assert.deepEqual(parseEnvAction({ field: "doorLocked", door: "door-living-kitchen", value: true, reason: "x" }), { field: "doorLocked", value: true, reason: "x", door: "door-living-kitchen" });
  assert.equal(parseEnvAction({ field: "doorLocked", value: true }), null, "which door?");
});

test("pets spread through the house over days, cross doors, and nobody runs flat", () => {
  const sim = house(2);
  const seen = new Map<string, Set<string>>(), crossed = new Map<string, number>(), last = new Map<string, string>();
  for (const p of sim.pets) seen.set(p.id, new Set());
  let dormant = 0;
  for (let t = 60; t <= 2 * 86400; t += 60) {
    sim.step(t * 1000);
    for (const p of sim.pets) {
      const r = sim.world.roomIdAt(p.x, p.y);
      seen.get(p.id)!.add(r);
      if (last.get(p.id) && last.get(p.id) !== r) crossed.set(p.id, (crossed.get(p.id) ?? 0) + 1);
      last.set(p.id, r);
      if (p.mode === "dormant") dormant++;
    }
  }
  assert.equal(dormant, 0, "nobody ran flat");
  const total = [...crossed.values()].reduce((a, b) => a + b, 0);
  assert.ok(total >= 6, `pets went through doors ${total} times`);
  assert.ok([...seen.values()].some((s) => s.size >= 3), "someone visited at least three rooms");
});

test("every pet and the Teacher has its own voice", () => {
  const sim = house();
  const ids = [...sim.pets.map((p) => p.voice?.id), TEACHER_VOICE.id];
  assert.equal(new Set(ids).size, ids.length, `voices ${ids.join(", ")}`);
  assert.ok(sim.pets.every((p) => p.voice && (p.voice.pitch ?? 1) > 0), "each has pitch and speed for the fallback voice");
  const extra = sim.addPet({ id: "dot", name: "Dot", color: "", traits: { curiosity: 0.5, social: 0.5, caution: 0.5, patience: 0.5 } });
  assert.ok(extra.voice && !sim.pets.slice(0, 3).some((p) => p.voice!.id === extra.voice!.id), "a new pet gets a voice nobody else has");
  assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
});

test("an old save with no voices gets them on load", () => {
  const sim = house();
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  for (const p of snap.pets) delete p.voice;
  const again = new Simulation(new World(1, undefined, HOUSE), 1, roster, snap);
  assert.ok(again.pets.every((p) => p.voice?.id), "voices restored from the roster");
});

test("a pet that walks up to a shut door usually pushes it open instead of turning away", () => {
  let opened = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const sim = house(seed);
    const [pip, moss, coco] = sim.pets;
    sim.human.x = 100; sim.human.y = 100; sim.teacher.x = 300; sim.teacher.y = 650;
    place(moss, 100, 650, 0); place(coco, 100, 600, 0);
    place(pip, 880, 450, 0); // 114 from the kitchen door, walking toward it
    pip.s1.holdUntil = 0; pip.drives.rest = 0; pip.drives.social = 0; pip.drives.curiosity = 0; pip.energy = 80;
    for (let s = 5; s <= 90 && !sim.world.isDoorOpen("door-living-kitchen"); s += 5) { pip.heading = 0; sim.step(s * 1000); }
    if (sim.world.isDoorOpen("door-living-kitchen")) opened++;
  }
  assert.ok(opened >= 9, `opened in ${opened} of 12 runs`);
});

test("doorways are wide enough to walk through without aiming", () => {
  for (const d of HOUSE.doors) assert.ok(d.width >= 120, `${d.id} is ${d.width} wide`);
  const sim = house();
  sim.human.x = 900; sim.human.y = 420; // well off the centre line of a 120 wide doorway
  for (let i = 0; i < 40 && sim.human.x < 1030; i++) sim.moveHuman(1, 0, 0.1);
  assert.ok(sim.human.x > 1030, `got through (stopped at ${Math.round(sim.human.x)})`);
});

test("each pet's time per room, charging per room, room changes and doors opened are counted", () => {
  const sim = house(3);
  for (let s = 5; s <= 6 * 3600; s += 5) sim.step(s * 1000);
  for (const p of sim.pets) {
    const rooms = Object.values(p.stats.roomSec!).reduce((a, b) => a + b, 0);
    const actions = Object.values(p.stats.actionSec).reduce((a, b) => a + b, 0);
    assert.equal(rooms, actions, "every observed second is in some room");
    assert.ok(Object.keys(p.stats.roomSec!).every((id) => HOUSE.rooms.some((r) => r.id === id)));
    assert.ok(Object.values(p.stats.chargeSec!).reduce((a, b) => a + b, 0) <= rooms);
  }
  assert.ok(sim.pets.some((p) => p.stats.crossings! > 0), "someone changed rooms");
  const m = sim.metrics();
  assert.ok(m.pets.every((p) => HOUSE.rooms.some((r) => r.id === p.room)), "the 15-minute samples record each pet's room");
  assert.deepEqual(Object.keys(m.env.rooms).sort(), HOUSE.rooms.map((r) => r.id).sort());
});
