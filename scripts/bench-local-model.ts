// Compare local models on the real prompts the pets use: slow thoughts (System 2), sleep gists, and dream narration.
// Every model gets the same prompts, one at a time (a local model serves one request at a time anyway).
//   npx tsx scripts/bench-local-model.ts qwen2.5:3b qwen2.5:1.5b
// Options: BASE_URL (default http://localhost:11434/v1), N_S2 (slow-thought prompts, default 6), TASKS (default S2,gist,dream),
// PRESENCE_PENALTY (default 0; the pets use 0.4 for local calls).
import { readFileSync, writeFileSync } from "node:fs";
import { Simulation } from "../src/sim.js";
import { World } from "../src/world.js";
import { buildPrompt, parseThought } from "../src/system2.js";
import { buildGistPrompt, parseGists } from "../src/sleep.js";
import { OUT_OF_WORLD, buildDreamPrompt, makeDream } from "../src/dreams.js";
import { SUGGESTIONS } from "../src/pet.js";

const BASE = process.env.BASE_URL ?? "http://localhost:11434/v1";
const N_S2 = Number(process.env.N_S2 ?? 6);
const models = process.argv.slice(2);
const TASKS = (process.env.TASKS ?? "S2,gist,dream").split(",");
const PENALTY = Number(process.env.PRESENCE_PENALTY ?? 0); // the pets run local calls with 0.4 by default
if (!models.length) { console.error("usage: bench-local-model.ts <model> [<model> ...]"); process.exit(1); }

const roster = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const sim = new Simulation(new World(5), 5, roster);
sim.step(40 * 3600_000); // enough life for pets to have moments, tones and dreams to talk about

type Job = { task: "S2" | "gist" | "dream"; name: string; system: string; user: string; json: boolean; max: number; check: (text: string) => { ok: boolean; note: string } };
const jobs: Job[] = [];
for (let i = 0; i < N_S2; i++) {
  const p = sim.pets[i % sim.pets.length];
  const { system, user } = buildPrompt(p, Math.floor(sim.simSec / 86400) + 1, Math.floor(sim.simSec / 60) % 1440, 0, sim.simSec);
  jobs.push({
    task: "S2", name: `${p.name} #${Math.floor(i / sim.pets.length) + 1}`, system, user, json: true, max: 900,
    check: (text) => {
      const t = parseThought(text);
      if (!t) return { ok: false, note: "not usable JSON" };
      let raw: any; try { raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { raw = {}; }
      const odd = raw.suggestion !== undefined && !SUGGESTIONS.includes(raw.suggestion); // the app treats this as "none", so it still counts as usable
      const copied = t.beliefs.filter((b) => /[(\[]\s*\d/.test(b.text)).length;
      return { ok: true, note: `${t.beliefs.length} beliefs${copied ? ` (${copied} with a copied number)` : ""}, suggestion ${odd ? `"${raw.suggestion}"→none` : t.suggestion}` };
    },
  });
}
for (const p of sim.pets.slice(0, 2)) {
  const g = buildGistPrompt(p, sim.simSec);
  jobs.push({ task: "gist", name: p.name, system: g.system, user: g.user, json: true, max: 700, check: (text) => { const r = parseGists(text, g.ids, [], sim.simSec); return { ok: r.length > 0, note: r.length ? `${r.length} gists cite real moments` : "no gist that cites a real moment" }; } });
}
for (const p of sim.pets.slice(0, 2)) {
  const d = makeDream(p, sim.simSec);
  if (!d) continue;
  const { system, user } = buildDreamPrompt(p, d);
  jobs.push({ task: "dream", name: p.name, system, user, json: false, max: 260, check: (text) => {
    const t = text.replace(/^["'`\s]+|["'`\s]+$/g, "");
    const bad = t.length < 25 ? "too short" : t.startsWith("{") ? "JSON, not a dream" : t.length > 600 ? "too long" : OUT_OF_WORLD.test(t) ? "mentions things from a human home" : "";
    return { ok: !bad, note: bad || `${t.length} chars` };
  } });
}

for (let i = jobs.length - 1; i >= 0; i--) if (!TASKS.includes(jobs[i].task)) jobs.splice(i, 1);

const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

async function call(model: string, job: Job) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: job.system }, { role: "user", content: job.user }], max_tokens: job.max, temperature: job.task === "dream" ? 0.95 : 0.8, ...(PENALTY > 0 ? { presence_penalty: PENALTY } : {}), ...(job.json ? { response_format: { type: "json_object" } } : {}) }),
    signal: AbortSignal.timeout(300_000),
  });
  const ms = Date.now() - t0;
  const d: any = await res.json().catch(() => ({}));
  return { ms, text: String(d?.choices?.[0]?.message?.content ?? ""), tin: d?.usage?.prompt_tokens ?? 0, tout: d?.usage?.completion_tokens ?? 0, status: res.status };
}

const report: any = {};
for (const model of models) {
  console.log(`\n=== ${model}: warming up (loading the model) ===`);
  const w0 = Date.now();
  await call(model, { task: "S2", name: "warmup", system: "Reply with the word ok.", user: "ok", json: false, max: 5, check: () => ({ ok: true, note: "" }) });
  console.log(`loaded in ${((Date.now() - w0) / 1000).toFixed(1)}s`);
  const rows: any[] = [];
  for (const job of jobs) {
    const r = await call(model, job).catch((e) => ({ ms: 300_000, text: "", tin: 0, tout: 0, status: 0, err: String(e) } as any));
    const c = r.status === 200 ? job.check(r.text) : { ok: false, note: `HTTP ${r.status || "error"} ${r.err ?? ""}` };
    rows.push({ task: job.task, name: job.name, ms: r.ms, tin: r.tin, tout: r.tout, ok: c.ok, note: c.note, sample: r.text.replace(/\s+/g, " ").slice(0, 260) });
    console.log(`${job.task.padEnd(5)} ${job.name.padEnd(10)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  in ${String(r.tin).padStart(4)} out ${String(r.tout).padStart(4)}  ${c.ok ? "OK  " : "FAIL"} ${c.note}`);
  }
  report[model] = rows;
}

console.log("\n=== summary ===");
for (const model of models) {
  for (const task of ["S2", "gist", "dream"] as const) {
    const r = report[model].filter((x: any) => x.task === task);
    if (!r.length) continue;
    const ms = r.map((x: any) => x.ms);
    console.log(`${model.padEnd(14)} ${task.padEnd(5)} valid ${r.filter((x: any) => x.ok).length}/${r.length} | median ${(pct(ms, 0.5) / 1000).toFixed(1)}s, slowest ${(Math.max(...ms) / 1000).toFixed(1)}s | avg tokens in ${Math.round(r.reduce((a: number, x: any) => a + x.tin, 0) / r.length)} out ${Math.round(r.reduce((a: number, x: any) => a + x.tout, 0) / r.length)}`);
  }
}
console.log("\n=== samples (same prompt, each model) ===");
for (const idx of [0, N_S2 + 0, jobs.length - 2]) {
  if (!jobs[idx]) continue;
  console.log(`\n[${jobs[idx].task} ${jobs[idx].name}]`);
  for (const model of models) console.log(` ${model}: ${report[model][idx]?.sample}`);
}
writeFileSync(process.env.OUT ?? "/tmp/bench-local-model.json", JSON.stringify(report, null, 2));
