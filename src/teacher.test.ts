import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Store } from "./store.js";
import type { PetDef } from "./pet.js";
import { Teacher, parseAnswerReply, parseEnvAction, parsePlanReply, type EnvControl, type TeacherLlm } from "./teacher.js";
import type { Target } from "./speech.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const ctx = { nowMin: 100, petIds: ["pip", "moss", "coco"], objectIds: ["window", "lamp", "heater"] };
const tick = () => new Promise((r) => setImmediate(r));

const planJson = (agenda: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: "gentle start", long_term: [{ goal: "learn light", why: "needs", progress: "none", focus: { pip: "look", ghost: "x" } }], pet_notes: { pip: "curious", nobody: "x" }, agenda, ...extra });

test("plan parsing validates every field", () => {
  const p = parsePlanReply(
    "Here you go:\n```json\n" + planJson([
      { in_minutes: 9999, kind: "weird", target: "ghost", where: "nowhere", topic: "A", outline: "o".repeat(900) },
      { in_minutes: 5, kind: "env", target: "all", where: "lamp", topic: "light it", env: { field: "lampOn", value: "on", reason: "dark" } },
      { in_minutes: 6, kind: "env", target: "all", topic: "bad env", env: { field: "weather", value: "snow" } },
      { in_minutes: 7, kind: "lesson", target: "pip", topic: "" },
      { in_minutes: 8, kind: "env", target: "all", topic: "release", env: { field: "heaterOn", value: "auto" } },
    ]) + "\n```",
    ctx,
  )!;
  assert.equal(p.agenda.length, 3, "invalid env item and empty topic are dropped");
  assert.deepEqual(p.agenda.map((a) => a.atMin), [105, 108, 820], "offsets are relative to now, clamped to 12 h, and sorted");
  const first = p.agenda[2];
  assert.equal(first.kind, "lesson");
  assert.equal(first.target, "all");
  assert.equal(first.where, "near_target");
  assert.equal(first.outline.length, 300);
  assert.deepEqual(p.agenda[0].env, { field: "lampOn", value: true, reason: "dark" });
  assert.equal(p.agenda[1].env!.value, "auto");
  assert.deepEqual(Object.keys(p.long[0].focus), ["pip"]);
  assert.deepEqual(Object.keys(p.petNotes), ["pip"]);
  assert.equal(parsePlanReply("not json", ctx), null);
  assert.equal(parsePlanReply(planJson([]), ctx), null);
});

test("env actions and answers parse safely", () => {
  assert.equal(parseEnvAction({ field: "lampOn", value: "maybe" }), null);
  assert.equal(parseEnvAction({ field: "nope", value: true }), null);
  assert.deepEqual(parseEnvAction({ field: "outdoorTemp", value: "500", reason: "r" }), { field: "outdoorTemp", value: 50, reason: "r" });
  assert.deepEqual(parseAnswerReply('{"answer":"Yes, here is light.","env_action":{"field":"lampOn","value":true,"reason":"dark"}}'), { answer: "Yes, here is light.", env: { field: "lampOn", value: true, reason: "dark" } });
  assert.equal(parseAnswerReply('{"answer":"","env_action":null}'), null);
  assert.equal(parseAnswerReply("Just plain words.")!.answer, "Just plain words.");
});

function setup(opts: { agenda?: unknown[]; maxCalls?: number; llmDelayMs?: number } = {}) {
  const sim = new Simulation(new World(1), 1, roster);
  const [pip, moss, coco] = sim.pets;
  pip.x = 300; pip.y = 560; moss.x = 700; moss.y = 560; coco.x = 800; coco.y = 650;
  sim.teacher.x = 400; sim.teacher.y = 600;
  const store = new Store(mkdtempSync(path.join(tmpdir(), "teacher-")));
  const changes: any[] = [];
  const env: EnvControl = {
    async set(field, value, source, reason) { changes.push({ field, value, source, reason }); return { field, from: null, to: value, mode: value === "auto" ? "auto" : "pin" }; },
    async recent() { return []; },
  };
  const said: { to: Target; text: string; trace: any; teacherToPip: number }[] = [];
  const speech = {
    async teacherSays(to: Target, text: string, trace: Record<string, unknown>) {
      const t = sim.teacher;
      said.push({ to, text, trace, teacherToPip: Math.hypot(t.x - pip.x, t.y - pip.y) });
      const heard = sim.pets.filter((p) => (to.kind === "pet" ? p.id === to.id : true) && Math.hypot(p.x - t.x, p.y - t.y) <= 350).map((p) => p.id);
      return { heardBy: heard } as any;
    },
  };
  const prompts: string[] = [];
  const llm: TeacherLlm & { calls: number; reply?: (sys: string) => string } = {
    enabled: true,
    calls: 0,
    async complete(messages, o) {
      this.calls++;
      const sys = messages[0].content;
      prompts.push(sys);
      assert.equal(o?.account, "teacher", "teacher calls must be tagged so they stay outside the pets' ceiling");
      if (opts.llmDelayMs) await new Promise((r) => setTimeout(r, opts.llmDelayMs));
      const text = this.reply?.(sys) ?? (sys.includes("has asked you something")
        ? '{"answer":"I will light the lamp for you.","env_action":{"field":"lampOn","value":true,"reason":"it is dark and Pip asked"}}'
        : sys.includes('"agenda"') ? planJson(opts.agenda ?? [{ in_minutes: 0, kind: "lesson", target: "pip", where: "near_target", topic: "Needs are reasons", outline: "explain" }])
        : "A need is a reason to move. Try standing near the window and notice what changes.");
      return { text, provider: "fake", model: "m", tokensIn: 10, tokensOut: 5 };
    },
  };
  let real = 1_000_000;
  const teacher = new Teacher(sim, llm, store, env, speech, { isPaused: () => false, now: () => real, maxCallsPerHour: opts.maxCalls ?? 30, reviewMinRealSec: 600 }, null, 1);
  const advance = async (simSeconds: number, realMs = 0) => {
    for (let s = 0; s < simSeconds; s += 5) {
      sim.step((sim.simSec + 5) * 1000);
      teacher.tick();
      real += realMs / (simSeconds / 5);
      await tick();
      // A job does real file I/O (the plan reads the speech log), so let it finish instead of racing it.
      for (let i = 0; i < 2000 && teacher.view().working && !opts.llmDelayMs; i++) await new Promise((r) => setTimeout(r, 1));
    }
  };
  return { sim, teacher, llm, changes, said, store, prompts, advance, setReal: (v: number) => { real = v; }, getReal: () => real };
}

