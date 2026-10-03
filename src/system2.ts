// System 2: slow, deliberate thinking. About once a minute of real time per pet it asks itself a question
// through the LLM gateway, updates its beliefs / intention, and may nudge System 1. It runs off the tick
// path: a slow or failed model call never delays the simulation.
import { LlmGateway, LlmUnavailable } from "./llm.js";
import { SUGGESTIONS, type Belief, type PetState, type Suggestion } from "./pet.js";
import type { Simulation } from "./sim.js";
import type { Store } from "./store.js";

export interface ParsedThought {
  question: string;
  thought: string;
  beliefs: { text: string; confidence: number }[];
  intention: string | null;
  dropIntention: boolean;
  suggestion: Suggestion;
  say: { to: "nearest" | "all"; meaning: string } | null;
}

const WORD = (v: number, lo: string, mid: string, hi: string) => (v < 0.34 ? lo : v < 0.67 ? mid : hi);

/** The pet's own notes: everything a language model is allowed to know about it. */
export function buildNotes(p: PetState, day: number, timeOfDay: number, nearby = 0): string {
  const t = p.traits;
  const hh = String(Math.floor(timeOfDay / 60)).padStart(2, "0");
  const mm = String(timeOfDay % 60).padStart(2, "0");
  const m = p.mind;
  return [
    `Time: day ${day}, ${hh}:${mm}.`,
    `Personality: ${WORD(t.curiosity, "not very curious", "somewhat curious", "very curious")}, ${WORD(t.social, "reserved", "moderately social", "very social")}, ${WORD(t.caution, "bold", "fairly careful", "very cautious")}, ${WORD(t.patience, "impatient", "fairly patient", "very patient")}.`,
    `Body: battery ${Math.round(p.energy)}%, currently ${p.mode}, doing "${p.s1.action}"${p.s1.lastReason ? ` because: ${p.s1.lastReason}` : ""}.`,
    `Needs (0-1): curiosity ${p.drives.curiosity.toFixed(2)}, social ${p.drives.social.toFixed(2)}, rest ${p.drives.rest.toFixed(2)}.`,
    `Senses now: light ${m.sensed.light}/100, temperature ${m.sensed.temperature}C${m.sensed.touch ? `, touching: ${m.sensed.touch}` : ""}${m.sensed.heard ? `, hearing ${m.sensed.heard}` : ""}.`,
    `Sees: ${m.sensed.seen.length ? m.sensed.seen.join("; ") : "nothing in view"}.`,
    `Within earshot: ${nearby ? `${nearby} other creature${nearby > 1 ? "s" : ""}` : "nobody"}.`,
    `Recent experience:\n${m.episodes.length ? m.episodes.slice(-10).map((e) => "- " + e).join("\n") : "- (nothing yet)"}`,
    `Current beliefs:\n${m.beliefs.length ? m.beliefs.map((b) => `- ${b.text} (${b.confidence.toFixed(2)})`).join("\n") : "- (none yet)"}`,
    `Things others told me (claims, NOT verified facts):\n${m.claims.length ? m.claims.slice(-5).map((c) => `- ${c.text} [${c.status}]`).join("\n") : "- (nothing)"}`,
    `Last question: ${m.question || "(none)"}`,
    `Current intention: ${m.intention ? m.intention.goal : "(none)"}`,
  ].join("\n");
}

export function buildPrompt(p: PetState, day: number, timeOfDay: number, nearby = 0): { system: string; user: string } {
  const system =
    `You are the slow, deliberate inner voice (System 2) of ${p.name}, a small pet living in a simple 2D room with two other pets and a human. ` +
    `You are not an assistant. You only know the notes you are given; never invent places, objects or events that are not in the notes. ` +
    `Pick ONE useful question about your situation, reflect on it briefly, and reply with ONLY a JSON object, no other text:\n` +
    `{"question": string (max 100 chars), "thought": string (1-2 sentences, first person), ` +
    `"beliefs": [{"text": string (max 80 chars), "confidence": number 0-1}] (0-3 items, only if the notes support them), ` +
    `"intention": string or null (a goal that could last hours or days, max 80 chars; null keeps your current one), ` +
    `"drop_intention": boolean, ` +
    `"suggestion": one of ${SUGGESTIONS.map((x) => `"${x}"`).join(", ")} (a nudge to your fast System 1), ` +
    `"say": null or {"to": "nearest" or "all", "meaning": string (max 100 chars: what you want to tell or ask, as plain ideas, not a sentence)}} ` +
    `Use "say" only if someone is within earshot and you have something genuinely worth telling or asking; otherwise null. ` +
    `Never state as fact something you only heard from others.`;
  return { system, user: buildNotes(p, day, timeOfDay, nearby) };
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
        .map((b: any) => ({ text: str(b.text, 80), confidence: Math.max(0, Math.min(1, Number(b.confidence) || 0.5)) }))
    : [];
  const suggestion = SUGGESTIONS.includes(raw.suggestion) ? (raw.suggestion as Suggestion) : "none";
  const intention = typeof raw.intention === "string" && raw.intention.trim() ? str(raw.intention, 80) : null;
  const sayMeaning = str(raw.say?.meaning, 100);
  const say = sayMeaning ? { to: raw.say?.to === "all" ? ("all" as const) : ("nearest" as const), meaning: sayMeaning } : null;
  return { question: str(raw.question, 100), thought: str(raw.thought, 300), beliefs, intention, dropIntention: raw.drop_intention === true, suggestion, say };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const MAX_BELIEFS = 10;

export function applyThought(p: PetState, t: ParsedThought, nowSec: number): void {
  const m = p.mind;
  if (t.question) m.question = t.question;
  for (const b of t.beliefs) {
    const existing = m.beliefs.find((x) => norm(x.text) === norm(b.text));
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

export class System2 {
  conversation?: SpeechHook;
  private due = new Map<string, number>();
  private busy = new Set<string>();
  private warned = false;

  constructor(
    private sim: Simulation,
    private llm: LlmGateway,
    private store: Store,
    private opts: { intervalSec: number; isPaused: () => boolean; now?: () => number; random?: () => number },
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
    const { system, user } = buildPrompt(p, day, tod, this.conversation?.nearbyCount(p) ?? 0);
    let result;
    try {
      result = await this.llm.complete([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 900, temperature: 0.7 });
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) console.error("system2 error", e);
      return; // no model available right now: skip this thought
    }
    const parsed = parseThought(result.text);
    if (!parsed) {
      console.warn(`system2 ${p.id}: unusable reply from ${result.provider}: ${result.text.slice(0, 120)}`);
      return;
    }
    const nowSec = this.sim.simSec;
    applyThought(p, parsed, nowSec);
    console.log(`system2 ${p.id} via ${result.provider} (${result.tokensIn}+${result.tokensOut} tok): ${parsed.thought.slice(0, 90)}`);
    await this.store.append(`thoughts/${p.id}`, {
      system: 2, pet: p.id, tSec: nowSec, day, hour: Math.floor(tod / 60), minute: tod % 60,
      question: parsed.question, thought: parsed.thought, beliefs: parsed.beliefs, intention: p.mind.intention?.goal ?? null,
      suggestion: parsed.suggestion, say: parsed.say, provider: result.provider, model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    if (parsed.say && this.conversation) await this.conversation.maybeSpeak(p, parsed.say, parsed, { provider: result.provider, model: result.model });
  }
}
