// What would the models cost? Runs the simulation with the REAL thinking, speech, Teacher, sleep and dream code and
// the real prompts, but a stub in place of the model that answers with canned replies and counts tokens. So it
// spends nothing, and the same seeds can be run before and after a change meant to save tokens.
//
//   npx tsx scripts/cost-bench.ts [--days 2] [--speed 1] [--seed 1] [--layout house] [--json out.json]
//
// Tokens are estimated as characters / 4 (a real tokenizer differs a little), priced at DeepSeek's list price.
// Time is virtual: a thought is due every S2_INTERVAL_SEC of *real* time at the chosen speed, so "--speed 1" means the
// hosted site left running at normal speed, and a day of it costs what this prints for one simulated day.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LlmGateway, type ChatMessage, type CompleteOpts, type LlmResult } from "../src/llm.js";
import { Simulation, DT } from "../src/sim.js";
import { World } from "../src/world.js";
import { LAYOUTS } from "../src/layout.js";
import type { Store } from "../src/store.js";
import { System2, situation } from "../src/system2.js";
import { Conversation } from "../src/conversation.js";
import { Teacher } from "../src/teacher.js";
import { Consolidator } from "../src/sleep.js";
import { Dreamer } from "../src/dreams.js";
import { UsageLedger } from "../src/usage.js";
import type { PetDef } from "../src/pet.js";

