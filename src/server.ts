import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SimClock, SPEEDS } from "./clock.js";
import { Store } from "./store.js";
import { readFileSync } from "node:fs";
import { Simulation, type SimSnapshot } from "./sim.js";
import type { PetDef } from "./pet.js";
import { gatewayFromEnv, type ProviderStats } from "./llm.js";
import { System2 } from "./system2.js";
import { Conversation } from "./conversation.js";
import type { Target } from "./speech.js";
import { readdir, stat } from "node:fs/promises";
import { OBJECTS, ROOM, World, type WorldSnapshot } from "./world.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const RUN_ID = process.env.RUN_ID ?? "main";
const SEED = Number(process.env.SEED ?? 12345);

const store = await Store.open(DATA_DIR, RUN_ID);

// Resume clock and world from the last save so a redeploy does not reset the pets' lives.
const savedClock = await store.readJson<{ simMs: number; speed: number }>("clock.json");
const savedWorld = await store.readJson<WorldSnapshot>("world.json");
const clock = new SimClock(savedClock?.simMs ?? 0);
if (savedClock && (SPEEDS as readonly number[]).includes(savedClock.speed)) clock.speed = savedClock.speed;
const world = new World(SEED, savedWorld ?? undefined);

// Pets: the default roster lives in config/pets.json; pets added later are kept in the data volume.
const defaultRoster: PetDef[] = JSON.parse(readFileSync(path.join(__dirname, "..", "config", "pets.json"), "utf8"));
const savedSim = await store.readJson<SimSnapshot>("pets.json");
const sim = new Simulation(world, SEED, defaultRoster, savedSim ?? undefined);

// Slow thinking (System 2) runs through the LLM gateway: Groq first, DeepSeek as the fallback.
const llm = gatewayFromEnv();
llm.restore(await store.readJson<ProviderStats[]>("llm.json"));
const system2 = new System2(sim, llm, store, { intervalSec: Number(process.env.S2_INTERVAL_SEC ?? 70), isPaused: () => clock.paused });
console.log(`LLM providers: ${llm.snapshot().map((p) => `${p.name}(${p.model})`).join(", ") || "none"}`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function status() {
  return { runId: RUN_ID, simTimeMs: clock.simTimeMs, ...clock.parts, speed: clock.speed, paused: clock.paused };
}

function petView() {
  return sim.pets.map((p) => ({
    id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y),
    heading: Math.round(p.heading * 100) / 100, mode: p.mode, action: p.s1.action,
    energy: Math.round(p.energy * 10) / 10, drives: p.drives,
  }));
}

function humanView() {
  const h = sim.human;
  return { x: Math.round(h.x), y: Math.round(h.y), heading: Math.round(h.heading * 100) / 100, moving: h.moving };
}

function worldView() {
  return { env: world.env, sunPatch: world.sunPatch(), pets: petView(), human: humanView() };
}

// Control endpoints are open unless ADMIN_TOKEN is set.
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (ADMIN_TOKEN && req.header("x-admin-token") !== ADMIN_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, ...status() }));
app.get("/api/status", (_req, res) => res.json(status()));
app.get("/api/world", (_req, res) => res.json({ room: ROOM, objects: OBJECTS, ...worldView() }));
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
  res.json(await store.readLog("events", limit));
});
app.get("/api/pets", (_req, res) => res.json(petView()));
app.get("/api/thoughts/:id", async (req, res) => {
  if (!/^[a-z0-9_-]{1,32}$/.test(req.params.id)) {
    res.status(400).json({ error: "bad pet id" });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 30) || 30, 500);
  res.json(await store.readLog(`thoughts/${req.params.id}`, limit));
});
app.post("/api/pets", requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const id = String(b.id ?? b.name ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  const num = (v: unknown, d: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);
  if (!id || !b.name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  try {
    sim.addPet({
      id, name: String(b.name).slice(0, 24), color: /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : "",
      traits: { curiosity: num(b.traits?.curiosity, 0.5), social: num(b.traits?.social, 0.5), caution: num(b.traits?.caution, 0.5), patience: num(b.traits?.patience, 0.5) },
      start: { x: 500, y: 300 },
    });
  } catch (e: any) {
    res.status(409).json({ error: e.message });
    return;
  }
  await store.append("events", { type: "pet_added", detail: String(b.name), ...clock.parts });
  res.json(petView());
});
app.get("/api/mind/:id", (req, res) => {
  const p = sim.pets.find((x) => x.id === req.params.id);
  if (!p) {
    res.status(404).json({ error: "no such pet" });
    return;
  }
  res.json({ question: p.mind.question, intention: p.mind.intention?.goal ?? null, beliefs: p.mind.beliefs, suggestion: p.mind.suggestion?.kind ?? null, episodes: p.mind.episodes });
});
// Tiny live check of one provider's key and model. Limited to one call per provider per 20 s.
const lastPing = new Map<string, number>();
app.get("/api/llm/test/:provider", async (req, res) => {
  const name = req.params.provider;
  if (Date.now() - (lastPing.get(name) ?? 0) < 20_000) {
    res.status(429).json({ ok: false, error: "try again in a few seconds" });
    return;
  }
  lastPing.set(name, Date.now());
  res.json(await llm.ping(name));
});
app.get("/api/llm", (_req, res) => {
  const now = Date.now();
  res.json({ enabled: llm.enabled, providers: llm.snapshot().map((s) => ({ ...s, cooldownSec: Math.max(0, Math.round((s.cooldownUntil - now) / 1000)) })) });
});
app.get("/api/world-log", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 48) || 48, 1000);
  res.json(await store.readLog("world", limit));
});

