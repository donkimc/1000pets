import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Rng } from "./rng.js";
import { BEACON_PITCH, TONE_RANGE, pitchBin, sense, type Observation } from "./sensors.js";
import { cueFor, cueTrust, describeCues, describeTone, newCue, novelty, startGoal, toneKey, updateCues } from "./cues.js";
import { decide } from "./system1.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { buildNotes } from "./system2.js";
import { centerOf, OBJECTS } from "./world.js";
import type { PetDef, PetState } from "./pet.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const charger = centerOf(OBJECTS.find((o) => o.kind === "charger")!);

function scene() {
  const sim = new Simulation(new World(1), 1, roster);
  const [pip, moss, coco] = sim.pets;
  moss.x = 100; moss.y = 600; coco.x = 100; coco.y = 650;
  sim.human.x = 120; sim.human.y = 400; sim.teacher.x = 200; sim.teacher.y = 450;
  const obs = (p: PetState = pip): Observation => sense(p, sim.pets, sim.world, [], 0, new Rng(1), sim.human, sim.teacher);
  return { sim, pip, moss, coco, obs };
}
const place = (p: PetState, x: number, y: number, heading: number) => { p.x = x; p.y = y; p.heading = heading; };
const headingTo = (p: PetState, x: number, y: number) => Math.atan2(y - p.y, x - p.x);

test("the hum is heard from any direction, grows louder nearer the charger, and has its own pitch bin", () => {
  const { pip, obs } = scene();
  place(pip, 500, 400, 0);
  const far = obs().tone!;
  place(pip, 700, 200, 0);
  const near = obs().tone!;
  assert.ok(near.volume > far.volume, "closer is louder");
  place(pip, 500, 400, Math.PI); // facing away from the charger: still heard, and the bearing shows where it is
  const away = obs().tone!;
  assert.ok(Math.abs(Math.abs(away.bearing) - 0) > 1.5 || Math.abs(away.bearing) > 1.5, `bearing ${away.bearing} should point behind`);
  assert.equal(pitchBin(away.pitch), pitchBin(BEACON_PITCH), "noise never moves it to another bin");
  place(pip, 20, 690, 0);
  assert.equal(obs().tone, null, `beyond ${TONE_RANGE} units nothing is heard`);
});

test("noises and the hum never share a pitch bin", () => {
  const bins = [100, 126, 178, 252, BEACON_PITCH].map(pitchBin);
  assert.equal(new Set(bins).size, 5);
});

test("switching the beacon off silences it, and the world remembers it as a setting", () => {
  const { sim, pip, obs } = scene();
  place(pip, 700, 200, 0);
  assert.ok(obs().tone);
  sim.world.setOverride("beaconOn", false);
  assert.equal(obs().tone, null);
  sim.world.step(3 * 3600_000);
  assert.equal(sim.world.env.beaconOn, false, "stays off while pinned");
  sim.world.setOverride("beaconOn", "auto");
  assert.equal(sim.world.env.beaconOn, true);
  const snap: any = JSON.parse(JSON.stringify(sim.world.snap));
  delete snap.env.beaconOn;
  assert.equal(new World(1, snap).env.beaconOn, true, "saves from before the beacon get the hum");
});

test("the hum is a separate channel: a loud noise does not hide it", () => {
  const { sim, pip } = scene();
  place(pip, 700, 200, 0);
  const o = sense(pip, sim.pets, sim.world, [{ tSec: 0, x: pip.x + 20, y: pip.y, volume: 1, pitch: 126 }], 0, new Rng(1), sim.human, sim.teacher);
  assert.ok(o.hearing && o.tone);
  assert.equal(pitchBin(o.hearing!.pitch), pitchBin(126));
  assert.equal(pitchBin(o.tone!.pitch), pitchBin(BEACON_PITCH));
});

test("charging after being close to the loud end is support; trust needs two and a good ratio", () => {
  const { pip, obs } = scene();
  place(pip, 860, 100, 0); // near the charger, loud
  pip.chargeRate = 0;
  updateCues(pip, obs(), 100, 5);
  assert.equal(cueFor(pip, obs().tone!)!.support, 0);
  pip.chargeRate = 1;
  updateCues(pip, obs(), 105, 5);
  const c = cueFor(pip, obs().tone!)!;
  assert.equal(c.support, 1);
  assert.deepEqual([cueTrust(c).tentative, cueTrust(c).trusted], [true, false]);
  updateCues(pip, obs(), 110, 5);
  assert.equal(c.support, 1, "still charging is not a new event");
  pip.chargeRate = 0; updateCues(pip, obs(), 120, 5);
  pip.chargeRate = 1; updateCues(pip, obs(), 125, 5);
  assert.equal(c.support, 1, "flickering off and on the pad within 10 minutes is one occasion");
  pip.chargeRate = 0; updateCues(pip, obs(), 800, 5);
  pip.chargeRate = 1; updateCues(pip, obs(), 805, 5);
  assert.equal(c.support, 2);
  assert.equal(cueTrust(c).trusted, true);
  c.contra = 3;
  assert.equal(cueTrust(c).trusted, false, "failures take trust away");
  assert.equal(cueTrust(undefined).tentative, false);
});

