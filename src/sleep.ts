// Sleep: slow consolidation of memory while a pet is asleep. It happens in two stages, once per sleep.
//
// Stage 1 is plain rules (no model) and runs inside the simulation once a pet has been asleep for a while:
//   - repeated moments are merged into one that remembers how many times it happened,
//   - moments that were never used fade, and the faint, old, unimportant ones are forgotten,
//   - what the pet was told is checked against what it has since experienced,
//   - belief and gist confidence move with counted evidence, and weak unsupported ones fade away.
// Stage 2 is one slow model call (the Consolidator) that writes up to three "gists": short statements of patterns
// the pet seems to have noticed, each linked to the moments it came from. A gist starts provisional and only gains
// confidence from later experience, never from the model's own opinion.
//
// Important things resist forgetting, and moments that back a young gist are kept until it has had time to prove itself.
import { LlmUnavailable, type ChatMessage, type CompleteOpts, type LlmResult } from "./llm.js";
import type { PetState } from "./pet.js";
import { describeCues } from "./cues.js";
import { addRefuted, checkStatement, conflicts, duplicates } from "./verify.js";
import { describeScene, sceneScore, type Scene } from "./scenes.js";
import { creditClaim } from "./relations.js";
import type { Simulation } from "./sim.js";
import type { Store } from "./store.js";

export const SLEEP_MIN_SEC = 900; // asleep this long before the night's consolidation runs (naps do not count)
const MERGE_AFTER_SEC = 3600; // fresh moments are left alone
const KEEP_PER_KIND = 2; // distinct examples kept for each kind of moment; the rest are folded into them
const DECAY_AFTER_SEC = 12 * 3600;
const DELETE_AFTER_SEC = 24 * 3600;
const PROTECT_IMPORTANCE = 0.7; // moments this important are never forgotten by fading
const FORGET_BELOW = 0.12;
const BELIEF_STALE_SEC = 36 * 3600;
const GIST_STALE_SEC = 48 * 3600;
const YOUNG_GIST_SEC = 48 * 3600;
const PROVEN = 0.6;
const WRONG_FOR_SEC = 4 * 3600; // a belief found wrong is let go if it is still contradicted this much later
export const MAX_GISTS = 12;
const GIST_COOLDOWN_SEC = 4 * 3600;
const GIST_START_MAX = 0.5; // a new gist is provisional whatever the model says

export interface Gist {
  id: string;
  text: string;
  confidence: number;
  kinds: string[]; // kinds of moment it was drawn from; later moments of these kinds count as evidence
  sources: string[]; // ids of the moments it cites, as provenance
  createdSec: number;
  checkedSec: number; // evidence up to here has been counted
  lastUsedSec: number;
  uses: number;
  verdict?: "supported" | "contradicted" | "conflict"; // what checking it against experience found
  why?: string;
}

export interface SleepSummary {
  atSec: number;
  scenesBefore: number;
  scenesAfter: number;
  merged: number;
  forgotten: number;
  claimsSupported: number;
  beliefsStrengthened: number;
  beliefsFaded: number;
  gistsStrengthened: number;
  gistsDropped: number;
  claimsContradicted: number; // things it was told that its own experience showed to be wrong
  beliefsRefuted: number; // beliefs flagged or let go for the same reason
  gistsConflicted: number; // patterns merged with a duplicate or weakened by a contradicting one
}

// ---- what can be checked: words in a statement point at kinds of experience that would support it ----

const KIND_WORDS: [RegExp, string[]][] = [
  [/charg|\bpad\b|battery|power|\bfill/i, ["charger"]],
  [/\blamp\b|light|bright|\blit\b/i, ["brighter"]],
  [/dark|dim|dusk|night/i, ["darker"]],
  [/warm|heat|\bcozy\b/i, ["warmer"]],
  [/cold|cool|chill|draft/i, ["colder"]],
  [/\bsun\b|sunlight|window|curtain|daylight/i, ["sunpatch", "brighter"]],
  [/\bwall\b|bump|collid/i, ["bump"]],
  [/company|friend|together|another pet|someone near/i, ["company"]],
];

