// Voices, in the browser. Nothing is sent to a server: the models run here (Kokoro for speaking, Whisper for listening)
// and are downloaded once from a CDN, then cached by the browser.
//
//  - Every pet and the Teacher speaks aloud in its own voice. You hear only what is near your avatar: loudness falls with
//    distance and a wall or shut door muffles it, and the sound comes from the side the speaker is on.
//  - You talk to them like a walkie-talkie: hold the button (or the space bar), say it, let go. Beeps mark the start and end.
//    Say a pet's name first ("Pip, ...") to talk to that pet; the radio carries your voice anywhere, and a pet's answer to
//    you comes back over the radio when it is too far to hear.
//
// Where a model cannot run (no WebGPU or too slow), the browser's own voice is used instead so it always speaks.

const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm";
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HEAR_RANGE = 520; // world units: beyond this a voice is not heard
const WALL_MUFFLE = 0.35; // loudness left after one wall or shut door (the same as in the simulation)

const $ = (id) => document.getElementById(id);
const app = () => window.__app;
const ls = {
  get(k, d) { try { return localStorage.getItem("voice." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("voice." + k, String(v)); } catch { /* private mode */ } },
};

const S = {
  on: ls.get("on", "0") === "1",
  engine: ls.get("engine", "auto"), // auto | kokoro | browser
  volume: Number(ls.get("volume", "0.9")),
  everyone: ls.get("everyone", "0") === "1", // hear all, wherever they are
  gpu: ls.get("gpu", "0") === "1", // try the graphics chip for speaking (faster where it works; on some machines it produces noise, so it is checked)
  teacherVoice: { id: "bf_emma", speed: 0.95, pitch: 0.95 },
  kokoro: null, kokoroState: "idle", // idle | loading | ready | failed
  queue: [], playing: false, lastRtf: 0,
  ctx: null,
};

function note(text) { const n = $("voice-note"); if (n) n.textContent = text; }

// ---------- hearing: how loud, and from where ----------
function crossings(a, b) {
  const L = app() && app().layout; if (!L || !L.walls) return 0;
  const shut = ((app().state && app().state.doors) || []).filter((d) => !d.open).map((d) => L.doorRects[d.id]).filter(Boolean);
  const rects = [...L.walls, ...shut];
  if (!rects.length) return 0;
  const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(d / 8));
  let count = 0, inside = false;
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n, y = a.y + ((b.y - a.y) * i) / n;
    const now = rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    if (now && !inside) count++;
    inside = now;
  }
  return count;
}

function positionOf(from) {
  const st = app() && app().state; if (!st) return null;
  if (from.kind === "teacher") return st.teacher;
  if (from.kind === "pet") return (st.pets || []).find((p) => p.id === from.id) || null;
  return null;
}

/** Loudness 0..1 and left/right pan -1..1 of a speaker as heard by the human avatar. */
function hearing(pos) {
  const st = app().state, me = st.human;
  if (!me || !pos) return { vol: S.everyone ? 0.7 : 0, pan: 0, near: false };
  const dist = Math.hypot(pos.x - me.x, pos.y - me.y);
  const walls = crossings(me, pos);
  const vol = Math.max(0, 1 - dist / HEAR_RANGE) * WALL_MUFFLE ** walls;
  const w3 = window.world3d;
  const facing = w3 && w3.view.mode === "walk" ? w3.yaw : me.heading;
  const rel = Math.atan2(pos.y - me.y, pos.x - me.x) - facing;
  return { vol, pan: dist < 30 ? 0 : Math.max(-1, Math.min(1, Math.sin(rel))), near: vol > 0.07 };
}

// ---------- speaking ----------
function audioCtx() {
  if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (S.ctx.state === "suspended") S.ctx.resume();
  return S.ctx;
}

async function loadKokoro() {
  if (S.kokoroState === "loading" || S.kokoroState === "ready") return;
  S.kokoroState = "loading";
  try {
    const { KokoroTTS } = await import(KOKORO_URL);
    const progress = (p) => { if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) note(`Downloading the voice model… ${Math.round(p.progress)}%`); };
    let tts = null;
    if (S.gpu && navigator.gpu) { // fast path, where the browser can use the graphics chip and it gives clean sound
      try {
        const g = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "fp32", device: "webgpu", progress_callback: progress });
        if (sane((await g.generate("Test.", { voice: "af_heart" })).audio)) { tts = g; S.device = "webgpu"; } else console.warn("kokoro on the graphics chip gave garbled sound; using the processor instead");
      } catch (e) { console.warn("kokoro webgpu failed", e); }
    }
    if (!tts) { tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "wasm", progress_callback: progress }); S.device = "wasm"; }
    S.kokoro = tts; S.kokoroState = "ready";
    note(`Voice model ready (${S.device}).`);
  } catch (e) {
    console.error(e); S.kokoroState = "failed"; note("The voice model could not load, so the browser's own voice is used.");
  }
}

/** Speech samples must sit within -1..1. Anything else is noise from a broken backend and must never reach the speakers. */
function sane(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (!(a <= 1e6)) return false; if (a > peak) peak = a; }
  return samples.length > 0 && peak <= 1.5;
}

