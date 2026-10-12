// Relationships: a pet comes to know the others in the room as individuals and forms its own view of each.
//
// Nothing here is told to the pet. It has no names for the others: it tells them apart the only way it can, by how they
// look (hue), and it learns who is who by seeing the same thing again. It remembers, for each one it knows:
//   - how long it has been around them, and how long that was in a good moment (company while it needed company)
//   - how often they bumped into each other
//   - what that one told it, and how often it turned out right or wrong against the pet's own experience (see sleep.ts)
// From these come a trust (how reliable their claims have been) and an affinity (how good their company has been).
// Both start at "don't know" and only move with counted evidence.
import type { Detection } from "./sensors.js";
import { colourWord } from "./scenes.js";
import type { Claim, Mind, PetState } from "./pet.js";

export const MAX_OTHERS = 8;
export const HUE_TOLERANCE = 8; // degrees: the same thing seen again still has this hue to within a few degrees
export const NEAR_SEC = 110; // closer than this counts as company
export const KNOWN_SEC = 300; // watched this long before the pet will say it knows what company they are
const LONELY = 0.35; // social need above this makes company a good thing
const BUMP_GAP_SEC = 20; // one bump counts once, however many ticks it lasts

export interface Relation {
  key: string;
  hue: number;
  label: string; // how the pet refers to it: "the green one", or "the Teacher" once it has been heard to be
  firstSec: number;
  lastSec: number;
  seenSec: number; // time spent seeing it
  goodSec: number; // time within company range while it was lonely
  bumps: number;
  lastBumpSec: number;
  told: number; // claims from it that were settled either way
  right: number; // ... that turned out right
  wrong: number; // ... that turned out wrong
}

const hueDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

export function ensureOthers(m: Mind): Record<string, Relation> {
  return (m.others ??= {});
}

/** The one it already knows that looks like this, or a new acquaintance. Null if it has met too many to keep another. */
export function relationFor(m: Mind, hue: number, now: number): Relation {
  const others = ensureOthers(m);
  let best: Relation | null = null;
  for (const r of Object.values(others)) {
    if (r.key === "teacher" && r.hue < 0) continue; // the unseen Teacher has no look to match
    if (hueDiff(r.hue, hue) <= HUE_TOLERANCE && (!best || hueDiff(r.hue, hue) < hueDiff(best.hue, hue))) best = r;
  }
  if (best) return best;
  const all = Object.values(others);
  if (all.length >= MAX_OTHERS) {
    const weakest = all.sort((a, b) => a.seenSec - b.seenSec)[0];
    delete others[weakest.key];
  }
  const used = new Set(Object.keys(others));
  const base = `h${Math.round(hue)}`;
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
  const r: Relation = { key, hue, label: `the ${colourWord(hue)} one`, firstSec: now, lastSec: now, seenSec: 0, goodSec: 0, bumps: 0, lastBumpSec: -1e9, told: 0, right: 0, wrong: 0 };
  others[key] = r;
  return r;
}

/** Each tick: who is in view, for how long, whether company was welcome, and who was bumped into. */
export function observeOthers(p: Pick<PetState, "mind" | "drives">, vision: Detection[], touch: string, now: number, dt: number, lonelyBefore: number): void {
  const movers = vision.filter((v) => v.category === "moving");
  let nearest: { r: Relation; distance: number } | null = null;
  for (const v of movers) {
    const r = relationFor(p.mind, v.hue, now);
    r.seenSec += dt;
    r.lastSec = now;
    if (v.distance < NEAR_SEC && lonelyBefore > LONELY) r.goodSec += dt;
    if (!nearest || v.distance < nearest.distance) nearest = { r, distance: v.distance };
  }
  // A bump with another pet is put down to the closest one it can see. If it cannot see one, it does not guess.
  if (touch === "pet" && nearest && nearest.distance < 90 && now - nearest.r.lastBumpSec > BUMP_GAP_SEC) {
    nearest.r.bumps++;
    nearest.r.lastBumpSec = now;
  }
}

/** A pet heard a voice and could see who it came from (or was told, as with the Teacher): that one now owns what was said. */
export function sourceOf(m: Mind, speaker: "teacher" | { hue: number }, seen: boolean, now: number): string | null {
  const others = ensureOthers(m);
  if (speaker === "teacher") {
    // The Teacher says who it is. If it is in view, its look is learnt and named; otherwise it is known by name alone.
    const named = Object.values(others).find((r) => r.label === "the Teacher");
    if (!seen) return (named ?? (others.teacher ??= { key: "teacher", hue: -1, label: "the Teacher", firstSec: now, lastSec: now, seenSec: 0, goodSec: 0, bumps: 0, lastBumpSec: -1e9, told: 0, right: 0, wrong: 0 })).key;
    return named?.key ?? null;
  }
  if (!seen) return null; // an unseen voice is nobody in particular
  return relationFor(m, speaker.hue, now).key;
}

