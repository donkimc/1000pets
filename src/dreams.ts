// Dreams: while asleep a pet recombines real moments with strange twists. A dream is remembered AS a dream: it is stored
// apart from everything the pet believes happened (never in beliefs, claims, scenes or gists), it is shown to System 2
// with a plain label saying it is not real, and a guard stops System 2 from turning a dream's invented content into a belief.
//
// Why bother: dreams rehearse what could go wrong. Moments are picked with a lean toward unresolved problems (a flat
// battery, a bump, the dark), the twists exaggerate or remove things, and each dream carries a "worry": a possibility
// worth checking in real life ("the tone or the pad might not always be there"). The worry is made by rules, not by a
// model, so it is always something concrete. The model only narrates the dream, and the dream exists without it.
import { LlmUnavailable, type ChatMessage, type CompleteOpts, type LlmResult } from "./llm.js";
import type { PetState } from "./pet.js";
import { Rng } from "./rng.js";
import { sceneScore, type Scene } from "./scenes.js";
import type { Simulation } from "./sim.js";
import type { Store } from "./store.js";

export const MAX_DREAMS = 6;
// What exists in a pet's world. A dream may bend these but not bring in a human world the pet has no way of knowing.
const THE_WORLD = "the charging pad and its steady hum, a lamp, a window with sunlight, a heater, a table, a bed, a plant, a door, light and dark, warmth and cold, walls, other small pets, a human, a Teacher";
export const OUT_OF_WORLD = /\b(phones?|screens?|books?|computers?|laptops?|televisions?|tv|keyboards?|internet|kitchen|plug(ged)?|unplug(ged)?|cars?|cups?|coffee|wifi|email)\b/i;
const SHOWN_FOR_SEC = 12 * 3600; // a dream is on the pet's mind for this long after it
const TROUBLE = new Set(["dormant", "lowbattery", "bump", "darker", "colder", "tonelost", "nocharge", "tonedrift"]); // moments dreams lean toward

export type TwistKind = "exaggerate" | "missing_source" | "swap_place" | "swap_thing" | "other_pet" | "blend";
export interface Twist { kind: TwistKind; text: string }

export interface Dream {
  id: string;
  tSec: number;
  theme: TwistKind; // the main twist
  ingredients: string[]; // ids of the real moments it was made from (they may later be merged or forgotten)
  kinds: string[]; // the kinds of those moments
  twists: Twist[];
  worry: string; // a concrete possibility the dream raises; a thing to check, not a fact
  narrative: string; // what the pet remembers of the dream
  source: string; // "rules", or the model that narrated it
  pending: boolean; // a model has not yet narrated it
}

// ---- making a dream (deterministic) ----

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const PLACES = ["a long dark corridor", "a room with no walls", "a floor that slowly tilted", "a far corner I have never seen", "a place where everything hummed"];
const COLOURS = ["red", "orange", "green", "blue", "purple", "pink", "teal"];

const WORRY: Record<string, string> = {
  dormant: "my battery could run out and leave me stranded",
  lowbattery: "my battery could run out before I reach the pad",
  charger: "the charging pad might not always be where I found it",
  tonefirst: "the tone might stop, or lead somewhere else",
  tonelost: "the tone might stop and not come back",
  toneback: "the tone might come and go without warning",
  tonedrift: "the tone might lead somewhere other than where I think",
  nocharge: "I might reach the end of the tone and not be charged",
  sunpatch: "the sunlight might not come back",
  brighter: "the light might not always come back",
  darker: "the light might go out and not return",
  warmer: "the warmth might go away",
  colder: "it could get colder than I can bear",
  bump: "I could get stuck against something and not get free",
  company: "I might be left alone",
  loud: "something loud could come back",
};

function worryFor(scenes: Scene[], twist: Twist): string {
  if (twist.kind === "missing_source") {
    const k = scenes.find((s) => ["charger", "tonefirst", "sunpatch"].includes(s.kind))?.kind;
    return k === "sunpatch" ? WORRY.sunpatch : "the tone or the pad might not always be there";
  }
  if (twist.kind === "other_pet") return WORRY.company;
  const first = scenes.find((s) => TROUBLE.has(s.kind)) ?? scenes[0];
  return WORRY[first.kind] ?? "something I rely on might change";
}