test("a charge far from the tone's loud end earns no credit", () => {
  const { pip, obs } = scene();
  place(pip, 150, 640, 0); // far side of the room: faint
  pip.chargeRate = 0; updateCues(pip, obs(), 10, 5);
  pip.chargeRate = 1; updateCues(pip, obs(), 15, 5); // e.g. a sunlit patch far from the pad
  const c = cueFor(pip, obs().tone ?? { pitch: BEACON_PITCH, volume: 0, bearing: 0 });
  assert.ok(!c || c.support === 0);
});

test("following a tone to its source with no charge counts against it; losing the tone does not", () => {
  const { sim, pip, obs } = scene();
  place(pip, charger.x - 20, charger.y + 20, 0);
  pip.chargeRate = 0;
  updateCues(pip, obs(), 0, 5);
  const tone = obs().tone!;
  startGoal(pip, tone, 0);
  pip.s1.action = "follow_tone"; // it keeps trying the whole time
  for (let t = 5; t <= 130; t += 5) updateCues(pip, obs(), t, 5);
  const c = cueFor(pip, tone)!;
  assert.equal(c.contra, 1);
  assert.equal(pip.cueState!.goal, null);
  // reaches the source but another pet is right beside it (the pad is busy): not the tone's fault either
  sim.pets[1].x = pip.x + 40; sim.pets[1].y = pip.y;
  startGoal(pip, tone, 140);
  pip.s1.action = "follow_tone";
  for (let t = 145; t <= 280; t += 5) updateCues(pip, obs(), t, 5);
  assert.equal(c.contra, 1, "a crowded pad is not evidence against the tone");
  sim.pets[1].x = 100; sim.pets[1].y = 600;
  // reaches the area, then falls asleep or wanders off: its own choice, so no blame on the tone
  startGoal(pip, tone, 150);
  pip.s1.action = "follow_tone";
  updateCues(pip, obs(), 155, 5);
  pip.s1.action = "sleep";
  for (let t = 160; t <= 330; t += 5) updateCues(pip, obs(), t, 5);
  assert.equal(c.contra, 1, "stopping on its own is not the tone's fault");
  assert.equal(pip.cueState!.goal, null);
  // the tone vanishes mid-attempt: no blame
  startGoal(pip, tone, 200);
  const silent = { ...obs(), tone: null };
  for (let t = 205; t <= 260; t += 5) updateCues(pip, silent, t, 5);
  assert.equal(c.contra, 1);
  assert.equal(pip.cueState!.goal, null);
});

test("novelty fades as the pet gets used to a tone", () => {
  const c = newCue("tone:29", 534, 0);
  assert.equal(novelty(undefined), 1);
  assert.equal(novelty(c), 1);
  c.exposureSec = 1800;
  assert.ok(novelty(c) < 0.4 && novelty(c) > 0.3);
  c.exposureSec = 10_000;
  assert.ok(novelty(c) < 0.01);
});

test("a curious, bold pet follows an unfamiliar tone; a cautious one does not; both stop once it is familiar", () => {
  const { pip, moss, obs } = scene();
  place(pip, 600, 500, 0); place(moss, 300, 560, 0);
  pip.drives.curiosity = 0.6; moss.drives.curiosity = 0.3; pip.drives.social = 0; moss.drives.social = 0;
  const op = obs(pip), om = obs(moss);
  const dp = decide(pip, op, new Rng(1), 1000), dm = decide(moss, om, new Rng(1), 1000);
  assert.equal(dp.action, "follow_tone");
  assert.match(dp.reason, /unfamiliar steady tone/);
  assert.notEqual(dm.action, "follow_tone", "Moss is cautious and not very curious");
  pip.mind.cues[toneKey(op.tone!)] = { ...newCue(toneKey(op.tone!), 534, 0), exposureSec: 5000 };
  assert.notEqual(decide(pip, op, new Rng(1), 1000).action, "follow_tone", "the tone is old news now");
});