/** The Teacher has been seen speaking: that look is the Teacher, and anything said before it was seen moves to it. */
export function learnTeacherLook(m: Mind, hue: number, now: number): string {
  const others = ensureOthers(m);
  const r = relationFor(m, hue, now);
  r.label = "the Teacher";
  const ghost = others.teacher;
  if (ghost && ghost.key !== r.key) {
    r.told += ghost.told; r.right += ghost.right; r.wrong += ghost.wrong;
    delete others.teacher;
    for (const c of m.claims) if (c.fromKey === "teacher") c.fromKey = r.key;
  }
  return r.key;
}

/** Brings a relation's record in line with how a claim from it has turned out. Safe to call every night: each claim counts once, and a verdict that flips is recounted. */
export function creditClaim(m: Mind, c: Claim): void {
  if (!c.fromKey) return;
  const r = ensureOthers(m)[c.fromKey];
  const now = c.status === "unverified" ? null : c.status;
  const was = c.counted ?? null;
  if (!r || now === was) return;
  const field = (s: "supported" | "contradicted") => (s === "supported" ? "right" : "wrong");
  if (was) { r[field(was)]--; r.told--; }
  if (now) { r[field(now)]++; r.told++; }
  c.counted = now ?? undefined;
}

/** How far to believe what this one says, 0..1. 0.5 means no record. A wrong claim weighs twice a right one. */
export function trustOf(r: Relation): number {
  return (r.right + 1) / (r.right + 2 * r.wrong + 2);
}

/** How good its company has been, -1..1; 0 until it has been watched long enough to say. */
export function affinityOf(r: Relation): number {
  if (r.seenSec < KNOWN_SEC) return 0;
  const good = Math.min(1, r.goodSec / (r.seenSec * 0.5)); // half the time in a good moment is as good as it gets
  // Pets brush against each other now and then without harm: what counts is how often, not that it ever happened.
  const hurt = Math.min(0.6, (r.bumps / (r.seenSec / 3600)) * 0.04);
  return Math.max(-1, Math.min(1, good - hurt - 0.2));
}

export function trustWord(r: Relation): string {
  if (r.told === 0) return "I have no record of what they tell me";
  const t = trustOf(r);
  const tally = `${r.right} of ${r.told} things they told me held up`;
  return `${t >= 0.65 ? "reliable" : t <= 0.35 ? "often wrong" : "mixed"}: ${tally}`;
}

function company(r: Relation): string {
  if (r.seenSec < KNOWN_SEC) return "I have only just got to know them";
  const a = affinityOf(r);
  return a > 0.25 ? "their company has been good for me" : a < -0.1 ? "being near them has not gone well" : "their company is neither here nor there";
}

/** Short lines for the pet's notes: the ones it knows, best known first. */
export function describeOthers(p: Pick<PetState, "mind">, now: number, n = 4, short = false): string[] {
  return Object.values(p.mind.others ?? {})
    .filter((r) => r.seenSec >= 30 || r.told > 0)
    .sort((a, b) => b.seenSec + b.told * 600 - (a.seenSec + a.told * 600))
    .slice(0, n)
    .map((r) => {
      const known = r.seenSec >= 3600 ? `${Math.round(r.seenSec / 3600)}h` : `${Math.max(1, Math.round(r.seenSec / 60))} min`;
      if (short) { // the same facts, said briefly (for the compact prompt)
        const a = affinityOf(r), co = r.seenSec < KNOWN_SEC ? "barely known" : a > 0.25 ? "good company" : a < -0.1 ? "poor company" : "company so-so";
        const trust = r.told === 0 ? "no record of what they say" : `${trustOf(r) >= 0.65 ? "reliable" : trustOf(r) <= 0.35 ? "often wrong" : "mixed"} (${r.right}/${r.told} of what they said held up)`;
        return `- ${r.label}: seen ${known}, ${co}${r.bumps ? `, ${r.bumps} bumps` : ""}, ${trust}${now - r.lastSec > 6 * 3600 ? ", not seen for a while" : ""}`;
      }
      const bumps = r.bumps ? `, bumped into them ${r.bumps}x` : "";
      return `- ${r.label}: seen for ${known}; ${company(r)}${bumps}; ${trustWord(r)}${now - r.lastSec > 6 * 3600 ? "; not seen for a while" : ""}`;
    });
}

/** The label of whoever a claim came from, with how far they can be trusted, for the pet's list of claims. */
export function sourceNote(m: Mind, c: Claim): string {
  const r = c.fromKey ? ensureOthers(m)[c.fromKey] : undefined;
  if (!r) return "";
  return r.told ? ` (from ${r.label}, ${trustWord(r)})` : ` (from ${r.label})`;
}

/** Which of the pets in view System 1 should go to when it wants company. Better company is worth a longer walk. A pet is never made to avoid anyone: measured, steering clear of those it bumps into only left it lonelier. */
export function pickCompany(p: Pick<PetState, "mind" | "drives">, vision: Detection[], now: number): Detection | undefined {
  let best: Detection | undefined, bestScore = Infinity;
  for (const v of vision) {
    if (v.category !== "moving") continue;
    const r = relationFor(p.mind, v.hue, now);
    const a = affinityOf(r);
    const score = v.distance * (1 - 0.4 * a);
    if (score < bestScore) { best = v; bestScore = score; }
  }
  return best;
}
