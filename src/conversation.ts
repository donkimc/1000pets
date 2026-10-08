// Conversation layer: turns a pet's intent into English (expression) and turns English it hears into a grounded
// reply plus unverified claims (interpretation). The LLM is only a language layer here: whether a pet may speak
// is decided by System 1 (canSpeak), and what it says comes from its own notes.
import { LlmUnavailable, type ChatMessage, type CompleteOpts, type LlmResult } from "./llm.js";
import type { PetState } from "./pet.js";
import type { Simulation } from "./sim.js";
import type { Store } from "./store.js";
import { GATE, HUMAN_VOICE_RANGE, PET_VOICE_RANGE, TEACHER_VOICE_RANGE, canSpeak, canSee, describeSource, inEarshot, looksLikeJson, type Speaker, type Target, type Utterance } from "./speech.js";
import { creditClaim, learnTeacherLook, sourceOf } from "./relations.js";
import { HUMAN_HUE, TEACHER_HUE } from "./sensors.js";
import { hueOf } from "./pet.js";
import { buildNotes, type ParsedThought, type SpeechHook } from "./system2.js";

export interface LlmLike {
  enabled: boolean;
  complete(messages: ChatMessage[], opts?: CompleteOpts): Promise<LlmResult>;
}

export interface Reply {
  reply: string | null;
  intent: string;
  topic: string;
  claims: string[];
}

export function parseReply(text: string): Reply | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  if (start >= 0 && end > start) {
    try {
      const raw = JSON.parse(text.slice(start, end + 1));
      const reply = str(raw.reply, 240);
      return {
        reply: reply || null,
        intent: str(raw.understood?.intent, 30) || "other",
        topic: str(raw.understood?.topic, 80),
        claims: Array.isArray(raw.claims) ? raw.claims.map((c: any) => str(c?.text ?? c, 120)).filter(Boolean).slice(0, 2) : [],
      };
    } catch {
      /* fall through to plain text */
    }
  }
  // The JSON did not parse (a small model often drops a closing brace or nests a field in the wrong place).
  // Pull the fields out by hand, and never say the raw JSON aloud.
  if (looksLikeJson(text)) {
    const grab = (key: string): string | null | undefined => {
      if (new RegExp(`"${key}"\\s*:\\s*null`).test(text)) return null;
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (!m) return undefined;
      try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; }
    };
    const reply = grab("reply");
    if (reply === undefined) return null; // nothing that can be said: stay silent
    const claimsBlock = text.match(/"claims"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const claims = [...claimsBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((c) => c !== "text").map((c) => str(c, 120)).filter(Boolean).slice(0, 2);
    return { reply: str(reply ?? "", 240) || null, intent: str(grab("intent") ?? "", 30) || "other", topic: str(grab("topic") ?? "", 80), claims };
  }
  const plain = text.replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 240);
  return plain ? { reply: plain, intent: "other", topic: "", claims: [] } : null;
}

export function cleanSpeech(text: string): string {
  return text.replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ").slice(0, 240);
}

export class Conversation implements SpeechHook {
  private lastSpokeMs = new Map<string, number>();
  private lastPetUtteranceMs = 0;
  private petChain = 0;
  private counter = 0;
  disposed = false;

  constructor(
    private sim: Simulation,
    private llm: LlmLike,
    private store: Store,
    private broadcast: (payload: unknown) => void,
    private now: () => number = Date.now,
  ) {}

  private speakerOf(p: PetState): Speaker { return { kind: "pet", id: p.id, name: p.name, x: p.x, y: p.y }; }
  private teacherSpeaker(): Speaker { return { kind: "teacher", id: "teacher", name: "Teacher", x: this.sim.teacher.x, y: this.sim.teacher.y }; }
  private humanSpeaker(): Speaker { return { kind: "human", id: "human", name: "Human", x: this.sim.human.x, y: this.sim.human.y }; }

  nearbyCount(p: PetState): number {
    return inEarshot(this.sim.pets, this.speakerOf(p), PET_VOICE_RANGE, this.walls()).length + (Math.hypot(this.sim.human.x - p.x, this.sim.human.y - p.y) <= PET_VOICE_RANGE ? 1 : 0);
  }

