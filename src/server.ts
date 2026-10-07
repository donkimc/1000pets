import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SimClock, SPEEDS } from "./clock.js";
import { Store } from "./store.js";
import { BrainLibrary, Saves } from "./saves.js";
import { Teacher, type EnvControl, type TeacherState } from "./teacher.js";
import { applyBrain, exportBrain, parseBrain } from "./brain.js";
import { describeScene } from "./scenes.js";
import { cueTrust } from "./cues.js";
import { predictView } from "./predict.js";
import { resetRules, ruleView } from "./rules.js";
import { Consolidator } from "./sleep.js";
import { Dreamer } from "./dreams.js";
import { readFileSync } from "node:fs";
import { Simulation, type SimSnapshot } from "./sim.js";
import { TEACHER_VOICE, hueOf, type PetDef } from "./pet.js";
import { HUMAN_HUE } from "./sensors.js";
import { KNOWN_SEC, affinityOf, trustOf } from "./relations.js";
import { keyHz } from "./places.js";
import { gatewayFromEnv, type ProviderStats } from "./llm.js";
import { System2 } from "./system2.js";
import { Conversation } from "./conversation.js";
import type { Target } from "./speech.js";
import { readdir, stat } from "node:fs/promises";
import { OVERRIDE_FIELDS, ROOM_FIELDS, World, type WorldSnapshot } from "./world.js";
import { LAYOUTS, HOUSE } from "./layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const RUN_ID = process.env.RUN_ID ?? "main";
const SEED = Number(process.env.SEED ?? 12345);

const store = await Store.open(DATA_DIR, RUN_ID);
const globalStore = new Store(DATA_DIR); // things that must not change when a save is loaded (the DeepSeek spend)
const saves = new Saves(DATA_DIR);
const brains = new BrainLibrary(DATA_DIR);
const defaultRoster: PetDef[] = JSON.parse(readFileSync(path.join(__dirname, "..", "config", "pets.json"), "utf8"));

