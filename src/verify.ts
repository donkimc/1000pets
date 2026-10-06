// Verification: checking what a pet believes, was told, or has concluded against what it actually experienced.
// Until now a statement could only be "supported" by a keyword match; nothing could ever show it to be wrong.
// Here a handful of testable topics each have a rule that reads the pet's own evidence (its remembered moments with
// where they happened, how often the tone led to charge, how it learned the tone behaves) and returns a verdict:
// supported, contradicted, or unclear, with the reason in plain words and the amount of evidence behind it.
//
// This is deliberately limited: it only knows the topics below, and says nothing about anything else. A statement it
// cannot test is left alone, never guessed at. The evidence is the pet's own: nothing here tells it how the world works.
import type { PetState } from "./pet.js";
import type { Scene } from "./scenes.js";

export type VerdictState = "supported" | "contradicted" | "unclear";
/** positive: the verdict rests on counted evidence for the statement, not merely on nothing having gone wrong yet. Only positive evidence can overturn a contradiction. */
export interface Verdict { topic: string; state: VerdictState; support: number; contra: number; why: string; positive?: boolean }

const SIX_HOURS = 6 * 3600;
const times = (s: Scene) => s.count ?? 1;
const lastTime = (s: Scene) => Math.max(s.tSec, s.lastSec ?? 0);
const ABSOLUTE = /\b(always|never|every time|all the time|without fail|only|forever)\b/i;