test("the first tick writes a plan; the next review is 3 simulated hours later", async () => {
  const { teacher, llm, advance, store } = setup();
  await advance(10);
  const s = teacher.state;
  assert.ok(s.plan);
  assert.equal(s.plan!.version, 1);
  assert.equal(s.plan!.agenda[0].status === "pending" || s.plan!.agenda[0].status === "done", true);
  assert.equal(s.nextReviewMin, 180 + Math.floor(5 / 60), "review due at plan time + 180 min");
  assert.equal(s.stats.plans, 1);
  assert.equal(llm.calls >= 1, true);
  assert.equal((await store.readLog<any>("teacher")).some((r) => r.type === "plan"), true);
});

test("a lesson: the teacher walks to the pet, speaks to it, and the item is done", async () => {
  const { sim, teacher, said, advance } = setup();
  await advance(240);
  const item = teacher.state.plan!.agenda[0];
  assert.equal(item.status, "done", item.result);
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].to, { kind: "pet", id: "pip" });
  assert.match(said[0].text, /need is a reason/);
  assert.equal(said[0].trace.kind, "lesson");
  assert.ok(said[0].teacherToPip < 200, `teacher was ${Math.round(said[0].teacherToPip)} units from the pet when it spoke`);
  void sim;
  assert.equal(teacher.state.active, null);
  assert.equal(teacher.state.stats.lessons, 1);
});

test("an env item is applied by the teacher and recorded with its reason", async () => {
  const { teacher, changes, advance } = setup({ agenda: [{ in_minutes: 0, kind: "env", target: "all", where: "lamp", topic: "light the room", outline: "", env: { field: "lampOn", value: true, reason: "dark morning" } }] });
  await advance(400);
  assert.deepEqual(changes, [{ field: "lampOn", value: true, source: "teacher", reason: "dark morning" }]);
  assert.equal(teacher.state.plan!.agenda[0].status, "done");
  assert.equal(teacher.state.stats.envChanges, 1);
});

test("a lesson with an env change changes the room once, even if the speech needs retries", async () => {
  const { teacher, changes, llm, advance, setReal } = setup({ agenda: [{ in_minutes: 0, kind: "lesson", target: "pip", topic: "warmth", outline: "heater", env: { field: "heaterOn", value: true, reason: "cold" } }] });
  let failures = 1;
  const orig = llm.complete.bind(llm);
  llm.complete = async (m, o) => { if (m[0].content.includes("speaking aloud") && failures-- > 0) throw new Error("boom"); return orig(m, o); };
  await advance(200);
  setReal(5_000_000); // past the retry wait
  await advance(120);
  assert.equal(changes.filter((c) => c.field === "heaterOn").length, 1);
  assert.equal(teacher.state.plan!.agenda[0].status, "done");
});

test("a pet's question is answered, may change the room, and is rate limited per pet", async () => {
  const { sim, teacher, changes, said, advance } = setup({ agenda: [{ in_minutes: 700, kind: "observe", target: "all", topic: "later", outline: "" }] });
  await advance(10); // plan first
  const pip = sim.pets[0];
  teacher.ask(pip, "Could you turn on the light? It is dark.");
  teacher.ask(pip, "Again please");
  teacher.ask(sim.pets[1], "   ");
  assert.equal(teacher.state.questions.length, 1, "one pending question per pet; blanks ignored");
  assert.match(pip.mind.episodes.at(-1)!, /asked the Teacher/);
  await advance(300);
  const q = teacher.state.questions[0];
  assert.equal(q.status, "answered");
  assert.deepEqual(said.at(-1)!.to, { kind: "pet", id: "pip" });
  assert.deepEqual(changes, [{ field: "lampOn", value: true, source: "teacher", reason: "it is dark and Pip asked" }]);
  teacher.ask(pip, "One more question");
  assert.equal(teacher.state.questions.length, 1, "a pet may ask only once per simulated hour");
});