// The language-model gateway outlives any single session. Spend is kept outside the run folder, so loading an
// old save can never rewind the DeepSeek ceiling.
const llm = gatewayFromEnv();
llm.restore((await globalStore.readJson<ProviderStats[]>("llm-spend.json")) ?? (await store.readJson<ProviderStats[]>("llm.json")));
console.log(`LLM providers: ${llm.snapshot().map((p) => `${p.name}(${p.model}${p.budgetUsd !== undefined ? `, ceiling $${p.budgetUsd}` : ""})`).join(", ") || "none"}`);

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/vendor/three", express.static(path.join(__dirname, "..", "node_modules", "three", "build"), { maxAge: "7d" })); // the 3D view runs on three.js, served from here so it works offline

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// The human is steered by joystick input over the WebSocket; input goes stale after 0.5 s so a lost
// connection or released finger always stops the avatar.
const input = { dx: 0, dy: 0, at: 0, yaw: undefined as number | undefined };
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (m?.type === "input" && Number.isFinite(m.dx) && Number.isFinite(m.dy)) {
        input.dx = Math.max(-1, Math.min(1, m.dx));
        input.dy = Math.max(-1, Math.min(1, m.dy));
        input.at = Date.now();
        input.yaw = Number.isFinite(m.yaw) ? m.yaw : undefined; // first-person look direction, if the client sends one
      } else if (m?.type === "goto" && Number.isFinite(m.x) && Number.isFinite(m.y) && sim) {
        sim.setHumanGoal(Math.max(0, Math.min(world.layout.width, m.x)), Math.max(0, Math.min(world.layout.height, m.y))); // tapped the map
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


// ---- the live session: clock, world, pets, teacher. Replaced as a whole when a save is loaded. ----
let clock!: SimClock;
let world!: World;
let sim!: Simulation;
let system2!: System2;
let conversation!: Conversation;
let teacher!: Teacher;
let consolidator!: Consolidator;
let dreamer!: Dreamer;
let lastLoggedHour = 0;
let lastMetricsQuarter = 0;
let loading = false;

const stampNow = () => ({ simMinute: Math.floor(sim.simSec / 60), ...clock.parts });

/** Environment control shared by the person and the teacher. Every change is written to env-changes.jsonl. */
async function setEnv(field: string, value: unknown, source: "human" | "teacher", reason = "", scope: { room?: string; door?: string } = {}) {
  let r: { field: string; from: unknown; to: unknown; mode: "pin" | "auto" };
  if (field === "doorLocked") {
    const id = String(scope.door ?? "");
    const from = world.isLocked(id);
    world.setLocked(id, value === true || value === "true");
    r = { field, from, to: world.isLocked(id), mode: "pin" };
  } else if (scope.room) r = world.setRoomOverride(scope.room, field, value);
  else r = world.setOverride(field, value);
  const where = scope.door ? ` ${scope.door}` : scope.room ? ` in ${scope.room}` : "";
  await store.append("env-changes", { ...stampNow(), source, field: r.field, mode: r.mode, from: r.from, to: r.to, reason, ...(scope.room ? { room: scope.room } : {}), ...(scope.door ? { door: scope.door } : {}) });
  const ev = { type: "env_changed", detail: `${source}: ${r.field}${where} ${r.mode === "auto" ? "released to auto" : "-> " + String(r.to)}${reason ? " (" + reason + ")" : ""}`, ...clock.parts };
  await store.append("events", ev);
  broadcast({ type: "events", events: [ev] });
  return r;
}

const AUTO_ENV_EVENTS: Record<string, (detail: string) => { field: string; to: unknown }> = {
  weather_changed: (d) => ({ field: "weather", to: d }),
  curtain_opened: () => ({ field: "curtainOpen", to: true }),
  curtain_closed: () => ({ field: "curtainOpen", to: false }),
  door_opened: () => ({ field: "doorOpen", to: true }),
  door_closed: () => ({ field: "doorOpen", to: false }),
  lamp_on: () => ({ field: "lampOn", to: true }),
  lamp_off: () => ({ field: "lampOn", to: false }),
  heater_on: () => ({ field: "heaterOn", to: true }),
  heater_off: () => ({ field: "heaterOn", to: false }),
};

const envControl: EnvControl = {
  set: (field, value, source, reason, scope) => setEnv(field, value, source, reason, scope),
  recent: (limit) => store.readLog("env-changes", limit),
};

/** Build the live session from the files in the run folder (or from scratch when there are none). */
async function loadSession() {
  const savedClock = await store.readJson<{ simMs: number; speed: number; paused?: boolean }>("clock.json");
  const savedWorld = await store.readJson<WorldSnapshot>("world.json");
  const savedSim = await store.readJson<SimSnapshot>("pets.json");
  const savedTeacher = await store.readJson<TeacherState>("teacher.json");
  if (system2) system2.disposed = true;
  teacher?.dispose();
  if (consolidator) consolidator.disposed = true;
  if (dreamer) dreamer.disposed = true;
  if (conversation) conversation.disposed = true;
  clock = new SimClock(savedClock?.simMs ?? 0);
  if (savedClock && (SPEEDS as readonly number[]).includes(savedClock.speed)) clock.speed = savedClock.speed;
  // A paused world stays paused across restarts and deploys (it used to come back running and spend model calls). START_PAUSED=on makes every start paused.
  if (process.env.START_PAUSED === "on" || savedClock?.paused) clock.setPaused(true);
  // A new run lives in the house. A run saved in the old single room stays there, unless LAYOUT=house moves it into the house.
  const layout = LAYOUTS[process.env.LAYOUT ?? savedWorld?.layoutId ?? (savedWorld ? "legacy" : "house")] ?? HOUSE;
  world = new World(SEED, savedWorld ?? undefined, layout);
  sim = new Simulation(world, SEED, defaultRoster, savedSim ?? undefined);
  if (savedSim?.ruleLearning === undefined) sim.ruleLearning = process.env.RULE_LEARNING === "on"; // off unless switched on; a save remembers its own setting
  system2 = new System2(sim, llm, store, { intervalSec: Number(process.env.S2_INTERVAL_SEC ?? 70), patienceSec: Number(process.env.S2_PATIENCE_SEC ?? 240), deepEvery: Number(process.env.S2_DEEP_EVERY ?? 4), isPaused: () => clock.paused });
  conversation = new Conversation(sim, llm, store, broadcast);
  system2.conversation = conversation;
  teacher = new Teacher(sim, llm, store, envControl, conversation, {
    isPaused: () => clock.paused,
    reviewEveryMin: Number(process.env.TEACHER_REVIEW_SIM_MIN ?? 180),
    reviewMinRealSec: Number(process.env.TEACHER_REVIEW_MIN_REAL_SEC ?? 600),
    maxCallsPerHour: Number(process.env.TEACHER_MAX_CALLS_PER_HOUR ?? 30),
  }, savedTeacher, SEED);
  system2.teacher = teacher;
  consolidator = new Consolidator(sim, llm, store, { isPaused: () => clock.paused });
  dreamer = new Dreamer(sim, llm, store, { isPaused: () => clock.paused });
  lastLoggedHour = Math.floor(world.snap.simMinute / 60);
  lastMetricsQuarter = Math.floor(world.snap.simMinute / 15);
}
await loadSession();

function status() {
  return { runId: RUN_ID, simTimeMs: clock.simTimeMs, ...clock.parts, speed: clock.speed, paused: clock.paused };
}

function petView() {
  return sim.pets.map((p) => ({
    id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y),
    heading: Math.round(p.heading * 100) / 100, mode: p.mode, action: p.s1.action,
    energy: Math.round(p.energy * 10) / 10, drives: p.drives, voice: p.voice,
  }));
}

