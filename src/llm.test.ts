import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmGateway, LlmUnavailable, type ProviderConfig } from "./llm.js";
import { applyThought, parseThought } from "./system2.js";
import { spawnPet } from "./pet.js";

const cfg = (name: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  name, baseUrl: `https://${name}.test/v1`, apiKey: "k", model: `${name}-m`, priceInPerM: 0, priceOutPerM: 0, rpm: 100, ...extra,
});
const ok = (text: string, pt = 100, ct = 50) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: pt, completion_tokens: ct } }), { status: 200 });
const msgs = [{ role: "user" as const, content: "hi" }];

test("uses groq first and records usage", async () => {
  const urls: string[] = [];
  const g = new LlmGateway([cfg("groq"), cfg("deepseek")], { fetchFn: async (u) => { urls.push(String(u)); return ok("hello"); } });
  const r = await g.complete(msgs);
  assert.equal(r.provider, "groq");
  assert.equal(urls.length, 1);
  assert.equal(g.snapshot()[0].tokensIn, 100);
});

test("429 falls back to deepseek and groq cools down for retry-after", async () => {
  let t = 1000;
  const calls: string[] = [];
  const g = new LlmGateway([cfg("groq"), cfg("deepseek")], {
    now: () => t,
    fetchFn: async (u) => {
      calls.push(String(u));
      return String(u).includes("groq") ? new Response("", { status: 429, headers: { "retry-after": "3600" } }) : ok("from deepseek");
    },
  });
  assert.equal((await g.complete(msgs)).provider, "deepseek");
  calls.length = 0;
  assert.equal((await g.complete(msgs)).provider, "deepseek");
  assert.ok(calls.every((c) => c.includes("deepseek")), "groq must not be retried while cooling down");
  t += 3601_000;
  calls.length = 0;
  await g.complete(msgs);
  assert.ok(calls[0].includes("groq"), "groq is tried again after the cooldown");
});

test("deepseek stops at its budget", async () => {
  const g = new LlmGateway([cfg("deepseek", { priceInPerM: 1_000_000, priceOutPerM: 0, budgetUsd: 150 })], { fetchFn: async () => ok("x", 100, 0) });
  await g.complete(msgs); // spends $100
  await g.complete(msgs); // spends $200 total
  await assert.rejects(g.complete(msgs), LlmUnavailable);
});

test("empty completion counts as a failure and falls back", async () => {
  const g = new LlmGateway([cfg("groq"), cfg("deepseek")], { fetchFn: async (u) => (String(u).includes("groq") ? ok("  ") : ok("fine")) });
  assert.equal((await g.complete(msgs)).provider, "deepseek");
});

test("rejects when nothing is available", async () => {
  await assert.rejects(new LlmGateway([]).complete(msgs), LlmUnavailable);
});

test("parseThought extracts JSON from noisy replies and validates it", () => {
  const t = parseThought('Sure!\n```json\n{"question":"why dark?","thought":"It is dim here.","beliefs":[{"text":"The window is bright by day","confidence":1.7}],"intention":null,"drop_intention":false,"suggestion":"seek_light"}\n```');
  assert.ok(t);
  assert.equal(t!.beliefs[0].confidence, 1);
  assert.equal(t!.suggestion, "seek_light");
  assert.equal(parseThought("no json here"), null);
  assert.equal(parseThought('{"thought":""}'), null);
  assert.equal(parseThought('{"thought":"x","suggestion":"fly"}')!.suggestion, "none");
});

