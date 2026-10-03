import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SimClock, SPEEDS } from "./clock.js";
import { Store } from "./store.js";
import { OBJECTS, ROOM, World, type WorldEvent, type WorldSnapshot } from "./world.js";

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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function status() {
  return { runId: RUN_ID, simTimeMs: clock.simTimeMs, ...clock.parts, speed: clock.speed, paused: clock.paused };
}

function worldView() {
  return { env: world.env, sunPatch: world.sunPatch() };
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

function broadcast(payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
}

let lastLoggedHour = Math.floor(world.snap.simMinute / 60);

async function tick() {
  clock.advance();
  // Cap work per tick so 1000x speed cannot starve the event loop; the world catches up on later ticks.
  const events: WorldEvent[] = world.step(clock.simTimeMs, 2000);
  for (const ev of events) await store.append("events", ev);

  const hour = Math.floor(world.snap.simMinute / 60);
  if (hour !== lastLoggedHour) {
    lastLoggedHour = hour;
    const p = clock.parts;
    await store.append("world", { simMinute: world.snap.simMinute, day: p.day, hour: p.hour, ...world.env });
  }
  broadcast({ type: "status", ...status(), ...worldView() });
  if (events.length) broadcast({ type: "events", events });
}

let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  tick().catch((e) => console.error("tick failed", e)).finally(() => (ticking = false));
}, 1000);

async function save() {
  await store.writeJson("clock.json", { simMs: clock.simTimeMs, speed: clock.speed });
  await store.writeJson("world.json", world.snap);
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
