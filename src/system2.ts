// System 2: slow, deliberate thinking. About once a minute of real time per pet it asks itself a question
// through the LLM gateway, updates its beliefs / intention, and may nudge System 1. It runs off the tick
// path: a slow or failed model call never delays the simulation.
import { LlmGateway, LlmUnavailable } from "./llm.js";
import { SUGGESTIONS, type Belief, type PetState, type Suggestion } from "./pet.js";
import type { Simulation } from "./sim.js";
import type { Store } from "./store.js";
import { describeScene, markUsed, selectScenes } from "./scenes.js";
import { describeCues } from "./cues.js";
import { describeExpectations, describeSurprises } from "./predict.js";
import { describeGists, markGistsUsed } from "./sleep.js";
import { copiesDream, dreamLine } from "./dreams.js";
import { copiesRefuted } from "./verify.js";
import { KNOB_NAMES, describeHabits, proposeTune, type KnobName } from "./rules.js";

export interface ParsedThought {
  question: string;
  thought: string;
  beliefs: { text: string; confidence: number }[];
  intention: string | null;
  dropIntention: boolean;
  suggestion: Suggestion;
  say: { to: "nearest" | "all"; meaning: string } | null;
  askTeacher: string | null;
  retract: string[]; // beliefs it now thinks are wrong, quoted as written
  tune: { habit: KnobName; direction: "up" | "down"; why: string } | null; // a small change to one of its habits that it would like to try
}

/**
 * Small models copy the confidence they were shown into the belief text ("Tone is fading (0.98)"). Strip a trailing
 * "(0.98)", "[0.98]", "(confidence 0.98)" or "(98%)", however many times it was copied.
 */
export function cleanBelief(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 4; i++) t = t.replace(/\s*[(\[]\s*(?:how\s+sure|confidence|conf|sure)?\s*[:=]?\s*(?:[01](?:\.\d+)?|\.\d+|\d{1,3}\s*%)\s*[)\]]\s*$/i, "").trim();
  return t;
}

/** Clean every belief and merge any that are now the same. */
export function cleanBeliefs(mind: Pick<PetState["mind"], "beliefs">): void {
  const seen = new Map<string, Belief>();
  for (const b of mind.beliefs) {
    b.text = cleanBelief(b.text);
    const k = b.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const have = seen.get(k);
    if (have) { have.confidence = Math.max(have.confidence, b.confidence); have.updatedSec = Math.max(have.updatedSec, b.updatedSec); }
    else seen.set(k, b);
  }
  mind.beliefs = [...seen.values()].filter((b) => b.text);
}

const WORD = (v: number, lo: string, mid: string, hi: string) => (v < 0.34 ? lo : v < 0.67 ? mid : hi);

