// Do the pets think as well on the cheaper prompts? The same pet in the same state is asked the same thing twice, once with the
// original prompt and once with the compact one, by a REAL model, and the two answers are compared on things that can be
// counted: is the reply usable JSON, is the question new, are the beliefs grounded in the notes, does it invent things that
// do not exist in the pets' world, copy a dream or something already found wrong, put numbers in a belief, speak up when
// nobody is near, retract only beliefs it holds. Deep reviews are compared the same way (old full prompt against compact).
//
//   npx tsx scripts/quality-bench.ts [--states 10] [--out docs/baselines/quality-raw.json] [--from data/runs/main]
//
// States come from a copy of a real run (the pets' beliefs, claims, dreams and so on are real), stepped forward a few hours
// at a time. Only the LOCAL model is used (qwen2.5:1.5b unless LOCAL_LLM_MODEL says otherwise): this spends no money.
// It saves each answer as it goes, so an interrupted run carries on where it stopped.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { gatewayFromEnv } from "../src/llm.js";
import { Simulation, type SimSnapshot } from "../src/sim.js";
import { World, type WorldSnapshot } from "../src/world.js";
import { LAYOUTS } from "../src/layout.js";
import { buildPrompt, parseThought } from "../src/system2.js";
import { copiesDream, OUT_OF_WORLD } from "../src/dreams.js";
import { copiesRefuted } from "../src/verify.js";
import type { PetDef, PetState } from "../src/pet.js";