app.post("/api/speed", requireAdmin, async (req, res) => {
  try {
    clock.setSpeed(Number(req.body?.speed));
  } catch {
    res.status(400).json({ error: `speed must be one of ${SPEEDS.join(", ")}` });
    return;
  }
  await store.append("events", { type: "speed_changed", detail: `${clock.speed}x`, ...clock.parts });
  res.json(status());
});

app.post("/api/pause", requireAdmin, async (req, res) => {
  clock.setPaused(Boolean(req.body?.paused));
  await store.append("events", { type: clock.paused ? "paused" : "resumed", detail: "", ...clock.parts });
  res.json(status());
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// The human is steered by joystick input over the WebSocket; input goes stale after 0.5 s so a lost
// connection or released finger always stops the avatar.
const input = { dx: 0, dy: 0, at: 0 };
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (m?.type === "input" && Number.isFinite(m.dx) && Number.isFinite(m.dy)) {
        input.dx = Math.max(-1, Math.min(1, m.dx));
        input.dy = Math.max(-1, Math.min(1, m.dy));
        input.at = Date.now();
      }
    } catch {
      /* ignore malformed messages */
    }
  });
});

function broadcast(payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
}

const conversation = new Conversation(sim, llm, store, broadcast);
system2.conversation = conversation;

// Chat with the pets. Limited to 8 messages a minute because the site is public and every message costs tokens.
const chatTimes: number[] = [];
app.post("/api/chat", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text || text.length > 300) {
    res.status(400).json({ error: "message must be 1-300 characters" });
    return;
  }
  const now = Date.now();
  while (chatTimes.length && now - chatTimes[0] > 60_000) chatTimes.shift();
  if (chatTimes.length >= 8) {
    res.status(429).json({ error: "slow down a little" });
    return;
  }
  chatTimes.push(now);
  const toId = String(req.body?.to ?? "all");
  let to: Target = { kind: "all" };
  if (toId !== "all") {
    if (!sim.pets.some((p) => p.id === toId)) {
      res.status(404).json({ error: "no such pet" });
      return;
    }
    to = { kind: "pet", id: toId };
  }
  const u = await conversation.humanSays(to, text, req.body?.anywhere !== false);
  res.json({ ok: true, heardBy: u.heardBy, notHeardBy: u.notHeardBy });
});
app.get("/api/comms", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 60) || 60, 500);
  res.json(await store.readLog("comms", limit));
});

// ---- dashboard data ----
const startedAt = Date.now();
app.get("/api/metrics", async (req, res) => {
  const hours = Math.min(Number(req.query.hours ?? 24) || 24, 24 * 60);
  const points = Math.min(Number(req.query.points ?? 96) || 96, 400);
  const rows = await store.readLog<any>("metrics", hours * 4 + 1);
  const stride = Math.max(1, Math.ceil(rows.length / points));
  res.json(rows.filter((_, i) => i % stride === 0 || i === rows.length - 1));
});

// All pets' thoughts merged, newest first; filter with ?pet=pip&system=2
app.get("/api/thoughts", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 40) || 40, 200);
  const pets = req.query.pet ? [String(req.query.pet)] : sim.pets.map((p) => p.id);
  const sys = Number(req.query.system) || 0;
  const all: any[] = [];
  for (const id of pets) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) continue;
    for (const t of await store.readLog<any>(`thoughts/${id}`, 300)) if (!sys || t.system === sys) all.push(t);
  }
  res.json(all.sort((a, b) => b.tSec - a.tSec).slice(0, limit));
});

