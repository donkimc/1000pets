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
