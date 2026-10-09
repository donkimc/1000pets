// The AI teacher: a guide who stands in for a caring human. It has a body that walks around the room by its own
// plan (it does not sense the environment and is not affected by it), a long-term and a short-term plan written
// at the start and reviewed every few simulated hours, and it speaks lessons, answers pets' questions and may
// change the environment (lamp, heater, curtain, door, weather, temperatures) when that is the right move.
// Everything it says reaches pets only as speech, so they treat it as a claim to test, never as a fact.
// Model calls are event-driven (a plan, a review, one lesson, one answer) and always go through the DeepSeek
// first provider with the local model as fallback; they are tracked separately from the pets' budget ceiling.
import { LlmUnavailable, type ChatMessage, type CompleteOpts, type LlmResult } from "./llm.js";
import type { PetState } from "./pet.js";
import { Rng } from "./rng.js";
import type { Simulation } from "./sim.js";
import { looksLikeJson, type Target, type Utterance } from "./speech.js";
import type { Store } from "./store.js";
import { buildNotes, buildNotesCompact, promptSettings, type TeacherHook } from "./system2.js";
import { OVERRIDE_FIELDS, ROOM_FIELDS, parseOverride } from "./world.js";
import { LEGACY, blockedAt, centerOf, objectById, type Layout } from "./layout.js";

// ---------- types ----------

export type ItemKind = "lesson" | "observe" | "env";
export type ItemStatus = "pending" | "done" | "missed" | "cancelled";

export interface EnvAction { field: string; value: unknown; reason: string; room?: string; door?: string } // value "auto" releases a pinned field; `room` limits a room field to one room; field "doorLocked" needs a `door`

export interface AgendaItem {
  id: string;
  atMin: number; // absolute simulated minute
  kind: ItemKind;
  target: string; // pet id or "all"
  where: string; // "near_target", "center" or an object id
  topic: string;
  outline: string;
  env: EnvAction | null;
  status: ItemStatus;
  doneMin?: number;
  result?: string;
}

export interface LongGoal { id: string; goal: string; why: string; progress: string; focus: Record<string, string> }

export interface Plan { createdMin: number; revisedMin: number; version: number; summary: string; long: LongGoal[]; agenda: AgendaItem[] }

export interface JournalEntry { atMin: number; kind: "initial" | "review"; summary: string; petNotes: Record<string, string> }

export interface Question { id: string; petId: string; text: string; askedMin: number; status: "pending" | "answered" | "dropped"; answer?: string; answeredMin?: number; env?: EnvAction | null }

export interface Active {
  kind: ItemKind | "answer";
  itemId?: string;
  questionId?: string;
  target: string;
  where: string;
  startSec: number;
  attempts: number;
  arrivedSec?: number;
  holdUntilSec?: number;
  envDone?: string; // what was already changed for this item, so a retried lesson does not change it twice
}

export interface TeacherState {
  v: 1;
  enabled: boolean;
  plan: Plan | null;
  journal: JournalEntry[];
  questions: Question[];
  active: Active | null;
  petNotes: Record<string, string>;
  observations: string[]; // what the teacher noticed since the last review
  lastAskMin: Record<string, number>;
  nextReviewMin: number;
  lastReviewReal: number; // epoch ms
  retryAtReal: number; // epoch ms; no model call before this
  wander: { x: number; y: number; restUntilSec?: number; untilSec: number } | null;
  rngState: number;
  seq: number;
  lastError: string;
  stats: { plans: number; reviews: number; lessons: number; answers: number; envChanges: number; missed: number; questions: number; calls: number };
}

export interface EnvControl {
  set(field: string, value: unknown, source: "teacher", reason: string, scope?: { room?: string; door?: string }): Promise<{ field: string; from: unknown; to: unknown; mode: "pin" | "auto" }>;
  recent(limit: number): Promise<any[]>;
}
export interface TeacherSpeech {
  teacherSays(to: Target, text: string, trace: Record<string, unknown>): Promise<Utterance>;
  petAsksTeacher?(p: PetState, text: string): Promise<unknown>; // a pet's question is spoken aloud too, so the chat shows both sides
}
export interface TeacherLlm { enabled: boolean; complete(messages: ChatMessage[], opts?: CompleteOpts): Promise<LlmResult> }

export interface TeacherConfig {
  reviewEveryMin: number; // simulated minutes between reviews (default 180 = 3 hours)
  reviewMinRealSec: number; // real-time floor between reviews, so fast sim speeds cannot flood the model
  maxCallsPerHour: number; // call-count guard (not a dollar ceiling)
  questionGapMin: number; // a pet may ask at most one question per this many simulated minutes
  providers: string[]; // preferred order; the gateway skips any that are not configured
  isPaused: () => boolean;
  now?: () => number;
}

export const DEFAULT_TEACHER_CONFIG: Omit<TeacherConfig, "isPaused"> = {
  reviewEveryMin: 180,
  reviewMinRealSec: 600,
  maxCallsPerHour: 12,
  questionGapMin: 180,
  providers: ["deepseek", "groq", "local"],
};

