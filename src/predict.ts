// Prediction and surprise. Each pet learns, from its own sensor stream, what usually happens next on a few channels
// (light, temperature, battery, the steady tone), and notices when reality lands far from what it expected.
// Nothing here is given to the pet as a fact about the world: the expectations are running statistics of what it has
// actually experienced, so they adapt (a change that lasts stops being surprising) and differ between pets.
//
// What surprise is for: it makes a moment memorable (a scene), it is shown to System 2 ("what surprised me lately"),
// it gives curiosity a small lift (curiosity from prediction error), it steers dreams toward what went unexpectedly,
// and its running level is logged so it can be charted over days.
//
// Channels:
//   light, temperature, battery  per-tick change, learned separately for moving/still (battery: charging/mode)
//   toneVolume                   change in the tone's loudness; while the pet is walking toward the tone it learns it usually gets louder
//   tonePresence                 whether a tone it was hearing keeps being heard (and whether a new one suddenly appears)
//   charge (from cues.ts)        reached the loud end of the tone, expected to be charged, was not
import type { Observation } from "./sensors.js";
import type { PetState } from "./pet.js";

export const MIN_N = 30; // observations before a channel may be surprised: a pet must know what is normal first
const ALPHA_MIN = 0.003; // forgetting: expectations follow roughly the last forty simulated minutes, long enough to include rare but normal jumps
const COOLDOWN_SEC = 300; // one surprise per channel per five simulated minutes
const REPORT_AT = 0.25; // surprise scores below this are noise
const AUDIBLE = 0.3; // walking at full speed changes the loudness by up to about 0.21 in one tick, so a tone this loud cannot just fade out or in; it was switched
const CURIOSITY_LIFT = 0.1; // a full surprise raises curiosity by this much
export const MAX_RECENT = 12;

// Each channel's sensor noise floor, so a tiny learned variance never makes a trivial wobble look extreme.
const SD_FLOOR: Record<string, number> = { light: 1.5, temperature: 0.15, battery: 0.05, toneVolume: 0.02 };

export interface Stat { n: number; mean: number; var: number; up: number } // up: how many changes were increases
export interface Surprise { tSec: number; channel: string; ctx: string; expected: number; actual: number; score: number; why: string }

/** What the last tick looked like, and what the pet was doing in it: that is what caused the change now being measured. */
interface Prev { light: number; temperature: number; energy: number; tone: number | null; moving: boolean; following: boolean; mode: string; charging: boolean }

export interface PredictState {
  stats: Record<string, Stat>; // "channel:context" to what is normal there
  presence: { present: number; vanished: number; absent: number; appeared: number }; // the tone: kept being heard / stopped; silent / suddenly loud
  prev: Prev | null;
  recent: Surprise[]; // newest last
  level: number; // running overall surprise, 0..1
  peak: number; // the biggest surprise since the metrics were last sampled, so a short spike still shows on a chart sampled every 15 minutes
  byChannel: Record<string, number>; // running surprise per channel
  lastAt: Record<string, number>;
}

export const newPredict = (): PredictState => ({ stats: {}, presence: { present: 0, vanished: 0, absent: 0, appeared: 0 }, prev: null, recent: [], level: 0, peak: 0, byChannel: {}, lastAt: {} });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function learn(s: Stat, x: number): void {
  s.n++;
  const a = Math.max(1 / s.n, ALPHA_MIN);
  const d = x - s.mean;
  s.mean += a * d;
  s.var = (1 - a) * (s.var + a * d * d);
  if (x > 0) s.up++;
}

/** 0 for anything within about 3 standard deviations of what the pet expects, rising to 1 by 8. */
export function scoreOf(z: number): number {
  return clamp((Math.abs(z) - 3) / 5, 0, 1);
}

/** Which way surprised, and how much, for a new observation against what is expected. Learns from it afterwards. */
function observe(ps: PredictState, key: string, channel: string, x: number): { z: number; expected: number; n: number } {
  const s = (ps.stats[key] ??= { n: 0, mean: 0, var: 0, up: 0 });
  const sd = Math.max(Math.sqrt(s.var), SD_FLOOR[channel] ?? 0.01);
  const out = { z: (x - s.mean) / sd, expected: s.mean, n: s.n };
  // Learn from it, but not all of a wild value: one huge jump must not inflate the spread and numb the pet to the next one.
  learn(s, clamp(x, s.mean - 6 * sd, s.mean + 6 * sd));
  return out;
}