/** The pet's own notes: everything a language model is allowed to know about it. */
export function buildNotes(p: PetState, day: number, timeOfDay: number, nearby = 0, nowSec = (day - 1) * 86400 + timeOfDay * 60, withHabits = false): string {
  const t = p.traits;
  const hh = String(Math.floor(timeOfDay / 60)).padStart(2, "0");
  const mm = String(timeOfDay % 60).padStart(2, "0");
  const m = p.mind;
  const clockOf = (tSec: number) => {
    const m = Math.floor(tSec / 60);
    return `D${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const moments = selectScenes(p, nowSec).map((sc) => `- ${describeScene(sc, p, clockOf(sc.tSec))}`);
  return [
    `Time: day ${day}, ${hh}:${mm}.`,
    `Personality: ${WORD(t.curiosity, "not very curious", "somewhat curious", "very curious")}, ${WORD(t.social, "reserved", "moderately social", "very social")}, ${WORD(t.caution, "bold", "fairly careful", "very cautious")}, ${WORD(t.patience, "impatient", "fairly patient", "very patient")}.`,
    `Body: battery ${Math.round(p.energy)}%, currently ${p.mode}, doing "${p.s1.action}"${p.s1.lastReason ? ` because: ${p.s1.lastReason}` : ""}.`,
    `Needs (0-1): curiosity ${p.drives.curiosity.toFixed(2)}, social ${p.drives.social.toFixed(2)}, rest ${p.drives.rest.toFixed(2)}.`,
    `Senses now: light ${m.sensed.light}/100, temperature ${m.sensed.temperature}C${m.sensed.touch ? `, touching: ${m.sensed.touch}` : ""}${m.sensed.heard ? `, hearing ${m.sensed.heard}` : ""}.`,
    `Sees: ${m.sensed.seen.length ? m.sensed.seen.join("; ") : "nothing in view"}.`,
    `Within reach, in any direction (you can sense this even without seeing it): ${m.sensed.near?.length ? m.sensed.near.join("; ") : "nothing"}.`,
    `Within earshot: ${nearby ? `${nearby} other creature${nearby > 1 ? "s" : ""}` : "nobody"}.`,
    `Hearing a steady tone: ${m.sensed.tone || "none right now"}.`,
    `How well I can predict things: ${describeExpectations(p)}`,
    `What has surprised me lately (something I expected did not happen):\n${describeSurprises(p, nowSec).join("\n") || "- (nothing)"}`,
    `What I have worked out about steady tones:\n${describeCues(p).join("\n") || "- (nothing yet)"}`,
    `What I have come to think from looking back over my memories (provisional, from sleep):\n${describeGists(p).join("\n") || "- (nothing yet)"}`,
    dreamLine(p, nowSec) ?? "No recent dream.",
    `Memorable moments:\n${moments.length ? moments.join("\n") : "- (none yet)"}`,
    `Recent experience:\n${m.episodes.length ? m.episodes.slice(-10).map((e) => "- " + e).join("\n") : "- (nothing yet)"}`,
    `Current beliefs:\n${m.beliefs.length ? m.beliefs.map((b) => `- ${b.text} [how sure: ${b.confidence.toFixed(2)}${b.verdict === "contradicted" ? `; my own experience disagrees: ${b.why}` : b.verdict === "supported" ? "; borne out by my experience" : ""}]`).join("\n") : "- (none yet)"}`,
    `Things others told me (claims, NOT verified facts):\n${m.claims.length ? m.claims.slice(-5).map((c) => `- ${c.text} [${c.status}${c.why && c.status !== "unverified" ? `: ${c.why}` : ""}]`).join("\n") : "- (nothing)"}`,
    `Things I believed or was told that my own experience showed to be WRONG (do not take them up again):\n${(m.refuted ?? []).filter((r) => nowSec - r.tSec < 3 * 86400).slice(-3).map((r) => `- ${r.text} (${r.why})`).join("\n") || "- (none)"}`,
    `Questions you asked yourself lately (ask something NEW this time, not one of these): ${m.recentQuestions?.length ? m.recentQuestions.map((q) => `"${q}"`).join(" | ") : "(none yet)"}`,
    ...((m.repeatStreak ?? 0) >= 2 ? [`You have asked the same thing several times in a row. Think about something completely different now: your body, the room, the others, or something you could try.`] : []),
    `Current intention: ${m.intention ? m.intention.goal : "(none)"}`,
    ...(withHabits ? [`My habits (small things about how I live that I am allowed to try changing a little):\n${describeHabits(p, nowSec)}`] : []),
  ].join("\n");
}

export function buildPrompt(p: PetState, day: number, timeOfDay: number, nearby = 0, nowSec?: number, deep = false, habits = false): { system: string; user: string } {
  const system =
    `You are the slow, deliberate inner voice (System 2) of ${p.name}, a small pet living in a simple 2D room with two other pets and a human. A wise Teacher also lives in the room: it explains things, answers questions and can change the room (lamp, heater, curtain, door) when that is a good idea. ` +
    `You are not an assistant. You only know the notes you are given; never invent places, objects or events that are not in the notes. ` +
    `Pick ONE useful question about your situation, reflect on it briefly, and reply with ONLY a JSON object, no other text:\n` +
    `{"question": string (max 100 chars), "thought": string (1-2 sentences, first person), ` +
    `"beliefs": [{"text": string (max 80 chars), "confidence": number 0-1}] (0-3 items, only if the notes support them), ` +
    `"intention": string or null (a goal that could last hours or days, max 80 chars; null keeps your current one), ` +
    `"drop_intention": boolean, ` +
    `"suggestion": one of ${SUGGESTIONS.map((x) => `"${x}"`).join(", ")} (a nudge to your fast System 1), ` +
    `"say": null or {"to": "nearest" or "all", "meaning": string (max 100 chars: what you want to tell or ask, as plain ideas, not a sentence)}, ` +
    `"ask_teacher": null or string (a real question or request for the Teacher, max 120 chars; use it rarely, only when you are truly puzzled or in need of help), ` +
    `"retract": [string] (beliefs of yours, quoted as written, that you now think are wrong; usually empty)` +
    (habits ? `, "tune": null or {"habit": one of ${KNOB_NAMES.map((k) => `"${k}"`).join(", ")}, "direction": "up" or "down", "why": string (max 100 chars)} (a small change to one of your habits to try out; almost always null, and only when something about how you live is not working for you; it is tried for a day and kept only if it truly helps)` : ``) +
    `} ` +
    `Write belief text as plain words only: never copy numbers or "how sure" values into it. Do not ask a question you asked recently; pick something new. ` +
    `Use "say" only if someone is within earshot and you have something genuinely worth telling or asking; otherwise null. ` +
    `Never state as fact something you only heard from others. A dream is not a memory: nothing in a dream happened, so never put anything from a dream in "beliefs"; ` +
    `if a dream's worry seems worth checking, turn it into a question or an intention to look into, not a belief. ` +
    `If your own experience contradicts something you believed or were told, let it go and do not take it up again.`;
  if (!deep) return { system, user: buildNotes(p, day, timeOfDay, nearby, nowSec, habits) };
  // A rare, careful moment: look back over the last few thoughts and correct what was mistaken or stuck in a loop.
  const recent = p.mind.recentThoughts.length ? p.mind.recentThoughts.map((t) => `- ${t}`).join("\n") : "- (none yet)";
  return {
    system: system + ` This is a rare, careful review. Read your last few thoughts below with an honest eye: if any were mistaken, repeated, confused, or went beyond what the notes support, correct them now (put wrong beliefs in "retract" and write the better ones in "beliefs"), and choose a question you have not asked before.`,
    user: `${buildNotes(p, day, timeOfDay, nearby, nowSec, habits)}\nYour last few thoughts (review them):\n${recent}`,
  };
}

/** Pull the first JSON object out of a model reply and validate it. Returns null if unusable. */
export function parseThought(text: string): ParsedThought | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw?.thought !== "string" || !raw.thought.trim()) return null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const beliefs = Array.isArray(raw.beliefs)
    ? raw.beliefs
        .filter((b: any) => typeof b?.text === "string" && b.text.trim())
        .slice(0, 3)
        .map((b: any) => ({ text: cleanBelief(str(b.text, 80)), confidence: Math.max(0, Math.min(1, Number(b.confidence) || 0.5)) }))
        .filter((b: { text: string }) => b.text)
    : [];
  const retract = Array.isArray(raw.retract) ? raw.retract.filter((x: unknown) => typeof x === "string" && x.trim()).slice(0, 3).map((x: string) => cleanBelief(str(x, 80))) : [];
  const suggestion = SUGGESTIONS.includes(raw.suggestion) ? (raw.suggestion as Suggestion) : "none";
  const intention = typeof raw.intention === "string" && raw.intention.trim() ? str(raw.intention, 80) : null;
  const sayMeaning = str(raw.say?.meaning, 100);
  const say = sayMeaning ? { to: raw.say?.to === "all" ? ("all" as const) : ("nearest" as const), meaning: sayMeaning } : null;
  const askTeacher = str(raw.ask_teacher, 120) || null;
  const tune = raw.tune && KNOB_NAMES.includes(raw.tune.habit) && (raw.tune.direction === "up" || raw.tune.direction === "down") ? { habit: raw.tune.habit as KnobName, direction: raw.tune.direction as "up" | "down", why: str(raw.tune.why, 100) || "I thought it over" } : null;
  return { question: str(raw.question, 100), thought: str(raw.thought, 300), beliefs, intention, dropIntention: raw.drop_intention === true, suggestion, say, askTeacher, retract, tune };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const MAX_BELIEFS = 10;