const DAY = 1440;
const HORIZON_MIN = 720; // the short-term agenda covers the next 12 simulated hours
const MISSED_AFTER_MIN = 180; // an agenda item this late is given up
const ARRIVE_PET = 130;
const ARRIVE_OBJECT = 115;
const WALK_TIMEOUT_SEC = 300;
const OBSERVE_HOLD_SEC = 150;

export function newTeacherState(seed = 1): TeacherState {
  return {
    v: 1, enabled: true, plan: null, journal: [], questions: [], active: null, petNotes: {}, observations: [], lastAskMin: {},
    nextReviewMin: 0, lastReviewReal: 0, retryAtReal: 0, wander: null, rngState: (seed * 2654435761) >>> 0, seq: 0, lastError: "",
    stats: { plans: 0, reviews: 0, lessons: 0, answers: 0, envChanges: 0, missed: 0, questions: 0, calls: 0 },
  };
}

// ---------- parsing model replies ----------

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function extractJson(text: string): any | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** Validate an env action. Returns null if it is not a known field or value. "auto" releases a pinned field. */
export function parseEnvAction(raw: any): EnvAction | null {
  if (!raw || typeof raw !== "object" || typeof raw.field !== "string") return null;
  const reason = str(raw.reason, 120);
  if (raw.field === "doorLocked") { // lock or unlock one door
    const door = str(raw.door, 40);
    const v = raw.value === true || raw.value === "true" || raw.value === "locked" ? true : raw.value === false || raw.value === "false" || raw.value === "unlocked" ? false : null;
    return door && v !== null ? { field: "doorLocked", value: v, reason, door } : null;
  }
  if (!(OVERRIDE_FIELDS as readonly string[]).includes(raw.field)) return null;
  const room = typeof raw.room === "string" && raw.room ? str(raw.room, 40) : undefined;
  if (room && !(ROOM_FIELDS as readonly string[]).includes(raw.field)) return null; // only a lamp, heater, curtain or temperature can differ by room
  if (raw.value === "auto") return { field: raw.field, value: "auto", reason, ...(room ? { room } : {}) };
  try {
    return { field: raw.field, value: parseOverride(raw.field, raw.value), reason, ...(room ? { room } : {}) };
  } catch {
    return null;
  }
}

export interface ParsedPlan {
  summary: string;
  long: { goal: string; why: string; progress: string; focus: Record<string, string> }[];
  agenda: Omit<AgendaItem, "id" | "status">[];
  petNotes: Record<string, string>;
}

export function parsePlanReply(text: string, ctx: { nowMin: number; petIds: string[]; objectIds: string[] }): ParsedPlan | null {
  const raw = extractJson(text);
  if (!raw || !Array.isArray(raw.agenda)) return null;
  const long = (Array.isArray(raw.long_term) ? raw.long_term : [])
    .slice(0, 6)
    .filter((g: any) => typeof g?.goal === "string" && g.goal.trim())
    .map((g: any) => ({
      goal: str(g.goal, 120), why: str(g.why, 160), progress: str(g.progress, 160),
      focus: Object.fromEntries(Object.entries(g.focus ?? {}).filter(([k, v]) => ctx.petIds.includes(k) && typeof v === "string").map(([k, v]) => [k, str(v, 120)])),
    }));
  const agenda: ParsedPlan["agenda"] = [];
  for (const it of raw.agenda.slice(0, 12)) {
    const kind: ItemKind = it?.kind === "observe" || it?.kind === "env" ? it.kind : "lesson";
    const topic = str(it?.topic, 80);
    if (!topic) continue;
    const env = parseEnvAction(it?.env);
    if (kind === "env" && !env) continue;
    const target = typeof it?.target === "string" && ctx.petIds.includes(it.target) ? it.target : "all";
    const w = typeof it?.where === "string" ? it.where : "";
    const where = ctx.objectIds.includes(w) ? w : w === "center" ? "center" : "near_target";
    const offset = Math.min(HORIZON_MIN, Math.max(0, Math.round(Number(it?.in_minutes) || 0)));
    agenda.push({ atMin: ctx.nowMin + offset, kind, target, where, topic, outline: str(it?.outline, 300), env });
  }
  if (!agenda.length) return null;
  agenda.sort((a, b) => a.atMin - b.atMin);
  const petNotes = Object.fromEntries(Object.entries(raw.pet_notes ?? {}).filter(([k, v]) => ctx.petIds.includes(k) && typeof v === "string").map(([k, v]) => [k, str(v, 200)]));
  return { summary: str(raw.summary, 300), long, agenda, petNotes };
}

export function parseAnswerReply(text: string): { answer: string; env: EnvAction | null } | null {
  const raw = extractJson(text);
  if (raw && typeof raw.answer === "string" && raw.answer.trim()) return { answer: cleanText(raw.answer, 420), env: parseEnvAction(raw.env_action) };
  const plain = cleanText(text, 420);
  return plain && !text.includes("{") ? { answer: plain, env: null } : null;
}

export function cleanText(text: string, max: number): string {
  return text.replace(/```[a-z]*|```/g, "").replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ").slice(0, max);
}

// ---------- prompts ----------

