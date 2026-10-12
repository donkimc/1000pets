import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmGateway, type CallRecord } from "./llm.js";
import { UsageLedger } from "./usage.js";

const rec = (over: Partial<CallRecord> = {}): CallRecord => ({ at: 1_000_000, kind: "thought", pet: "pip", provider: "deepseek", model: "m", ok: true, teacher: false, tokensIn: 1000, tokensOut: 100, cachedIn: 0, costUsd: 0.0004, ms: 500, ...over });

test("the ledger rolls calls up by kind, pet, provider and simulated day", () => {
  const l = new UsageLedger();
  l.add(rec(), 1); l.add(rec({ pet: "moss" }), 1); l.add(rec({ kind: "reply", tokensIn: 400, tokensOut: 40 }), 2);
  l.add(rec({ ok: false, tokensIn: 0, tokensOut: 0, costUsd: 0, error: "429" }), 2);
  const v = l.view(1_000_000);
  assert.equal(v.total.calls, 3);
  assert.equal(v.total.fails, 1, "a failed attempt is counted, but costs nothing");
  assert.equal(v.byKind[0].kind, "thought");
  assert.equal(v.byKind[0].calls, 2);
  assert.ok(Math.abs(v.byKind.reduce((n, k) => n + k.share, 0) - 1) < 1e-9, "shares add up to the whole");
  assert.deepEqual(v.byPet.map((p) => [p.pet, p.calls]).sort(), [["moss", 1], ["pip", 2]]);
  assert.deepEqual(v.perDay.map((d) => [d.day, d.tokens, d.calls]), [[1, 2200, 2], [2, 440, 1]]);
  assert.equal(v.byProvider[0].provider, "deepseek");
  assert.deepEqual([v.recent[0].ok, v.recent[1].kind], [false, "reply"], "newest first");
});

test("the last hour's pace gives a projection, and how long the budget lasts at it", () => {
  const l = new UsageLedger();
  const now = 10 * 3_600_000;
  for (let i = 0; i < 60; i++) l.add(rec({ at: now - 3_600_000 + 60_000 * i + 30_000, costUsd: 0.001 }), 1); // 60 calls an hour
  l.add(rec({ at: now - 10_000, teacher: true, kind: "teacher-review", pet: undefined, costUsd: 0.5 }), 1); // the Teacher is not the pets' budget
  l.add(rec({ at: now - 7_200_000 }), 1); // older than an hour: not in the pace
  const v = l.view(now, { budgetUsd: 1, spentUsd: 0.4 });
  assert.equal(v.lastHour.calls, 61);
  assert.ok(Math.abs(v.lastHour.costUsd - 0.56) < 1e-6);
  assert.ok(v.projection.hoursLeft! > 9 && v.projection.hoursLeft! < 11, `0.6 left at 0.06 an hour is about 10 hours (${v.projection.hoursLeft})`);
  assert.ok(v.projection.tokensPerDay > 1_000_000);
  assert.equal(v.projection.ready, true);
  assert.equal(new UsageLedger().view(now, { budgetUsd: 1, spentUsd: 0 }).projection.hoursLeft, null, "no calls, no pace");
  const few = new UsageLedger();
  few.add(rec({ at: now - 1000 }), 1); few.add(rec({ at: now - 500 }), 1);
  const early = few.view(now, { budgetUsd: 1, spentUsd: 0 });
  assert.deepEqual([early.projection.ready, early.projection.hoursLeft], [false, null], "two calls are not a pace");
});

test("a ledger survives being saved and loaded, and a bad file starts it empty", () => {
  const l = new UsageLedger();
  l.add(rec(), 3);
  const back = UsageLedger.from(JSON.parse(JSON.stringify(l.data)));
  assert.equal(back.view(1_000_000).total.calls, 1);
  assert.equal(UsageLedger.from({ nope: 1 } as any).view(0).total.calls, 0);
  assert.equal(UsageLedger.from(null).view(0).total.calls, 0);
});

