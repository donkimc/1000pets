import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrainLibrary, Saves } from "./saves.js";
import { Store } from "./store.js";

const info = { simDay: 2, simTime: "D2 10:00", speed: 1, pets: ["Pip"] };

async function setup() {
  const data = await mkdtemp(path.join(tmpdir(), "saves-"));
  const store = await Store.open(data, "main");
  await store.writeJson("world.json", { v: 1 });
  await store.append("events", { type: "a" });
  await writeFile(path.join(store.dir, "thoughts", "pip.jsonl"), '{"t":1}\n');
  return { data, store, saves: new Saves(data) };
}

test("a save copies the whole run folder and lists it", async () => {
  const { store, saves } = await setup();
  const m = await saves.create(store.dir, "Day two", info);
  assert.match(m.id, /^\d{14}-day-two$/);
  assert.ok(m.bytes > 0);
  const list = await saves.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Day two");
});

test("loading restores the run folder exactly, dropping files added since", async () => {
  const { store, saves } = await setup();
  const m = await saves.create(store.dir, "keep", info);
  await store.writeJson("world.json", { v: 2 });
  await store.writeJson("extra.json", { stray: true });
  await store.append("events", { type: "b" });
  await saves.restore(m.id, store.dir);
  assert.deepEqual(await store.readJson("world.json"), { v: 1 });
  assert.equal(await store.readJson("extra.json"), null);
  assert.deepEqual(await store.readLog("events"), [{ type: "a" }]);
  assert.equal((await readFile(path.join(store.dir, "thoughts", "pip.jsonl"), "utf8")).trim(), '{"t":1}');
  await store.append("events", { type: "c" }); // folders needed by the server exist again
});

test("rename, delete, and unsafe ids", async () => {
  const { store, saves } = await setup();
  const m = await saves.create(store.dir, "a", info);
  assert.equal((await saves.rename(m.id, "b")).name, "b");
  await assert.rejects(saves.restore("../../etc", store.dir), /no such save|bad save id/);
  await assert.rejects(saves.remove("nope"), /no such save/);
  await saves.remove(m.id);
  assert.deepEqual(await saves.list(), []);
});

test("same-name saves get distinct ids, and only the latest 3 automatic backups are kept", async () => {
  const { store, saves } = await setup();
  const a = await saves.create(store.dir, "same", info);
  const b = await saves.create(store.dir, "same", info);
  assert.notEqual(a.id, b.id);
  for (let i = 0; i < 5; i++) await saves.create(store.dir, `auto ${i}`, info, true);
  const list = await saves.list();
  assert.equal(list.filter((s) => s.auto).length, 3);
  assert.equal(list.filter((s) => !s.auto).length, 2, "manual saves are never pruned");
});

test("a half-written save never shows up in the list", async () => {
  const { data, saves } = await setup();
  await mkdir(path.join(data, "saves", ".x.partial", "run"), { recursive: true });
  await mkdir(path.join(data, "saves", "orphan"), { recursive: true });
  assert.deepEqual(await saves.list(), []);
});

test("writeJson is atomic: no temp files are left behind", async () => {
  const { store } = await setup();
  await store.writeJson("a.json", { n: 1 });
  await store.writeJson("a.json", { n: 2 });
  assert.deepEqual(await store.readJson("a.json"), { n: 2 });
  assert.ok(!(await readdir(store.dir)).some((f) => f.endsWith(".tmp")));
});

test("brain library saves, lists, reads and deletes", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "brains-"));
  const lib = new BrainLibrary(data);
  assert.deepEqual(await lib.list(), []);
  const id = await lib.save({ id: "pip", label: "Pip early" }, { id: "pip", name: "Pip", label: "Pip early", savedAt: new Date().toISOString(), simDay: 3 });
  const id2 = await lib.save({ id: "pip", label: "Pip early" }, { id: "pip", name: "Pip", label: "Pip early", savedAt: new Date().toISOString(), simDay: 4 });
  assert.notEqual(id, id2);
  assert.equal((await lib.list()).length, 2);
  assert.equal(((await lib.read(id)) as any).simDay, 3);
  await assert.rejects(lib.read("../x"), /bad brain id/);
  await lib.remove(id);
  assert.equal((await lib.list()).length, 1);
});

import { gzipSync, gunzipSync } from "node:zlib";
import { BUNDLE_FORMAT } from "./saves.js";