export function applyThought(p: PetState, t: ParsedThought, nowSec: number): void {
  const m = p.mind;
  for (const r of t.retract ?? []) {
    const k = norm(r);
    if (k.length >= 8) m.beliefs = m.beliefs.filter((b) => { const bk = norm(b.text); return !(bk === k || (k.length >= 12 && (bk.includes(k) || k.includes(bk)))); });
  }
  if (t.question) {
    const q = norm(t.question);
    m.repeatStreak = (m.recentQuestions ?? []).some((x) => norm(x) === q) ? (m.repeatStreak ?? 0) + 1 : 0;
    m.question = t.question;
    m.recentQuestions = [...(m.recentQuestions ?? []).filter((x) => norm(x) !== q), t.question].slice(-4);
  }
  m.recentThoughts = [...(m.recentThoughts ?? []), t.thought.slice(0, 160)].slice(-3);
  for (const b of t.beliefs) {
    if (copiesDream(p, b.text)) continue; // a dream's invented content must not become something the pet believes
    if (copiesRefuted(p, b.text, nowSec)) continue; // nor can something its experience just showed to be wrong
    const existing = m.beliefs.find((x) => norm(x.text) === norm(b.text));
    if (existing?.verdict === "contradicted") continue; // repeating a belief the evidence contradicts does not bring it back
    if (existing) {
      existing.confidence = Math.round((existing.confidence * 0.5 + b.confidence * 0.5) * 100) / 100;
      existing.updatedSec = nowSec;
    } else {
      m.beliefs.push({ text: b.text, confidence: Math.round(b.confidence * 100) / 100, updatedSec: nowSec } as Belief);
    }
  }
  if (m.beliefs.length > MAX_BELIEFS) {
    m.beliefs.sort((a, b) => b.confidence - a.confidence || b.updatedSec - a.updatedSec);
    m.beliefs.length = MAX_BELIEFS;
  }
  if (t.dropIntention) m.intention = null;
  if (t.intention && t.intention !== m.intention?.goal) m.intention = { goal: t.intention, sinceSec: nowSec };
  m.suggestion = t.suggestion === "none" ? null : { kind: t.suggestion, untilSec: nowSec + 600 };
  m.lastThoughtSec = nowSec;
}