test("the gateway reports every attempt with what it was for, its tokens, cached tokens, cost and time", async () => {
  const seen: CallRecord[] = [];
  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let n = 0;
  const g = new LlmGateway(
    [{ name: "a", baseUrl: "http://x", apiKey: "k", model: "ma", priceInPerM: 1, priceOutPerM: 2, rpm: 100 }, { name: "b", baseUrl: "http://y", apiKey: "k", model: "mb", priceInPerM: 0.5, priceOutPerM: 1, rpm: 100 }],
    { fetchFn: ((url: string) => (n++ === 0 ? reply({ error: "no" }, 500)() : reply({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 2000, completion_tokens: 100, prompt_cache_hit_tokens: 1500 } })())) as any },
  );
  g.onCall = (r) => seen.push(r);
  const r = await g.complete([{ role: "user", content: "hi" }], { tag: { kind: "thought", pet: "pip" } });
  assert.equal(r.cachedIn, 1500);
  assert.ok(Math.abs(r.costUsd! - (2000 * 0.5 + 100 * 1) / 1e6) < 1e-12);
  assert.equal(seen.length, 2, "the failed attempt at the first provider and the one that worked");
  assert.deepEqual([seen[0].provider, seen[0].ok, seen[0].kind, seen[0].pet], ["a", false, "thought", "pip"]);
  assert.deepEqual([seen[1].provider, seen[1].ok, seen[1].tokensIn, seen[1].cachedIn], ["b", true, 2000, 1500]);
  assert.ok(seen[1].ms >= 0);
  const untagged = new LlmGateway([{ name: "a", baseUrl: "http://x", apiKey: "k", model: "ma", priceInPerM: 0, priceOutPerM: 0, rpm: 100 }], { fetchFn: reply({ choices: [{ message: { content: "ok" } }], usage: {} }) as any });
  untagged.onCall = (x) => seen.push(x);
  await untagged.complete([{ role: "user", content: "hi" }]);
  assert.equal(seen[2].kind, "other");
  untagged.onCall = () => { throw new Error("a broken listener"); };
  assert.equal((await untagged.complete([{ role: "user", content: "hi" }])).text, "ok", "a listener that throws never breaks a call");
});

import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { System2 } from "./system2.js";
import { Conversation } from "./conversation.js";
import type { CompleteOpts, ChatMessage, LlmResult } from "./llm.js";
import type { PetDef } from "./pet.js";
import type { Store } from "./store.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const nostore = { append: async () => {}, readLog: async () => [], readJson: async () => null, writeJson: async () => {}, dir: "" } as unknown as Store;
class Capture extends LlmGateway {
  tags: (CompleteOpts["tag"])[] = [];
  constructor(private text: string) { super([{ name: "x", baseUrl: "", apiKey: "", model: "m", priceInPerM: 0, priceOutPerM: 0, rpm: 99 }]); }
  override async complete(_m: ChatMessage[], opts: CompleteOpts = {}): Promise<LlmResult> { this.tags.push(opts.tag); return { text: this.text, provider: "x", model: "m", tokensIn: 1, tokensOut: 1 }; }
}

test("slow thoughts, deep thoughts and replies say what they are for and which pet", async () => {
  const sim = new Simulation(new World(1), 1, roster);
  const thought = JSON.stringify({ question: "q", thought: "t", beliefs: [], intention: null, suggestion: "none", say: null, ask_teacher: null });
  const llm = new Capture(thought);
  const s2 = new System2(sim, llm, nostore, { intervalSec: 70, deepEvery: 2, isPaused: () => false });
  await s2.think(sim.pets[0]); // the first of every 2 is ordinary
  sim.pets[0].stats.s2Thoughts = 1;
  await s2.think(sim.pets[0]); // and the second is deep
  assert.deepEqual(llm.tags, [{ kind: "thought", pet: "pip" }, { kind: "deep", pet: "pip" }]);

  const talk = new Capture(JSON.stringify({ understood: { intent: "chat", topic: "x" }, claims: [], reply: "hi there" }));
  const conv = new Conversation(sim, talk as any, nostore, () => {});
  const pip = sim.pets[0], moss = sim.pets[1];
  pip.x = 500; pip.y = 300; moss.x = 560; moss.y = 300; pip.mode = "idle"; moss.mode = "idle";
  await conv.respond(pip, { kind: "human", id: "human", name: "Human", x: 520, y: 300 }, "hello", { kind: "pet", id: "pip" }, "u1");
  assert.deepEqual(talk.tags[0], { kind: "reply", pet: "pip" });
});

import { LlmUnavailable, gatewayFromEnv } from "./llm.js";