async function realRun() {
  const data = await mkdtemp(path.join(tmpdir(), "saves-"));
  const store = await Store.open(data, "main");
  await store.writeJson("clock.json", { simMs: 90_000_000, speed: 10, paused: true });
  await store.writeJson("world.json", { simMinute: 1500, env: { weather: "clear" } });
  await store.writeJson("pets.json", { simSec: 90000, pets: [{ id: "pip", name: "Pip" }, { id: "moss", name: "Moss" }] });
  await store.writeJson("teacher.json", { plan: null });
  await store.append("events", { type: "a" });
  await writeFile(path.join(store.dir, "thoughts", "pip.jsonl"), '{"t":1}\n{"t":2}\n');
  await writeFile(path.join(store.dir, "clock.json.123.tmp"), "half written");
  return { data, store, saves: new Saves(data) };
}
const bundleOf = (obj: unknown) => gzipSync(Buffer.from(JSON.stringify(obj)));
const good = (files: { path: string; data: string }[] = []) => ({
  format: BUNDLE_FORMAT, version: 1, meta: { name: "Day 2", simDay: 2, simTime: "D2 01:00", pets: ["Pip", "Moss"] },
  files: [
    { path: "clock.json", data: '{"simMs":1000,"speed":1}' }, { path: "world.json", data: '{"simMinute":5,"env":{}}' },
    { path: "pets.json", data: '{"pets":[{"id":"pip","name":"Pip"}]}' }, ...files,
  ],
});

test("a save downloads as one file and comes back as an identical save", async () => {
  const { store, saves } = await realRun();
  const m = await saves.create(store.dir, "Day two", info);
  const file = await saves.exportBundle(m.id);
  const inside = JSON.parse(gunzipSync(file).toString());
  assert.equal(inside.format, BUNDLE_FORMAT);
  const names = inside.files.map((f: any) => f.path).sort();
  assert.ok(names.includes("clock.json") && names.includes("thoughts/pip.jsonl") && names.includes("events.jsonl"));
  assert.ok(!names.some((n: string) => n.endsWith(".tmp")), "half-written leftovers are not exported");

  const other = new Saves(await mkdtemp(path.join(tmpdir(), "saves-")));
  const got = await other.importBundle(file);
  assert.match(got.name, /Day two \(uploaded\)/);
  assert.deepEqual(got.pets, ["Pip"]);
  assert.equal(got.auto, false);
  assert.equal((await other.list()).length, 1);
  assert.equal(await readFile(path.join(other.dir, got.id, "run", "thoughts", "pip.jsonl"), "utf8"), '{"t":1}\n{"t":2}\n');
  assert.equal(JSON.parse(await readFile(path.join(other.dir, got.id, "run", "clock.json"), "utf8")).paused, true);
  // and it can be loaded like any other save
  const run = await Store.open(await mkdtemp(path.join(tmpdir(), "run-")), "main");
  await other.restore(got.id, run.dir);
  assert.equal(JSON.parse(await readFile(path.join(run.dir, "pets.json"), "utf8")).pets.length, 2);
});

test("a file that is not a save, or is damaged, is refused and leaves nothing behind", async () => {
  const saves = new Saves(await mkdtemp(path.join(tmpdir(), "saves-")));
  await assert.rejects(saves.importBundle(Buffer.from("hello")), /not a 1000pets save file/);
  await assert.rejects(saves.importBundle(bundleOf({ format: "other", version: 1, files: [] })), /not a 1000pets save file/);
  await assert.rejects(saves.importBundle(bundleOf({ ...good(), version: 2 })), /not a 1000pets save file/);
  const noClock = good(); noClock.files = noClock.files.filter((f) => f.path !== "clock.json");
  await assert.rejects(saves.importBundle(bundleOf(noClock)), /missing clock.json/);
  await assert.rejects(saves.importBundle(bundleOf(good([{ path: "events.jsonl", data: "{}" }, { path: "events.jsonl", data: "{}" }]))), /twice/);
  const broken = good(); broken.files[1] = { path: "world.json", data: "{not json" };
  await assert.rejects(saves.importBundle(bundleOf(broken)), /world.json in the save file is damaged/);
  const noPets = good(); noPets.files[2] = { path: "pets.json", data: '{"pets":[]}' };
  await assert.rejects(saves.importBundle(bundleOf(noPets)), /does not hold a simulation/);
  const badId = good(); badId.files[2] = { path: "pets.json", data: '{"pets":[{"id":"../x"}]}' };
  await assert.rejects(saves.importBundle(bundleOf(badId)), /does not hold a simulation/);
  assert.deepEqual(await saves.list(), []);
  assert.deepEqual((await readdir(saves.dir).catch(() => [])).filter((n) => !n.startsWith(".") || n.endsWith(".partial")), []);
});

test("a bundle cannot write outside the save, or anything but logs and state files", async () => {
  const saves = new Saves(await mkdtemp(path.join(tmpdir(), "saves-")));
  for (const bad of ["../evil.json", "/etc/passwd.json", "thoughts/../../evil.json", "a/b/c/d.json", "run.sh", "notes.txt", "x\\y.json", ".hidden.json"]) {
    await assert.rejects(saves.importBundle(bundleOf(good([{ path: bad, data: "{}" }]))), /something unexpected/, bad);
  }
  assert.deepEqual(await saves.list(), []);
});
