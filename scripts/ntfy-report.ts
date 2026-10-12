// Posts a 6-hour report of the local simulator to an ntfy topic.
//   npx tsx --env-file-if-exists=.env.local scripts/ntfy-report.ts
// NTFY_TOPIC (default https://ntfy.sh/1000pets), optional NTFY_TOKEN, SIM_URL (default http://localhost:3000).
// A launch agent on this Mac runs it at 02:00, 08:00, 14:00 and 20:00.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TOPIC = process.env.NTFY_TOPIC ?? "https://ntfy.sh/1000pets";
const TOKEN = process.env.NTFY_TOKEN ?? "";
const SIM = (process.env.SIM_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RUN = path.resolve(process.env.DATA_DIR ?? "data", "runs", process.env.RUN_ID ?? "main");
const statePath = path.resolve("data", "ntfy-last.json");
const MAX = 3500; // ntfy.sh rejects a message longer than 4096 bytes

type Snap = { at: number; simSec: number; costUsd: number };

const money = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pad = (n: number) => String(n).padStart(2, "0");
const clip = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const when = (tSec: number) => {
  const m = Math.floor(tSec / 60);
  return `D${Math.floor(m / 1440) + 1} ${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`;
};

async function post(title: string, body: string) {
  const headers: Record<string, string> = { Title: title, Tags: "dog" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(TOPIC, { method: "POST", headers, body });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`ntfy ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function sendAll(title: string, body: string) {
  const parts: string[] = [];
  let cur = "";
  for (const block of body.split("\n\n")) {
    const next = cur ? `${cur}\n\n${block}` : block;
    if (next.length > MAX && cur) { parts.push(cur); cur = block; }
    else cur = next;
  }
  if (cur) parts.push(cur);
  for (let i = 0; i < parts.length; i++) await post(parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title, parts[i]);
}

async function log(name: string): Promise<any[]> {
  try {
    const text = await readFile(path.join(RUN, name), "utf8");
    const out: any[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
    return out;
  } catch { return []; }
}

function top(counts: Map<string, number>, n: number) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function main() {
  let dash: any;
  let usage: any = null;
  let teacher: any = null;
  try {
    const [d, u, t] = await Promise.all([
      fetch(`${SIM}/api/dashboard`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${SIM}/api/usage`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${SIM}/api/teacher`, { signal: AbortSignal.timeout(8000) }),
    ]);
    if (!d.ok) throw new Error(`dashboard ${d.status}`);
    dash = await d.json();
    if (u.ok) usage = await u.json();
    if (t.ok) teacher = await t.json();
  } catch (e) {
    await post("1000pets", "The simulator is not running on this Mac.");
    console.error(e);
    return;
  }

  const simSec = Number(dash.simTimeMs) / 1000;
  let prev: Partial<Snap> | null = null;
  try { prev = JSON.parse(await readFile(statePath, "utf8")); } catch { /* first note */ }
  const fromSec = typeof prev?.simSec === "number" ? prev.simSec : Math.max(0, simSec - 6 * 3600 * (dash.speed || 1));
  const inWin = (tSec: number) => tSec >= fromSec;

  const pets: any[] = dash.pets ?? [];
  const minds = await Promise.all(pets.map(async (p) => {
    try {
      const r = await fetch(`${SIM}/api/mind/${p.id}`, { signal: AbortSignal.timeout(8000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }));

  const [comms, events, teacherLog, calls, ...thoughtsByPet] = await Promise.all([
    log("comms.jsonl"), log("events.jsonl"), log("teacher.jsonl"), log("llm-calls.jsonl"),
    ...pets.map((p) => log(`thoughts/${p.id}.jsonl`)),
  ]);

  const rooms: any[] = dash.rooms ?? [];
  const roomOf = (name: string) => rooms.find((r) => (r.pets ?? []).includes(name))?.name ?? "somewhere";
  const onOff = (v: boolean, word: string) => `${word} ${v ? "on" : "off"}`;
  const roomLines = rooms.map((r) => {
    const who = (r.pets ?? []).join(", ") || "empty";
    const temp = typeof r.indoorTemp === "number" ? `${Math.round(r.indoorTemp)}°` : "";
    return `${r.name} · ${[temp, onOff(!!r.lampOn, "lamp"), onOff(!!r.heaterOn, "heater"), r.curtainOpen ? "curtain open" : "curtain shut", who].filter(Boolean).join(" · ")}`;
  });

  const critical: string[] = [];
  const surpriseKind = (why: string) => /tone|hum/.test(why) ? "the tone" : /light/.test(why) ? "the light" : /warm|cold|temperature/.test(why) ? "the temperature" : "something else";
  for (let i = 0; i < pets.length; i++) {
    const surprises = thoughtsByPet[i].filter((t: any) => inWin(t.tSec) && t.stage === "surprise" && t.surprise?.score >= 0.5);
    if (surprises.length) {
      const kinds = new Map<string, number>();
      let strongest = surprises[0];
      for (const t of surprises) {
        const kind = surpriseKind(String(t.surprise.why ?? "").toLowerCase());
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        if (t.surprise.score > strongest.surprise.score) strongest = t;
      }
      const breakdown = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
      critical.push(`${pets[i].name} was strongly surprised ${surprises.length} times (${breakdown}). Sharpest: ${clip(strongest.surprise.why, 120)}`);
    }
    for (const ref of minds[i]?.refuted ?? []) {
      if (!inWin(ref.tSec)) continue;
      critical.push(`${pets[i].name} found this wrong · ${clip(ref.text, 100)} (${clip(ref.why, 80)})`);
    }
  }
  for (const e of events) {
    const tSec = (e.simMinute ?? 0) * 60;
    if (!inWin(tSec)) continue;
    if (e.type === "pet_dormant" || e.type === "pet_recovered") critical.push(`${when(tSec)} · ${e.detail} ${e.type === "pet_dormant" ? "went flat" : "recovered"}`);
    if (e.type === "weather_changed") critical.push(`${when(tSec)} · weather ${e.detail}`);
  }

  const windowCalls = calls.filter((c) => inWin(((c.day - 1) * 1440 + c.hour * 60 + c.minute) * 60));
  const byModel = new Map<string, { calls: number; fails: number; cost: number; tokens: number }>();
  for (const c of windowCalls) {
    const key = `${c.provider} · ${c.model}`;
    const b = byModel.get(key) ?? { calls: 0, fails: 0, cost: 0, tokens: 0 };
    if (c.ok) { b.calls++; b.cost += c.costUsd || 0; b.tokens += (c.tokensIn || 0) + (c.tokensOut || 0); }
    else b.fails++;
    byModel.set(key, b);
  }
  const modelLines = [...byModel.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([name, b]) =>
    `${name} · ${b.calls} calls${b.fails ? `, ${b.fails} failed` : ""} · ${b.tokens.toLocaleString("en-US")} tokens · ${money(b.cost)}`);
  const paid = [...byModel.values()].reduce((n, b) => n + b.cost, 0);

  const state = dash.paused ? "paused" : dash.llmIdle ? "running, thinking on hold" : "running";
  const overview = [
    `${when(simSec)} · ${state} · ${dash.speed}×`,
    `From ${when(fromSec)} to ${when(simSec)}`,
    "",
    "Rooms",
    roomLines.join("\n") || "No rooms",
    "",
    "Critical",
    critical.slice(0, 8).join("\n") || "None",
    "",
    "Models",
    modelLines.join("\n") || "No model calls",
    `Paid in this window: ${money(paid)}`,
  ].join("\n");

  const petBodies = pets.map((p, i) => {
    const thoughts = thoughtsByPet[i].filter((t: any) => inWin(t.tSec));
    const said = comms.filter((u) => inWin(u.tSec) && u.from?.id === p.id && clip(u.text, 400).length >= 25);
    const talk = [
      ...said.filter((u) => u.trace?.kind === "initiative"),
      ...said.filter((u) => u.trace?.kind !== "initiative"),
    ].slice(-3);
    const intentions = new Map<string, number>();
    const learned: string[] = [];
    const seenBelief = new Set<string>();
    for (const t of thoughts) {
      if (t.system === 2 && t.intention) intentions.set(t.intention, (intentions.get(t.intention) ?? 0) + 1);
      for (const b of t.beliefs ?? []) {
        const text = clip(b.text ?? b, 140);
        if (text && !seenBelief.has(text)) { seenBelief.add(text); learned.push(text); }
      }
      for (const g of t.gists ?? []) {
        const text = clip(g.text, 140);
        if (text && !seenBelief.has(text)) { seenBelief.add(text); learned.push(`gist: ${text}`); }
      }
    }
    const now = p.intention ? `Now: ${clip(p.intention, 140)}` : "Now: no intention";
    const intentLines = top(intentions, 5).map(([goal, n], k) => `${k + 1}. ${clip(goal, 120)} (${n})`);
    const talkLines = talk.map((u) => {
      const to = u.to?.name || u.to?.kind || "someone";
      return `${when(u.tSec)} to ${to}: ${clip(u.text, 180)}`;
    });
    return [
      `${p.name} · ${roomOf(p.name)} · ${p.energy}% · ${p.mode}`,
      now,
      "",
      "Said",
      talkLines.join("\n") || "Nothing substantial",
      "",
      "Intentions",
      intentLines.join("\n") || "None",
      "",
      "Learned",
      learned.slice(-5).join("\n") || "Nothing new",
    ].join("\n");
  });

  const fromMin = fromSec / 60;
  const tlog = teacherLog.filter((e) => (e.simMinute ?? 0) >= fromMin);
  const teacherLines: string[] = [];
  const active = teacher?.active;
  teacherLines.push(active ? `Doing now: ${active.kind}${active.target ? ` for ${active.target}` : ""}${active.where ? ` at ${active.where}` : ""}` : "Doing now: nothing in progress");
  if (teacher?.plan?.summary) teacherLines.push(`Plan: ${clip(teacher.plan.summary, 200)}`);
  for (const e of tlog) {
    if (e.type === "review") teacherLines.push(`${when(e.simMinute * 60)} review: ${clip(e.summary, 220)}`);
    if (e.type === "lesson") teacherLines.push(`${when(e.simMinute * 60)} lesson to ${e.target}: ${clip(e.topic, 80)} — ${clip(e.text, 160)}`);
    if (e.type === "answer") teacherLines.push(`${when(e.simMinute * 60)} answered ${e.pet}: ${clip(e.text, 80)} — ${clip(e.answer, 160)}`);
    if (e.type === "env") teacherLines.push(`${when(e.simMinute * 60)} changed the house: ${clip(e.did, 80)} (${clip(e.reason, 120)})`);
    if (e.type === "observe") teacherLines.push(`${when(e.simMinute * 60)} noticed: ${clip(e.note, 160)}`);
  }

  await sendAll("1000pets", overview);
  for (let i = 0; i < pets.length; i++) await sendAll(`1000pets · ${pets[i].name}`, petBodies[i]);
  await sendAll("1000pets · Teacher", teacherLines.join("\n") || "No teacher log in this window");

  await mkdir(path.dirname(statePath), { recursive: true });
  const next: Snap = { at: Date.now(), simSec, costUsd: Number(usage?.total?.costUsd ?? 0) };
  await writeFile(statePath, JSON.stringify(next));
  console.log(`sent ${when(fromSec)}–${when(simSec)}, ${critical.length} critical, ${windowCalls.length} model calls`);
}

main().catch((e) => { console.error(e); process.exit(1); });