test("applyThought merges beliefs, sets intention and a time-limited suggestion", () => {
  const p = spawnPet({ id: "a", name: "A", color: "#ff0000", traits: { curiosity: 0.5, social: 0.5, caution: 0.5, patience: 0.5 } }, 1, 0);
  const base = { question: "q", thought: "t", beliefs: [{ text: "Window is bright", confidence: 0.4 }], intention: "find the sun", dropIntention: false, suggestion: "find_pet" as const };
  applyThought(p, base, 100);
  applyThought(p, { ...base, beliefs: [{ text: "window is bright!", confidence: 0.8 }], intention: null }, 200);
  assert.equal(p.mind.beliefs.length, 1);
  assert.equal(p.mind.beliefs[0].confidence, 0.6);
  assert.equal(p.mind.intention?.goal, "find the sun");
  assert.equal(p.mind.suggestion?.untilSec, 800);
  applyThought(p, { ...base, intention: null, dropIntention: true, suggestion: "none" }, 300);
  assert.equal(p.mind.intention, null);
  assert.equal(p.mind.suggestion, null);
});

import { cleanKey, gatewayFromEnv } from "./llm.js";

test("cleanKey strips whitespace, quotes and a Bearer prefix", () => {
  assert.equal(cleanKey('  "gsk_abc"\n'), "gsk_abc");
  assert.equal(cleanKey("Bearer gsk_abc"), "gsk_abc");
  assert.equal(cleanKey(undefined), "");
  assert.ok(gatewayFromEnv({ GROQ_API_KEY: "  \n" } as any).enabled === false);
});

test("a 401 backs the provider off for 10 minutes", async () => {
  let t = 0;
  const g = new LlmGateway([cfg("groq"), cfg("deepseek")], {
    now: () => t,
    fetchFn: async (u) => (String(u).includes("groq") ? new Response('{"error":"Invalid API Key"}', { status: 401 }) : ok("ok")),
  });
  assert.equal((await g.complete(msgs)).provider, "deepseek");
  assert.ok(g.snapshot()[0].cooldownUntil >= 600_000);
  assert.match(g.snapshot()[0].lastError, /401/);
});

test("ping reports success and failure for one provider", async () => {
  const g = new LlmGateway([cfg("groq"), cfg("deepseek")], {
    fetchFn: async (u) => (String(u).includes("deepseek") ? new Response('{"error":"Invalid API Key"}', { status: 401 }) : ok("ok")),
  });
  assert.equal((await g.ping("groq")).ok, true);
  const bad = await g.ping("deepseek");
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /401/);
  assert.equal((await g.ping("nope")).ok, false);
});

test("teacher calls bypass the pets' budget ceiling and are accounted separately", async () => {
  const g = new LlmGateway([cfg("deepseek", { priceInPerM: 1_000_000, priceOutPerM: 0, budgetUsd: 150 })], { fetchFn: async () => ok("x", 100, 0) });
  await g.complete(msgs);
  await g.complete(msgs); // pets are now at $200, past the $150 ceiling
  await assert.rejects(g.complete(msgs), LlmUnavailable);
  const r = await g.complete(msgs, { account: "teacher" });
  assert.equal(r.provider, "deepseek");
  const s = g.snapshot()[0];
  assert.equal(s.spendUsd, 200, "teacher spend must not count toward the pets' ceiling");
  assert.equal(s.teacherSpendUsd, 100);
  assert.equal(s.teacherCalls, 1);
  assert.equal(s.budgetUsd, 150);
});

test("per-call provider order, json mode and timeout are honoured", async () => {
  const seen: { url: string; body: any }[] = [];
  const g = new LlmGateway([cfg("local"), cfg("deepseek")], { fetchFn: async (u, init) => { seen.push({ url: String(u), body: JSON.parse(String(init?.body)) }); return ok("{}"); } });
  const r = await g.complete(msgs, { providers: ["deepseek", "local"], json: true });
  assert.equal(r.provider, "deepseek");
  assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
  assert.equal((await g.complete(msgs)).provider, "local");
  assert.equal(seen[1].body.response_format, undefined);
});

test("spend counters restore with the teacher fields, and older files without them still load", () => {
  const g = new LlmGateway([cfg("deepseek")]);
  g.restore([{ name: "deepseek", model: "m", calls: 3, failures: 0, tokensIn: 1, tokensOut: 1, spendUsd: 0.5, cooldownUntil: 0, lastError: "", lastErrorAt: 0, lastRemaining: {} } as any]);
  assert.equal(g.snapshot()[0].spendUsd, 0.5);
  assert.equal(g.snapshot()[0].teacherSpendUsd, 0);
});

