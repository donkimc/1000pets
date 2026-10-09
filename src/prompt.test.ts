import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { HOUSE } from "./layout.js";
import { LlmGateway, type ChatMessage, type CompleteOpts, type LlmResult } from "./llm.js";
import { System2, buildNotesCompact, buildPrompt, promptSettings } from "./system2.js";
import type { PetDef, PetState } from "./pet.js";
import type { Scene } from "./scenes.js";
import type { Store } from "./store.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const nostore = { append: async () => {}, readLog: async () => [], readJson: async () => null, writeJson: async () => {}, dir: "" } as unknown as Store;
const scene = (id: string, tSec: number, over: Partial<Scene> = {}): Scene => ({
  id, tSec, kind: "charger", why: "found the charging pad and my battery started filling quickly", importance: 0.8, pose: { x: 0, y: 0 }, seen: [{ category: "static", size: "small", colour: "yellow", distance: 90, bearing: 0.1 }], near: [],
  view: "...........|....", tone: { pitch: 534, volume: 0.8 }, light: 20, temperature: 18, battery: 45, action: "wander", uses: 0, lastUsedSec: -1, ...over,
});

/** A pet that has been around a while and knows a few things, so there is something to say in every part of the prompt. */
function busyPet(): { sim: Simulation; p: PetState } {
  const sim = new Simulation(new World(1, undefined, HOUSE), 1, roster);
  for (let s = 5; s <= 8 * 3600; s += 5) sim.step(s * 1000);
  const p = sim.pets[0];
  p.mind.beliefs = [{ text: "The steady tone leads to the pad", confidence: 0.8, updatedSec: 100 }, { text: "Doors can be pushed open", confidence: 0.6, updatedSec: 100, verdict: "supported", why: "I did it" }];
  p.mind.claims = [{ text: "The heater makes the room warmer", from: "the Teacher", tSec: 50, status: "unverified" }];
  p.mind.refuted = [{ text: "The pad moves", why: "I always found it in the same place", tSec: sim.simSec - 100 }];
  p.mind.recentQuestions = ["Why did the light change?", "Where is the pad?"];
  p.mind.intention = { goal: "find out what the hum means", sinceSec: 0 };
  p.mind.scenes = [scene("a", 100, { importance: 0.9 }), scene("b", 200, { importance: 0.8 }), scene("c", 300, { importance: 0.7 })];
  p.mind.dreams = [{ id: "d1", tSec: sim.simSec - 600, theme: "x", ingredients: [], kinds: [], twists: [], worry: "the pad might not always be there", narrative: "I dreamed the pad kept moving away.", source: "rules", pending: false }];
  return { sim, p };
}
const day = (sim: Simulation) => Math.floor(sim.simSec / 86400) + 1, tod = (sim: Simulation) => Math.floor(sim.simSec / 60) % 1440;

test("the compact prompt keeps every rule and every kind of fact, in fewer words", () => {
  const { sim, p } = busyPet();
  const c = buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, false, false, "compact");
  for (const rule of [/"retract": \[string\]/, /never copy numbers or "how sure" values/, /nothing in a dream happened, so never put anything from a dream in "beliefs"/, /let it go and do not take it up again/, /Never state as fact something you only heard from others/, /Ask something new/, /ONLY a JSON object/]) assert.match(c.system, rule);
  for (const field of ["question", "thought", "beliefs", "intention", "drop_intention", "suggestion", "say", "ask_teacher"]) assert.match(c.system, new RegExp(`"${field}"`), field);
  assert.doesNotMatch(c.system, /"tune"/, "habits are only mentioned when learning is on");
  assert.match(buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, false, true, "compact").system, /"tune": null or \{"habit"/);
  assert.match(c.user, /You are Pip\./);
  assert.match(c.user, /The steady tone leads to the pad \[how sure: 0\.80\]/, "every belief is there, with how sure");
  assert.match(c.user, /Doors can be pushed open \[how sure: 0\.60; borne out by my experience\]/);
  assert.match(c.user, /The heater makes the room warmer.*\[unverified\]/, "what it was told, marked as not verified");
  assert.match(c.user, /showed to be WRONG[^\n]*\n- The pad moves \(I always found it in the same place\)/);
  assert.match(c.user, /A DREAM you had \(NOT real, not a memory, never a belief\): "I dreamed the pad kept moving away\./);
  assert.match(c.user, /Questions you asked yourself lately[^\n]*"Why did the light change\?" \| "Where is the pad\?"/);
  assert.match(c.user, /Current intention: find out what the hum means/);
  assert.match(c.user, /Now: day \d+, \d\d:\d\d\. Battery \d+%/);
  assert.match(c.user, /Senses: light/);
  assert.match(c.user, /Memorable moments:\n- D1 .*found the charging pad/);
  assert.doesNotMatch(c.user, /No recent dream/);
  const block = /Memorable moments:\n([\s\S]*?)(?:\nRecent experience:|\nQuestions you asked|\nCurrent intention)/.exec(c.user)![1];
  assert.equal((block.match(/^- D\d+ /gm) ?? []).length, 2, "two memories, not three");
});