app.get("/api/dashboard", async (_req, res) => {
  const comms = await store.readLog<any>("comms", 5000);
  const nowMs = Date.now();
  const realMs = (id: string) => Number(String(id).split("-")[0]) || 0;
  const pet = comms.filter((u) => u.from.kind === "pet");
  const files: { name: string; bytes: number }[] = [];
  for (const dir of ["", "thoughts"]) {
    for (const f of await readdir(path.join(store.dir, dir)).catch(() => [] as string[])) {
      if (!/\.jsonl?$/.test(f)) continue;
      const st = await stat(path.join(store.dir, dir, f)).catch(() => null);
      if (st) files.push({ name: (dir ? dir + "/" : "") + f, bytes: st.size });
    }
  }
  const sinceSim = sim.simSec - 86400;
  res.json({
    ...status(), uptimeSec: Math.round(process.uptime()), serverStartedAt: startedAt, memMB: Math.round(process.memoryUsage().rss / 1048576),
    pets: sim.pets.map((p) => ({
      id: p.id, name: p.name, color: p.color, energy: Math.round(p.energy), mode: p.mode, action: p.s1.action, stats: p.stats,
      beliefs: p.mind.beliefs.length, claims: p.mind.claims.length, intention: p.mind.intention?.goal ?? null,
    })),
    comms: {
      total: comms.length,
      fromHuman: comms.filter((u) => u.from.kind === "human").length,
      petInitiative: pet.filter((u) => u.trace?.kind === "initiative").length,
      petReplies: pet.filter((u) => u.trace?.kind === "reply").length,
      lastRealHour: pet.filter((u) => nowMs - realMs(u.id) < 3600_000).length,
      lastSimDay: pet.filter((u) => u.tSec > sinceSim).length,
    },
    storage: files.sort((a, b) => b.bytes - a.bytes),
  });
});

let lastLoggedHour = Math.floor(world.snap.simMinute / 60);
let lastMetricsQuarter = Math.floor(world.snap.simMinute / 15);

let lastTickAt = Date.now();

async function tick() {
  const now = Date.now();
  const realDt = Math.min((now - lastTickAt) / 1000, 1);
  lastTickAt = now;
  const fresh = now - input.at < 500;
  sim.moveHuman(fresh ? input.dx : 0, fresh ? input.dy : 0, realDt);
  clock.advance();
  // Cap work per tick so 1000x speed cannot starve the event loop; the world catches up on later ticks.
  system2.tick();
  const { events, thoughts } = sim.step(clock.simTimeMs, 400);
  for (const ev of events) await store.append("events", ev);
  for (const th of thoughts) await store.append(`thoughts/${th.pet}`, th);

  const quarter = Math.floor(world.snap.simMinute / 15);
  if (quarter !== lastMetricsQuarter) {
    lastMetricsQuarter = quarter;
    await store.append("metrics", sim.metrics());
  }
  const hour = Math.floor(world.snap.simMinute / 60);
  if (hour !== lastLoggedHour) {
    lastLoggedHour = hour;
    const p = clock.parts;
    await store.append("world", { simMinute: world.snap.simMinute, day: p.day, hour: p.hour, ...world.env });
  }
  broadcast({ type: "status", ...status(), ...worldView() });
  if (events.length) broadcast({ type: "events", events: events.filter((e) => e.type !== "speed_changed") });
}

let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  tick().catch((e) => console.error("tick failed", e)).finally(() => (ticking = false));
}, 250);

async function save() {
  await store.writeJson("clock.json", { simMs: clock.simTimeMs, speed: clock.speed });
  await store.writeJson("world.json", world.snap);
  await store.writeJson("pets.json", sim.snapshot());
  await store.writeJson("llm.json", llm.snapshot());
}
setInterval(() => void save().catch((e) => console.error("save failed", e)), 30_000);

// Railway sends SIGTERM on redeploy: save so the pets' world resumes exactly where it stopped.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    save().finally(() => process.exit(0));
  });
}

await store.append("events", { type: "server_started", detail: `seed ${SEED}`, ...clock.parts });
server.listen(PORT, () => console.log(`1000pets listening on :${PORT}, data in ${store.dir}`));
