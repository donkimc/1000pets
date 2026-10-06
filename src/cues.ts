// Cue learning: how a pet works out what a steady tone is about. The charger hums, but nothing tells the pet that.
// A pet only counts what happened: charging began soon after it had been close to the loud end of a tone
// (support), or it followed a tone to its loud end and no charge came (contra). That evidence, not a model's
// opinion, decides whether the tone is trusted. System 2 can name and reason about it, and the Teacher can
// teach it as a claim that the pet then checks by following the tone itself.
import { pitchBin, type Observation, type Tone } from "./sensors.js";
import type { PetState } from "./pet.js";
import { recordSurprise, type Surprise } from "./predict.js";

export const LOUD = 0.4; // a tone this loud means the source is within about 420 units
export const NEAR_SOURCE = 0.85; // within about 105 units of the source
const WINDOW_SEC = 60; // charging this soon after being close to a tone's loud end counts as following it
const GIVE_UP_SEC = 120; // reached the source and not charged for this long: the attempt failed
const SEPARATE_SEC = 600; // two charge starts closer together than this are one occasion
const MAX_CUES = 12;
const HABITUATION_SEC = 1800; // novelty fades as total exposure approaches this

export interface Cue {
  key: string; // "tone:29": the semitone bin of the pitch
  pitch: number; // typical pitch in Hz
  firstHeardSec: number;
  lastHeardSec: number;
  exposureSec: number; // total simulated seconds the tone has been audible
  support: number; // charge started soon after the pet was close to this tone's loud end
  contra: number; // the pet followed it to the source and no charge came
  peakVolume: number; // loudest in the last minute
  peakAtSec: number;
  lastVolume: number; // volume at the previous tick, to tell whether it is getting louder
  lastSupportSec: number; // when support was last counted: separate occasions only, not every flicker on and off the pad
}

/** Working state for following a tone: lives with the pet, not in its long-term memory. */
export interface CueGoal { key: string; sinceSec: number; lastToneSec: number; reachedSec?: number; bestVolume: number; lastProgressSec: number; lastFollowSec: number }
export interface CueState { charge: number; goal: CueGoal | null }

export const toneKey = (t: Pick<Tone, "pitch">) => `tone:${pitchBin(t.pitch)}`;

export function newCue(key: string, pitch: number, nowSec: number): Cue {
  return { key, pitch, firstHeardSec: nowSec, lastHeardSec: nowSec, exposureSec: 0, support: 0, contra: 0, peakVolume: 0, peakAtSec: nowSec, lastVolume: 0, lastSupportSec: -1e9 };
}

export function cueFor(p: Pick<PetState, "mind">, tone: Tone): Cue | undefined {
  return p.mind.cues?.[toneKey(tone)];
}

export interface Trust { trusted: boolean; tentative: boolean; ratio: number }

/** Trust is earned from counts: two successes and mostly successes. One success is only a hunch. */
export function cueTrust(c: Cue | undefined): Trust {
  if (!c) return { trusted: false, tentative: false, ratio: 0 };
  const n = c.support + c.contra;
  const ratio = n ? c.support / n : 0;
  return { trusted: c.support >= 2 && ratio >= 0.6, tentative: c.support >= 1 && ratio >= 0.5, ratio };
}

/** 1 for a sound never heard before, fading toward 0 as the pet gets used to it. */
export function novelty(c: Cue | undefined): number {
  return c ? Math.exp(-c.exposureSec / HABITUATION_SEC) : 1;
}

/** System 1 calls this when it starts to follow a tone, so the outcome can be judged. */
export function startGoal(p: PetState, tone: Tone, nowSec: number): void {
  const cs = (p.cueState ??= { charge: 0, goal: null });
  const key = toneKey(tone);
  if (cs.goal?.key === key) return;
  cs.goal = { key, sinceSec: nowSec, lastToneSec: nowSec, bestVolume: tone.volume, lastProgressSec: nowSec, lastFollowSec: nowSec };
}

/**
 * Called once per pet tick after it has acted. Tracks how long each tone has been heard, and turns what happened
 * into evidence: charge starting soon after the pet was close to a tone's loud end is support; following a tone
 * to its source and not being charged is contra. Losing the tone (it was switched off) cancels an attempt
 * without blame.
 */