/** The kinds of experience that would count as evidence for a statement. Empty if it is not something we can check. */
export function kindsFor(text: string): string[] {
  const out = new Set<string>();
  for (const [re, kinds] of KIND_WORDS) if (re.test(text)) for (const k of kinds) out.add(k);
  return [...out];
}

const lastTime = (s: Scene) => Math.max(s.tSec, s.lastSec ?? 0);
const times = (s: Scene) => s.count ?? 1;

/** How many remembered occasions of these kinds happened after `since`. */
function evidenceSince(p: Pick<PetState, "mind">, kinds: string[], since: number): number {
  let n = 0;
  for (const s of p.mind.scenes) if (kinds.includes(s.kind) && lastTime(s) > since) n += times(s);
  return n;
}

/** A moment is held back from forgetting while it backs a young, still unproven gist. */
function backsYoungGist(p: Pick<PetState, "mind">, sceneId: string, now: number): boolean {
  return p.mind.gists.some((g) => g.sources.includes(sceneId) && g.confidence < PROVEN && now - g.createdSec < YOUNG_GIST_SEC);
}

// ---- stage 1 ----

/** Fold older repeats of the same kind into the few most important examples, remembering how often it happened. */
export function mergeScenes(p: Pick<PetState, "mind" | "odo">, now: number): number {
  const m = p.mind;
  const byKind = new Map<string, Scene[]>();
  for (const s of m.scenes) {
    if (now - lastTime(s) < MERGE_AFTER_SEC || backsYoungGist(p, s.id, now)) continue;
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  let merged = 0;
  for (const list of byKind.values()) {
    if (list.length <= KEEP_PER_KIND) continue;
    list.sort((a, b) => b.importance - a.importance || lastTime(b) - lastTime(a));
    const reps = list.slice(0, KEEP_PER_KIND);
    for (const r of list.slice(KEEP_PER_KIND)) {
      // into the representative that happened closest to where this one did (or the most important one)
      let into = reps[0];
      if (r.pose) {
        let best = Infinity;
        for (const c of reps) if (c.pose) {
          const d = Math.hypot(c.pose.x - r.pose.x, c.pose.y - r.pose.y);
          if (d < best) { best = d; into = c; }
        }
      }
      into.count = times(into) + times(r);
      into.lastSec = Math.max(lastTime(into), lastTime(r));
      into.importance = Math.min(1, Math.round((into.importance + 0.03 * times(r)) * 100) / 100);
      into.uses += r.uses;
      for (const g of m.gists) g.sources = g.sources.map((id) => (id === r.id ? into.id : id));
      m.scenes.splice(m.scenes.indexOf(r), 1);
      merged++;
    }
  }
  return merged;
}

/** Unused moments fade; the faint, old, unimportant ones are forgotten. Important moments fade only very slowly and are kept. */
export function forgetScenes(p: Pick<PetState, "mind">, now: number): number {
  const m = p.mind;
  let forgotten = 0;
  m.scenes = m.scenes.filter((s) => {
    const age = now - lastTime(s);
    if (s.uses > 0 || age <= DECAY_AFTER_SEC) return true;
    s.importance = Math.round(s.importance * (s.importance >= PROTECT_IMPORTANCE ? 0.98 : 0.9) * 1000) / 1000;
    if (s.importance < FORGET_BELOW && age > DELETE_AFTER_SEC && !backsYoungGist(p, s.id, now)) {
      forgotten++;
      return false;
    }
    return true;
  });
  return forgotten;
}

/**
 * What the pet was told is checked against what it has experienced since. Where the statement is about something that can be
 * tested (see verify.ts) the evidence can support it or contradict it. Nothing else is ever guessed at: it stays unverified.
 */
export function verifyClaims(p: Pick<PetState, "mind" | "predict" | "places">, now = 0): { supported: number; contradicted: number } {
  let supported = 0, contradicted = 0;
  for (const c of p.mind.claims) {
    if (c.status === "contradicted") {
      // Once found wrong it stays wrong, even after the moments that showed it have faded: only newer experience can overturn it.
      const fresh = checkStatement(p, c.text, c.checkedSec ?? c.tSec, now);
      if (fresh?.state === "supported" && fresh.positive) { c.status = "supported"; c.why = fresh.why; c.checkedSec = now; supported++; }
      continue;
    }
    const v = checkStatement(p, c.text, c.tSec, now);
    if (v && v.state !== "unclear") {
      if (v.state === "contradicted") {
        c.status = "contradicted";
        c.why = v.why;
        c.checkedSec = now;
        addRefuted(p, c.text, v.why, now);
        contradicted++;
      } else if (v.state === "supported" && c.status !== "supported") {
        c.status = "supported";
        c.why = v.why;
        c.checkedSec = now;
        supported++;
      }
      continue;
    }
    // A "supported" mark with no reason is a leftover from the old keyword rule, which marked meaningless things supported: undo it.
    if (!v && c.status === "supported" && !c.why) c.status = "unverified";
    // Anything else (an instruction, a feeling, a loose remark, a claim a small model made up) stays unverified: matching a keyword
    // to some moment that happened to follow proves nothing, and used to mark meaningless things "supported".
  }
  for (const c of p.mind.claims) creditClaim(p.mind, c); // who told it counts as right or wrong once, and again if the verdict flips
  return { supported, contradicted };
}

/**
 * Belief confidence moves with evidence. A belief about something testable is checked against experience: contradicted, its
 * confidence is cut to 40%, it is flagged, and if it is still contradicted a few hours later it is let go and remembered as
 * something found to be wrong. Other beliefs rise with counted matching moments, and weak unsupported ones fade.
 */
export function adjustBeliefs(p: Pick<PetState, "mind" | "predict" | "places">, now: number): { strengthened: number; faded: number; refuted: number } {
  let strengthened = 0, faded = 0, refuted = 0;
  p.mind.beliefs = p.mind.beliefs.filter((b) => {
    if (b.verdict === "contradicted") {
      // Flagged as wrong. It stays flagged even once the moments that showed it have faded; newer experience can rescue it,
      // otherwise a few hours later it is let go and remembered as something found to be wrong.
      const fresh = checkStatement(p, b.text, b.checkedSec ?? now, now);
      if (fresh?.state === "supported" && fresh.positive) {
        b.verdict = "supported";
        b.why = fresh.why;
        b.confidence = Math.round(Math.min(0.95, b.confidence + 0.15) * 100) / 100;
        b.checkedSec = now;
        strengthened++;
        return true;
      }
      if (now - (b.checkedSec ?? now) >= WRONG_FOR_SEC) {
        addRefuted(p, b.text, b.why ?? "my own experience disagreed", now);
        return false;
      }
      return true;
    }
    const v = checkStatement(p, b.text, b.updatedSec, now);
    if (v && v.state === "contradicted") {
      b.confidence = Math.round(Math.max(0.05, b.confidence * 0.4) * 100) / 100;
      b.verdict = "contradicted";
      b.why = v.why;
      b.checkedSec = now;
      refuted++;
      return true;
    }
    if (v && v.state === "supported") {
      if (b.verdict !== "supported") {
        b.confidence = Math.round(Math.min(0.95, b.confidence + 0.15) * 100) / 100;
        b.verdict = "supported";
        b.why = v.why;
        strengthened++;
      }
      b.checkedSec = now;
      return true;
    }
    const kinds = kindsFor(b.text);
    if (!kinds.length && !v) return true;
    const since = Math.max(b.updatedSec, b.checkedSec ?? -Infinity);
    const ev = v ? 0 : evidenceSince(p, kinds, since); // a statement with its own evidence rule is never helped by a keyword match
    if (ev > 0) {
      b.confidence = Math.round(Math.min(0.95, b.confidence + Math.min(0.2, 0.05 * ev)) * 100) / 100;
      b.checkedSec = now;
      strengthened++;
    } else if (now - since > BELIEF_STALE_SEC && b.confidence < 0.5) {
      b.confidence = Math.round((b.confidence - 0.1) * 100) / 100;
      b.checkedSec = now;
      if (b.confidence < 0.15) { faded++; return false; }
    }
    return true;
  });
  return { strengthened, faded, refuted };
}

/**
 * A gist gains confidence only from later experience. About something testable it can also be contradicted by it: its confidence
 * is cut and it is dropped if still contradicted hours later. Gists that say the same thing are merged, and when one denies
 * another the weaker is weakened (the evidence checks above are what really settle it).
 */
export function reviseGists(p: Pick<PetState, "mind" | "predict" | "places">, now: number): { strengthened: number; dropped: number; conflicted: number } {
  let strengthened = 0, dropped = 0, conflicted = 0;
  p.mind.gists = p.mind.gists.filter((g) => {
    if (g.verdict === "contradicted") {
      // Same as for beliefs: the verdict outlives the evidence unless newer experience overturns it.
      const fresh = checkStatement(p, g.text, g.checkedSec, now);
      if (fresh?.state === "supported" && fresh.positive) {
        g.verdict = "supported";
        g.why = fresh.why;
        g.confidence = Math.round(Math.min(0.95, g.confidence + 0.15) * 100) / 100;
        g.checkedSec = now;
        strengthened++;
        return true;
      }
      if (now - g.checkedSec >= WRONG_FOR_SEC) {
        addRefuted(p, g.text, g.why ?? "my own experience disagreed", now);
        dropped++;
        return false;
      }
      return true;
    }
    const v = checkStatement(p, g.text, g.createdSec, now);
    if (v && v.state === "contradicted") {
      g.confidence = Math.round(Math.max(0.05, g.confidence * 0.4) * 100) / 100;
      g.verdict = "contradicted";
      g.why = v.why;
      g.checkedSec = now;
      conflicted++;
      return true;
    }
    const ev = v ? 0 : evidenceSince(p, g.kinds, g.checkedSec); // same: only the topic's own rule can support it
    if ((v && v.state === "supported") || ev > 0) {
      const gain = v && v.state === "supported" && g.verdict !== "supported" ? 0.15 : Math.min(0.2, 0.08 * ev);
      g.confidence = Math.round(Math.min(0.95, g.confidence + gain) * 100) / 100;
      if (v && v.state === "supported") { g.verdict = "supported"; g.why = v.why; }
      g.checkedSec = now;
      strengthened++;
    } else if (now - g.checkedSec > GIST_STALE_SEC) {
      g.confidence = Math.round((g.confidence - 0.1) * 100) / 100;
      g.checkedSec = now;
      if (g.confidence < 0.15) { dropped++; return false; }
    }
    return true;
  });
  // Duplicates are merged into the more confident one; a statement and its denial leave the weaker one weakened.
  const kept: Gist[] = [];
  for (const g of [...p.mind.gists].sort((x, y) => y.confidence - x.confidence || x.createdSec - y.createdSec)) {
    const same = kept.find((k) => duplicates(k.text, g.text));
    if (same) {
      same.sources = [...new Set([...same.sources, ...g.sources])].slice(0, 6);
      same.kinds = [...new Set([...same.kinds, ...g.kinds])];
      same.uses += g.uses;
      conflicted++;
    } else kept.push(g);
  }
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      if (!conflicts(kept[i].text, kept[j].text)) continue;
      const stronger = kept[i], weaker = kept[j]; // kept is ordered strongest first
      if (weaker.verdict !== "conflict") {
        weaker.confidence = Math.round(Math.max(0.05, weaker.confidence * 0.5) * 100) / 100;
        weaker.verdict = "conflict";
        weaker.why = `it conflicts with: "${stronger.text}"`;
        conflicted++;
      }
    }
  }
  p.mind.gists = kept.filter((g) => g.confidence >= 0.05);
  return { strengthened, dropped, conflicted };
}