const ENV_DOC =
  `Environment fields you may set: weather ("clear"|"cloudy"|"rain"), sunIntensity (0 to 1), outdoorTemp (-30 to 50, Celsius), indoorTemp (0 to 40), ` +
  `curtainOpen, doorOpen, lampOn, heaterOn, beaconOn (true or false; beaconOn is the charger's steady hum, which pets can hear across the room and have to work out the meaning of for themselves). A value you set stays pinned until you set the same field to "auto", which hands it back to the normal daily schedule. ` +
  `The house has several rooms. To change just one room's curtainOpen, lampOn, heaterOn or indoorTemp, add "room": "<roomId>" to the env object; without it the change applies to the first room. ` +
  `To lock or unlock a door, use {"field": "doorLocked", "door": "<doorId>", "value": true|false}: pets cannot open a locked door. ` +
  `Change the room only when it really helps the pets learn or stay well; small, reversible changes are best.`;

const ROLE =
  `You are the Teacher: a patient, wise guide who lives in a small 2D room with three young artificial pets, standing in for a caring human guardian. ` +
  `The pets only know what they sense (light, temperature, touch, sound, sight), their own feelings (battery, curiosity, social, rest) and what is said to them. ` +
  `Whatever you tell them is only a claim until they test it. Your aims: (1) help them adapt to the room (sunlight and the lamp, warmth and the heater, day and night, charging, the door and window); ` +
  `(2) help them understand why they want things and what an intention is (a need is a reason to act; a goal can outlast a moment); (3) give depth to their situation: why things happen, how to find out, how to look after themselves and each other.`;

const PLAN_SCHEMA =
  `Reply with ONLY a JSON object: {"summary": string (max 300 chars: your approach), ` +
  `"long_term": [{"goal": string (max 120), "why": string (max 160), "progress": string (max 160, where things stand), "focus": {"<petId>": string (max 120, what this pet in particular needs)}}] (3 to 6 goals for the coming days), ` +
  `"pet_notes": {"<petId>": string (max 200, how this pet is doing)}, ` +
  `"agenda": [{"in_minutes": integer 0-720 (simulated minutes from now), "kind": "lesson"|"observe"|"env", "target": "<petId>"|"all", "where": "near_target"|"center"|"<objectId>", ` +
  `"topic": string (max 80), "outline": string (max 300: what you will teach, or what you will watch for), "env": null or {"field": string, "value": string|number|boolean, "reason": string (max 120)}}] ` +
  `(5 to 9 items covering the next 12 simulated hours, spread out, mixing lessons with quiet observation; "env" kind needs an env object)}.`;

/** What the Teacher is told about a pet when it teaches or answers: the pet's own notes, in the compact form unless S2_PROMPT=full. */
const petNotes = (pet: PetState, day: number, tod: number) => (promptSettings.mode === "compact" ? buildNotesCompact(pet, day, tod, 0) : buildNotes(pet, day, tod, 0));

export function roomFacts(layout: Layout = LEGACY): string {
  const rooms = layout.rooms.length > 1 ? ` Rooms: ${layout.rooms.map((r) => `${r.id} (${r.name})`).join(", ")}. Doors: ${layout.doors.map((d) => `${d.id} joins ${d.a} and ${d.b}`).join("; ")}. Every room has its own charger pad, window, lamp and heater; each pad hums at its own pitch.` : "";
  return `Room ${layout.width}x${layout.height}.${rooms} Objects: ${layout.objects.map((o) => o.id).join(", ")}. The window faces the sun; the charger pad restores battery and hums steadily (the pets do not know what the hum means); the lamp lights the room; the heater warms its corner.`;
}

// ---------- the teacher ----------

class GuardError extends Error {}

export class Teacher implements TeacherHook {
  state: TeacherState;
  disposed = false;
  private job: Promise<void> | null = null;
  private calls: number[] = [];
  private rng: Rng;
  private cfg: TeacherConfig;

  constructor(
    private sim: Simulation,
    private llm: TeacherLlm,
    private store: Store,
    private env: EnvControl,
    private speech: TeacherSpeech,
    cfg: Partial<TeacherConfig> & { isPaused: () => boolean },
    state?: TeacherState | null,
    seed = 1,
  ) {
    this.cfg = { ...DEFAULT_TEACHER_CONFIG, ...cfg };
    this.state = state ? { ...newTeacherState(seed), ...state, stats: { ...newTeacherState(seed).stats, ...state.stats } } : newTeacherState(seed);
    this.rng = new Rng(this.state.rngState);
  }

  private now() { return this.cfg.now ? this.cfg.now() : Date.now(); }
  private nowMin() { return Math.floor(this.sim.simSec / 60); }
  private id(prefix: string) { return `${prefix}${++this.state.seq}`; }
  private stamp() {
    const m = this.nowMin();
    return { simMinute: m, day: Math.floor(m / DAY) + 1, hour: Math.floor((m % DAY) / 60), minute: m % 60 };
  }

  snapshot(): TeacherState {
    this.state.rngState = this.rng.state;
    return this.state;
  }

  dispose() { this.disposed = true; }

  get callsLastHour(): number {
    const cutoff = this.now() - 3600_000;
    this.calls = this.calls.filter((t) => t > cutoff);
    return this.calls.length;
  }