export function updateCues(p: PetState, obs: Observation, nowSec: number, dt: number): Surprise[] {
  const surprises: Surprise[] = [];
  const cs = (p.cueState ??= { charge: 0, goal: null });
  const cues = (p.mind.cues ??= {});
  const tone = obs.tone;
  if (tone) {
    const key = toneKey(tone);
    let c = cues[key];
    if (!c) {
      if (Object.keys(cues).length >= MAX_CUES) {
        const stalest = Object.values(cues).sort((a, b) => a.lastHeardSec - b.lastHeardSec)[0];
        delete cues[stalest.key];
      }
      c = cues[key] = newCue(key, tone.pitch, nowSec);
    }
    c.exposureSec += dt;
    c.lastHeardSec = nowSec;
    c.pitch = Math.round(c.pitch * 0.9 + tone.pitch * 0.1);
    if (tone.volume >= c.peakVolume || nowSec - c.peakAtSec > WINDOW_SEC) {
      c.peakVolume = tone.volume;
      c.peakAtSec = nowSec;
    }
    c.lastVolume = tone.volume;
  }

  // Charge starting now: every tone that was heard loud within the last minute gets the credit.
  const onset = cs.charge < 0.5 && p.chargeRate >= 0.9;
  if (onset) {
    for (const c of Object.values(cues)) {
      if (nowSec - c.lastHeardSec <= WINDOW_SEC && c.peakVolume >= LOUD && nowSec - c.peakAtSec <= WINDOW_SEC && nowSec - c.lastSupportSec >= SEPARATE_SEC) {
        c.support++;
        c.lastSupportSec = nowSec;
      }
    }
    cs.goal = null;
  }

  const g = cs.goal;
  if (g) {
    const c = cues[g.key];
    if (p.s1.action === "follow_tone") g.lastFollowSec = nowSec;
    if (tone && toneKey(tone) === g.key) {
      g.lastToneSec = nowSec;
      if (tone.volume > g.bestVolume + 0.03) { g.bestVolume = tone.volume; g.lastProgressSec = nowSec; } // getting louder means getting closer
      if (tone.volume >= NEAR_SOURCE && g.reachedSec === undefined) g.reachedSec = nowSec;
    }
    if (g.reachedSec !== undefined && nowSec - g.reachedSec >= GIVE_UP_SEC && p.chargeRate < 0.5) {
      // Someone else right beside it (very likely using the pad) is a busy source, not evidence that the tone is wrong.
      const crowded = obs.near.some((n) => n.category === "moving");
      // How surprising this is depends on what the pet knew before it happened: failing once when it works 85% of the time is no shock.
      const tries = c ? c.support + c.contra : 0;
      const score = tries < 5 ? 0.3 : Math.min(1, Math.max(0, (-Math.log2((c!.contra + 0.5) / (tries + 1)) - 1.5) / 4));
      if (c && !crowded) c.contra++;
      // Whoever was at fault, it was not what the pet expected: it reached the source and was not charged.
      const sur: Surprise = { tSec: nowSec, channel: "charge", ctx: "nocharge", expected: 1, actual: 0, score: Math.round(score * 100) / 100, why: "I reached the loud end of the steady tone and expected to be charged, but it did not happen" };
      if (recordSurprise(p, sur)) surprises.push(sur);
      cs.goal = null;
    } else if (nowSec - g.lastToneSec > 30 || nowSec - g.sinceSec > 900 || nowSec - g.lastFollowSec > 30) {
      cs.goal = null; // the tone went away, the pet chose to do something else, or it simply took too long: no blame
    }
  }
  cs.charge = p.chargeRate;
  return surprises;
}

// ---- words for System 2's notes ----

const SIDE = (b: number) => (Math.abs(b) < 0.4 ? "ahead of me" : Math.abs(b) > 2.3 ? "behind me" : b > 0 ? "to my right" : "to my left");

/** What a pet perceives of a tone right now: pitch, loudness, direction, and whether it is getting louder. */
export function describeTone(tone: Tone, prevVolume: number | undefined): string {
  const loud = tone.volume > 0.7 ? "very loud" : tone.volume > 0.4 ? "fairly loud" : tone.volume > 0.15 ? "quiet" : "very quiet";
  const d = prevVolume === undefined ? 0 : tone.volume - prevVolume;
  const trend = d > 0.04 ? ", getting louder" : d < -0.04 ? ", getting quieter" : "";
  return `a steady tone at ${tone.pitch} Hz, ${loud}${trend}, ${SIDE(tone.bearing)}`;
}

/** What the pet has learned about each tone, as plain counts. */
export function describeCues(p: Pick<PetState, "mind">): string[] {
  return Object.values(p.mind.cues ?? {})
    .sort((a, b) => b.support - a.support || b.exposureSec - a.exposureSec)
    .slice(0, 2)
    .map((c) => {
      const t = cueTrust(c);
      const mins = Math.max(1, Math.round(c.exposureSec / 60));
      const verdict = t.trusted ? "I trust it" : t.tentative ? "I suspect it" : c.contra > c.support ? "I doubt it" : "I do not know what it means yet";
      return `- the steady tone at ${c.pitch} Hz: heard for about ${mins} min in total. Times I got close to its loud end and charging began: ${c.support}. Times I followed it to the source and was not charged: ${c.contra}. ${verdict}.`;
    });
}