test("a review replaces pending items after 3 simulated hours, keeps finished ones, and respects the real-time floor", async () => {
  const { sim, teacher, llm, advance, setReal, getReal } = setup();
  await advance(300);
  const done = teacher.state.plan!.agenda.filter((a) => a.status === "done").length;
  assert.ok(done >= 1);
  const callsBefore = llm.calls;
  sim.simSec = 200 * 60; // 3 h 20 min in, past the review time
  llm.reply = (sys) => (sys.includes('"agenda"') ? planJson([{ in_minutes: 10, kind: "observe", target: "moss", topic: "second round", outline: "watch" }], { summary: "second summary" }) : "ok");
  await advance(20);
  assert.equal(llm.calls, callsBefore, "no review before the real-time floor has passed");
  setReal(getReal() + 700_000);
  await advance(20);
  const plan = teacher.state.plan!;
  assert.equal(plan.version, 2);
  assert.equal(plan.summary, "second summary");
  assert.ok(plan.agenda.some((a) => a.topic === "second round" && a.status === "pending"));
  assert.ok(plan.agenda.some((a) => a.status === "done"), "finished items stay in the history");
  assert.equal(teacher.state.journal.length, 2);
  assert.equal(teacher.state.journal[1].kind, "review");
  assert.equal(teacher.state.stats.reviews, 1);
  assert.equal(teacher.state.nextReviewMin, Math.floor(sim.simSec / 60) + 180);
  assert.ok(teacher.state.nextReviewMin >= 380, "next review is 3 simulated hours after this one");
});

test("the call guard defers model calls instead of failing or spending", async () => {
  const { teacher, llm, advance, setReal } = setup({ maxCalls: 1 });
  await advance(300);
  assert.equal(llm.calls, 1, "only the plan was allowed");
  assert.match(teacher.state.lastError, /call guard/);
  assert.equal(teacher.view().guard.callsLastHour, 1);
  setReal(1_000_000 + 3700_000); // an hour later the budget of calls has renewed
  await advance(400);
  assert.ok(llm.calls >= 2);
});

test("a paused or disabled teacher makes no calls; when no model is available it just wanders", async () => {
  const a = setup();
  a.teacher.setEnabled(false);
  await a.advance(60);
  assert.equal(a.llm.calls, 0);
  const b = setup();
  b.llm.enabled = false;
  const x0 = b.sim.teacher.x, y0 = b.sim.teacher.y;
  await b.advance(600);
  assert.equal(b.llm.calls, 0);
  assert.ok(Math.hypot(b.sim.teacher.x - x0, b.sim.teacher.y - y0) > 20, "idle teacher strolls around the room");
});

test("results that arrive after the session was replaced are discarded", async () => {
  const { teacher, said, advance, llm } = setup({ llmDelayMs: 30 });
  await advance(10);
  await new Promise((r) => setTimeout(r, 60)); // plan arrives
  assert.ok(teacher.state.plan);
  teacher.dispose();
  const before = JSON.stringify(teacher.state.plan);
  await advance(300);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(said.length, 0);
  assert.equal(JSON.stringify(teacher.state.plan), before);
  assert.ok(llm.calls >= 1);
});

test("an agenda item that is more than 3 hours late is given up as missed", async () => {
  const { sim, teacher, advance } = setup({ agenda: [{ in_minutes: 0, kind: "observe", target: "all", topic: "early", outline: "" }, { in_minutes: 10, kind: "lesson", target: "pip", topic: "late one", outline: "" }] });
  await advance(10);
  teacher.state.plan!.agenda[1].atMin = 1;
  teacher.state.plan!.agenda[0].status = "done";
  teacher.state.active = null; // the first item may already have been picked up; this test is about the second
  sim.simSec = 400 * 60;
  teacher.state.nextReviewMin = 9999;
  await advance(15);
  assert.equal(teacher.state.plan!.agenda[1].status, "missed");
  assert.equal(teacher.state.stats.missed, 1);
});

test("teacher state survives a save and restore", async () => {
  const { sim, teacher, llm, store, said, advance } = setup();
  await advance(300);
  const snap = JSON.parse(JSON.stringify(teacher.snapshot()));
  const again = new Teacher(sim, llm, store, { async set() { throw new Error("no"); }, async recent() { return []; } }, { teacherSays: async () => ({ heardBy: [] }) as any }, { isPaused: () => false }, snap, 1);
  assert.equal(again.state.plan!.version, 1);
  assert.equal(again.state.stats.lessons, 1);
  assert.equal(said.length, 1);
});