const arg = (name: string, d: string) => { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = Number(arg("days", "2")), SPEED = Number(arg("speed", "1")), SEED = Number(arg("seed", "1")), LAYOUT = arg("layout", "house");
const PRICE_IN = 0.27, PRICE_OUT = 1.1; // USD per million tokens (DeepSeek, cache miss)
const PRICE_HIT = 0.07; // ... and for input served from its prompt cache (the start of a prompt it has seen lately)
const INTERVAL = Number(process.env.S2_INTERVAL_SEC ?? 70);

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const est = (s: string) => Math.ceil(s.length / 4);

/** Stands in for the model: a valid reply for each kind of call, and the tokens a real one would have used. */
class BenchLlm extends LlmGateway {
  private n = new Map<string, number>();
  private lastPrompt = new Map<string, string>();
  noCache = 0; // what everything would have cost with no prompt caching at all
  thoughtAt: Record<string, number[]> = {}; // sim seconds at which each pet's thoughts were asked for
  constructor(private ledger: UsageLedger, private day: () => number, private simNow: () => number = () => 0) {
    super([{ name: "bench", baseUrl: "", apiKey: "", model: "bench", priceInPerM: PRICE_IN, priceOutPerM: PRICE_OUT, rpm: 1e9 }]);
  }
  private count(key: string) { const v = (this.n.get(key) ?? 0) + 1; this.n.set(key, v); return v; }

  private reply(kind: string, pet?: string): string {
    const k = this.count(kind + ":" + (pet ?? ""));
    switch (kind) {
      case "thought": case "deep":
        return JSON.stringify({
          question: `What is different about ${["the light", "the hum", "the door", "my battery", "the others"][k % 5]} now? (${k})`, thought: "I notice something and want to look at it again soon.",
          beliefs: [], intention: null, drop_intention: false, suggestion: "none",
          say: k % 6 === 0 ? { to: "nearest", meaning: "I am curious about the hum" } : null, ask_teacher: k % 9 === 0 ? "How does the hum lead to the pad?" : null,
        });
      case "speech": return "I wonder what that humming is.";
      case "reply": return JSON.stringify({ understood: { intent: "chat", topic: "hello" }, claims: [], reply: "Hello, I am here." });
      case "dream": return "I dreamed of a long hall and a humming pad that kept moving away.";
      case "gist": return JSON.stringify({ gists: [] });
      case "teacher-plan": case "teacher-review":
        return JSON.stringify({
          summary: "The pets are settling in.", long_term: [{ goal: "Keep everyone charged", why: "A flat battery stops a pet", progress: "so far so good", focus: Object.fromEntries(roster.map((r) => [r.id, "stay curious"])) }],
          pet_notes: {}, agenda: [
            { in_minutes: 5, kind: "lesson", target: "all", where: "center", topic: "Where the pad is", outline: "Say the hum leads to a pad", env: null },
            { in_minutes: 40, kind: "observe", target: "all", where: "center", topic: "Watch how they cope", outline: "Look quietly", env: null },
            { in_minutes: 80, kind: "lesson", target: roster[0].id, where: "near_target", topic: "Doors", outline: "Doors can be pushed open", env: null },
            { in_minutes: 140, kind: "lesson", target: "all", where: "center", topic: "Light and warmth", outline: "The window gives light", env: null },
            { in_minutes: 200, kind: "observe", target: "all", where: "center", topic: "Rest", outline: "Watch who sleeps", env: null },
            { in_minutes: 300, kind: "lesson", target: roster[1].id, where: "near_target", topic: "Friends", outline: "Others can help", env: null },
          ],
        });
      case "teacher-lesson": return "Listen to the hum and walk toward where it gets louder. It leads to a pad where your battery fills.";
      case "teacher-answer": return JSON.stringify({ answer: "Walk toward the hum and see whether it gets louder as you go.", env_action: null });
      default: return "ok";
    }
  }

  override async complete(messages: ChatMessage[], opts: CompleteOpts = {}): Promise<LlmResult> {
    const kind = opts.tag?.kind ?? "other";
    if ((kind === "thought" || kind === "deep") && opts.tag?.pet) (this.thoughtAt[opts.tag.pet] ??= []).push(this.simNow());
    const text = this.reply(kind, opts.tag?.pet);
    const tokensIn = messages.reduce((n, m) => n + est(m.content) + 4, 0), tokensOut = est(text);
    // The provider caches the start of a prompt it saw lately (in blocks of 64 tokens): how much of this one starts the same as the last of its kind?
    const whole = messages.map((m) => m.content).join("\u0001"), key = kind + ":" + (opts.tag?.pet ?? "");
    const before = this.lastPrompt.get(key) ?? "";
    let same = 0; while (same < whole.length && same < before.length && whole[same] === before[same]) same++;
    this.lastPrompt.set(key, whole);
    const cachedIn = Math.min(tokensIn, Math.floor(est(whole.slice(0, same)) / 64) * 64);
    const costNoCache = (tokensIn * PRICE_IN + tokensOut * PRICE_OUT) / 1e6;
    const costUsd = ((tokensIn - cachedIn) * PRICE_IN + cachedIn * PRICE_HIT + tokensOut * PRICE_OUT) / 1e6;
    this.noCache += costNoCache;
    const rec = { at: Date.now(), kind, ...(opts.tag?.pet ? { pet: opts.tag.pet } : {}), provider: "bench", model: "bench", ok: true, teacher: opts.account === "teacher", tokensIn, tokensOut, cachedIn, costUsd, ms: 0 };
    this.ledger.add(rec, this.day());
    return { text, provider: "bench", model: "bench", tokensIn, tokensOut, cachedIn, costUsd, ms: 0 };
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "cost-bench-"));
// No disk: the logs are not wanted here, and waiting on them would slow the stub calls and so undercount them.
const store = { dir, append: async () => {}, readLog: async () => [], readJson: async () => null, writeJson: async () => {} } as unknown as Store;
const world = new World(SEED, undefined, LAYOUTS[LAYOUT] ?? LAYOUTS.house);
const sim = new Simulation(world, SEED, roster);
const ledger = new UsageLedger();
const llm = new BenchLlm(ledger, () => Math.floor(sim.simSec / 86400) + 1, () => sim.simSec);
let seed = SEED * 7919;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const vnow = () => (sim.simSec * 1000) / SPEED; // real milliseconds, as they would have passed
const never = () => false;
const conversation = new Conversation(sim, llm as any, store, () => {});
const system2 = new System2(sim, llm, store, { intervalSec: INTERVAL, patienceSec: 0, deepEvery: Number(process.env.S2_DEEP_EVERY ?? 8), isPaused: never, now: vnow, random });
system2.conversation = conversation;
const teacher = new Teacher(sim, llm as any, store, { set: async (f, v, _s, _r) => { const r = world.setOverride(f, v); return { field: r.field, from: r.from, to: r.to, mode: r.mode }; }, recent: async () => [] }, conversation, {
  isPaused: never, reviewEveryMin: 180, reviewMinRealSec: 600, maxCallsPerHour: Number(process.env.TEACHER_MAX_CALLS_PER_HOUR ?? 12), questionGapMin: Number(process.env.TEACHER_QUESTION_GAP_MIN ?? 180), now: vnow,
}, null, SEED);
system2.teacher = teacher;
const consolidator = new Consolidator(sim, llm as any, store, { isPaused: never });
const dreamer = new Dreamer(sim, llm as any, store, { isPaused: never });

const lastSig = new Map<string, string>(); const changes: Record<string, number[]> = {};
const t0 = Date.now();
const end = DAYS * 86400;
for (let s = DT; s <= end; s += DT) {
  system2.tick(); teacher.tick(); consolidator.tick(); dreamer.tick();
  sim.step(s * 1000);
  for (const p of sim.pets) { // when did something change that a pet might want to think about?
    const sig = situation(p, world.roomIdAt(p.x, p.y), conversation.nearbyCount(p));
    if (lastSig.get(p.id) !== undefined && lastSig.get(p.id) !== sig) (changes[p.id] ??= []).push(s);
    lastSig.set(p.id, sig);
  }
  await new Promise((r) => setImmediate(r)); // let the calls the stub started finish before the next step
}
await new Promise((r) => setTimeout(r, 200));
system2.disposed = true; teacher.dispose(); consolidator.disposed = true; dreamer.disposed = true;

const v = ledger.view(Date.now());
const days = DAYS, pets = roster.length;
const usd = (x: number) => (x >= 1 ? "$" + x.toFixed(2) : "$" + x.toFixed(4));
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`\nCost bench: ${DAYS} simulated day(s), ${pets} pets, seed ${SEED}, ${LAYOUT}, speed ${SPEED}x, thought every ~${INTERVAL}s of real time (took ${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
console.log("kind".padEnd(16) + pad("calls/day", 10) + pad("avg in", 8) + pad("avg out", 9) + pad("tokens/day", 12) + pad("share", 7) + pad("$/day", 9));
for (const k of v.byKind) {
  console.log(k.kind.padEnd(16) + pad((k.calls / days).toFixed(0), 10) + pad(k.calls ? Math.round(k.tokensIn / k.calls) : 0, 8) + pad(k.calls ? Math.round(k.tokensOut / k.calls) : 0, 9) + pad(Math.round((k.tokensIn + k.tokensOut) / days).toLocaleString(), 12) + pad(Math.round(k.share * 100) + "%", 7) + pad(usd(k.costUsd / days), 9));
}
const tokPerDay = (v.total.tokensIn + v.total.tokensOut) / days;
console.log("-".repeat(71));
console.log("TOTAL".padEnd(16) + pad((v.total.calls / days).toFixed(0), 10) + pad("", 8) + pad("", 9) + pad(Math.round(tokPerDay).toLocaleString(), 12) + pad("100%", 7) + pad(usd(v.total.costUsd / days), 9));
const made = sim.pets.reduce((n, p) => n + p.stats.s2Thoughts, 0), skipped = sim.pets.reduce((n, p) => n + (p.stats.s2Skipped ?? 0), 0);
console.log(`\nSlow thoughts made: ${(made / days).toFixed(0)} a day; skipped because nothing was new: ${(skipped / days).toFixed(0)} a day (${Math.round((100 * skipped) / Math.max(1, made + skipped))}% of the times one was due).`);
// How quickly does a pet get to think about a change? (from the change to the next thought asked for, in simulated seconds)
const delays: number[] = [];
for (const p of sim.pets) for (const c of changes[p.id] ?? []) { const next = (llm.thoughtAt[p.id] ?? []).find((t) => t >= c); if (next !== undefined) delays.push(next - c); }
delays.sort((a, b) => a - b);
const q = (f: number) => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(f * delays.length))] : 0);
const within = (sec: number) => (delays.length ? Math.round((100 * delays.filter((d) => d <= sec).length) / delays.length) : 0);
console.log(`\nReaction to a change (${delays.length} changes): median ${q(0.5)} s, 90th percentile ${q(0.9)} s, ${within(120)}% thought about within 2 min, ${within(300)}% within 5 min (simulated time).`);
console.log(`\nWith the provider's prompt cache (a repeated prompt start is billed at ${usd(PRICE_HIT / 1000)} per thousand tokens instead of ${usd(PRICE_IN / 1000)}): ${usd(v.total.costUsd / days)} a day; without any caching: ${usd(llm.noCache / days)} a day. ${Math.round((v.total.cachedIn / Math.max(1, v.total.tokensIn)) * 100)}% of input tokens were a repeated start.`);
console.log(`\nPer simulated day: ${Math.round(tokPerDay).toLocaleString()} tokens, ${usd(v.total.costUsd / days)} at DeepSeek list price (all calls paid, as on the hosted site, which has no local model).`);
console.log(`Per pet per hour of simulated time: ${Math.round(tokPerDay / pets / 24).toLocaleString()} tokens.`);
console.log(`At ${SPEED}x speed that is ${usd((v.total.costUsd / days) * SPEED / 24)} per real hour, ${usd(v.total.costUsd / days * SPEED)} per real day.`);
const out = arg("json", "");
if (out) writeFileSync(out, JSON.stringify({ days: DAYS, speed: SPEED, seed: SEED, layout: LAYOUT, intervalSec: INTERVAL, promptMode: process.env.S2_PROMPT ?? "compact", gate: process.env.S2_GATE ?? "on", deepEvery: Number(process.env.S2_DEEP_EVERY ?? 8), deepPrompt: process.env.S2_DEEP_PROMPT ?? "full", thoughtsMade: made, thoughtsSkipped: skipped, reaction: { changes: delays.length, medianSec: q(0.5), p90Sec: q(0.9), within2min: within(120), within5min: within(300) }, tokensPerDay: tokPerDay, costPerDay: v.total.costUsd / days, costPerDayNoCache: llm.noCache / days, cachedShare: v.total.cachedIn / Math.max(1, v.total.tokensIn), byKind: v.byKind }, null, 2));
process.exit(0);