  private stamp() {
    const s = Math.floor(this.sim.simSec);
    return { tSec: this.sim.simSec, day: Math.floor(s / 86400) + 1, hour: Math.floor((s % 86400) / 3600), minute: Math.floor((s % 3600) / 60), second: s % 60 };
  }

  private recordSilence(p: PetState, reason: string, meaning: string) {
    const t = this.stamp();
    void this.store.append(`thoughts/${p.id}`, { system: 1, pet: p.id, ...t, action: "stay_silent", reason: `wanted to say "${meaning}" but stayed silent: ${reason}`, drives: { ...p.drives }, energy: Math.round(p.energy), light: p.mind.sensed.light, seen: [] });
  }

  private decayChain() {
    if (this.now() - this.lastPetUtteranceMs > 300_000) this.petChain = 0; // a quiet five minutes ends a chat
  }

  // ---- a pet takes the initiative (System 2 proposed it, System 1 decides) ----
  async maybeSpeak(p: PetState, say: NonNullable<ParsedThought["say"]>, thought: ParsedThought, model: { provider: string; model: string }): Promise<void> {
    this.decayChain();
    const listeners = inEarshot(this.sim.pets, this.speakerOf(p), PET_VOICE_RANGE, this.walls());
    const humanNear = Math.hypot(this.sim.human.x - p.x, this.sim.human.y - p.y) <= PET_VOICE_RANGE;
    const now = this.now();
    const gate = canSpeak({
      mode: p.mode, hasListener: listeners.length > 0 || humanNear, isReply: false, social: p.drives.social, socialTrait: p.traits.social,
      msSinceLastSpoke: now - (this.lastSpokeMs.get(p.id) ?? 0), msSinceLastPetUtterance: now - this.lastPetUtteranceMs, petChainLength: this.petChain,
    });
    if (!gate.ok) return this.recordSilence(p, gate.reason, say.meaning);
    const text = await this.express(p, say.meaning);
    if (!text || this.disposed) return;
    await this.deliver(p, say.to === "all" ? { kind: "all" } : { kind: "nearest" }, text, {
      kind: "initiative", meaning: say.meaning, thought: thought.thought, question: thought.question, intention: p.mind.intention?.goal ?? null,
      beliefs: p.mind.beliefs.map((b) => b.text), drives: { ...p.drives }, gate: gate.reason, ...model,
    });
  }