test("the compact prompt is much smaller than the full one for a pet that knows things", () => {
  const { sim, p } = busyPet();
  const size = (x: { system: string; user: string }) => (x.system.length + x.user.length) / 4;
  const full = size(buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, false, false, "full"));
  const compact = size(buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, false, false, "compact"));
  assert.ok(compact < full * 0.7, `compact ${Math.round(compact)} tokens against ${Math.round(full)}`);
});

test("slow-changing facts come first and the clock and senses last, and the system text is the same for every pet", () => {
  const { sim, p } = busyPet();
  const a = buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, false, false, "compact");
  const notes = a.user;
  assert.ok(notes.indexOf("Current beliefs") < notes.indexOf("Now: day"), "beliefs before the clock");
  assert.ok(notes.indexOf("Now: day") < notes.indexOf("Memorable moments"), "the clock before this minute's memories");
  // a minute later, only the changing part differs: the start is the same, which is what a prompt cache rewards
  p.energy -= 2; p.mind.sensed.light = 55;
  const b = buildPrompt(p, day(sim), (tod(sim) + 1) % 1440, 1, sim.simSec + 60, false, false, "compact");
  let same = 0; while (same < Math.min(a.user.length, b.user.length) && a.user[same] === b.user[same]) same++;
  assert.ok(same > a.user.indexOf("Now: day"), "everything before 'Now' is identical");
  assert.equal(a.system, b.system);
  assert.equal(buildPrompt(sim.pets[1], day(sim), tod(sim), 1, sim.simSec, false, false, "compact").system, a.system, "the same system text for Moss as for Pip");
});

test("a deep review and the full mode are untouched", () => {
  const { sim, p } = busyPet();
  p.mind.recentThoughts = ["The tone means trouble."];
  const deep = buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, true, false, "compact");
  assert.match(deep.user, /^Time: day /, "a deep thought still gets the full notes");
  assert.match(deep.user, /Your last few thoughts \(review them\):\n- The tone means trouble\./);
  assert.match(deep.system, /rare, careful review/);
  assert.match(deep.system, /of Pip, a small pet living in a simple 2D room/);
  const full = buildPrompt(p, day(sim), tod(sim), 1, sim.simSec, false, false, "full");
  assert.match(full.user, /^Time: day /);
  assert.match(full.system, /of Pip, a small pet living in a simple 2D room/);
  const was = promptSettings.mode;
  promptSettings.mode = "full";
  assert.match(buildPrompt(p, day(sim), tod(sim), 1, sim.simSec).user, /^Time: day /, "S2_PROMPT=full gives the old prompt back");
  promptSettings.mode = "compact";
  assert.match(buildPrompt(p, day(sim), tod(sim), 1, sim.simSec).user, /^You are Pip\./);
  promptSettings.mode = was;
  assert.equal(buildNotesCompact(p, day(sim), tod(sim), 1, sim.simSec).includes("No recent dream"), false);
});

class Capture extends LlmGateway {
  calls: { max?: number; tag?: string; user: string }[] = [];
  constructor() { super([{ name: "x", baseUrl: "", apiKey: "", model: "m", priceInPerM: 0, priceOutPerM: 0, rpm: 99 }]); }
  override async complete(m: ChatMessage[], o: CompleteOpts = {}): Promise<LlmResult> {
    this.calls.push({ max: o.maxTokens, tag: o.tag?.kind, user: m[1].content });
    return { text: JSON.stringify({ question: "q", thought: "t", beliefs: [], intention: null, suggestion: "none", say: null, ask_teacher: null }), provider: "x", model: "m", tokensIn: 1, tokensOut: 1 };
  }
}

test("a routine thought asks for a shorter answer than a deep one, and only the memories it was shown count as used", async () => {
  const { sim, p } = busyPet();
  const llm = new Capture();
  const s2 = new System2(sim, llm, nostore, { intervalSec: 70, deepEvery: 2, isPaused: () => false });
  p.stats.s2Thoughts = 0;
  await s2.think(p); // an ordinary thought
  assert.equal(llm.calls[0].max, 450);
  const uses = p.mind.scenes.map((s) => s.uses).sort();
  assert.deepEqual(uses, [0, 1, 1], "two of three memories were shown, so two count as used");
  p.stats.s2Thoughts = 1;
  await s2.think(p); // the second is deep
  assert.equal(llm.calls[1].max, 900);
  assert.equal(llm.calls[1].tag, "deep");
});