test("deepseek ceiling defaults to $1 and can be changed from the environment", async () => {
  const { gatewayFromEnv } = await import("./llm.js");
  const ceil = (env: Record<string, string>) => gatewayFromEnv({ DEEPSEEK_API_KEY: "k", ...env } as any).snapshot().find((p) => p.name === "deepseek")!.budgetUsd;
  assert.equal(ceil({}), 1);
  assert.equal(ceil({ DEEPSEEK_BUDGET_USD: "2.5" }), 2.5);
  const local = gatewayFromEnv({ LOCAL_LLM_MODEL: "qwen2.5:3b", DEEPSEEK_API_KEY: "k" } as any).snapshot();
  assert.deepEqual(local.map((p) => p.name), ["local", "deepseek"]);
});

test("a provider at its concurrency limit is skipped as busy, so calls fall through instead of queueing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek")], {
    fetchFn: async (u) => { if (String(u).includes("local")) await gate; return ok(String(u).includes("local") ? "slow local" : "from deepseek"); },
  });
  const first = g.complete(msgs); // occupies the only local slot
  assert.equal((await g.complete(msgs)).provider, "deepseek");
  release();
  assert.equal((await first).provider, "local");
  assert.equal((await g.complete(msgs)).provider, "local", "the slot is free again afterwards");
});

test("a slow background call can wait for a busy provider; an ordinary call falls through instead", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek")], {
    fetchFn: async (u) => { if (String(u).includes("local")) await gate; return ok(String(u).includes("local") ? "local reply" : "deepseek reply"); },
  });
  const first = g.complete(msgs); // holds the only local slot
  const waiting = g.complete(msgs, { providers: ["local"], waitMs: 5000 });
  await new Promise((r) => setTimeout(r, 1200));
  release();
  assert.equal((await first).provider, "local");
  assert.equal((await waiting).provider, "local", "waited for the slot instead of failing");
  const held = g.complete(msgs);
  await assert.rejects(g.complete(msgs, { providers: ["local"] }), LlmUnavailable, "without waitMs a busy provider fails at once");
  await held;
});

// A provider that answers only when told to, so tests control exactly who is being served and who is waiting.
function controlled() {
  const served: string[] = [];
  const gates: (() => void)[] = [];
  const fetchFn = async (u: any, init: any) => {
    const url = String(u);
    const who = JSON.parse(String(init?.body)).messages[0].content as string;
    if (url.includes("local")) {
      served.push(who);
      await new Promise<void>((r) => gates.push(r));
      return ok(`local:${who}`);
    }
    served.push(`cloud:${who}`);
    return ok(`cloud:${who}`);
  };
  const ask = (g: LlmGateway, who: string, opts: any = {}) => g.complete([{ role: "user", content: who }], opts);
  const finishOne = async () => { await new Promise((r) => setTimeout(r, 10)); gates.shift()?.(); await new Promise((r) => setTimeout(r, 10)); };
  return { served, ask, finishOne, fetchFn };
}