/** How many remembered occasions of these kinds happened after `since`. */
function count(p: Pick<PetState, "mind">, kinds: string[], since: number, where?: (s: Scene) => boolean): number {
  let n = 0;
  for (const s of p.mind.scenes) if (kinds.includes(s.kind) && lastTime(s) > since && (!where || where(s))) n += times(s);
  return n;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Scenes of a kind that have a known place. */
/** Which pad a charger moment was at, told apart by its hum, the only thing about a pad that identifies it. */
const padHum = (s: { tone: { pitch: number } | null }) => (s.tone ? Math.round(12 * Math.log2(s.tone.pitch / 100)) : -1);
const placed = (p: Pick<PetState, "mind">, kind: string) => p.mind.scenes.filter((s) => s.kind === kind && s.pose);

/** A rate of failures against occasions, turned into a verdict. Too few occasions: unclear. */
function byRate(topic: string, support: number, contra: number, absolute: boolean, why: (s: number, c: number) => string): Verdict {
  const n = support + contra;
  const rate = n ? contra / n : 0;
  const state: VerdictState = n >= 3 && rate >= (absolute ? 0.3 : 0.5) ? "contradicted" : n >= 3 && rate <= 0.2 ? "supported" : "unclear";
  return { topic, state, support, contra, why: why(support, contra), positive: true };
}

interface Topic {
  id: string;
  matches: (text: string) => boolean;
  check: (p: Pick<PetState, "mind" | "predict">, text: string, since: number, now: number) => Verdict;
}

const has = (re: RegExp) => (t: string) => re.test(t);

function occurs(id: string, matches: (t: string) => boolean, kinds: string[], what: string): Topic {
  return {
    id,
    matches,
    check: (p, _text, since) => {
      const n = count(p, kinds, since);
      return { topic: id, state: n >= 2 ? "supported" : "unclear", positive: true, support: n, contra: 0, why: n >= 2 ? `${what} ${n} times since` : "I have not experienced it enough times to say" };
    },
  };
}

// Order matters: the first topic that matches decides.
const TOPICS: Topic[] = [
  {
    // "the tone leads to the pad / to charging / to my battery filling"
    id: "tone leads to charge",
    matches: (t) => /\b(tone|hum(ming|s)?|sound|noise)\b/i.test(t) && /\b(charg|pad|battery|fill|energy|power)/i.test(t),
    check: (p, text, since) => {
      // support: finding the pad while a tone was audible; against: reaching the loud end of the tone and not being charged
      const support = count(p, ["charger"], since, (s) => !!s.tone);
      const contra = count(p, ["nocharge"], since);
      return byRate("tone leads to charge", support, contra, ABSOLUTE.test(text), (s, c) => `following the tone ended at the pad ${s} time${s === 1 ? "" : "s"}, and ${c} time${c === 1 ? "" : "s"} I reached its loud end and was not charged`);
    },
  },
  {
    // "the tone is always there / never stops / is steady"
    id: "tone is steady",
    matches: (t) => /\b(tone|hum(ming|s)?)\b/i.test(t) && /\b(always|never (stops?|goes? away|ends?)|steady|constant|continuous|forever|keeps (playing|going|humming))\b/i.test(t),
    check: (p, text, since, now) => {
      const lost = count(p, ["tonelost"], since);
      const heardRecently = Object.values(p.mind.cues ?? {}).some((c) => c.lastHeardSec >= now - 600);
      const absolute = ABSOLUTE.test(text);
      const long = now - since >= (absolute ? 6 * 3600 : 1800) && heardRecently; // 'never' needs hours of listening to bear it out
      const state: VerdictState = lost >= (absolute ? 1 : 3) ? "contradicted" : long && lost === 0 ? "supported" : "unclear";
      return { topic: "tone is steady", state, positive: false, support: state === "supported" ? 1 : 0, contra: lost, why: lost ? `the tone I was hearing suddenly stopped ${lost} time${lost === 1 ? "" : "s"}` : long ? "it kept sounding for a long while without stopping" : "not enough time has passed to tell" };
    },
  },
  {
    // "walking toward the tone makes it louder"
    id: "tone gets louder toward it",
    matches: (t) => /\b(tone|hum(ming|s)?|sound)\b/i.test(t) && /\b(louder|stronger|closer|quieter|softer|fainter|weaker)\b/i.test(t) && /\b(toward|towards|follow|walk|approach|nearer|get(ting)? close)/i.test(t),
    check: (p, text) => {
      const says = /\b(quieter|softer|fainter|weaker)\b/i.test(text) ? "down" : "up"; // which way the claim says it goes
      const st = p.predict?.stats["toneVolume:following"];
      if (!st || st.n < 30) return { topic: "tone gets louder toward it", state: "unclear", support: 0, contra: 0, why: "I have not walked toward it enough to tell" };
      const rate = st.up / st.n; // how often it got louder
      const louder = rate >= 0.6, quieter = rate <= 0.35;
      const state: VerdictState = (louder && says === "up") || (quieter && says === "down") ? "supported" : (louder && says === "down") || (quieter && says === "up") ? "contradicted" : "unclear";
      return { topic: "tone gets louder toward it", state, positive: true, support: state === "supported" ? Math.max(st.up, st.n - st.up) : 0, contra: state === "contradicted" ? Math.max(st.up, st.n - st.up) : 0, why: `walking toward the tone it got louder ${Math.round(rate * 100)}% of the time` };
    },
  },
  {
    // "the pad stays in the same place" / "the pad moves"
    id: "pad stays put",
    matches: (t) => /\b(pad|charger)\b/i.test(t) && /\b(same (place|spot|position)|stays?|fixed|always (here|there|in the same)|doesn'?t move|never moves|moves?|moving|shifts?|changes? (place|position))\b/i.test(t) && !/\b(heater|warm)/i.test(t),
    check: (p, text) => {
      const stays = /\b(same (place|spot|position)|stays?|fixed|always (here|there|in the same)|doesn'?t move|never moves)\b/i.test(text);
      const cs = placed(p, "charger");
      let spread = -1, pairs = 0;
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        if (Math.abs(cs[i].tSec - cs[j].tSec) > SIX_HOURS) continue; // dead reckoning drifts over many hours: only compare moments close in time
        if (padHum(cs[i]) !== padHum(cs[j])) continue; // each room has its own pad, with its own hum: pads that hum differently are different pads
        pairs++;
        spread = Math.max(spread, dist(cs[i].pose!, cs[j].pose!));
      }
      if (!pairs) return { topic: "pad stays put", state: "unclear", support: 0, contra: 0, why: "I have not found it enough times to compare" };
      const consistent = spread <= 180, scattered = spread > 400;
      const state: VerdictState = consistent ? (stays ? "supported" : "contradicted") : scattered ? (stays ? "contradicted" : "supported") : "unclear";
      return { topic: "pad stays put", state, positive: true, support: state === "supported" ? pairs : 0, contra: state === "contradicted" ? pairs : 0, why: consistent ? `every place I found it is within ${Math.round(spread)} steps of the others` : `the places I found it are up to ${Math.round(spread)} steps apart` };
    },
  },
  {
    // "the pad is by the heater / in the warm corner"
    id: "pad is by the heater",
    matches: (t) => /\b(pad|charger)\b/i.test(t) && /\b(heater|warm(th)? corner|warm corner|warm spot)\b/i.test(t),
    check: (p) => {
      // For each time it got suddenly warm: how far was that from where it found the pad around then? One odd pair proves nothing
      // (stepping away from a cold window also feels warmer), so it takes a pattern over several occasions either way.
      const cs = placed(p, "charger");
      let total = 0, near = 0, far = 0, nearest = Infinity;
      for (const w of placed(p, "warmer")) {
        const ds = cs.filter((c) => Math.abs(c.tSec - w.tSec) <= SIX_HOURS).map((c) => dist(c.pose!, w.pose!));
        if (!ds.length) continue;
        const d = Math.min(...ds), n = times(w);
        total += n;
        nearest = Math.min(nearest, d);
        if (d <= 250) near += n; else if (d > 450) far += n;
      }
      if (total < 3) return { topic: "pad is by the heater", state: "unclear", support: 0, contra: 0, why: "I have not felt the warmth near enough times, close in time to finding the pad, to compare" };
      const state: VerdictState = near / total >= 0.67 ? "supported" : far / total >= 0.67 ? "contradicted" : "unclear";
      return { topic: "pad is by the heater", state, positive: true, support: state === "supported" ? near : 0, contra: state === "contradicted" ? far : 0, why: state === "supported" ? `${near} of the ${total} times it got suddenly warm I was within 250 steps of where I found the pad` : `${far} of the ${total} times it got suddenly warm I was at least 450 steps from where I found the pad` };
    },
  },
  // Simple cause-and-effect statements that can only be borne out, by the pet having experienced it a few times since being told.
  // They cannot be contradicted by their absence, so they never are.
  occurs("pad charges you", (t) => /\b(pad|charger)\b/i.test(t) && /\b(charg(e|es|ed|ing)|fills?|filling|battery)\b/i.test(t) && !/\b(heater|warm)/i.test(t), ["charger"], "I have been charged at the pad"),
  occurs("heater warms", (t) => /\b(heater|heat)\b/i.test(t) && /\b(warm|warms|warmth|hot)\b/i.test(t), ["warmer"], "I have felt it get suddenly warm"),
  occurs("lamp or sun brightens", (t) => /\b(lamp|sun|sunlight|window|curtain)\b/i.test(t) && /\b(bright|brighter|light up|lights up|lit)\b/i.test(t), ["brighter", "sunpatch"], "I have felt the light suddenly get brighter"),
];

/** Test a statement against the pet's own experience since `sinceSec`. Null if it is not about anything this knows how to check. */
export function checkStatement(p: Pick<PetState, "mind" | "predict">, text: string, sinceSec: number, nowSec: number): Verdict | null {
  const topic = TOPICS.find((t) => t.matches(text));
  return topic ? topic.check(p, text, sinceSec, nowSec) : null;
}

// ---- what was found to be wrong ----

export const REFUTED_FOR_SEC = 24 * 3600; // a belief found wrong cannot simply be taken up again for a day
export const MAX_REFUTED = 8;

export function addRefuted(p: Pick<PetState, "mind">, text: string, why: string, nowSec: number): void {
  const list = (p.mind.refuted ??= []);
  if (list.some((r) => r.text === text)) return;
  list.push({ text, why, tSec: nowSec });
  if (list.length > MAX_REFUTED) list.shift();
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 4);

/** True if a statement repeats something the pet recently found to be wrong. */
export function copiesRefuted(p: Pick<PetState, "mind">, text: string, nowSec: number): boolean {
  const w = new Set(words(text));
  if (w.size < 3) return false;
  for (const r of p.mind.refuted ?? []) {
    if (nowSec - r.tSec > REFUTED_FOR_SEC) continue;
    const rw = words(r.text);
    if (rw.length >= 3 && rw.filter((x) => w.has(x)).length / rw.length >= 0.6) return true;
  }
  return false;
}

// ---- gists that say the same thing, or the opposite ----

const NEGATION = /\b(not|never|no|none|nothing|isn'?t|doesn'?t|don'?t|cannot|can'?t|stops?|stopped|fails?|failed|without)\b/i;

export function similarity(a: string, b: string): number {
  const x = new Set(words(a)), y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Two statements about the same thing, one saying it and one denying it. */
export function conflicts(a: string, b: string): boolean {
  return similarity(a, b) >= 0.6 && NEGATION.test(a) !== NEGATION.test(b);
}

/** Two statements that say the same thing. */
export function duplicates(a: string, b: string): boolean {
  return similarity(a, b) >= 0.75 && NEGATION.test(a) === NEGATION.test(b);
}