test("with low battery a trusted tone is followed toward its bearing; an untrusted one is not; a full pet ignores it", () => {
  const { pip, obs } = scene();
  place(pip, 700, 450, 0);
  pip.drives.curiosity = 0; pip.drives.social = 0;
  pip.energy = 20;
  const o = { ...obs(), energy: 20 };
  const key = toneKey(o.tone!);
  pip.mind.cues[key] = { ...newCue(key, 534, 0), exposureSec: 9000 }; // familiar, nothing learned
  assert.notEqual(decide(pip, o, new Rng(1), 1000).action, "follow_tone");
  pip.mind.cues[key].support = 3;
  const d = decide(pip, o, new Rng(1), 1000);
  assert.equal(d.action, "follow_tone");
  assert.match(d.reason, /led me to charge before/);
  assert.ok(Math.abs(d.turn - Math.max(-1.5, Math.min(1.5, o.tone!.bearing))) < 1e-9);
  assert.equal(pip.cueState!.goal!.key, key, "an attempt is now being tracked");
  pip.energy = 90;
  assert.notEqual(decide(pip, { ...o, energy: 90 }, new Rng(1), 1000).action, "follow_tone");
});

test("System 2 can urge a pet to follow a tone it does not yet trust", () => {
  const { pip, obs } = scene();
  place(pip, 700, 450, 0);
  pip.drives.curiosity = 0; pip.drives.social = 0;
  const o = { ...obs(), energy: 20 };
  pip.energy = 20;
  const key = toneKey(o.tone!);
  pip.mind.cues[key] = { ...newCue(key, 534, 0), exposureSec: 9000 };
  pip.mind.suggestion = { kind: "follow_tone", untilSec: 5000 };
  assert.equal(decide(pip, o, new Rng(1), 1000).action, "follow_tone");
});

test("end to end: a trusting pet far from the pad with a low battery walks to it and charges", () => {
  const sim = new Simulation(new World(2), 2, roster);
  const [pip, moss, coco] = sim.pets;
  place(pip, 600, 550, 0); place(moss, 120, 120, 0); place(coco, 300, 650, 0);
  sim.human.x = 100; sim.human.y = 300; sim.teacher.x = 300; sim.teacher.y = 500;
  pip.energy = 20; pip.drives.curiosity = 0; pip.drives.social = 0;
  pip.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 9000, support: 3 };
  let reached = -1;
  for (let s = 5; s <= 1800; s += 5) {
    sim.step(s * 1000);
    if (Math.hypot(pip.x - charger.x, pip.y - charger.y) < 36 && reached < 0) reached = s;
  }
  assert.ok(reached > 0 && reached < 1500, `reached the pad after ${reached}s`);
  assert.ok(pip.energy > 20, `battery ${pip.energy}`);
  assert.ok(pip.mind.cues["tone:29"].support >= 4, "arriving and charging added to the evidence");
});

test("the notes tell System 2 what the pet hears and what it has worked out, in plain counts", () => {
  const { pip, obs } = scene();
  place(pip, 700, 200, 0);
  const o = obs();
  const key = toneKey(o.tone!);
  pip.mind.cues[key] = { ...newCue(key, 534, 0), exposureSec: 1200, support: 2, contra: 1 };
  pip.mind.sensed.tone = describeTone(o.tone!, 0.1);
  const notes = buildNotes(pip, 1, 600, 0, 600);
  assert.match(notes, /Hearing a steady tone: a steady tone at \d+ Hz, (quiet|fairly loud|very loud), getting louder/);
  assert.match(notes, /heard for about 20 min in total.*charging began: 2.*not charged: 1.*I (suspect|trust) it/);
  assert.match(describeCues(pip)[0], /534 Hz/);
  assert.doesNotMatch(notes, /charger|beacon/i, "the pet is never told what the tone is");
});

test("what a pet learned about tones travels in its brain file, and bad cue data is cleaned", () => {
  const { sim, pip } = scene();
  sim.simSec = 10_000;
  pip.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 777, support: 4, contra: 1, lastHeardSec: 9_900 };
  const file = parseBrain(JSON.parse(JSON.stringify(exportBrain(pip, sim.simSec))));
  assert.deepEqual(file.cues, [{ key: "tone:29", pitch: 534, exposureSec: 777, support: 4, contra: 1, ageSec: 100 }]);
  const other = new Simulation(new World(5), 5, roster);
  other.simSec = 50;
  applyBrain(other.pets[1], file, other.simSec);
  const c = other.pets[1].mind.cues["tone:29"];
  assert.equal(c.support, 4);
  assert.equal(c.lastHeardSec, 50 - 100);
  assert.equal(cueTrust(c).trusted, true);
  const dirty = parseBrain({ ...JSON.parse(JSON.stringify(file)), cues: [{ key: "<img>", support: 9 }, { key: "tone:7", pitch: 1e9, support: -4, contra: "x" }, ...Array(30).fill({ key: "tone:1" })] });
  assert.equal(dirty.cues!.length, 11, "only the first 12 entries are looked at, and the invalid one is dropped");
  assert.equal(dirty.cues![0].key, "tone:7");
  assert.equal(dirty.cues![0].pitch, 5000);
  assert.equal(dirty.cues![0].support, 0);
  assert.deepEqual(parseBrain({ ...JSON.parse(JSON.stringify(file)), cues: undefined }).cues, []);
});