/** Record that an expectation was broken: remember it, lift curiosity a little, and keep the running levels. */
export function recordSurprise(p: PetState, s: Surprise): boolean {
  const ps = (p.predict ??= newPredict());
  const slot = `${s.channel}:${s.ctx}`; // a tone appearing and a tone vanishing are different events
  if (s.score < REPORT_AT || s.tSec - (ps.lastAt[slot] ?? -1e9) < COOLDOWN_SEC) return false;
  ps.lastAt[slot] = s.tSec;
  ps.recent.push(s);
  if (ps.recent.length > MAX_RECENT) ps.recent.shift();
  p.drives.curiosity = clamp(p.drives.curiosity + CURIOSITY_LIFT * s.score, 0, 1);
  return true;
}

const dir = (n: number) => (n > 0 ? "up" : "down");

/**
 * Called once per pet tick after it has acted. Compares what just happened with what it had learned to expect,
 * then learns from it. Returns the surprises worth remembering this tick.
 */
export function updatePredictions(p: PetState, obs: Observation, nowSec: number): Surprise[] {
  const ps = (p.predict ??= newPredict());
  const out: Surprise[] = [];
  const prev = ps.prev;
  const tone = obs.tone ? obs.tone.volume : null;
  ps.prev = { light: obs.light, temperature: obs.temperature, energy: obs.energy, tone, moving: p.speed > 1, following: p.s1.action === "follow_tone", mode: p.mode, charging: obs.chargeRate >= 0.5 };
  if (!prev) return out;
  let worst = 0;
  const bump = (channel: string, score: number) => {
    ps.byChannel[channel] = (ps.byChannel[channel] ?? 0) * 0.99 + score * 0.01;
    worst = Math.max(worst, score);
  };
  const emit = (channel: string, ctx: string, expected: number, actual: number, score: number, why: string) => {
    const s: Surprise = { tSec: nowSec, channel, ctx, expected: r2(expected), actual: r2(actual), score: r2(score), why };
    if (recordSurprise(p, s)) out.push(s);
  };

  // Light, temperature and battery: how much they changed this tick, against what is usual for this kind of moment.
  const delta = (channel: string, ctx: string, x: number, say: (e: number, a: number) => string) => {
    const r = observe(ps, `${channel}:${ctx}`, channel, x);
    const score = r.n >= MIN_N ? scoreOf(r.z) : 0;
    bump(channel, score);
    if (score > 0) emit(channel, ctx, r.expected, x, score, say(r.expected, x));
  };
  const kind = prev.moving ? "moving" : "still"; // what it was doing during the interval that is being measured
  delta("light", kind, obs.light - prev.light, (e, a) => `the light jumped ${dir(a)} by ${Math.abs(Math.round(a))} in a moment; I expected a change of about ${Math.abs(Math.round(e))}`);
  delta("temperature", kind, obs.temperature - prev.temperature, (_e, a) => `it got ${a > 0 ? "warmer" : "colder"} by ${Math.abs(a).toFixed(1)} degrees in a moment, which is far more than usual`);
  delta("battery", prev.charging ? "charging" : prev.mode, obs.energy - prev.energy, (_e, a) => `my battery changed by ${a > 0 ? "+" : ""}${a.toFixed(2)} in a moment, not what I expected`);

  // The steady tone: does it keep being there, and does it get louder as I walk toward it?
  const pr = ps.presence;
  if (prev.tone !== null && prev.tone >= AUDIBLE) {
    pr.present++;
    if (tone === null) {
      pr.vanished++;
      const bits = -Math.log2((pr.vanished + 0.5) / (pr.present + 1));
      const score = pr.present >= MIN_N ? clamp((bits - 3) / 5, 0, 1) : 0;
      bump("tonePresence", score);
      if (score > 0) emit("tonePresence", "vanished", 1 - pr.vanished / pr.present, 0, score, "the steady tone I was hearing suddenly stopped");
    } else bump("tonePresence", 0);
  } else if (prev.tone === null) {
    pr.absent++;
    if (tone !== null && tone >= AUDIBLE) {
      pr.appeared++;
      const bits = -Math.log2((pr.appeared + 0.5) / (pr.absent + 1));
      const score = pr.absent >= MIN_N ? clamp((bits - 3) / 5, 0, 1) : 0;
      bump("tonePresence", score);
      if (score > 0) emit("tonePresence", "appeared", 0, tone, score, "a steady tone I had not been hearing suddenly came back, loud");
    }
  }
  if (prev.tone !== null && tone !== null) {
    const following = prev.following;
    const tctx = following ? "following" : prev.moving ? "moving" : "still"; // walking about changes the loudness a lot; standing still, hardly at all
    const r = observe(ps, `toneVolume:${tctx}`, "toneVolume", tone - prev.tone);
    const score = r.n >= MIN_N ? scoreOf(r.z) : 0;
    bump("toneVolume", score);
    if (score > 0) {
      const why = following && tone - prev.tone < r.expected
        ? "I was walking toward the steady tone but it got quieter, not louder"
        : `the steady tone got ${tone > prev.tone ? "much louder" : "much quieter"} in a moment, which is not what I expected`;
      emit("toneVolume", tctx, r.expected, tone - prev.tone, score, why);
    }
  }
  ps.level = ps.level * 0.995 + worst * 0.005;
  ps.peak = Math.max(ps.peak ?? 0, worst);
  return out;
}