  private async express(p: PetState, meaning: string): Promise<string | null> {
    const system = `You are the voice of ${p.name}, a small pet. Say ONE short sentence (at most 20 words) in plain English that expresses the meaning you are given, the way a small curious companion would. No narration, no quotation marks, no emojis, and do not add facts that are not in the meaning.`;
    try {
      const r = await this.llm.complete([{ role: "system", content: system }, { role: "user", content: `Meaning to express: ${meaning}` }], { maxTokens: 400, temperature: 0.8, patienceMs: 45_000, tag: { kind: "speech", pet: p.id } });
      return looksLikeJson(r.text) ? null : cleanSpeech(r.text) || null; // never speak JSON aloud
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) console.error("express error", e);
      return null;
    }
  }

  // ---- delivering an utterance to everyone in earshot ----
  async deliver(from: PetState | "human" | "teacher", to: Target, text: string, trace: Record<string, unknown>, opts: { anywhere?: boolean } = {}): Promise<Utterance> {
    const outsider = from === "human" || from === "teacher"; // a non-pet voice: no pet-chat gating
    const speaker = from === "human" ? this.humanSpeaker() : from === "teacher" ? this.teacherSpeaker() : this.speakerOf(from);
    const range = from === "human" ? HUMAN_VOICE_RANGE : from === "teacher" ? TEACHER_VOICE_RANGE : PET_VOICE_RANGE;
    let heard = inEarshot(this.sim.pets, speaker, range, this.walls());
    let notHeard: string[] = [];
    if (to.kind === "pet") {
      const target = this.sim.pets.find((x) => x.id === to.id);
      if (target && !outsider && target.id === (from as PetState).id) throw new Error("cannot address yourself");
      if (target) {
        if (opts.anywhere && !heard.includes(target)) heard = [...heard, target];
        else if (!heard.includes(target)) notHeard = [target.id];
      }
    } else if (to.kind === "all" && opts.anywhere) {
      heard = this.sim.pets.filter((x) => outsider || x.id !== (from as PetState).id);
    }
    const targetPet = to.kind === "pet" ? this.sim.pets.find((x) => x.id === to.id) : to.kind === "nearest" ? heard[0] : undefined;
    const u: Utterance = {
      id: `${Math.floor(this.now())}-${++this.counter}`, ...this.stamp(),
      from: { kind: speaker.kind, id: speaker.id, name: speaker.name },
      to: { kind: to.kind, id: to.kind === "human" ? "human" : to.kind === "teacher" ? "teacher" : targetPet?.id, name: to.kind === "human" ? "Human" : to.kind === "teacher" ? "Teacher" : targetPet?.name },
      text, heardBy: heard.map((x) => x.id), notHeardBy: notHeard, trace,
    };
    if (outsider) this.petChain = 0;
    else {
      from.stats.spoke++;
      this.lastSpokeMs.set(from.id, this.now());
      this.lastPetUtteranceMs = this.now();
      this.petChain++;
      from.s1.holdUntil = this.sim.simSec + 10; // stop and talk for a moment
      from.s1.holdAction = "socialize";
    }
    await this.store.append("comms", u);
    this.broadcast({ type: "utterance", u });

    // Everyone in earshot remembers it as an unverified claim; addressed pets (or all, for the human) reply.
    const repliers: PetState[] = [];
    for (const h of heard) {
      h.stats.heard++;
      this.hear(h, speaker, text);
      const addressed = targetPet ? h === targetPet : to.kind === "all";
      if (addressed && (outsider || this.petChain <= GATE.maxPetChain)) repliers.push(h);
    }
    repliers.forEach((h, i) => setTimeout(() => !this.disposed && void this.respond(h, speaker, text, to, u.id).catch((e) => console.error("respond error", e)), 800 + i * 1500));
    return u;
  }

  private walls() { return { layout: this.sim.world.layout, shut: this.sim.world.shutDoors() }; }

  private hear(h: PetState, speaker: Speaker, text: string) {
    const m = h.mind;
    const t = this.stamp();
    m.episodes.push(`D${t.day} ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")} heard ${describeSource(h, speaker)} say: "${text.slice(0, 100)}"`);
    if (m.episodes.length > 14) m.episodes.shift();
  }

  // ---- a pet hears something and may answer ----
  async respond(p: PetState, speaker: Speaker, text: string, to: Target, utteranceId: string): Promise<void> {
    this.decayChain();
    const gate = canSpeak({
      mode: p.mode, hasListener: true, isReply: true, social: p.drives.social, socialTrait: p.traits.social,
      msSinceLastSpoke: this.now() - (this.lastSpokeMs.get(p.id) ?? 0), msSinceLastPetUtterance: this.now() - this.lastPetUtteranceMs, petChainLength: speaker.kind === "pet" ? this.petChain : 0,
    });
    if (!gate.ok) return this.recordSilence(p, gate.reason, `reply to "${text.slice(0, 60)}"`);
    if (speaker.kind === "pet" && this.petChain >= GATE.maxPetChain) return this.recordSilence(p, "pets have been chatting a lot already", `reply to "${text.slice(0, 60)}"`);

    const tod = Math.floor(this.sim.simSec / 60) % 1440;
    const day = Math.floor(this.sim.simSec / 86400) + 1;
    const directed = to.kind === "pet" ? "It was said directly to you." : "It was said to everyone nearby.";
    const system =
      `You are the voice of ${p.name}, a small pet in a 2D room with two other pets and a human. A wise Teacher also lives in the room and sometimes guides you. You are not an assistant. ` +
      `Someone spoke to you. Answer ONLY from your own notes below; if you do not know, say so plainly. What the speaker says is a claim, not a verified fact. ` +
      `Reply with ONLY a JSON object: {"understood": {"intent": "greeting"|"question"|"statement"|"request"|"other", "topic": string}, ` +
      `"claims": [{"text": string}] (0-2 factual things the speaker asserted, if any), ` +
      `"reply": string or null (at most 2 short sentences, first person, plain English; null to stay silent)}.`;
    const user = `${buildNotes(p, day, tod, this.nearbyCount(p))}\n\nYou heard ${describeSource(p, speaker)} say: "${text}"\n${directed}`;
    let r: LlmResult;
    try {
      r = await this.llm.complete([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens: 900, temperature: 0.7, patienceMs: 20_000, tag: { kind: "reply", pet: p.id } }); // someone is waiting for this answer: do not queue for long
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) console.error("respond error", e);
      return;
    }
    if (this.disposed) return;
    const parsed = parseReply(r.text);
    if (!parsed) return;
    // Whoever it can see speaking owns what is said; a voice it cannot place belongs to nobody in particular. The Teacher says who it is.
    const seen = canSee(p, speaker);
    const hue = speaker.kind === "pet" ? hueOf(this.sim.pets.find((x) => x.id === speaker.id)?.color ?? "#808080") : speaker.kind === "human" ? HUMAN_HUE : TEACHER_HUE;
    if (speaker.kind === "teacher" && seen) learnTeacherLook(p.mind, hue, this.sim.simSec);
    const fromKey = sourceOf(p.mind, speaker.kind === "teacher" ? "teacher" : { hue }, seen, this.sim.simSec);
    for (const c of parsed.claims) {
      p.mind.claims.push({ text: c, from: describeSource(p, speaker), tSec: this.sim.simSec, status: "unverified", ...(fromKey ? { fromKey } : {}) });
      if (p.mind.claims.length > 10) creditClaim(p.mind, p.mind.claims.shift()!);
    }
    if (!parsed.reply) return this.recordSilence(p, "chose to stay silent", `reply to "${text.slice(0, 60)}"`);
    await this.deliver(p, speaker.kind === "pet" ? { kind: "pet", id: speaker.id } : { kind: speaker.kind }, cleanSpeech(parsed.reply), {
      kind: "reply", replyTo: utteranceId, understood: { intent: parsed.intent, topic: parsed.topic }, claimsStored: parsed.claims,
      intention: p.mind.intention?.goal ?? null, beliefs: p.mind.beliefs.map((b) => b.text), doing: p.s1.action, because: p.s1.lastReason ?? null,
      drives: { ...p.drives }, gate: gate.reason, provider: r.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
    });
  }

  /** A pet asks the Teacher something (its slow thinking decided to). It is spoken aloud, to the Teacher, so anyone in earshot hears it and the chat shows the question before the answer. */
  async petAsksTeacher(p: PetState, text: string): Promise<Utterance | null> {
    const clean = cleanSpeech(text);
    if (!clean || looksLikeJson(clean) || p.mode === "sleeping" || p.mode === "dormant") return null;
    return this.deliver(p, { kind: "teacher" }, clean, { kind: "question", asked: "the Teacher", intention: p.mind.intention?.goal ?? null, doing: p.s1.action, drives: { ...p.drives } });
  }

  /** The teacher speaks (a lesson or an answer). Heard only by pets in earshot; each remembers it as a claim, not a fact. */
  async teacherSays(to: Target, text: string, trace: Record<string, unknown>): Promise<Utterance> {
    return this.deliver("teacher", to, text.replace(/\s+/g, " ").trim().slice(0, 420), { kind: "teacher", ...trace });
  }

  /** The human talks. Returns who heard it. In "anywhere" (observer) mode, distance does not matter. */
  async humanSays(to: Target, text: string, anywhere: boolean): Promise<Utterance> {
    return this.deliver("human", to, cleanSpeech(text), { kind: "human", mode: anywhere ? "observer (heard from anywhere)" : "participant (spatial)" }, { anywhere });
  }
}