/** One night's rule-based consolidation. Deterministic: no model, no randomness. */
export function consolidate(p: PetState, now: number): SleepSummary {
  const before = p.mind.scenes.length;
  const merged = mergeScenes(p, now);
  const forgotten = forgetScenes(p, now);
  const c = verifyClaims(p, now);
  const b = adjustBeliefs(p, now);
  const g = reviseGists(p, now);
  const summary: SleepSummary = {
    atSec: now, scenesBefore: before, scenesAfter: p.mind.scenes.length, merged, forgotten, claimsSupported: c.supported,
    beliefsStrengthened: b.strengthened, beliefsFaded: b.faded, gistsStrengthened: g.strengthened, gistsDropped: g.dropped,
    claimsContradicted: c.contradicted, beliefsRefuted: b.refuted, gistsConflicted: g.conflicted,
  };
  p.mind.lastSleep = summary;
  // Worth asking the model for a gist only with enough to go on, and not every sleep.
  p.mind.gistDue = p.mind.scenes.length >= 3 && now - (p.mind.lastGistSec ?? -1e9) >= GIST_COOLDOWN_SEC;
  return summary;
}

/** Called every tick for every pet: runs the night's consolidation once, after the pet has been asleep a while. */
export function sleepTick(p: PetState, now: number): SleepSummary | null {
  const sl = (p.sleep ??= { since: null, done: false });
  if (p.mode === "sleeping") {
    sl.since ??= now;
    if (!sl.done && now - sl.since >= SLEEP_MIN_SEC) {
      sl.done = true;
      return consolidate(p, now);
    }
  } else {
    sl.since = null;
    sl.done = false;
  }
  return null;
}

