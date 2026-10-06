import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Conversation, parseReply, type LlmLike } from "./conversation.js";
import { looksLikeJson } from "./speech.js";
import { Simulation } from "./sim.js";
import { World } from "./world.js";
import { Store } from "./store.js";
import { canSpeak, describeSource, inEarshot, GATE, type Speaker } from "./speech.js";
import type { PetDef } from "./pet.js";

const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(replyJson: (n: number) => string) {
  const sim = new Simulation(new World(1), 1, roster);
  const [pip, moss, coco] = sim.pets;
  pip.x = 500; pip.y = 300; moss.x = 560; moss.y = 300; coco.x = 60; coco.y = 650;
  sim.human.x = 450; sim.human.y = 300;
  const store = await Store.open(mkdtempSync(path.join(tmpdir(), "pets-")), "t");
  let n = 0;
  const calls: string[] = [];
  const llm: LlmLike = {
    enabled: true,
    async complete(messages) {
      calls.push(messages[messages.length - 1].content);
      return { text: replyJson(++n), provider: "fake", model: "fake-m", tokensIn: 10, tokensOut: 5 };
    },
  };
  const sent: any[] = [];
  const conv = new Conversation(sim, llm, store, (p) => sent.push(p));
  return { sim, store, conv, calls, sent, pip, moss, coco };
}

const speaker = (x: number, y: number): Speaker => ({ kind: "human", id: "human", name: "Human", x, y });

test("earshot is distance-based and sorted nearest first", () => {
  const { sim } = { sim: new Simulation(new World(1), 1, roster) };
  const [a, b, c] = sim.pets;
  a.x = 100; a.y = 100; b.x = 200; b.y = 100; c.x = 900; c.y = 600;
  const heard = inEarshot(sim.pets, speaker(130, 100), 300);
  assert.deepEqual(heard.map((p) => p.id), [a.id, b.id]);
  assert.ok(!heard.includes(c));
});

test("a voice you cannot see is described as unseen", () => {
  const sim = new Simulation(new World(1), 1, roster);
  const p = sim.pets[0];
  p.x = 300; p.y = 300; p.heading = 0;
  assert.match(describeSource(p, speaker(500, 300)), /ahead.*can see/);
  assert.match(describeSource(p, speaker(100, 300)), /behind me.*cannot see/);
});

test("System 1 speech gate explains itself", () => {
  const base = { mode: "idle" as const, hasListener: true, isReply: false, social: 0.6, socialTrait: 0.5, msSinceLastSpoke: 1e9, msSinceLastPetUtterance: 1e9, petChainLength: 0 };
  assert.equal(canSpeak(base).ok, true);
  assert.match(canSpeak({ ...base, mode: "sleeping" }).reason, /asleep/);
  assert.match(canSpeak({ ...base, hasListener: false }).reason, /earshot/);
  assert.match(canSpeak({ ...base, msSinceLastSpoke: 1000 }).reason, /recently/);
  assert.match(canSpeak({ ...base, petChainLength: GATE.maxPetChain }).reason, /chatting/);
  assert.match(canSpeak({ ...base, social: 0, socialTrait: 0.1 }).reason, /mood/);
  assert.equal(canSpeak({ ...base, isReply: true, social: 0, petChainLength: 99 }).ok, true);
});

test("parseReply handles JSON, noisy JSON and plain text", () => {
  assert.deepEqual(parseReply('{"understood":{"intent":"greeting","topic":"hi"},"claims":[{"text":"he is Don"}],"reply":"Hello!"}'), { reply: "Hello!", intent: "greeting", topic: "hi", claims: ["he is Don"] });
  assert.equal(parseReply('ok ```json {"reply":null} ```')!.reply, null);
  assert.equal(parseReply('"Just words"')!.reply, "Just words");
  assert.equal(parseReply("   "), null);
});

test("human talks to a pet in range: it replies, logs, stores a claim", async () => {
  const { conv, store, pip, sent } = await setup(() => '{"understood":{"intent":"greeting","topic":"introduction"},"claims":[{"text":"The human is called Don"}],"reply":"Hi Don, I am Pip."}');
  const u = await conv.humanSays({ kind: "pet", id: "pip" }, "Hi, I'm Don", false);
  assert.deepEqual(u.heardBy.includes("pip"), true);
  await wait(1300);
  const comms = await store.readLog<any>("comms");
  assert.equal(comms.length, 2);
  assert.equal(comms[1].from.id, "pip");
  assert.equal(comms[1].to.kind, "human");
  assert.equal(comms[1].trace.kind, "reply");
  assert.equal(pip.mind.claims[0].status, "unverified");
  assert.match(pip.mind.claims[0].text, /Don/);
  assert.ok(sent.filter((m) => m.type === "utterance").length === 2);
});

