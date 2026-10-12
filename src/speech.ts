// Spatial speech rules. Speech is not a global channel: only pets within range hear it, and what they hear
// is stored as an unverified claim. System 1 decides whether a pet may speak at all.
import { normAngle } from "./geometry.js";
import { VISION_HALF_ANGLE, VISION_RANGE } from "./sensors.js";
import type { PetState } from "./pet.js";
import type { Layout } from "./layout.js";
import { crossings } from "./acoustics.js";

export const PET_VOICE_RANGE = 300;
export const HUMAN_VOICE_RANGE = 350;
export const TEACHER_VOICE_RANGE = 350;
const CLOSE_VOICE = 150; // centre-to-centre distance at which a speaker counts as right beside the listener

export interface Speaker { kind: "pet" | "human" | "teacher"; id: string; name: string; x: number; y: number }
export type Target = { kind: "pet"; id: string } | { kind: "all" } | { kind: "nearest" } | { kind: "human" } | { kind: "teacher" };

export interface Utterance {
  id: string;
  tSec: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  from: { kind: "pet" | "human" | "teacher"; id: string; name: string };
  to: { kind: "pet" | "all" | "nearest" | "human" | "teacher"; id?: string; name?: string };
  text: string;
  heardBy: string[]; // pet ids that were within earshot
  notHeardBy: string[]; // addressed pets that were too far away
  trace: Record<string, unknown>; // why this was said: meaning, drives, beliefs, model
}

/** Pets within `range` of the speaker (the speaker itself excluded). */
export function inEarshot(pets: PetState[], speaker: Speaker, range: number, walls?: { layout: Layout; shut: readonly string[] }): PetState[] {
  // A wall or shut door between them makes the voice carry a third as far.
  const reach = (p: PetState) => (walls && crossings(walls.layout, p, speaker, walls.shut) > 0 ? range / 3 : range);
  return pets
    .filter((p) => !(speaker.kind === "pet" && p.id === speaker.id) && Math.hypot(p.x - speaker.x, p.y - speaker.y) <= reach(p))
    .sort((a, b) => Math.hypot(a.x - speaker.x, a.y - speaker.y) - Math.hypot(b.x - speaker.x, b.y - speaker.y));
}

/** Whether the listener can see the speaker: in front of it, within sight. Only then can it tell who is talking. */
export function canSee(listener: PetState, speaker: Speaker): boolean {
  const dx = speaker.x - listener.x, dy = speaker.y - listener.y;
  return Math.abs(normAngle(Math.atan2(dy, dx) - listener.heading)) <= VISION_HALF_ANGLE && Math.hypot(dx, dy) <= VISION_RANGE;
}

/** How a listener perceives where a voice came from. It never learns who spoke from this alone. */
export function describeSource(listener: PetState, speaker: Speaker): string {
  const dx = speaker.x - listener.x, dy = speaker.y - listener.y;
  const dist = Math.hypot(dx, dy);
  const bearing = normAngle(Math.atan2(dy, dx) - listener.heading);
  const side = Math.abs(bearing) < 0.4 ? "ahead" : Math.abs(bearing) > 2.3 ? "behind me" : bearing > 0 ? "to my right" : "to my left";
  const visible = Math.abs(bearing) <= VISION_HALF_ANGLE && dist <= VISION_RANGE;
  // Someone right next to the listener is not "unseen" just because they are outside the vision cone.
  const close = dist <= CLOSE_VOICE;
  const where = close ? `very close, ${side}` : `${side}, about ${Math.round(dist / 10) * 10} away`;
  if (speaker.kind === "teacher") return `the Teacher (${where}${visible ? "" : close ? ", right next to me though I am not facing them" : ", out of sight"})`;
  return `a voice ${where}${visible ? " (I can see the moving thing it came from)" : close ? " (someone is right next to me, though I am not facing them)" : " (I cannot see who it is)"}`;
}

export interface GateInput {
  mode: PetState["mode"];
  hasListener: boolean;
  isReply: boolean;
  social: number;
  socialTrait: number;
  msSinceLastSpoke: number;
  msSinceLastPetUtterance: number; // any pet, to stop chatter piling up
  petChainLength: number; // consecutive pet-to-pet utterances without the human taking part
}

export const GATE = {
  initiativeCooldownMs: 90_000,
  replyCooldownMs: 4_000,
  globalPetGapMs: 30_000,
  maxPetChain: 3,
};

/** System 1's judgement on whether a pet should speak now. Always explains itself. */
export function canSpeak(g: GateInput): { ok: boolean; reason: string } {
  if (g.mode === "sleeping") return { ok: false, reason: "asleep" };
  if (g.mode === "dormant") return { ok: false, reason: "powered down" };
  if (!g.hasListener) return { ok: false, reason: "nobody within earshot" };
  if (g.msSinceLastSpoke < (g.isReply ? GATE.replyCooldownMs : GATE.initiativeCooldownMs)) return { ok: false, reason: "spoke very recently" };
  if (g.isReply) return { ok: true, reason: "someone spoke to me" };
  if (g.petChainLength >= GATE.maxPetChain) return { ok: false, reason: "pets have been chatting a lot already" };
  if (g.msSinceLastPetUtterance < GATE.globalPetGapMs) return { ok: false, reason: "another pet just spoke" };
  if (g.social + g.socialTrait * 0.3 < 0.45) return { ok: false, reason: "not in a talkative mood" };
  return { ok: true, reason: "has something to say and someone is near" };
}

/** True if a model's text is structured data (JSON, a fenced block, a field name) that must never be spoken aloud as if it were speech. */
export function looksLikeJson(text: string): boolean {
  return /^\s*(```|json\b|[{\[])/i.test(text) || /"(reply|understood|intent|topic|claims|thought|beliefs)"\s*:/.test(text);
}