function twistText(kind: TwistKind, scenes: Scene[], rng: Rng): string {
  switch (kind) {
    case "exaggerate": {
      const k = scenes.find((s) => TROUBLE.has(s.kind))?.kind ?? scenes[0].kind;
      return k === "dormant" || k === "lowbattery" ? "my battery drained all the way to nothing, far from anywhere" : k === "bump" ? "the wall grew and closed in around me" : k === "darker" ? "all the light went out and stayed out" : `everything about it became far bigger and stranger`;
    }
    case "missing_source":
      return "the hum was gone, and the place where the pad should be was empty";
    case "swap_place":
      return `it all happened in ${rng.pick(PLACES)}`;
    case "swap_thing": {
      const was = scenes.flatMap((s) => s.seen).find((t) => t.colour)?.colour ?? "yellow";
      const now = rng.pick(COLOURS.filter((c) => c !== was));
      return `the ${was} thing was ${now} instead, and it spoke without a voice`;
    }
    case "other_pet":
      return "another pet stood where I needed to be, and would not move";
    case "blend":
      return "the two moments melted into one, with no way to tell them apart";
  }
}

function applicable(scenes: Scene[]): TwistKind[] {
  const kinds: TwistKind[] = ["exaggerate", "swap_place", "blend"];
  if (scenes.some((s) => ["charger", "tonefirst", "sunpatch", "brighter", "tonelost", "toneback", "nocharge"].includes(s.kind) || s.tone)) kinds.push("missing_source");
  if (scenes.some((s) => s.seen.length)) kinds.push("swap_thing");
  if (scenes.some((s) => s.kind === "company" || s.near.some((n) => n.category === "moving"))) kinds.push("other_pet");
  return kinds;
}