const arg = (name: string, d: string) => { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STATES = Number(arg("states", "10")), OUT = arg("out", "docs/baselines/quality-raw.json"), FROM = arg("from", "data/runs/main");

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const llm = gatewayFromEnv({ LOCAL_LLM_MODEL: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:1.5b", LOCAL_LLM_TIMEOUT_SEC: "300", LOCAL_LLM_CONCURRENCY: "1" } as NodeJS.ProcessEnv); // (no paid keys are passed on)
if (!llm.enabled) throw new Error("no local model configured");

// ---- the states: a copy of a real run, stepped forward ----
const ws: WorldSnapshot = JSON.parse(readFileSync(path.join(FROM, "world.json"), "utf8"));
const ss: SimSnapshot = JSON.parse(readFileSync(path.join(FROM, "pets.json"), "utf8"));
const layout = LAYOUTS[ws.layoutId ?? "legacy"] ?? LAYOUTS.legacy;
const sim = new Simulation(new World(1, ws, layout), 1, roster, ss);

interface Sample { id: string; kind: "normal" | "deep"; pet: string; day: number; tod: number; nearby: number; full: { system: string; user: string }; compact: { system: string; user: string }; state: { recentQuestions: string[]; beliefs: string[]; refutedAt: number; hasDream: boolean } }
const samples: Sample[] = [];
const nearbyOf = (p: PetState) => sim.pets.filter((o) => o !== p && Math.hypot(o.x - p.x, o.y - p.y) <= 300).length + (Math.hypot(sim.human.x - p.x, sim.human.y - p.y) <= 300 ? 1 : 0);
for (let k = 0; k < STATES; k++) {
  for (let s = 0; s < 2 * 3600; s += 5) sim.step((sim.simSec + 5) * 1000);
  const day = Math.floor(sim.simSec / 86400) + 1, tod = Math.floor(sim.simSec / 60) % 1440;
  for (const [i, p] of sim.pets.entries()) {
    const nearby = nearbyOf(p);
    samples.push({
      id: `${k}:${p.id}:normal`, kind: "normal", pet: p.id, day, tod, nearby,
      full: buildPrompt(p, day, tod, nearby, sim.simSec, false, false, "full"), compact: buildPrompt(p, day, tod, nearby, sim.simSec, false, false, "compact"),
      state: snapshotOf(p),
    });
    if (i === k % sim.pets.length) {
      p.mind.recentThoughts = p.mind.recentThoughts.length ? p.mind.recentThoughts : ["I keep noticing the light change.", "Maybe the tone has something to do with charging."];
      samples.push({
        id: `${k}:${p.id}:deep`, kind: "deep", pet: p.id, day, tod, nearby,
        full: buildPrompt(p, day, tod, nearby, sim.simSec, true, false, "full"), compact: buildPrompt(p, day, tod, nearby, sim.simSec, true, false, "compact", "compact"),
        state: snapshotOf(p),
      });
    }
  }
}
function snapshotOf(p: PetState) { return { recentQuestions: [...(p.mind.recentQuestions ?? [])], beliefs: p.mind.beliefs.map((b) => b.text), refutedAt: sim.simSec, hasDream: p.mind.dreams.length > 0 }; }
// copiesDream / copiesRefuted look at the pet's mind, so keep the minds as they were for each sample
const minds = new Map<string, Pick<PetState, "mind">>();
for (const s of samples) minds.set(s.id, { mind: structuredClone(sim.pets.find((p) => p.id === s.pet)!.mind) });
const simSecAt = sim.simSec;

// ---- ask the model ----
type Raw = Record<string, { text: string; tokensIn: number; tokensOut: number; ms: number }>;
const raw: Raw = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const total = samples.length * 2;
let n = Object.keys(raw).length;
for (const s of samples) {
  for (const v of ["full", "compact"] as const) {
    const key = `${s.id}:${v}`;
    if (raw[key]) continue;
    const prompt = s[v];
    const t0 = Date.now();
    try {
      const r = await llm.complete([{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], { maxTokens: s.kind === "deep" || v === "full" ? 900 : 450, temperature: s.kind === "deep" ? 0.7 : 0.8, patienceMs: 900_000, tag: { kind: "quality", pet: s.pet } });
      raw[key] = { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ms: Date.now() - t0 };
    } catch (e: any) {
      raw[key] = { text: "", tokensIn: 0, tokensOut: 0, ms: Date.now() - t0 }; // no usable reply counts against it
      console.warn("call failed:", e.message);
    }
    writeFileSync(OUT, JSON.stringify(raw));
    console.log(`${++n}/${total} ${key} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
}

// ---- score ----
const STOP = new Set("that this with have from they there their been when what which about into more than then them were will would could should only some very just also much many such like over after before while being does your you the and for are but not can its has had was who how why".split(" "));
const words = (t: string) => t.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const jac = (a: string, b: string) => { const x = new Set(words(a)), y = new Set(words(b)); if (!x.size || !y.size) return 0; let i = 0; for (const w of x) if (y.has(w)) i++; return i / (x.size + y.size - i); };

interface Score { valid: boolean; novel: boolean | null; beliefs: number; grounded: number; invented: boolean; copyDream: number; copyRefuted: number; numbers: number; sayAlone: boolean; retract: number; retractValid: number; ask: boolean; suggestion: string; thoughtLen: number; tokensIn: number; tokensOut: number }
function score(s: Sample, v: "full" | "compact"): Score {
  const r = raw[`${s.id}:${v}`], parsed = r?.text ? parseThought(r.text) : null, prompt = (s[v].system + "\n" + s[v].user).toLowerCase(), mind = minds.get(s.id)!;
  const out: Score = { valid: !!parsed, novel: null, beliefs: 0, grounded: 0, invented: false, copyDream: 0, copyRefuted: 0, numbers: 0, sayAlone: false, retract: 0, retractValid: 0, ask: false, suggestion: "", thoughtLen: 0, tokensIn: r?.tokensIn ?? 0, tokensOut: r?.tokensOut ?? 0 };
  if (!parsed) return out;
  out.novel = parsed.question ? !s.state.recentQuestions.some((q) => norm(q) === norm(parsed.question) || jac(q, parsed.question) >= 0.8) : null;
  out.beliefs = parsed.beliefs.length;
  for (const b of parsed.beliefs) {
    const w = words(b.text);
    if (w.length && w.filter((x) => prompt.includes(x)).length / w.length >= 0.6) out.grounded++;
    if (copiesDream(mind, b.text)) out.copyDream++;
    if (copiesRefuted(mind, b.text, simSecAt)) out.copyRefuted++;
    if (/\d/.test(b.text)) out.numbers++;
  }
  out.invented = OUT_OF_WORLD.test(parsed.thought + " " + parsed.beliefs.map((b) => b.text).join(" ")) && !OUT_OF_WORLD.test(prompt);
  out.sayAlone = !!parsed.say && s.nearby === 0;
  out.retract = parsed.retract.length;
  out.retractValid = parsed.retract.filter((t) => s.state.beliefs.some((b) => norm(b) === norm(t) || (norm(t).length >= 12 && (norm(b).includes(norm(t)) || norm(t).includes(norm(b)))))).length;
  out.ask = !!parsed.askTeacher;
  out.suggestion = parsed.suggestion;
  out.thoughtLen = parsed.thought.length;
  return out;
}

const pct = (a: number, b: number) => (b ? a / b : 0);
function summarise(kind: "normal" | "deep") {
  const rows = samples.filter((s) => s.kind === kind);
  const side = (v: "full" | "compact") => {
    const sc = rows.map((s) => score(s, v)), ok = sc.filter((x) => x.valid), beliefs = ok.reduce((a, x) => a + x.beliefs, 0), withQ = ok.filter((x) => x.novel !== null);
    return {
      n: rows.length, valid: pct(ok.length, sc.length), novelQuestion: pct(withQ.filter((x) => x.novel).length, withQ.length), beliefsPerThought: ok.length ? beliefs / ok.length : 0,
      grounded: beliefs ? pct(ok.reduce((a, x) => a + x.grounded, 0), beliefs) : 1,
      invented: pct(ok.filter((x) => x.invented).length, ok.length), copiesDream: pct(ok.reduce((a, x) => a + x.copyDream, 0), Math.max(1, beliefs)), copiesRefuted: pct(ok.reduce((a, x) => a + x.copyRefuted, 0), Math.max(1, beliefs)),
      numbersInBeliefs: pct(ok.reduce((a, x) => a + x.numbers, 0), Math.max(1, beliefs)), speaksAlone: pct(ok.filter((x) => x.sayAlone).length, ok.length),
      retractionsValid: pct(ok.reduce((a, x) => a + x.retractValid, 0), Math.max(1, ok.reduce((a, x) => a + x.retract, 0))), asksTeacher: pct(ok.filter((x) => x.ask).length, ok.length),
      thoughtChars: ok.length ? ok.reduce((a, x) => a + x.thoughtLen, 0) / ok.length : 0, tokensIn: sc.reduce((a, x) => a + x.tokensIn, 0) / Math.max(1, sc.length), tokensOut: sc.reduce((a, x) => a + x.tokensOut, 0) / Math.max(1, sc.length),
      suggestions: Object.fromEntries([...new Set(ok.map((x) => x.suggestion))].map((k) => [k, ok.filter((x) => x.suggestion === k).length])),
    };
  };
  const full = side("full"), compact = side("compact");
  const same = rows.filter((s) => { const a = score(s, "full"), b = score(s, "compact"); return a.valid && b.valid && a.suggestion === b.suggestion; }).length;
  return { full, compact, suggestionAgreement: pct(same, rows.length) };
}

// How much worse is acceptable: higher is better for the first group, lower is better for the second.
const GOOD: [keyof ReturnType<typeof summarise>["full"], number][] = [["valid", 0.1], ["novelQuestion", 0.1], ["grounded", 0.1], ["retractionsValid", 0.15]];
const BAD: [keyof ReturnType<typeof summarise>["full"], number][] = [["invented", 0.1], ["copiesDream", 0.1], ["copiesRefuted", 0.1], ["numbersInBeliefs", 0.1], ["speaksAlone", 0.1]];
const report: Record<string, unknown> = { model: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:1.5b", states: STATES, samples: samples.length };
let failed = false;
for (const kind of ["normal", "deep"] as const) {
  const r = summarise(kind);
  console.log(`\n== ${kind} thoughts: original prompt against compact prompt, ${r.full.n} states each ==`);
  console.log("measure".padEnd(22) + "original".padStart(10) + "compact".padStart(10) + "change".padStart(9) + "  verdict");
  const line = (label: string, a: number, b: number, fmt: (x: number) => string, verdict: string) => console.log(label.padEnd(22) + fmt(a).padStart(10) + fmt(b).padStart(10) + ((b - a >= 0 ? "+" : "") + fmt(b - a)).padStart(9) + "  " + verdict);
  const P = (x: number) => (x * 100).toFixed(0) + "%";
  for (const [k, tol] of GOOD) { const a = r.full[k] as number, b = r.compact[k] as number, bad = b - a < -tol; if (bad) failed = true; line(String(k), a, b, P, bad ? "WORSE" : "ok"); }
  for (const [k, tol] of BAD) { const a = r.full[k] as number, b = r.compact[k] as number, bad = b - a > tol; if (bad) failed = true; line(String(k), a, b, P, bad ? "WORSE" : "ok"); }
  line("beliefs per thought", r.full.beliefsPerThought, r.compact.beliefsPerThought, (x) => x.toFixed(2), "(information)");
  line("thought length (chars)", r.full.thoughtChars, r.compact.thoughtChars, (x) => x.toFixed(0), "(information)");
  line("tokens in", r.full.tokensIn, r.compact.tokensIn, (x) => x.toFixed(0), "(information)");
  console.log(`same suggestion to System 1 in both: ${P(r.suggestionAgreement)}`);
  report[kind] = r;
}
console.log(failed ? "\nRESULT: at least one measure is clearly worse on the compact prompt." : "\nRESULT: nothing measured is clearly worse on the compact prompt (with this few samples, small differences are noise).");
report.failed = failed;
writeFileSync(OUT.replace(/\.json$/, "-summary.json"), JSON.stringify(report, null, 2));
process.exit(0);