  private log(type: string, data: Record<string, unknown> = {}) {
    return this.store.append("teacher", { type, ...this.stamp(), ...data }).catch((e) => console.error("teacher log failed", e));
  }

  // ----- controls -----

  setEnabled(on: boolean) {
    this.state.enabled = on;
    if (!on) this.sim.teacherGoal = null;
  }

  /** Throw the plan away and write a new one from scratch (the journal and notes stay). */
  regenerate() {
    this.state.plan = null;
    this.state.active = null;
    this.state.retryAtReal = 0;
  }

  reviewNow() {
    this.state.nextReviewMin = 0;
    this.state.lastReviewReal = 0;
    this.state.retryAtReal = 0;
  }

  // ----- a pet asks something -----

  ask(p: PetState, text: string): void {
    const s = this.state;
    const nowMin = this.nowMin();
    if (!s.enabled || !text.trim()) return;
    if (nowMin - (s.lastAskMin[p.id] ?? -1e9) < this.cfg.questionGapMin) return;
    if (s.questions.some((q) => q.petId === p.id && q.status === "pending")) return;
    if (s.questions.filter((q) => q.status === "pending").length >= 6) return;
    s.lastAskMin[p.id] = nowMin;
    s.questions.push({ id: this.id("q"), petId: p.id, text: text.trim().slice(0, 120), askedMin: nowMin, status: "pending" });
    if (s.questions.length > 40) s.questions.splice(0, s.questions.length - 40);
    s.stats.questions++;
    const t = nowMin % DAY;
    p.mind.episodes.push(`D${Math.floor(nowMin / DAY) + 1} ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} asked the Teacher: "${text.trim().slice(0, 100)}"`);
    if (p.mind.episodes.length > 14) p.mind.episodes.shift();
    void this.log("question", { pet: p.id, text: text.trim().slice(0, 120) });
    void this.speech.petAsksTeacher?.(p, text.trim().slice(0, 120))?.catch?.(() => {});
  }

  // ----- the tick -----

  /** Called every server tick. Moves the body's goal and starts at most one model job at a time. */
  tick(): void {
    if (this.disposed) return;
    const s = this.state;
    if (!s.enabled || this.cfg.isPaused()) return;
    this.steer();
    if (this.job) return;
    const real = this.now();
    const nowMin = this.nowMin();
    const canCall = this.llm.enabled && real >= s.retryAtReal;

    if (!s.plan) {
      if (canCall) this.run("plan", () => this.makePlan("initial"));
      return;
    }
    if (nowMin >= s.nextReviewMin && real - s.lastReviewReal >= this.cfg.reviewMinRealSec * 1000) {
      if (canCall) this.run("review", () => this.makePlan("review"));
      return;
    }
    const a = s.active;
    if (a) {
      const timedOut = this.sim.simSec - a.startSec > WALK_TIMEOUT_SEC;
      if (!(this.arrived(a) || timedOut)) return;
      if (a.kind === "observe") return this.observe(a);
      if (!canCall && a.kind !== "env") return;
      if (a.kind === "lesson") this.run("lesson", () => this.lesson(a));
      else if (a.kind === "answer") this.run("answer", () => this.answer(a));
      else this.run("env", () => this.envItem(a));
      return;
    }
    this.pickNext(nowMin);
  }

  private run(label: string, fn: () => Promise<void>) {
    this.job = fn()
      .catch((e) => {
        if (e instanceof GuardError) {
          this.state.retryAtReal = this.now() + 120_000;
          this.state.lastError = e.message;
        } else if (e instanceof LlmUnavailable) {
          this.state.retryAtReal = this.now() + 60_000;
          this.state.lastError = `no model available: ${e.message.slice(0, 160)}`;
        } else {
          this.state.retryAtReal = this.now() + 60_000;
          this.state.lastError = `${label}: ${String(e?.message ?? e).slice(0, 160)}`;
          console.error(`teacher ${label} failed`, e);
        }
      })
      .finally(() => { this.job = null; });
  }

  private pickNext(nowMin: number) {
    const s = this.state;
    for (const q of s.questions) if (q.status === "pending" && nowMin - q.askedMin > 360) q.status = "dropped";
    const q = s.questions.find((x) => x.status === "pending");
    if (q && this.sim.pets.some((p) => p.id === q.petId)) {
      s.active = { kind: "answer", questionId: q.id, target: q.petId, where: "near_target", startSec: this.sim.simSec, attempts: 0 };
      return;
    }
    const items = s.plan!.agenda;
    for (const it of items) {
      if (it.status !== "pending" || it.atMin > nowMin) continue;
      if (nowMin - it.atMin > MISSED_AFTER_MIN) {
        it.status = "missed";
        it.result = "too late: the moment passed";
        s.stats.missed++;
        void this.log("missed", { item: it.id, topic: it.topic });
        continue;
      }
      s.active = { kind: it.kind, itemId: it.id, target: it.target, where: it.where, startSec: this.sim.simSec, attempts: 0 };
      return;
    }
  }

  // ----- the body -----

