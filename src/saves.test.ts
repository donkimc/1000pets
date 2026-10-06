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