function pickBrowserVoice(v) {
  const list = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  const en = list.filter((x) => /^en/i.test(x.lang));
  if (!en.length) return null;
  let h = 0; for (const ch of v.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return en[h % en.length];
}

function speakBrowser(item) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(item.text);
    const v = item.voice;
    u.voice = pickBrowserVoice(v); u.pitch = v.pitch ?? 1; u.rate = Math.max(0.6, Math.min(1.6, v.speed ?? 1));
    u.volume = Math.min(1, item.vol * S.volume * 1.2);
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

async function speakKokoro(item) {
  const t0 = performance.now();
  const audio = await S.kokoro.generate(item.text, { voice: item.voice.id, speed: item.voice.speed ?? 1 });
  if (!sane(audio.audio)) throw new Error("the voice model produced noise");
  const seconds = audio.audio.length / audio.sampling_rate;
  S.lastRtf = (performance.now() - t0) / 1000 / Math.max(0.1, seconds); // how many seconds it took per second of speech
  const ctx = audioCtx();
  const buf = ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
  buf.copyToChannel(audio.audio, 0);
  return new Promise((resolve) => {
    const src = ctx.createBufferSource(); src.buffer = buf;
    const gain = ctx.createGain(); gain.gain.value = Math.min(1.5, item.vol * S.volume * 1.4);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (pan) pan.pan.value = item.pan;
    let tail = src;
    if (item.radio) { // far away: it comes over the radio, thin and a little rough
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 0.7;
      src.connect(bp); tail = bp; gain.gain.value = Math.min(1.5, S.volume * 1.2);
    }
    tail.connect(gain); gain.connect(pan || ctx.destination); if (pan) pan.connect(ctx.destination);
    src.onended = () => { if (item.radio) beep(520, 0.06, 0.12); resolve(); };
    if (item.radio) beep(900, 0.05, 0.12);
    src.start();
  });
}

async function pump() {
  if (S.playing) return;
  S.playing = true;
  try {
    while (S.queue.length) {
      const item = S.queue.shift();
      // Kokoro when it is ready and keeping up; the browser's voice otherwise, so speech is never far behind the conversation
      const kokoroOk = S.kokoroState === "ready" && S.engine !== "browser" && (S.engine === "kokoro" || (S.lastRtf < 1.6 && S.queue.length < 2));
      try { if (kokoroOk) await speakKokoro(item); else await speakBrowser(item); } catch (e) { console.warn("speech failed", e); }
    }
  } finally { S.playing = false; }
}

function say(item) {
  S.queue.push(item);
  while (S.queue.length > 4) S.queue.shift(); // never fall far behind
  pump();
}

function onUtterance(u) {
  if (!S.on || !app() || u.from.kind === "human") return; // your own words are not read back to you
  if (typeof u.text !== "string" || !u.text.trim()) return;
  const pos = positionOf(u.from);
  const h = hearing(pos);
  const toYou = u.to && u.to.kind === "human";
  // A voice too far to hear is lost, unless it is answering you: that comes back over the radio.
  const radio = !h.near && (toYou || S.everyone);
  if (!h.near && !radio) return;
  const pets = (app().state && app().state.pets) || [];
  const voice = u.from.kind === "teacher" ? S.teacherVoice : (pets.find((p) => p.id === u.from.id) || {}).voice || { id: "af_heart" };
  say({ text: u.text.slice(0, 240), voice, vol: radio ? 0.8 : Math.min(1, 0.25 + h.vol), pan: radio ? 0 : h.pan, radio });
}

// ---------- the walkie-talkie ----------
function beep(freq, dur, vol = 0.15) {
  try {
    const ctx = audioCtx(), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square"; o.frequency.value = freq; g.gain.value = vol * S.volume;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
  } catch { /* no audio */ }
}

const rec = { stream: null, ctx: null, node: null, chunks: [], active: false, asr: null, asrLoading: null };

async function loadAsr() {
  if (rec.asr) return rec.asr;
  if (!rec.asrLoading) {
    note("Loading the listening model (first time only)…");
    rec.asrLoading = (async () => {
      const { pipeline } = await import(TRANSFORMERS_URL);
      const opts = { dtype: "q8", progress_callback: (p) => { if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) note(`Downloading the listening model… ${Math.round(p.progress)}%`); } };
      rec.asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", opts);
      note("Listening model ready.");
      return rec.asr;
    })().catch((e) => { rec.asrLoading = null; throw e; });
  }
  return rec.asrLoading;
}

async function startTalking() {
  if (rec.active) return;
  rec.active = true;
  $("ptt")?.classList.add("bg-red-500"); $("ptt3d")?.classList.add("bg-red-500");
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!rec.active) { rec.stream.getTracks().forEach((t) => t.stop()); return; }
    beep(880, 0.07); // the radio opens
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const src = rec.ctx.createMediaStreamSource(rec.stream);
    rec.node = rec.ctx.createScriptProcessor(4096, 1, 1);
    rec.chunks = [];
    rec.node.onaudioprocess = (e) => { if (rec.active) rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    src.connect(rec.node); rec.node.connect(rec.ctx.destination);
    note("Listening… let go when you are done.");
    loadAsr().catch(() => {}); // warm the model while you talk
  } catch (e) {
    rec.active = false; note("The microphone is not available: " + (e && e.message ? e.message : e));
    $("ptt")?.classList.remove("bg-red-500"); $("ptt3d")?.classList.remove("bg-red-500");
  }
}