// ---- gists: reading them back, and for System 2's notes ----

export function describeGists(p: Pick<PetState, "mind">, n = 3): string[] {
  return [...p.mind.gists]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, n)
    .map((g) => `- (${Math.round(g.confidence * 100)}% sure${g.verdict === "contradicted" ? `; my experience disagrees: ${g.why}` : g.verdict === "conflict" ? `; ${g.why}` : ""}) ${g.text}`);
}

export function markGistsUsed(p: Pick<PetState, "mind">, nowSec: number, n = 3): void {
  const top = [...p.mind.gists].sort((a, b) => b.confidence - a.confidence).slice(0, n);
  for (const g of top) {
    g.uses++;
    g.lastUsedSec = nowSec;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Pull gists out of a model reply. Each must cite moments that really exist; confidence is capped; duplicates are dropped. */
export function parseGists(text: string, valid: Map<string, Scene>, existing: Gist[], now: number): Gist[] {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return [];
  let raw: any;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return [];
  }
  const have = new Set(existing.map((g) => norm(g.text)));
  const out: Gist[] = [];
  for (const g of Array.isArray(raw?.gists) ? raw.gists : []) {
    if (out.length >= 3) break;
    const t = str(g?.text, 120);
    const sources = (Array.isArray(g?.from) ? g.from : []).map((x: unknown) => String(x)).filter((id: string) => valid.has(id));
    if (t.length < 8 || !sources.length || have.has(norm(t))) continue;
    have.add(norm(t));
    const kinds = [...new Set<string>(sources.map((id: string) => valid.get(id)!.kind))];
    const c = Number(g?.confidence);
    out.push({
      id: `g${Math.floor(now)}-${out.length + 1}`, text: t, confidence: Math.round(Math.min(GIST_START_MAX, Math.max(0.1, Number.isFinite(c) ? c : 0.3)) * 100) / 100,
      kinds, sources: [...new Set<string>(sources)].slice(0, 6), createdSec: now, checkedSec: now, lastUsedSec: -1, uses: 0,
    });
  }
  return out;
}

export function addGists(p: Pick<PetState, "mind">, gists: Gist[]): void {
  p.mind.gists.push(...gists);
  if (p.mind.gists.length > MAX_GISTS) {
    p.mind.gists.sort((a, b) => b.confidence - a.confidence || b.createdSec - a.createdSec);
    p.mind.gists.length = MAX_GISTS;
  }
}

// ---- stage 2: the slow model call ----

export interface SleepLlm { enabled: boolean; complete(messages: ChatMessage[], opts?: CompleteOpts): Promise<LlmResult> }

const clockOf = (tSec: number) => {
  const m = Math.floor(tSec / 60);
  return `D${Math.floor(m / 1440) + 1} ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export function buildGistPrompt(p: PetState, now: number): { system: string; user: string; ids: Map<string, Scene> } {
  const top = [...p.mind.scenes].sort((a, b) => sceneScore(b, now) - sceneScore(a, now)).slice(0, 12);
  const ids = new Map(top.map((s) => [s.id, s]));
  const system =
    `You are the quiet, slow part of ${p.name}'s mind that works while it sleeps, looking back over its memorable moments. ` +
    `Write up to 3 short statements of patterns ${p.name} seems to have noticed: what tends to happen, where, or when. ` +
    `Use ONLY the moments given and never invent places, objects or events that are not in them. Each statement is what the pet thinks, not a proven fact. ` +
    `Prefer something that repeats. If you see no pattern, say nothing. Reply with ONLY a JSON object: ` +
    `{"gists": [{"text": string (max 120 chars, first person, plain words), "from": [ids of the moments it is drawn from], "confidence": number 0-1}]}`;
  const lines = top.map((s) => `- [${s.id}] ${describeScene(s, p, clockOf(s.tSec))}`);
  const cues = describeCues(p);
  const known = p.mind.gists.map((g) => `- ${g.text}`);
  const user = [
    `Memorable moments:\n${lines.join("\n") || "- none"}`,
    cues.length ? `What it has worked out about steady tones:\n${cues.join("\n")}` : "",
    known.length ? `Statements it already holds (do not repeat them):\n${known.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { system, user, ids };
}

/** Writes one gist batch per sleep, in the background, for a pet that is asleep. A slow or failed call costs nothing but a missed night. Groq first, then DeepSeek (the small local models were measured and cannot do this). */
export class Consolidator {
  disposed = false;
  private busy = false;

  constructor(
    private sim: Simulation,
    private llm: SleepLlm,
    private store: Store,
    private opts: { isPaused: () => boolean; providers?: string[]; timeoutMs?: number } = { isPaused: () => false },
  ) {}

  tick(): void {
    if (this.disposed || this.busy || !this.llm.enabled || this.opts.isPaused()) return;
    const p = this.sim.pets.find((x) => x.mind.gistDue && x.mode === "sleeping");
    if (!p) return;
    this.busy = true;
    p.mind.gistDue = false; // one attempt per night, whatever happens
    p.mind.lastGistSec = this.sim.simSec;
    void this.write(p)
      .catch((e) => {
        if (e instanceof LlmUnavailable) console.warn(`sleep ${p.id}: no gist tonight (${e.message.slice(0, 120)})`);
        else console.error("sleep gist failed", e);
      })
      .finally(() => { this.busy = false; });
  }

  async write(p: PetState): Promise<void> {
    const now = this.sim.simSec;
    const { system, user, ids } = buildGistPrompt(p, now);
    const r = await this.llm.complete([{ role: "system", content: system }, { role: "user", content: user }], {
      maxTokens: 700, temperature: 0.6, json: true, tag: { kind: "gist", pet: p.id }, timeoutMs: this.opts.timeoutMs ?? 240_000, providers: this.opts.providers ?? ["groq", "deepseek"], // the small local models cannot write these (measured), so cloud only; DeepSeek counts toward the pets' ceiling
    });
    if (this.disposed) return;
    const gists = parseGists(r.text, ids, p.mind.gists, this.sim.simSec);
    if (!gists.length) return;
    addGists(p, gists);
    const t = Math.floor(this.sim.simSec / 60) % 1440;
    console.log(`sleep ${p.id} via ${r.provider}: ${gists.map((g) => g.text).join(" | ").slice(0, 120)}`);
    await this.store.append(`thoughts/${p.id}`, {
      system: 3, stage: "gist", pet: p.id, tSec: this.sim.simSec, day: Math.floor(this.sim.simSec / 86400) + 1, hour: Math.floor(t / 60), minute: t % 60,
      gists: gists.map((g) => ({ text: g.text, confidence: g.confidence, sources: g.sources })), provider: r.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
    });
  }
}