export interface SpeechHook {
  nearbyCount(p: PetState): number;
  maybeSpeak(p: PetState, say: NonNullable<ParsedThought["say"]>, thought: ParsedThought, model: { provider: string; model: string }): Promise<void>;
}

export interface TeacherHook {
  ask(p: PetState, question: string): void;
}

export class System2 {
  conversation?: SpeechHook;
  teacher?: TeacherHook;
  disposed = false;
  private due = new Map<string, number>();
  private busy = new Set<string>();
  private warned = false;

  constructor(
    private sim: Simulation,
    private llm: LlmGateway,
    private store: Store,
    private opts: { intervalSec: number; patienceSec?: number; deepEvery?: number; isPaused: () => boolean; now?: () => number; random?: () => number },
  ) {}

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }
  private rand() { return this.opts.random ? this.opts.random() : Math.random(); }

  /** Called every server tick; starts at most one model call per pet when it is due. */
  tick(): void {
    if (!this.llm.enabled) {
      if (!this.warned) { console.warn("System 2 disabled: no GROQ_API_KEY or DEEPSEEK_API_KEY set"); this.warned = true; }
      return;
    }
    if (this.opts.isPaused()) return;
    const now = this.now();
    this.sim.pets.forEach((p, i) => {
      if (!this.due.has(p.id)) this.due.set(p.id, now + 10_000 + i * 20_000); // stagger the first thoughts
      if (this.busy.has(p.id) || now < this.due.get(p.id)!) return;
      this.busy.add(p.id);
      void this.think(p).finally(() => {
        this.busy.delete(p.id);
        this.due.set(p.id, this.now() + this.opts.intervalSec * 1000 * (0.8 + this.rand() * 0.5));
      });
    });
  }

  async think(p: PetState): Promise<void> {
    const tod = Math.floor(this.sim.simSec / 60) % 1440;
    const day = Math.floor(this.sim.simSec / 86400) + 1;
    // Every Nth thought is a "deep review" by a stronger model, which can catch what the small local one got wrong or stuck on.
    const every = this.opts.deepEvery ?? 0;
    const wantsDeep = every > 0 && (p.stats.s2Thoughts + 1) % every === 0;
    const nearby = this.conversation?.nearbyCount(p) ?? 0;
    let deep = wantsDeep;
    let prompt = buildPrompt(p, day, tod, nearby, this.sim.simSec, deep, this.sim.ruleLearning);
    markUsed(p, this.sim.simSec); // these memories were shown, so they count as used
    markGistsUsed(p, this.sim.simSec);
    const patienceMs = (this.opts.patienceSec ?? 240) * 1000;
    const ask = (pr: { system: string; user: string }, o: Record<string, unknown>) =>
      this.llm.complete([{ role: "system", content: pr.system }, { role: "user", content: pr.user }], { maxTokens: 900, ...o });
    let result;
    try {
      try {
        result = deep
          ? await ask(prompt, { temperature: 0.7, providers: ["deepseek", "groq"] }) // its cost counts toward the pets' ceiling
          : await ask(prompt, { temperature: 0.8, patienceMs });
      } catch (e) {
        if (!deep || !(e instanceof LlmUnavailable)) throw e;
        deep = false; // the stronger models are unavailable (e.g. the ceiling is reached): think the ordinary way
        prompt = buildPrompt(p, day, tod, nearby, this.sim.simSec, false, this.sim.ruleLearning);
        result = await ask(prompt, { temperature: 0.8, patienceMs });
      }
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) console.error("system2 error", e);
      return; // no model available right now: skip this thought
    }
    if (this.disposed) return; // this session was replaced (a save was loaded) while the model was thinking
    const parsed = parseThought(result.text);
    if (!parsed) {
      console.warn(`system2 ${p.id}: unusable reply from ${result.provider}: ${result.text.slice(0, 120)}`);
      return;
    }
    const nowSec = this.sim.simSec;
    applyThought(p, parsed, nowSec);
    p.stats.s2Thoughts++;
    console.log(`system2 ${p.id}${deep ? " [deep]" : ""} via ${result.provider} (${result.tokensIn}+${result.tokensOut} tok): ${parsed.thought.slice(0, 90)}`);
    await this.store.append(`thoughts/${p.id}`, {
      system: 2, pet: p.id, tSec: nowSec, day, hour: Math.floor(tod / 60), minute: tod % 60,
      question: parsed.question, thought: parsed.thought, beliefs: parsed.beliefs, intention: p.mind.intention?.goal ?? null,
      suggestion: parsed.suggestion, say: parsed.say, askTeacher: parsed.askTeacher, retract: parsed.retract, tune: parsed.tune, deep, provider: result.provider, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    if (parsed.tune && this.sim.ruleLearning) {
      // The pet asked to try a small change to a habit. It starts a trial; the evidence, not this thought, decides if it stays.
      const r = proposeTune(p, nowSec, parsed.tune.habit, parsed.tune.direction, parsed.tune.why, "thinking");
      if (r.event) await this.store.append(`thoughts/${p.id}`, { system: 3, stage: "habit", pet: p.id, tSec: nowSec, day, hour: Math.floor(tod / 60), minute: tod % 60, event: r.event });
    }
    if (parsed.askTeacher && this.teacher) this.teacher.ask(p, parsed.askTeacher);
    if (parsed.say && this.conversation) await this.conversation.maybeSpeak(p, parsed.say, parsed, { provider: result.provider, model: result.model });
  }
}