/** Pick moments, leaning toward trouble and importance, without picking the same one twice. */
function pickIngredients(p: Pick<PetState, "mind">, now: number, rng: Rng, n: number): Scene[] {
  const pool = p.mind.scenes.map((s) => ({ s, w: Math.max(0.02, sceneScore(s, now)) * (TROUBLE.has(s.kind) ? 1.8 : 1) }));
  const out: Scene[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((a, x) => a + x.w, 0);
    let r = rng.next() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= pool[i].w; if (r <= 0) break; }
    out.push(pool.splice(i, 1)[0].s);
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the pet would recall of the dream with no model: the real moments told in order, interrupted by the twists. */
export function plainNarrative(scenes: Scene[], twists: Twist[]): string {
  const [a, b] = scenes;
  const parts = [`I ${a.why}.`, `${cap(twists[0].text)}.`];
  if (b) parts.push(`Then I ${b.why}${twists[1] ? `, and ${twists[1].text}` : ""}.`);
  else if (twists[1]) parts.push(`${cap(twists[1].text)}.`);
  return parts.join(" ").slice(0, 320);
}

/** Make tonight's dream, or null if there is too little to dream from. Deterministic for a given pet and moment. */
export function makeDream(p: PetState, now: number): Dream | null {
  if (p.mind.scenes.length < 2) return null;
  const rng = new Rng(hash(p.id) ^ (Math.floor(now) >>> 0));
  const scenes = pickIngredients(p, now, rng, 2);
  const options = applicable(scenes);
  const first = rng.pick(options);
  const twists: Twist[] = [{ kind: first, text: twistText(first, scenes, rng) }];
  const rest = options.filter((k) => k !== first);
  if (rest.length && rng.chance(0.5)) {
    const second = rng.pick(rest);
    twists.push({ kind: second, text: twistText(second, scenes, rng) });
  }
  return {
    id: `d${Math.floor(now)}`, tSec: now, theme: first, ingredients: scenes.map((s) => s.id), kinds: [...new Set(scenes.map((s) => s.kind))],
    twists, worry: worryFor(scenes, twists[0]), narrative: plainNarrative(scenes, twists), source: "rules", pending: true,
  };
}

export function addDream(p: Pick<PetState, "mind">, d: Dream): void {
  p.mind.dreams.push(d);
  if (p.mind.dreams.length > MAX_DREAMS) p.mind.dreams.shift();
}

// ---- how a dream is remembered ----

/** The line System 2 reads while a dream is still on the pet's mind. It says plainly that none of it happened. */
export function dreamLine(p: Pick<PetState, "mind">, nowSec: number): string | null {
  const d = p.mind.dreams[p.mind.dreams.length - 1];
  if (!d || nowSec - d.tSec > SHOWN_FOR_SEC) return null;
  return `A DREAM you had (it is NOT something that happened, so do not treat any of it as a fact or a memory): "${d.narrative}" It left you wondering whether ${d.worry}. That is only a possibility you could look out for.`;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length >= 4);

/**
 * True if a belief only repeats what a dream invented. Real things appear in dreams too, so only the twisted parts
 * (the invented places, things and events) are compared, never the real moments the dream was made from.
 */
export function copiesDream(p: Pick<PetState, "mind">, belief: string): boolean {
  const b = new Set(words(belief));
  if (b.size < 3) return false;
  for (const d of p.mind.dreams) {
    for (const t of d.twists) {
      const tw = words(t.text);
      if (tw.length < 3) continue;
      const shared = tw.filter((w) => b.has(w)).length;
      if (shared / tw.length >= 0.6) return true;
    }
  }
  return false;
}

// ---- narration by a model (optional, slow, in the background) ----

export interface DreamLlm { enabled: boolean; complete(messages: ChatMessage[], opts?: CompleteOpts): Promise<LlmResult> }

export function buildDreamPrompt(p: PetState, d: Dream): { system: string; user: string } {
  const moments = d.ingredients.map((id) => p.mind.scenes.find((s) => s.id === id)).filter((s): s is Scene => !!s);
  const system =
    `You are ${p.name}'s sleeping mind. Write ONE short dream (2 or 3 sentences, first person, vivid and a little strange) that mixes the real moments below with the twists. ` +
    `It must feel like a dream: things change, places do not make sense, at least one thing could never really happen. Do not explain it, and do not say it really happened. ` +
    `The only things that exist in ${p.name}'s world are: ${THE_WORLD}. Dream strange things, but only out of these: no phones, books, screens, machines, vehicles or anything else from a human home. ` +
    `Use only the moments and twists given. Reply with only the dream, no title and no quotation marks.`;
  const user = `Real moments it is made from:\n${moments.map((s) => `- I ${s.why}`).join("\n") || "- (they have faded)"}\nTwists to weave in:\n${d.twists.map((t) => `- ${t.text}`).join("\n")}`;
  return { system, user };
}

/** Narrates tonight's dream for a pet that is asleep. If it fails, the plain version already stands. */
export class Dreamer {
  disposed = false;
  private busy = false;

  constructor(
    private sim: Simulation,
    private llm: DreamLlm,
    private store: Store,
    private opts: { isPaused: () => boolean; providers?: string[]; timeoutMs?: number } = { isPaused: () => false },
  ) {}

  tick(): void {
    if (this.disposed || this.busy || !this.llm.enabled || this.opts.isPaused()) return;
    const p = this.sim.pets.find((x) => x.mode === "sleeping" && x.mind.dreams.at(-1)?.pending);
    if (!p) return;
    const d = p.mind.dreams.at(-1)!;
    d.pending = false; // one attempt per dream
    this.busy = true;
    void this.narrate(p, d)
      .catch((e) => { if (!(e instanceof LlmUnavailable)) console.error("dream narration failed", e); })
      .finally(() => { this.busy = false; });
  }

  async narrate(p: PetState, d: Dream): Promise<void> {
    const { system, user } = buildDreamPrompt(p, d);
    const r = await this.llm.complete([{ role: "system", content: system }, { role: "user", content: user }], {
      maxTokens: 260, temperature: 0.95, timeoutMs: this.opts.timeoutMs ?? 240_000,
      providers: this.opts.providers ?? ["groq", "deepseek"],
    });
    if (this.disposed) return;
    const text = r.text.replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\s+/g, " ");
    if (text.length < 25 || text.startsWith("{") || text.length > 600 || OUT_OF_WORLD.test(text)) return; // keep the plain version
    d.narrative = text.slice(0, 320);
    d.source = r.model;
    const t = Math.floor(this.sim.simSec / 60) % 1440;
    await this.store.append(`thoughts/${p.id}`, {
      system: 3, stage: "dream_narration", pet: p.id, tSec: this.sim.simSec, day: Math.floor(this.sim.simSec / 86400) + 1, hour: Math.floor(t / 60), minute: t % 60,
      dream: { id: d.id, narrative: d.narrative, worry: d.worry }, provider: r.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
    });
  }
}