function humanView() {
  const h = sim.human;
  return { x: Math.round(h.x), y: Math.round(h.y), heading: Math.round(h.heading * 100) / 100, moving: h.moving };
}

function roomsView() {
  return world.layout.rooms.map((r) => ({ id: r.id, name: r.name, ...world.roomEnv(r.id), pinned: r.id === world.primaryRoom ? Object.keys(world.overrides).filter((f) => (ROOM_FIELDS as readonly string[]).includes(f)) : Object.keys(world.snap.roomOverrides?.[r.id] ?? {}) }));
}
function doorsView() {
  return world.layout.doors.map((d) => ({ id: d.id, a: d.a, b: d.b, open: world.isDoorOpen(d.id), locked: world.isLocked(d.id) }));
}

function worldView() {
  const t = sim.teacher;
  return { env: world.env, rooms: roomsView(), doors: doorsView(), sunPatch: world.sunPatch(), sunPatches: Object.fromEntries(world.layout.rooms.map((r) => [r.id, world.sunPatch(r.id)])), pets: petView(), human: humanView(), teacher: { x: Math.round(t.x), y: Math.round(t.y), heading: Math.round(t.heading * 100) / 100, moving: t.moving } };
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
app.get("/api/world", (_req, res) => res.json({ room: { width: world.layout.width, height: world.layout.height }, teacherVoice: TEACHER_VOICE, layout: world.layout, objects: world.layout.objects, ...worldView() }));
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
  const clockOf = (tSec: number) => {
    const m = Math.floor(tSec / 60);
    return `D${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const scenes = [...p.mind.scenes].sort((a, b) => b.tSec - a.tSec).map((s) => ({
    id: s.id, when: clockOf(s.tSec), kind: s.kind, why: s.why, importance: s.importance, view: s.view, grid: s.grid ?? null, uses: s.uses,
    text: describeScene(s, p, clockOf(s.tSec)), pose: s.pose,
  }));
  res.json({ question: p.mind.question, intention: p.mind.intention?.goal ?? null, beliefs: p.mind.beliefs, suggestion: p.mind.suggestion?.kind ?? null, episodes: p.mind.episodes, scenes,
    gists: p.mind.gists.map((g) => ({ id: g.id, text: g.text, confidence: g.confidence, uses: g.uses, sources: g.sources.length, verdict: g.verdict ?? null, why: g.why ?? null })),
    lastSleep: p.mind.lastSleep,
    predict: predictView(p),
    places: p.places ? {
      nodes: Object.values(p.places.nodes).map((n) => ({ id: n.id, kind: n.kind, x: n.x, y: n.y, hz: n.key ? keyHz(n.key) : null, charged: n.charged, visits: n.visits, avoided: (p.places!.avoid[n.id] ?? 0) > sim.simSec })),
      edges: p.places.edges.map((e) => ({ a: e.a, b: e.b, len: e.len, n: e.n, via: e.via })),
      route: p.places.route ? { path: p.places.route.path, step: p.places.route.step } : null,
      here: { x: Math.round(p.odo.x), y: Math.round(p.odo.y) },
    } : null,
    rules: ruleView(p, sim.simSec),
    claims: p.mind.claims.map((c) => ({ text: c.text, from: c.from, status: c.status, why: c.why ?? null })),
    refuted: [...p.mind.refuted].reverse(),
    others: Object.values(p.mind.others ?? {}).sort((a, b) => b.seenSec - a.seenSec).map((r) => {
      // The pet does not know names; the page may say who it really is, by matching the look.
      const who = r.label === "the Teacher" ? "the Teacher" : sim.pets.find((o) => o.id !== p.id && Math.abs(hueOf(o.color) - r.hue) <= 8)?.name ?? (Math.abs(r.hue - HUMAN_HUE) <= 8 ? "the human" : null);
      return { label: r.label, actually: who, minutes: Math.round(r.seenSec / 60), bumps: r.bumps, told: r.told, right: r.right, wrong: r.wrong, trust: r.told ? Math.round(trustOf(r) * 100) / 100 : null, affinity: Math.round(affinityOf(r) * 100) / 100, known: r.seenSec >= KNOWN_SEC };
    }),
    dreams: [...p.mind.dreams].reverse().map((d) => ({ id: d.id, theme: d.theme, narrative: d.narrative, worry: d.worry, twists: d.twists.map((t) => t.text), source: d.source })),
    cues: Object.values(p.mind.cues).map((c) => ({ key: c.key, pitch: c.pitch, minutes: Math.round(c.exposureSec / 60), support: c.support, contra: c.contra, ...cueTrust(c) })) });
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
    rooms: world.layout.rooms.map((r) => ({
      id: r.id, name: r.name, floor: r.floor, ...world.roomEnv(r.id),
      pets: sim.pets.filter((p) => world.roomIdAt(p.x, p.y) === r.id).map((p) => p.name),
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

let lastTickAt = Date.now();

async function tick() {
  if (loading) return;
  const now = Date.now();
  const realDt = Math.min((now - lastTickAt) / 1000, 1);
  lastTickAt = now;
  const fresh = now - input.at < 500;
  sim.moveHuman(fresh ? input.dx : 0, fresh ? input.dy : 0, realDt, fresh ? input.yaw : undefined);
  clock.advance();
  // Cap work per tick so 1000x speed cannot starve the event loop; the world catches up on later ticks.
  system2.tick();
  teacher.tick();
  consolidator.tick();
  dreamer.tick();
  const { events, thoughts } = sim.step(clock.simTimeMs, 400);
  for (const ev of events) {
    await store.append("events", ev);
    const auto = AUTO_ENV_EVENTS[ev.type];
    if (auto) await store.append("env-changes", { simMinute: ev.simMinute, day: ev.day, hour: ev.hour, minute: ev.minute, source: "auto", mode: "auto", ...auto(ev.detail) });
  }
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


// ---- environment control (pin a value, or release it back to the daily schedule) ----
const envView = () => ({ env: world.env, overrides: world.overrides, fields: OVERRIDE_FIELDS, rooms: roomsView(), doors: doorsView() });
app.get("/api/env", (_req, res) => res.json(envView()));
app.post("/api/env", requireAdmin, async (req, res) => {
  try {
    await setEnv(String(req.body?.field ?? ""), req.body?.value === undefined ? null : req.body.value, "human", String(req.body?.reason ?? "").slice(0, 120), { room: req.body?.room ? String(req.body.room) : undefined, door: req.body?.door ? String(req.body.door) : undefined });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
    return;
  }
  res.json(envView());
});
app.post("/api/env/release-all", requireAdmin, async (_req, res) => {
  for (const f of Object.keys(world.overrides)) await setEnv(f, null, "human", "release all");
  for (const [room, pins] of Object.entries(world.snap.roomOverrides ?? {})) for (const f of Object.keys(pins)) await setEnv(f, null, "human", "release all", { room });
  res.json(envView());
});
app.get("/api/env/history", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
  const rows = await store.readLog<any>("env-changes", limit);
  const src = String(req.query.source ?? "");
  res.json((src ? rows.filter((r) => r.source === src) : rows).reverse());
});

// ---- saving and loading the whole simulation ----
async function createSave(name: string, auto = false) {
  await save(); // flush the live state to the run folder first
  const m = clock.parts;
  return saves.create(store.dir, name, { simDay: m.day, simTime: `D${m.day} ${pad2(m.hour)}:${pad2(m.minute)}`, speed: clock.speed, pets: sim.pets.map((p) => p.name) }, auto);
}
const pad2 = (n: number) => String(n).padStart(2, "0");

app.get("/api/saves", async (_req, res) => res.json(await saves.list()));
app.post("/api/saves", requireAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 60) || `Save ${new Date().toLocaleString()}`;
  if (loading) {
    res.status(409).json({ error: "busy loading a save" });
    return;
  }
  res.json(await createSave(name));
});
// A save as one file you can keep, and load back later (here or on another machine).
app.get("/api/saves/:id/download", async (req, res) => {
  try {
    const meta = await saves.get(req.params.id);
    if (!meta) throw new Error("no such save");
    const buf = await saves.exportBundle(meta.id);
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-disposition", `attachment; filename="1000pets-${meta.id}.1000pets"`);
    res.send(buf);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});
app.post("/api/saves/import", requireAdmin, express.raw({ type: () => true, limit: "300mb" }), async (req, res) => {
  if (loading) {
    res.status(409).json({ error: "busy loading a save" });
    return;
  }
  try {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new Error("no file was sent");
    res.json(await saves.importBundle(body, decodeURIComponent(String(req.header("x-file-name") ?? "")).replace(/\.1000pets$/i, "").slice(0, 44) || undefined));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/saves/:id/rename", requireAdmin, async (req, res) => {
  try {
    res.json(await saves.rename(req.params.id, String(req.body?.name ?? "").trim() || "Untitled"));
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});
app.delete("/api/saves/:id", requireAdmin, async (req, res) => {
  try {
    await saves.remove(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});
app.post("/api/saves/:id/load", requireAdmin, async (req, res) => {
  if (loading) {
    res.status(409).json({ error: "already loading" });
    return;
  }
  const meta = await saves.get(req.params.id).catch(() => null);
  if (!meta) {
    res.status(404).json({ error: "no such save" });
    return;
  }
  loading = true;
  try {
    clock.setPaused(true);
    await createSave(`Before loading "${meta.name}"`, true); // so a mistaken load can be undone
    await saves.restore(meta.id, store.dir);
    await loadSession();
    clock.setPaused(true); // look around first, then resume
    await store.append("events", { type: "save_loaded", detail: meta.name, ...clock.parts });
    broadcast({ type: "reloaded" });
    res.json({ ok: true, loaded: meta, status: status() });
  } catch (e: any) {
    console.error("load failed", e);
    res.status(500).json({ error: `load failed: ${e.message}` });
  } finally {
    loading = false;
  }
});

// ---- pet brains: save, download, upload, and put into a pet in this or another simulation ----
async function brainFor(petId: string, label: string, includeBody: boolean) {
  const p = sim.pets.find((x) => x.id === petId);
  if (!p) return null;
  const thoughts = (await store.readLog<any>(`thoughts/${p.id}`, 400)).filter((t) => t.system === 2).slice(-40);
  return exportBrain(p, sim.simSec, { label, thoughts, includeBody });
}
app.get("/api/brains", async (_req, res) => res.json(await brains.list()));
app.get("/api/pets/:id/brain", async (req, res) => {
  const b = await brainFor(req.params.id, String(req.query.label ?? ""), req.query.body === "1");
  if (!b) {
    res.status(404).json({ error: "no such pet" });
    return;
  }
  res.setHeader("content-disposition", `attachment; filename="${b.id}-brain-day${b.simDay}.json"`);
  res.json(b);
});
app.post("/api/pets/:id/brain/save", requireAdmin, async (req, res) => {
  const b = await brainFor(req.params.id, String(req.body?.label ?? "").trim().slice(0, 60), req.body?.includeBody === true);
  if (!b) {
    res.status(404).json({ error: "no such pet" });
    return;
  }
  if (!String(req.body?.label ?? "").trim()) b.label = `${b.name} day ${b.simDay}`;
  res.json({ id: await brains.save(b, b), label: b.label });
});
app.get("/api/brains/:id", async (req, res) => {
  try {
    res.setHeader("content-disposition", `attachment; filename="${req.params.id}.json"`);
    res.json(await brains.read(req.params.id));
  } catch {
    res.status(404).json({ error: "no such brain" });
  }
});
app.delete("/api/brains/:id", requireAdmin, async (req, res) => {
  try {
    await brains.remove(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "no such brain" });
  }
});
app.post("/api/brains/upload", requireAdmin, async (req, res) => {
  try {
    const b = parseBrain(req.body);
    res.json({ id: await brains.save(b, b), label: b.label, name: b.name });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/brains/:id/apply", requireAdmin, async (req, res) => {
  let brain;
  try {
    brain = parseBrain(await brains.read(req.params.id));
  } catch (e: any) {
    res.status(e.code === "ENOENT" ? 404 : 400).json({ error: e.code === "ENOENT" ? "no such brain" : e.message });
    return;
  }
  const mode = req.body?.mode === "new" ? "new" : "replace";
  const includeBody = req.body?.includeBody === true;
  let pet;
  if (mode === "replace") {
    pet = sim.pets.find((p) => p.id === String(req.body?.petId ?? ""));
    if (!pet) {
      res.status(404).json({ error: "pick the pet that should receive this brain" });
      return;
    }
    applyBrain(pet, brain, sim.simSec, { includeBody, adoptIdentity: req.body?.adoptIdentity === true });
  } else {
    let id = brain.id;
    for (let i = 2; sim.pets.some((p) => p.id === id); i++) id = `${brain.id.slice(0, 28)}-${i}`;
    pet = sim.addPet({ id, name: brain.name, color: brain.color, traits: brain.traits, start: { x: 500, y: 300 } });
    applyBrain(pet, brain, sim.simSec, { includeBody: false, adoptIdentity: true });
  }
  for (const t of brain.thoughts) {
    const { ageSec, ...rest } = t;
    await store.append(`thoughts/${pet.id}`, { ...rest, pet: pet.id, tSec: sim.simSec - ageSec, imported: true });
  }
  await store.append("events", { type: "brain_loaded", detail: `${brain.label} -> ${pet.name}`, ...clock.parts });
  res.json({ ok: true, pet: pet.id, pets: petView() });
});

// ---- habits: may pets try tuning their own soft rules? ----
app.get("/api/settings", (_req, res) => res.json({ ruleLearning: sim.ruleLearning }));
app.post("/api/settings", requireAdmin, async (req, res) => {
  if (typeof req.body?.ruleLearning !== "boolean") {
    res.status(400).json({ error: "ruleLearning must be true or false" });
    return;
  }
  sim.ruleLearning = req.body.ruleLearning;
  await store.append("events", { type: "setting_changed", detail: `pets may tune their own habits: ${sim.ruleLearning ? "on" : "off"}`, ...clock.parts });
  res.json({ ruleLearning: sim.ruleLearning });
});
app.post("/api/pets/:id/rules/reset", requireAdmin, async (req, res) => {
  const p = sim.pets.find((x) => x.id === req.params.id);
  if (!p) {
    res.status(404).json({ error: "no such pet" });
    return;
  }
  resetRules(p, sim.simSec);
  await store.append("events", { type: "habits_reset", detail: p.name, ...clock.parts });
  res.json(ruleView(p, sim.simSec));
});

// ---- the teacher ----
app.get("/api/teacher", (_req, res) => res.json(teacher.view()));
app.get("/api/teacher/log", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 60) || 60, 500);
  res.json((await store.readLog("teacher", limit)).reverse());
});
app.post("/api/teacher/enable", requireAdmin, (req, res) => {
  teacher.setEnabled(req.body?.enabled !== false);
  res.json(teacher.view());
});
app.post("/api/teacher/regenerate", requireAdmin, (_req, res) => {
  teacher.regenerate();
  res.json(teacher.view());
});
app.post("/api/teacher/review-now", requireAdmin, (_req, res) => {
  teacher.reviewNow();
  res.json(teacher.view());
});

let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  tick().catch((e) => console.error("tick failed", e)).finally(() => (ticking = false));
}, 250);

async function save() {
  await store.writeJson("clock.json", { simMs: clock.simTimeMs, speed: clock.speed, paused: clock.paused });
  await store.writeJson("world.json", world.snap);
  await store.writeJson("pets.json", sim.snapshot());
  await store.writeJson("teacher.json", teacher.snapshot());
  await globalStore.writeJson("llm-spend.json", llm.snapshot());
}
setInterval(() => { if (!loading) void save().catch((e) => console.error("save failed", e)); }, 30_000);

// Railway sends SIGTERM on redeploy: save so the pets' world resumes exactly where it stopped.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    (loading ? Promise.resolve() : save()).finally(() => process.exit(0));
  });
}

await store.append("events", { type: "server_started", detail: `seed ${SEED}`, ...clock.parts });
server.listen(PORT, () => console.log(`1000pets listening on :${PORT}, data in ${store.dir}`));