test("calls with patience wait their turn for the busy local model, first come first served", async () => {
  const c = controlled();
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek")], { fetchFn: c.fetchFn as any });
  const a = c.ask(g, "A", { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  const b = c.ask(g, "B", { patienceMs: 5000 });
  const cc = c.ask(g, "C", { patienceMs: 5000 });
  const d = c.ask(g, "D", { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.queued("local"), 3, "three are waiting in line");
  assert.deepEqual(c.served, ["A"], "only one is being served, and nobody went to the cloud");
  await c.finishOne();
  assert.deepEqual(c.served, ["A", "B"], "B was first in line");
  await c.finishOne();
  await c.finishOne();
  await c.finishOne();
  assert.deepEqual(c.served, ["A", "B", "C", "D"], "strict arrival order");
  for (const [p, who] of [[a, "A"], [b, "B"], [cc, "C"], [d, "D"]] as const) assert.equal((await p).text, `local:${who}`);
  assert.equal(g.queued("local"), 0);
});

test("someone who runs out of patience leaves the line and uses the next provider; the rest keep their places", async () => {
  const c = controlled();
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek")], { fetchFn: c.fetchFn as any });
  const a = c.ask(g, "A", { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  const impatient = c.ask(g, "impatient", { patienceMs: 60 });
  const patient = c.ask(g, "patient", { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await impatient).provider, "deepseek", "gave up waiting and went to the cloud");
  assert.equal(g.queued("local"), 1, "the patient one is still in line");
  await c.finishOne();
  await c.finishOne();
  assert.equal((await patient).text, "local:patient");
  assert.equal((await a).provider, "local");
});

test("without patience a busy local model is skipped at once, and patience only applies to the preferred provider", async () => {
  const c = controlled();
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek", { maxConcurrent: 1 })], { fetchFn: c.fetchFn as any });
  const a = c.ask(g, "A");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await c.ask(g, "no patience")).provider, "deepseek");
  assert.equal(g.queued("local"), 0);
  await c.finishOne();
  await a;
  // a provider listed second is never queued for, even with patience
  const g2 = new LlmGateway([cfg("deepseek"), cfg("local", { maxConcurrent: 1 })], { fetchFn: c.fetchFn as any });
  assert.equal((await c.ask(g2, "x", { patienceMs: 5000 })).provider, "deepseek");
});

test("a provider that starts cooling down while a caller waits for it is not used afterwards", async () => {
  let t = 1000;
  const c = controlled();
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek")], { now: () => t, fetchFn: c.fetchFn as any });
  const a = c.ask(g, "A", { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  const waiting = c.ask(g, "waiting", { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  (g as any).stats.get("local").cooldownUntil = t + 600_000; // e.g. the first call just failed and the provider is resting
  await c.finishOne();
  assert.equal((await waiting).provider, "deepseek");
  await a;
  assert.equal(g.queued("local"), 0);
  assert.equal((g as any).slotsOf("local").inflight, 0, "the place was handed back, not leaked");
});

test("a failing call still passes its place on, so the line never gets stuck", async () => {
  let n = 0;
  const g = new LlmGateway([cfg("local", { maxConcurrent: 1 }), cfg("deepseek")], {
    fetchFn: (async (u: any) => { if (String(u).includes("local") && n++ === 0) { await new Promise((r) => setTimeout(r, 30)); return new Response("", { status: 500 }); } return ok(String(u).includes("local") ? "local ok" : "cloud ok"); }) as any,
  });
  const first = g.complete(msgs, { patienceMs: 5000 });
  await new Promise((r) => setTimeout(r, 5));
  const second = g.complete(msgs, { patienceMs: 5000 });
  assert.equal((await first).provider, "deepseek", "the local call failed, so it fell through");
  assert.equal((await second).provider, "deepseek", "and the second one, who was waiting, found local cooling down and did the same");
  assert.equal((g as any).slotsOf("local").inflight, 0);
  assert.equal(g.queued("local"), 0);
});

test("belief text loses a copied confidence however it is written, and old beliefs are cleaned and merged", async () => {
  const { cleanBelief, cleanBeliefs } = await import("./system2.js");
  assert.equal(cleanBelief("Tone is fading (0.98)"), "Tone is fading");
  assert.equal(cleanBelief("Tone is fading (0.98) (0.98)"), "Tone is fading");
  assert.equal(cleanBelief("The pad charges me [how sure: 0.9]"), "The pad charges me", "the exact form the notes show");
  assert.equal(cleanBelief("The steady tone at 534 Hz indicates my battery needs attention [how sure: 0.80]"), "The steady tone at 534 Hz indicates my battery needs attention");
  assert.equal(cleanBelief("It is loud (how sure 0.7) [how sure: 0.7]"), "It is loud");
  assert.equal(cleanBelief("Low light hides hazards (confidence 0.95)"), "Low light hides hazards");
  assert.equal(cleanBelief("I am sure about this (98%)"), "I am sure about this");
  assert.equal(cleanBelief("Watch for movement (1.00)"), "Watch for movement");
  assert.equal(cleanBelief("The hum is at 534 Hz (steady)"), "The hum is at 534 Hz (steady)", "real parentheses stay");
  assert.equal(cleanBelief("I have 3 friends (3 pets)"), "I have 3 friends (3 pets)");
  const mind: any = { beliefs: [{ text: "Tone is fading (0.98)", confidence: 0.98, updatedSec: 5 }, { text: "Tone is fading", confidence: 0.6, updatedSec: 9 }, { text: " (0.5)", confidence: 0.5, updatedSec: 1 }] };
  cleanBeliefs(mind);
  assert.deepEqual(mind.beliefs.map((b: any) => [b.text, b.confidence, b.updatedSec]), [["Tone is fading", 0.98, 9]]);
});

test("a thought can retract wrong beliefs; repeated questions are counted and shown back to the pet", async () => {
  const { applyThought: apply, buildNotes, parseThought: parse } = await import("./system2.js");
  const p = spawnPet({ id: "a", name: "A", color: "#ff0000", traits: { curiosity: 0.5, social: 0.5, caution: 0.5, patience: 0.5 } }, 1, 0);
  p.mind.beliefs = [{ text: "Faint tones mean my battery is failing", confidence: 0.7, updatedSec: 0 }, { text: "The pad fills my battery", confidence: 0.8, updatedSec: 0 }];
  const t = parse(JSON.stringify({ thought: "I was wrong about that.", question: "What is new?", beliefs: [{ text: "A quieter tone means I am further away (0.9)", confidence: 0.9 }], retract: ["faint tones mean my battery is failing!"], suggestion: "none" }))!;
  assert.deepEqual(t.retract, ["faint tones mean my battery is failing!"]);
  assert.equal(t.beliefs[0].text, "A quieter tone means I am further away", "the copied number is gone");
  apply(p, t, 100);
  assert.deepEqual(p.mind.beliefs.map((b) => b.text), ["The pad fills my battery", "A quieter tone means I am further away"]);
  const ask = (q: string) => apply(p, { question: q, thought: "t", beliefs: [], intention: null, dropIntention: false, suggestion: "none", say: null, askTeacher: null, retract: [] }, 200);
  ask("Should I follow the tone?"); ask("should I follow the tone?"); ask("Should I follow the tone?!");
  assert.equal(p.mind.repeatStreak, 2);
  assert.deepEqual(p.mind.recentQuestions, ["What is new?", "Should I follow the tone?!"], "recent questions are kept once each, newest last");
  const notes = buildNotes(p, 1, 600, 0, 600);
  assert.match(notes, /Questions you asked yourself lately \(ask something NEW this time, not one of these\): "What is new\?" \| "Should I follow the tone\?!"/);
  assert.match(notes, /asked the same thing several times in a row/);
  assert.match(notes, /\[how sure: 0\.80\]/, "confidence is shown in a form that is hard to copy into belief text");
  ask("Something completely different");
  assert.equal(p.mind.repeatStreak, 0);
  assert.doesNotMatch(buildNotes(p, 1, 600, 0, 600), /several times in a row/);
  assert.equal(p.mind.recentThoughts.length, 3);
});

test("the deep review shows the pet its last thoughts and asks it to correct them", async () => {
  const { buildPrompt } = await import("./system2.js");
  const p = spawnPet({ id: "a", name: "A", color: "#ff0000", traits: { curiosity: 0.5, social: 0.5, caution: 0.5, patience: 0.5 } }, 1, 0);
  p.mind.recentThoughts = ["The fainting tone means trouble.", "Maybe the pad is failing."];
  const normal = buildPrompt(p, 1, 600, 0, 600);
  const deep = buildPrompt(p, 1, 600, 0, 600, true);
  assert.doesNotMatch(normal.user, /Your last few thoughts/);
  assert.match(deep.user, /Your last few thoughts \(review them\):\n- The fainting tone means trouble\.\n- Maybe the pad is failing\./);
  assert.match(deep.system, /rare, careful review[\s\S]*"retract"/);
  assert.match(normal.system, /"retract": \[string\]/, "any thought may retract a belief");
  assert.match(normal.system, /never copy numbers or "how sure" values/);
});

test("every Nth slow thought is a deep review by a stronger model, and falls back to the ordinary route when none is available", async () => {
  const { System2 } = await import("./system2.js");
  const { Simulation } = await import("./sim.js");
  const { World } = await import("./world.js");
  const { Store } = await import("./store.js");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const roster = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
  const sim = new Simulation(new World(1), 1, roster);
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "deep-")), "t");
  const calls: any[] = [];
  let deepAvailable = true;
  const llm: any = {
    enabled: true,
    async complete(messages: any[], opts: any) {
      calls.push({ deep: /rare, careful review/.test(messages[0].content), opts });
      if (opts.providers?.[0] === "deepseek" && !deepAvailable) throw new LlmUnavailable("deepseek: budget reached");
      return { text: JSON.stringify({ thought: "A thought.", question: "q" + calls.length, beliefs: [], suggestion: "none" }), provider: "x", model: "m", tokensIn: 1, tokensOut: 1 };
    },
  };
  const s2 = new System2(sim, llm, store, { intervalSec: 1, deepEvery: 4, isPaused: () => false });
  const pip = sim.pets[0];
  for (let i = 0; i < 8; i++) await s2.think(pip);
  const kinds = calls.map((c) => (c.deep ? "deep" : "normal"));
  assert.deepEqual(kinds, ["normal", "normal", "normal", "deep", "normal", "normal", "normal", "deep"], "every 4th thought");
  assert.deepEqual(calls[3].opts.providers, ["deepseek", "groq"]);
  assert.equal(calls[3].opts.patienceMs, undefined, "the stronger model is not queued for");
  assert.equal(calls[0].opts.temperature, 0.8);
  assert.ok(calls[0].opts.patienceMs > 0, "ordinary thoughts wait in line for the local model");
  const log = await store.readLog<any>(`thoughts/${pip.id}`);
  assert.deepEqual(log.map((t) => t.deep), [false, false, false, true, false, false, false, true]);
  // no stronger model available: the thought is still had, the ordinary way
  deepAvailable = false;
  calls.length = 0;
  for (let i = 0; i < 4; i++) await s2.think(pip);
  assert.equal(pip.stats.s2Thoughts, 12, "no thought was lost");
  assert.equal(calls.filter((c) => c.deep).length, 1, "the deep attempt was made once");
  assert.equal(calls.filter((c) => !c.deep).length, 4, "and the ordinary call followed it");
  const last = (await store.readLog<any>(`thoughts/${pip.id}`)).at(-1);
  assert.equal(last.deep, false, "recorded as an ordinary thought");
  // switched off
  const off = new System2(sim, llm, store, { intervalSec: 1, deepEvery: 0, isPaused: () => false });
  calls.length = 0;
  for (let i = 0; i < 8; i++) await off.think(pip);
  assert.ok(calls.every((c) => !c.deep));
});

test("the local model gets a mild presence penalty against repeating itself, and it can be turned off", () => {
  const body = (env: Record<string, string>) => (gatewayFromEnv({ LOCAL_LLM_MODEL: "m", ...env } as any) as any).providers.find((p: any) => p.name === "local").extraBody;
  assert.deepEqual(body({}), { presence_penalty: 0.4 });
  assert.deepEqual(body({ LOCAL_LLM_PRESENCE_PENALTY: "0.7" }), { presence_penalty: 0.7 });
  assert.equal(body({ LOCAL_LLM_PRESENCE_PENALTY: "0" }), undefined);
});