function resample(data, from, to) {
  if (from === to) return data;
  const out = new Float32Array(Math.floor((data.length * to) / from));
  for (let i = 0; i < out.length; i++) { const x = (i * from) / to, i0 = Math.floor(x), i1 = Math.min(data.length - 1, i0 + 1); out[i] = data[i0] + (data[i1] - data[i0]) * (x - i0); }
  return out;
}

async function stopTalking() {
  if (!rec.active) return;
  rec.active = false;
  $("ptt")?.classList.remove("bg-red-500"); $("ptt3d")?.classList.remove("bg-red-500");
  if (!rec.stream) return;
  const rate = rec.ctx ? rec.ctx.sampleRate : 16000;
  rec.node && rec.node.disconnect(); rec.stream.getTracks().forEach((t) => t.stop());
  rec.ctx && rec.ctx.close().catch(() => {});
  const chunks = rec.chunks; rec.chunks = []; rec.stream = rec.ctx = rec.node = null;
  beep(660, 0.09); // the radio closes
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total < rate * 0.4) { note("Too short: hold the button while you speak."); return; }
  const all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  note("Transcribing…");
  try {
    const asr = await loadAsr();
    const out = await asr(resample(all, rate, 16000), { chunk_length_s: 30 });
    const text = String((out && out.text) || "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) { note("Did not catch that."); return; }
    sendSpoken(text);
  } catch (e) { console.error(e); note("Could not transcribe: " + (e && e.message ? e.message : e)); }
}

/** "Pip, come here" talks to Pip; with no name it goes to whoever the Talk tab has selected (everyone by default). */
function sendSpoken(text) {
  const pets = (app() && app().state && app().state.pets) || [];
  let target = null, body = text;
  const m = text.match(/^\s*(?:hey|hi|hello|ok|okay|yo)?[\s,]*([A-Za-z]+)[\s,:!.?-]+(.*)$/i);
  if (m) { const p = pets.find((x) => x.name.toLowerCase() === m[1].toLowerCase()); if (p) { target = p.id; body = m[2] || text; } }
  if (target) $("to").value = target;
  note(`You said: “${text}”`);
  $("msg").value = body.slice(0, 300);
  $("anywhere").checked = true; // the radio carries your voice anywhere
  if (window.sendChat) window.sendChat();
}

// ---------- the page controls ----------
function paint() {
  const on = $("voice-on"); if (!on) return;
  on.textContent = S.on ? "Voices on" : "Voices off";
  on.classList.toggle("bg-accent", S.on); on.classList.toggle("text-emerald-950", S.on); on.classList.toggle("bg-slate-700", !S.on);
}

function init() {
  if (!$("voice-on")) return;
  fetch("/api/world").then((r) => r.json()).then((w) => { if (w.teacherVoice) S.teacherVoice = w.teacherVoice; }).catch(() => {});
  $("voice-on").onclick = () => {
    S.on = !S.on; ls.set("on", S.on ? 1 : 0); paint();
    if (S.on) { audioCtx(); beep(700, 0.05, 0.08); if (S.engine !== "browser") loadKokoro(); note("Voices on. You hear what is near you."); }
    else { S.queue.length = 0; window.speechSynthesis && speechSynthesis.cancel(); note(""); }
  };
  $("voice-engine").value = S.engine;
  $("voice-engine").onchange = (e) => { S.engine = e.target.value; ls.set("engine", S.engine); if (S.on && S.engine !== "browser") loadKokoro(); };
  $("voice-volume").value = String(S.volume);
  $("voice-volume").oninput = (e) => { S.volume = Number(e.target.value); ls.set("volume", S.volume); };
  $("voice-gpu").checked = S.gpu;
  $("voice-gpu").onchange = (e) => { S.gpu = e.target.checked; ls.set("gpu", S.gpu ? 1 : 0); note("Takes effect after you reload the page."); };
  $("voice-everyone").checked = S.everyone;
  $("voice-everyone").onchange = (e) => { S.everyone = e.target.checked; ls.set("everyone", S.everyone ? 1 : 0); };
  paint();
  if (S.on && S.engine !== "browser") note("Voices are on; tap “Voices on” once after a reload to let the browser play sound.");

  for (const id of ["ptt", "ptt3d"]) {
    const b = $(id); if (!b) continue;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); startTalking(); });
    b.addEventListener("pointerup", stopTalking); b.addEventListener("pointercancel", stopTalking);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  let spaceDown = false;
  addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat && !/INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target && e.target.tagName) || "")) { e.preventDefault(); spaceDown = true; startTalking(); } });
  addEventListener("keyup", (e) => { if (e.code === "Space" && spaceDown) { spaceDown = false; stopTalking(); } });
}

window.voice = { onUtterance, state: S, say, startTalking, stopTalking, sendSpoken, hearing };
init();