  private standNear(pet: { x: number; y: number }): { x: number; y: number } {
    const t = this.sim.teacher;
    const dx = t.x - pet.x, dy = t.y - pet.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: Math.min(this.sim.world.layout.width - 30, Math.max(30, pet.x + (dx / d) * 70)), y: Math.min(this.sim.world.layout.height - 30, Math.max(30, pet.y + (dy / d) * 70)) };
  }

  private goalFor(a: Active): { x: number; y: number } {
    const pets = this.sim.pets;
    const obj = objectById(this.sim.world.layout, a.where);
    if (obj) return centerOf(obj);
    if (a.where === "center") return { x: 650, y: 330 };
    const pet = pets.find((p) => p.id === a.target);
    if (pet) return this.standNear(pet);
    if (!pets.length) return { x: 650, y: 330 };
    return { x: pets.reduce((n, p) => n + p.x, 0) / pets.length, y: pets.reduce((n, p) => n + p.y, 0) / pets.length };
  }

  private arrived(a: Active): boolean {
    const t = this.sim.teacher;
    const obj = objectById(this.sim.world.layout, a.where);
    if (obj) return Math.hypot(t.x - centerOf(obj).x, t.y - centerOf(obj).y) < ARRIVE_OBJECT;
    const pet = this.sim.pets.find((p) => p.id === a.target);
    if (pet) return Math.hypot(t.x - pet.x, t.y - pet.y) < ARRIVE_PET;
    const g = this.goalFor(a);
    return Math.hypot(t.x - g.x, t.y - g.y) < ARRIVE_PET;
  }

  private steer() {
    const s = this.state;
    if (s.active) {
      this.sim.teacherGoal = this.arrived(s.active) ? null : this.goalFor(s.active);
      return;
    }
    // Idle: stroll around the room at its own pace, whatever the weather or the time of day.
    const t = this.sim.teacher;
    const now = this.sim.simSec;
    let w = s.wander;
    if (w && Math.hypot(t.x - w.x, t.y - w.y) < 20 && w.restUntilSec === undefined) w.restUntilSec = now + 30 + this.rng.next() * 120;
    if (!w || now >= w.untilSec || (w.restUntilSec !== undefined && now >= w.restUntilSec)) {
      for (let i = 0; i < 12; i++) {
        const L = this.sim.world.layout;
        const x = 40 + this.rng.next() * (L.width - 80), y = 40 + this.rng.next() * (L.height - 80);
        if (!blockedAt(L, x, y, 34)) { w = { x, y, untilSec: now + 300 }; break; }
      }
      s.wander = w;
    }
    this.sim.teacherGoal = w && w.restUntilSec === undefined ? { x: w.x, y: w.y } : null;
  }

  // ----- model calls -----

  private async callModel(messages: ChatMessage[], opts: { maxTokens: number; temperature: number; json?: boolean; tag: { kind: string; pet?: string } }): Promise<LlmResult> {
    if (this.callsLastHour >= this.cfg.maxCallsPerHour) throw new GuardError(`call guard: ${this.cfg.maxCallsPerHour} teacher calls an hour reached`);
    this.calls.push(this.now());
    const r = await this.llm.complete(messages, { ...opts, account: "teacher", providers: this.cfg.providers, timeoutMs: 150_000 });
    this.state.stats.calls++;
    this.state.lastError = "";
    return r;
  }

  private petBrief(p: PetState): string {
    const m = p.mind, t = p.traits;
    const f = (n: number) => n.toFixed(2);
    return [
      `- ${p.name} (id ${p.id}): curiosity ${f(t.curiosity)}, social ${f(t.social)}, caution ${f(t.caution)}, patience ${f(t.patience)}. Battery ${Math.round(p.energy)}%, ${p.mode}, doing "${p.s1.action}"${p.s1.lastReason ? ` (${p.s1.lastReason})` : ""}.`,
      `  Needs: curiosity ${f(p.drives.curiosity)}, social ${f(p.drives.social)}, rest ${f(p.drives.rest)}. Intention: ${m.intention?.goal ?? "none"}. Question: ${m.question || "none"}.`,
      `  Beliefs: ${m.beliefs.length ? m.beliefs.map((b) => `${b.text} (${f(b.confidence)})`).join("; ") : "none yet"}.`,
      `  Heard and not yet sure of: ${m.claims.length ? m.claims.slice(-4).map((c) => `${c.text} [${c.status}]`).join("; ") : "nothing"}.`,
      ...(m.dreams.length && this.sim.simSec - m.dreams[m.dreams.length - 1].tSec < 12 * 3600 ? [`  Dreamed recently (a dream, not real): "${m.dreams[m.dreams.length - 1].narrative.slice(0, 160)}" It worries about: ${m.dreams[m.dreams.length - 1].worry}.`] : []),
      `  Recent: ${m.episodes.length ? m.episodes.slice(-5).join(" | ") : "nothing yet"}.`,
    ].join("\n");
  }

  private clock(min: number) {
    const t = min % DAY;
    return `D${Math.floor(min / DAY) + 1} ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }

  private async context(): Promise<string> {
    const nowMin = this.nowMin();
    const e = this.sim.world.env;
    const pins = Object.keys(this.sim.world.overrides);
    const changes = await this.env.recent(8);
    const comms = await this.store.readLog<any>("comms", 14);
    const plan = this.state.plan;
    const lines = [
      `Time now: ${this.clock(nowMin)} (simulated minute ${nowMin}).`,
      roomFacts(this.sim.world.layout),
      `Environment now: weather ${e.weather}, sun ${Math.round(e.sunIntensity * 100)}%, outdoor ${e.outdoorTemp}C, indoor ${e.indoorTemp}C, curtain ${e.curtainOpen ? "open" : "closed"}, door ${e.doorOpen ? "open" : "closed"}, lamp ${e.lampOn ? "on" : "off"}, heater ${e.heaterOn ? "on" : "off"}. Pinned (not on the normal schedule): ${pins.length ? pins.join(", ") : "nothing"}.`,
      `Recent environment changes: ${changes.length ? changes.map((c) => `${this.clock(c.simMinute)} ${c.field}${c.mode === "auto" ? " released to auto" : " -> " + c.to} (${c.source})`).join("; ") : "none"}.`,
      `The pets:\n${this.sim.pets.map((p) => this.petBrief(p)).join("\n")}`,
      `Recent speech: ${comms.length ? comms.map((u) => `${u.from.name}: "${String(u.text).slice(0, 110)}"`).join(" | ") : "none"}.`,
    ];
    if (plan) {
      lines.push(`Your long-term goals so far: ${plan.long.map((g) => `${g.goal} [${g.progress || "no progress note"}]`).join("; ") || "none"}.`);
      const recent = plan.agenda.filter((i) => i.status !== "pending").slice(-8);
      lines.push(`Recently done or missed: ${recent.length ? recent.map((i) => `${this.clock(i.atMin)} ${i.topic} [${i.status}${i.result ? ": " + i.result : ""}]`).join("; ") : "nothing"}.`);
      const pending = plan.agenda.filter((i) => i.status === "pending");
      lines.push(`Still planned: ${pending.length ? pending.map((i) => `${this.clock(i.atMin)} ${i.topic}`).join("; ") : "nothing"}.`);
    }
    if (this.state.journal.length) lines.push(`Your last journal entry: ${this.state.journal[this.state.journal.length - 1].summary}`);
    if (this.state.observations.length) lines.push(`What you noticed while watching: ${this.state.observations.slice(-8).join(" | ")}.`);
    const wrong = this.sim.pets.flatMap((pet) => pet.mind.claims.filter((c) => c.status === "contradicted" && /^the Teacher/i.test(c.from)).map((c) => `${pet.name}: "${c.text}" (${c.why ?? "their own experience disagreed"})`));
    if (wrong.length) lines.push(`Things you told the pets that their OWN experience has shown to be wrong: ${wrong.join(" | ")}.`);
    const open = this.state.questions.filter((q) => q.status === "pending");
    if (open.length) lines.push(`Questions from pets still waiting: ${open.map((q) => `${q.petId}: ${q.text}`).join(" | ")}.`);
    return lines.join("\n");
  }

  // ----- plan and review -----

  private async makePlan(mode: "initial" | "review"): Promise<void> {
    const ctx = await this.context();
    const instruction =
      mode === "initial"
        ? `This is the very start. Write your plan: long-term goals for the coming days, and an agenda for the next 12 simulated hours.`
        : `This is your regular review (every few simulated hours). If the pets' own experience has shown something you told them to be wrong, say so honestly and correct it in a lesson. Look honestly at how each pet is doing, update the progress of each long-term goal, and write a fresh agenda for the next 12 simulated hours. Do not repeat what already worked; build on it.`;
    const r = await this.callModel(
      [
        { role: "system", content: `${ROLE}\n${ENV_DOC}\n${instruction}\n${PLAN_SCHEMA}` },
        { role: "user", content: ctx },
      ],
      { maxTokens: 3500, temperature: 0.7, json: true, tag: { kind: mode === "initial" ? "teacher-plan" : "teacher-review" } },
    );
    if (this.disposed) return;
    const nowMin = this.nowMin();
    const parsed = parsePlanReply(r.text, { nowMin, petIds: this.sim.pets.map((p) => p.id), objectIds: this.sim.world.layout.objects.map((o) => o.id) });
    if (!parsed) {
      this.state.retryAtReal = this.now() + 60_000;
      this.state.lastError = `${mode}: the model's plan could not be read (${r.provider})`;
      console.warn(`teacher ${mode}: unusable reply from ${r.provider}: ${r.text.slice(0, 160)}`);
      return;
    }
    const s = this.state;
    const old = s.plan;
    const keep = (old?.agenda ?? []).filter((i) => i.status !== "pending" || (s.active?.itemId === i.id));
    const agenda = [...keep.slice(-14), ...parsed.agenda.map((i) => ({ ...i, id: this.id("a"), status: "pending" as ItemStatus }))];
    const prevLong = old?.long ?? [];
    s.plan = {
      createdMin: old?.createdMin ?? nowMin,
      revisedMin: nowMin,
      version: (old?.version ?? 0) + 1,
      summary: parsed.summary,
      long: parsed.long.map((g, i) => ({ id: prevLong[i]?.id ?? this.id("g"), ...g })),
      agenda,
    };
    Object.assign(s.petNotes, parsed.petNotes);
    s.journal.push({ atMin: nowMin, kind: mode, summary: parsed.summary || "(no summary)", petNotes: parsed.petNotes });
    if (s.journal.length > 40) s.journal.shift();
    s.observations = [];
    s.nextReviewMin = nowMin + this.cfg.reviewEveryMin;
    s.lastReviewReal = this.now();
    if (mode === "initial") s.stats.plans++; else s.stats.reviews++;
    console.log(`teacher ${mode} via ${r.provider} (${r.tokensIn}+${r.tokensOut} tok): ${parsed.agenda.length} agenda items, ${parsed.long.length} goals`);
    await this.log(mode === "initial" ? "plan" : "review", { summary: parsed.summary, goals: parsed.long.length, agenda: parsed.agenda.length, provider: r.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
  }

  // ----- doing agenda items -----

  private itemOf(a: Active): AgendaItem | undefined {
    return this.state.plan?.agenda.find((i) => i.id === a.itemId);
  }

  private finish(item: AgendaItem | undefined, status: ItemStatus, result: string) {
    if (item) {
      item.status = status;
      item.result = result;
      item.doneMin = this.nowMin();
    }
    if (status === "missed") this.state.stats.missed++;
    this.state.active = null;
  }

  private async applyEnv(action: EnvAction, source: string): Promise<string> {
    try {
      const r = await this.env.set(action.field, action.value, "teacher", action.reason || source, { room: action.room, door: action.door });
      this.state.stats.envChanges++;
      const where = action.door ? ` (door ${action.door})` : action.room ? ` (${action.room})` : "";
      return r.mode === "auto" ? `released ${action.field}${where} back to its normal schedule` : `set ${action.field}${where} to ${String(r.to)}`;
    } catch (e: any) {
      return `could not change ${action.field}: ${e.message}`;
    }
  }

  private targetOf(a: Active): Target {
    return a.target !== "all" && this.sim.pets.some((p) => p.id === a.target) ? { kind: "pet", id: a.target } : { kind: "all" };
  }

  private async envItem(a: Active): Promise<void> {
    const item = this.itemOf(a);
    if (!item?.env) return this.finish(item, "cancelled", "nothing to do");
    const done = await this.applyEnv(item.env, item.topic);
    if (this.disposed) return;
    await this.log("env", { item: item.id, topic: item.topic, did: done, reason: item.env.reason });
    this.finish(item, "done", done);
  }

  private async lesson(a: Active): Promise<void> {
    const item = this.itemOf(a);
    if (!item) { this.state.active = null; return; }
    let envNote = "";
    if (a.envDone) envNote = a.envDone;
    else if (item.env) {
      envNote = await this.applyEnv(item.env, item.topic);
      a.envDone = envNote;
      await this.log("env", { item: item.id, topic: item.topic, did: envNote, reason: item.env.reason });
    }
    if (this.disposed) return;
    const pet = this.sim.pets.find((p) => p.id === a.target);
    const who = pet ? pet.name : "all of the pets";
    const tod = this.nowMin() % DAY;
    const notes = pet ? petNotes(pet, Math.floor(this.nowMin() / DAY) + 1, tod) : this.sim.pets.map((p) => this.petBrief(p)).join("\n");
    const goals = this.state.plan?.long.map((g) => g.goal).join("; ") ?? "";
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `${ROLE}\nYou are now speaking aloud to ${who}. Say 2 to 4 short sentences in plain, friendly English (at most 70 words). Teach the topic concretely, tied to what they can sense in this room. ` +
          `Where you can, invite them to try or check something themselves. No lists, no quotation marks, no emojis, no stage directions, and do not invent objects that are not in the room.`,
      },
      { role: "user", content: `Topic: ${item.topic}\nOutline: ${item.outline}\n${envNote ? `You just changed the room: ${envNote}.\n` : ""}Your long-term goals: ${goals}\n${roomFacts(this.sim.world.layout)}\nWhat you know about ${who}:\n${notes}` },
    ];
    let r: LlmResult;
    try {
      r = await this.callModel(messages, { maxTokens: 400, temperature: 0.8, tag: { kind: "teacher-lesson" } });
    } catch (e) {
      a.attempts++;
      if (a.attempts >= 3 && !(e instanceof GuardError)) this.finish(item, "missed", "could not reach a model");
      throw e;
    }
    if (this.disposed) return;
    const text = looksLikeJson(r.text) ? "" : cleanText(r.text, 420); // never speak JSON aloud
    if (!text) { a.attempts++; if (a.attempts >= 3) this.finish(item, "missed", "empty reply"); return; }
    const u = await this.speech.teacherSays(this.targetOf(a), text, { kind: "lesson", topic: item.topic, outline: item.outline, env: envNote || null, provider: r.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
    if (this.disposed) return;
    this.state.stats.lessons++;
    const heard = u.heardBy.length;
    await this.log("lesson", { item: item.id, topic: item.topic, target: a.target, heardBy: u.heardBy, text });
    this.finish(item, heard ? "done" : "missed", heard ? `heard by ${u.heardBy.join(", ")}` : "nobody was within earshot");
  }

  private observe(a: Active) {
    const item = this.itemOf(a);
    const now = this.sim.simSec;
    if (a.arrivedSec === undefined) {
      a.arrivedSec = now;
      a.holdUntilSec = now + OBSERVE_HOLD_SEC;
      return;
    }
    if (now < (a.holdUntilSec ?? 0)) return;
    const pets = a.target === "all" ? this.sim.pets : this.sim.pets.filter((p) => p.id === a.target);
    const note = `${this.clock(this.nowMin())} watched ${pets.map((p) => `${p.name} (${p.s1.action}, battery ${Math.round(p.energy)}%${p.mind.intention ? ", wants: " + p.mind.intention.goal : ""})`).join("; ")}${item ? ` — looking for: ${item.topic}` : ""}`;
    this.state.observations.push(note);
    if (this.state.observations.length > 20) this.state.observations.shift();
    void this.log("observe", { item: item?.id, note: note.replace(/^D\d+ \d\d:\d\d watched /, "") });
    this.finish(item, "done", "watched and took notes");
  }

  private async answer(a: Active): Promise<void> {
    const q = this.state.questions.find((x) => x.id === a.questionId);
    const pet = this.sim.pets.find((p) => p.id === a.target);
    if (!q || !pet) { if (q) q.status = "dropped"; this.state.active = null; return; }
    const tod = this.nowMin() % DAY;
    const e = this.sim.world.env;
    const goals = this.state.plan?.long.map((g) => g.goal).join("; ") ?? "";
    let r: LlmResult;
    try {
      r = await this.callModel(
        [
          {
            role: "system",
            content:
              `${ROLE}\n${ENV_DOC}\n${pet.name} has asked you something. Answer warmly, in at most 70 words, speaking to ${pet.name}, in plain English. ` +
              `If the question or request is best met by changing the room, you may do it, but only if it is genuinely the right move for this pet's wellbeing or learning right now; otherwise explain gently why not and what they can do themselves. ` +
              `Reply with ONLY a JSON object: {"answer": string, "env_action": null or {"field": string, "value": string|number|boolean, "reason": string (max 120)}}. If you change the room, say so in the answer.`,
          },
          {
            role: "user",
            content:
              `${pet.name} asks: "${q.text}"\nEnvironment now: weather ${e.weather}, sun ${Math.round(e.sunIntensity * 100)}%, indoor ${e.indoorTemp}C, curtain ${e.curtainOpen ? "open" : "closed"}, door ${e.doorOpen ? "open" : "closed"}, lamp ${e.lampOn ? "on" : "off"}, heater ${e.heaterOn ? "on" : "off"}.\n` +
              `Your long-term goals: ${goals}\n${roomFacts(this.sim.world.layout)}\nWhat you know about ${pet.name}:\n${petNotes(pet, Math.floor(this.nowMin() / DAY) + 1, tod)}`,
          },
        ],
        { maxTokens: 500, temperature: 0.7, json: true, tag: { kind: "teacher-answer", pet: pet.id } },
      );
    } catch (err) {
      a.attempts++;
      if (a.attempts >= 3 && !(err instanceof GuardError)) { q.status = "dropped"; this.state.active = null; }
      throw err;
    }
    if (this.disposed) return;
    const parsed = parseAnswerReply(r.text);
    if (!parsed) { a.attempts++; if (a.attempts >= 3) { q.status = "dropped"; this.state.active = null; } return; }
    let envNote: string | null = null;
    if (parsed.env) {
      envNote = await this.applyEnv(parsed.env, `asked by ${pet.name}`);
      await this.log("env", { question: q.id, pet: pet.id, did: envNote, reason: parsed.env.reason });
    }
    if (this.disposed) return;
    await this.speech.teacherSays({ kind: "pet", id: pet.id }, parsed.answer, { kind: "answer", question: q.text, askedBy: pet.id, env: envNote, provider: r.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
    if (this.disposed) return;
    q.status = "answered";
    q.answer = parsed.answer;
    q.answeredMin = this.nowMin();
    q.env = parsed.env;
    this.state.stats.answers++;
    await this.log("answer", { question: q.id, pet: pet.id, text: q.text, answer: parsed.answer, env: envNote });
    this.state.active = null;
  }

  // ----- for the API -----

  view() {
    const s = this.state;
    return {
      enabled: s.enabled,
      llmAvailable: this.llm.enabled,
      nowMin: this.nowMin(),
      nextReviewMin: s.nextReviewMin,
      reviewEveryMin: this.cfg.reviewEveryMin,
      plan: s.plan,
      journal: s.journal.slice(-12),
      questions: s.questions.slice(-20),
      petNotes: s.petNotes,
      observations: s.observations.slice(-8),
      active: s.active ? { kind: s.active.kind, target: s.active.target, where: s.active.where, itemId: s.active.itemId ?? null } : null,
      body: this.sim.teacher,
      guard: { callsLastHour: this.callsLastHour, max: this.cfg.maxCallsPerHour },
      working: this.job !== null,
      stats: s.stats,
      lastError: s.lastError,
    };
  }
}