test("a pet out of range does not hear a spatial message, but does in anywhere mode", async () => {
  const a = await setup(() => '{"reply":"hello"}');
  const far = await a.conv.humanSays({ kind: "pet", id: "coco" }, "hello?", false);
  assert.deepEqual(far.notHeardBy, ["coco"]);
  await wait(1200);
  assert.equal((await a.store.readLog("comms")).length, 1);
  const b = await setup(() => '{"reply":"hello"}');
  const anywhere = await b.conv.humanSays({ kind: "pet", id: "coco" }, "hello?", true);
  assert.deepEqual(anywhere.heardBy.includes("coco"), true);
  await wait(1300);
  assert.equal((await b.store.readLog<any>("comms")).at(-1).from.id, "coco");
});

test("sleeping pets stay silent and say why", async () => {
  const { conv, store, pip } = await setup(() => '{"reply":"hello"}');
  pip.mode = "sleeping";
  await conv.humanSays({ kind: "pet", id: "pip" }, "wake up", false);
  await wait(1300);
  assert.equal((await store.readLog("comms")).length, 1);
  const thoughts = await store.readLog<any>("thoughts/pip");
  assert.match(thoughts.at(-1).reason, /asleep/);
});

test("pet-to-pet chatter stops after the chain limit", async () => {
  // the first call writes pip's opening line (plain speech); every later call is a reply in JSON
  const { conv, store, pip, moss } = await setup((n) => (n === 1 ? "Hello over there!" : '{"reply":"and so on"}'));
  pip.drives.social = 1; moss.drives.social = 1;
  await conv.maybeSpeak(pip, { to: "nearest", meaning: "greet" }, { thought: "t", question: "q", beliefs: [], intention: null, dropIntention: false, suggestion: "none", say: null }, { provider: "fake", model: "m" });
  // the fake model answers every call with a reply; wait long enough for any chain to play out
  await wait(9000);
  const comms = await store.readLog<any>("comms");
  assert.ok(comms.length >= 2 && comms.length <= GATE.maxPetChain + 1, `got ${comms.length} utterances`);
});

test("a small model's broken JSON is never spoken aloud: fields are recovered, or the pet stays silent", () => {
  // exactly what Pip said in the chat: the "understood" object is never closed, so it is not valid JSON
  const broken = 'json { "understood": { "intent": "statement", "topic": "Teacher\'s message", "claims": [ "The teacher" ], "reply": "I\'m here, Teacher; can I help you with anything?" }';
  const r = parseReply(broken)!;
  assert.equal(r.reply, "I'm here, Teacher; can I help you with anything?");
  assert.equal(r.intent, "statement");
  assert.equal(r.topic, "Teacher's message");
  assert.deepEqual(r.claims, ["The teacher"]);
  assert.doesNotMatch(r.reply!, /understood|intent|\{|json/);
  // fenced and truncated
  assert.equal(parseReply('```json\n{"understood": {"intent": "greeting", "topic": "hi"}, "reply": "Hello there!"')!.reply, "Hello there!");
  // an explicit "stay silent"
  assert.equal(parseReply('{"understood": {"intent": "other", "topic": ""}, "reply": null')!.reply, null);
  // escaped quotes inside the reply
  assert.equal(parseReply('{"reply": "She said \\"hi\\" to me", "understood": {')!.reply, 'She said "hi" to me');
  // structured text with no reply at all: nothing to say
  assert.equal(parseReply('json { "understood": { "intent": "statement", "topic": "x" }'), null);
  assert.equal(parseReply('```json\n{"gists": []}\n```')?.reply ?? null, null, "valid JSON with no reply field is silence, not speech");
  // ordinary speech still passes through untouched
  assert.equal(parseReply("I like it here.")!.reply, "I like it here.");
  assert.equal(looksLikeJson("I like it here."), false);
  assert.equal(looksLikeJson('{"reply": "x"}'), true);
  assert.equal(looksLikeJson("Then the \"reply\": field"), true);
});

test("initiative speech and teacher lessons also refuse structured text", async () => {
  const { conv, calls } = await setup(() => '{"thought": "x", "reply": "hello"}');
  void calls;
  const said = await (conv as any).express(Object.assign({}, { name: "Pip" }), "say hi");
  assert.equal(said, null, "JSON is not a sentence a pet can say");
});

test("a claim belongs to whoever the pet could see saying it, and to nobody if the voice was unseen", async () => {
  const reply = () => '{"understood":{"intent":"tell","topic":"x"},"claims":[{"text":"The pad charges you"}],"reply":"ok"}';
  const a = await setup(reply);
  a.pip.heading = Math.PI; // facing the human, 50 away
  await a.conv.humanSays({ kind: "pet", id: "pip" }, "hello", false);
  await wait(1300);
  const k = a.pip.mind.claims[0].fromKey;
  assert.ok(k && a.pip.mind.others[k], "the human is now someone it knows by look");
  const b = await setup(reply);
  b.pip.heading = 0; // the human is behind it
  await b.conv.humanSays({ kind: "pet", id: "pip" }, "hello", false);
  await wait(1300);
  assert.equal(b.pip.mind.claims[0].fromKey, undefined, "an unseen voice is nobody in particular");
});