test("a provider with a daily limit refuses the pets once it has spent that today, starts again the next UTC day, and never limits the Teacher", async () => {
  let now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const ok = async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1000, completion_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  const g = new LlmGateway([{ name: "p", baseUrl: "http://x", apiKey: "k", model: "m", priceInPerM: 6, priceOutPerM: 0, rpm: 100, budgetUsd: 100, dailyBudgetUsd: 0.01 }], { fetchFn: ok as any, now: () => now }); // each call costs 0.006
  await g.complete([{ role: "user", content: "a" }]);
  await g.complete([{ role: "user", content: "b" }]); // 0.012 spent: over
  await assert.rejects(g.complete([{ role: "user", content: "c" }]), (e: any) => e instanceof LlmUnavailable && /daily budget reached/.test(e.message));
  await g.complete([{ role: "user", content: "teacher" }], { account: "teacher" }); // the Teacher is not held to it
  assert.ok(Math.abs(g.snapshot()[0].daySpendUsd! - 0.012) < 1e-9, "the Teacher's call is not counted against the pets' day");
  now += 24 * 3600_000; // tomorrow
  await g.complete([{ role: "user", content: "d" }]);
  assert.ok(Math.abs(g.snapshot()[0].daySpendUsd! - 0.006) < 1e-9, "a new day starts from zero");
  assert.ok(Math.abs(g.snapshot()[0].spendUsd - 0.018) < 1e-9, "the overall total keeps counting");
  const saved = JSON.parse(JSON.stringify(g.snapshot()));
  const again = new LlmGateway([{ name: "p", baseUrl: "http://x", apiKey: "k", model: "m", priceInPerM: 6, priceOutPerM: 0, rpm: 100, dailyBudgetUsd: 0.01 }], { fetchFn: ok as any, now: () => now });
  again.restore(saved);
  assert.ok(Math.abs(again.snapshot()[0].daySpendUsd! - 0.006) < 1e-9, "today's spend survives a restart, so a restart cannot reset the limit");
  await again.complete([{ role: "user", content: "e" }]);
  await assert.rejects(again.complete([{ role: "user", content: "f" }]), /daily budget reached/);
});

test("a hosted copy gets a daily limit by default, your own machine does not, and DEEPSEEK_DAILY_BUDGET_USD decides either way", () => {
  const ds = (env: Record<string, string>) => gatewayFromEnv({ DEEPSEEK_API_KEY: "k", ...env } as any).snapshot().find((p) => p.name === "deepseek")!;
  assert.equal(ds({ RAILWAY_ENVIRONMENT_NAME: "production" }).dailyBudgetUsd, 0.25);
  assert.equal(ds({}).dailyBudgetUsd, undefined);
  assert.equal(ds({ RAILWAY_ENVIRONMENT_NAME: "production", DEEPSEEK_DAILY_BUDGET_USD: "0" }).dailyBudgetUsd, undefined, "0 switches it off");
  assert.equal(ds({ DEEPSEEK_DAILY_BUDGET_USD: "0.1" }).dailyBudgetUsd, 0.1);
});

test("routine thoughts can be limited to certain providers, so a busy local model means a skipped thought, not a paid one", async () => {
  const sim = new Simulation(new World(1), 1, roster);
  const seen: (string[] | undefined)[] = [];
  class Spy extends LlmGateway {
    constructor() { super([{ name: "x", baseUrl: "", apiKey: "", model: "m", priceInPerM: 0, priceOutPerM: 0, rpm: 99 }]); }
    override async complete(_m: ChatMessage[], o: CompleteOpts = {}): Promise<LlmResult> {
      seen.push(o.providers);
      return { text: JSON.stringify({ question: "q", thought: "t", beliefs: [], intention: null, suggestion: "none", say: null, ask_teacher: null }), provider: "x", model: "m", tokensIn: 1, tokensOut: 1 };
    }
  }
  const s2 = new System2(sim, new Spy(), nostore, { intervalSec: 70, deepEvery: 2, isPaused: () => false, routineProviders: ["local"] });
  await s2.think(sim.pets[0]); // ordinary
  sim.pets[0].stats.s2Thoughts = 1;
  await s2.think(sim.pets[0]); // deep
  assert.deepEqual(seen[0], ["local"]);
  assert.deepEqual(seen[1], ["deepseek", "groq"], "a deep review still goes to the stronger models");
  const open = new System2(sim, new Spy(), nostore, { intervalSec: 70, deepEvery: 0, isPaused: () => false });
  seen.length = 0;
  await open.think(sim.pets[0]);
  assert.equal(seen[0], undefined, "with no limit it uses whatever is available, as before");
});