test("saves from before tone learning still load and keep running", () => {
  const sim = new Simulation(new World(4), 4, roster);
  sim.step(3600_000);
  const snap: any = JSON.parse(JSON.stringify(sim.snapshot()));
  for (const p of snap.pets) { delete p.mind.cues; delete p.mind.sensed.tone; delete p.cueState; }
  const old = new Simulation(sim.world, 4, roster, snap);
  assert.deepEqual(old.pets[0].mind.cues, {});
  old.step(sim.simSec * 1000 + 1800_000);
  assert.ok(Object.keys(old.pets[0].mind.cues).length >= 1, "it starts hearing the hum");
});

test("regression: a trusting pet stuck behind the table gets round it instead of pushing at it forever", () => {
  const sim = new Simulation(new World(11), 11, roster);
  const [pip, moss, coco] = sim.pets;
  place(pip, 368, 385, 0); place(moss, 120, 120, 0); place(coco, 150, 660, 0); // just west of the table, the charger north-east of it
  sim.human.x = 100; sim.human.y = 300; sim.teacher.x = 300; sim.teacher.y = 600;
  pip.energy = 30; pip.drives.curiosity = 0; pip.drives.social = 0;
  pip.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 9000, support: 5 };
  let reached = -1;
  for (let s = 5; s <= 4000; s += 5) {
    sim.step(s * 1000);
    if (Math.hypot(pip.x - charger.x, pip.y - charger.y) < 36 && reached < 0) reached = s;
  }
  assert.ok(reached > 0, "never got round the table");
});

test("regression: a pet that follows a tone and makes no progress gives up for a while and explores", () => {
  const { pip, obs } = scene();
  place(pip, 700, 450, 0);
  pip.energy = 20; pip.drives.curiosity = 0; pip.drives.social = 0;
  const o = { ...obs(), energy: 20 };
  const key = toneKey(o.tone!);
  pip.mind.cues[key] = { ...newCue(key, 534, 0), exposureSec: 9000, support: 3 };
  assert.equal(decide(pip, o, new Rng(1), 1000).action, "follow_tone");
  assert.notEqual(decide(pip, o, new Rng(1), 1000 + 300).action, "follow_tone", "300 s with no louder tone: it stops pushing");
  assert.notEqual(decide(pip, o, new Rng(1), 1000 + 400).action, "follow_tone", "and stays off it for a while");
  assert.equal(decide(pip, o, new Rng(1), 1000 + 300 + 200).action, "follow_tone", "then tries again");
});

test("regression: the obstacle ray sees another pet as wide as the bodies really are", () => {
  const { sim, pip, moss } = scene();
  place(pip, 700, 500, 0); // facing east
  place(moss, 760, 530, 0); // 60 ahead, 30 to the side: a ray 18 wide would miss it, the two bodies (36) would not
  const front = sense(pip, sim.pets, sim.world, [], 0, new Rng(1), sim.human, sim.teacher).proximity.front;
  assert.ok(front < 100, `front ray ${front} should see the other pet`);
});

test("regression: a pet blocked by a neighbour slides past it instead of pushing into it forever", () => {
  const sim = new Simulation(new World(5), 5, roster);
  const [pip, moss, coco] = sim.pets;
  place(pip, 978, 68, 2.75); place(moss, 976, 104, 0); place(coco, 976, 31, 0); // the line-up beside the pad that used to deadlock
  sim.human.x = 100; sim.human.y = 300; sim.teacher.x = 300; sim.teacher.y = 600;
  for (const p of [pip, moss, coco]) { p.energy = 30; p.drives.curiosity = 0; p.drives.social = 0; p.mind.cues["tone:29"] = { ...newCue("tone:29", 534, 0), exposureSec: 9000, support: 5 }; }
  let charged = 0;
  for (let s = 5; s <= 3000; s += 5) {
    sim.step(s * 1000);
    charged = [pip, moss, coco].filter((p) => p.energy > 31).length;
    if (charged === 3) break;
  }
  assert.equal(charged, 3, "everyone got to charge");
});

test("regression: over 8 simulated days pets in a crowded room never end up stranded and dormant", () => {
  const sim = new Simulation(new World(5), 5, roster);
  let dormantSamples = 0, samples = 0;
  for (let h = 1; h <= 8 * 24; h++) {
    sim.step(h * 3600_000);
    if (h % 4 === 0) { samples++; for (const p of sim.pets) if (p.mode === "dormant") dormantSamples++; }
  }
  assert.equal(dormantSamples, 0, "no pet ran flat");
});
