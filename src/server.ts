import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SimClock, SPEEDS } from "./clock.js";
import { Store } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const RUN_ID = process.env.RUN_ID ?? "main";

const store = await Store.open(DATA_DIR, RUN_ID);

// Resume the clock from the last snapshot so a redeploy does not reset the pets' lives.
const saved = await store.readJson<{ simMs: number; speed: number }>("clock.json");
const clock = new SimClock(saved?.simMs ?? 0);
if (saved && (SPEEDS as readonly number[]).includes(saved.speed)) clock.speed = saved.speed;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function status() {
  return { runId: RUN_ID, simTimeMs: clock.simTimeMs, ...clock.parts, speed: clock.speed, paused: clock.paused };
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
app.get("/api/events", async (_req, res) => res.json(await store.readLog("events")));

app.post("/api/speed", requireAdmin, async (req, res) => {
  try {
    clock.setSpeed(Number(req.body?.speed));
  } catch {
    res.status(400).json({ error: `speed must be one of ${SPEEDS.join(", ")}` });
    return;
  }
  await store.append("events", { type: "speed_changed", speed: clock.speed, ...clock.parts });
  res.json(status());
});

app.post("/api/pause", requireAdmin, async (req, res) => {
  clock.setPaused(Boolean(req.body?.paused));
  await store.append("events", { type: clock.paused ? "paused" : "resumed", ...clock.parts });
  res.json(status());
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(payload: unknown) {
  const msg = JSON.stringify(payload);
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
}

// World tick: 1 real second drives the clock; later phases hook the world/pets in here.
setInterval(() => {
  clock.advance();
  broadcast({ type: "status", ...status() });
}, 1000);

// Persist the clock every 30 s so a restart resumes where it left off.
setInterval(() => {
  void store.writeJson("clock.json", { simMs: clock.simTimeMs, speed: clock.speed });
}, 30_000);

await store.append("events", { type: "server_started", ...clock.parts });
server.listen(PORT, () => console.log(`1000pets listening on :${PORT}, data in ${store.dir}`));