// ---- for System 2's notes and the dashboard ----

const SIX_HOURS = 6 * 3600;

export function describeSurprises(p: Pick<PetState, "predict">, nowSec: number, n = 3): string[] {
  const clock = (t: number) => {
    const m = Math.floor(t / 60);
    return `D${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return [...(p.predict?.recent ?? [])]
    .filter((s) => nowSec - s.tSec <= SIX_HOURS)
    .sort((a, b) => b.score - a.score || b.tSec - a.tSec)
    .slice(0, n)
    .map((s) => `- ${clock(s.tSec)} ${s.why} (${s.score >= 0.6 ? "very" : "somewhat"} surprising)`);
}

/** In plain words how well the pet has been able to predict things lately, and what it has learned to expect about the tone. */
export function describeExpectations(p: Pick<PetState, "predict">): string {
  const ps = p.predict;
  if (!ps) return "I have not been watching long enough to know what to expect.";
  const level = ps.level < 0.02 ? "very little" : ps.level < 0.06 ? "a little" : "quite a lot";
  const parts = [`Lately things have surprised me ${level}.`];
  const f = ps.stats["toneVolume:following"];
  if (f && f.n >= MIN_N) parts.push(`When I walk toward a steady tone it has got louder ${Math.round((100 * f.up) / f.n)}% of the time.`);
  const pr = ps.presence;
  if (pr.present >= MIN_N) parts.push(`A tone I am hearing has stopped on me ${pr.vanished} of ${pr.present} times.`);
  return parts.join(" ");
}

/** The biggest surprise since the last call, then start again. Used by the 15-minute metrics. */
export function takePeak(p: Pick<PetState, "predict">): number {
  const ps = p.predict;
  if (!ps) return 0;
  const v = ps.peak ?? 0;
  ps.peak = 0;
  return Math.round(v * 100) / 100;
}

/** For the dashboard: the running level and the latest surprises. */
export function predictView(p: Pick<PetState, "predict">) {
  const ps = p.predict;
  return {
    level: r2(ps?.level ?? 0),
    byChannel: Object.fromEntries(Object.entries(ps?.byChannel ?? {}).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    recent: [...(ps?.recent ?? [])].reverse(),
    learned: Object.entries(ps?.stats ?? {}).map(([key, s]) => ({ key, n: s.n, mean: Math.round(s.mean * 1000) / 1000, sd: Math.round(Math.sqrt(s.var) * 1000) / 1000 })),
  };
}
