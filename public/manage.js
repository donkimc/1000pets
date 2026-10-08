// Env, Teacher and Saves tabs, plus the "save brain" buttons on pet cards.
(() => {
  const el = (id) => document.getElementById(id);
  const p2 = (n) => String(n).padStart(2, "0");
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clock = (min) => `D${Math.floor(min / 1440) + 1} ${p2(Math.floor((min % 1440) / 60))}:${p2(min % 60)}`;
  const S = () => (typeof state !== "undefined" ? state : null); // the page's live state (a top-level let, not a window property)
  const BTN = "px-3 py-2 rounded-lg bg-slate-700 text-xs active:bg-slate-600";
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `request failed (${r.status})`);
    return d;
  };
  const bytes = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : b > 1024 ? Math.round(b / 1024) + " KB" : b + " B");

  // ================= Environment =================
  const FIELDS = [
    { f: "weather", label: "Weather", kind: "select", options: ["clear", "cloudy", "rain"] },
    { f: "sunIntensity", label: "Sunlight", kind: "range", min: 0, max: 100, fmt: (v) => Math.round(v * 100) + "%", toApi: (v) => Number(v) / 100, fromEnv: (v) => Math.round(v * 100) },
    { f: "outdoorTemp", label: "Outdoor °C", kind: "number", min: -30, max: 50 },
    { f: "indoorTemp", label: "Indoor °C", kind: "number", min: 0, max: 40 },
    { f: "curtainOpen", label: "Curtain", kind: "bool", on: "open", off: "closed" },
    { f: "doorOpen", label: "Door", kind: "bool", on: "open", off: "closed" },
    { f: "lampOn", label: "Lamp", kind: "bool", on: "on", off: "off" },
    { f: "heaterOn", label: "Heater", kind: "bool", on: "on", off: "off" },
    { f: "beaconOn", label: "Charger hum", kind: "bool", on: "on", off: "off" },
  ];
  const ROOM_FIELDS = ["indoorTemp", "curtainOpen", "lampOn", "heaterOn"];
  let envRoom = ""; // "" = the world (and the first room); otherwise one room
  let envCur = null;
  let envFilter = "";
  let envBuilt = false;
  const fieldLabel = Object.fromEntries(FIELDS.map((x) => [x.f, x.label]));

  function showVal(x, v) {
    if (x.kind === "bool") return v ? x.on : x.off;
    if (x.fmt) return x.fmt(v);
    return String(v);
  }

  function buildEnv() {
    el("env-controls").innerHTML = FIELDS.map((x) => {
      let ctl = "";
      if (x.kind === "select") ctl = `<select data-ctl="${x.f}" class="bg-slate-700 rounded-lg px-2 py-2 text-sm">${x.options.map((o) => `<option>${o}</option>`).join("")}</select>`;
      else if (x.kind === "bool") ctl = `<select data-ctl="${x.f}" class="bg-slate-700 rounded-lg px-2 py-2 text-sm"><option value="true">${x.on}</option><option value="false">${x.off}</option></select>`;
      else if (x.kind === "range") ctl = `<input data-ctl="${x.f}" type="range" min="${x.min}" max="${x.max}" class="w-full min-w-0 accent-emerald-400">`;
      else ctl = `<input data-ctl="${x.f}" type="number" min="${x.min}" max="${x.max}" step="0.5" class="w-20 bg-slate-700 rounded-lg px-2 py-2 text-base outline-none focus:ring-1 focus:ring-accent">`;
      return `<div class="flex items-center gap-2" data-row="${x.f}"><div class="w-24 shrink-0"><div class="text-sm">${x.label}</div><div class="text-xs text-mute" data-cur="${x.f}"></div></div><div class="flex-1 min-w-0">${ctl}</div><button data-set="${x.f}" class="${BTN}">Set</button><button data-auto="${x.f}" class="${BTN}">Auto</button></div>`;
    }).join("");
    el("env-controls").onclick = async (e) => {
      const set = e.target.closest("[data-set]"), auto = e.target.closest("[data-auto]");
      if (!set && !auto) return;
      const f = (set || auto).dataset.set || (set || auto).dataset.auto, x = FIELDS.find((y) => y.f === f);
      let value = "auto";
      if (set) {
        const raw = el("env-controls").querySelector(`[data-ctl="${f}"]`).value;
        value = x.kind === "bool" ? raw === "true" : x.kind === "select" ? raw : x.toApi ? x.toApi(raw) : Number(raw);
      }
      try {
        el("env-note").textContent = "";
        await api("POST", "/api/env", { field: f, value, ...(roomScoped() ? { room: envRoom } : {}) });
        envDirty.delete(f);
        await loadEnv(true);
      } catch (err) { el("env-note").textContent = err.message; }
    };
    el("env-controls").addEventListener("input", (e) => { const c = e.target.closest("[data-ctl]"); if (c) envDirty.add(c.dataset.ctl); });
    el("env-release").onclick = async () => { try { await api("POST", "/api/env/release-all", {}); envDirty.clear(); await loadEnv(true); } catch (err) { el("env-note").textContent = err.message; } };
    el("env-filter").innerHTML = [["", "All"], ["human", "You"], ["teacher", "Teacher"], ["auto", "Auto"]].map(([v, l]) => `<button data-src="${v}" class="px-2 py-1 rounded-md text-xs">${l}</button>`).join("");
    el("env-filter").onclick = (e) => { const b = e.target.closest("[data-src]"); if (b) { envFilter = b.dataset.src; loadEnv(); } };
    envBuilt = true;
  }

  const roomScoped = () => !!envRoom && envCur && envCur.rooms && envCur.rooms.length > 1 && envCur.rooms[0].id !== envRoom;

  const envDirty = new Set(); // controls the person is editing: do not overwrite them on refresh

  async function loadEnv() {
    if (!envBuilt) buildEnv();
    const [cur, hist] = await Promise.all([api("GET", "/api/env"), api("GET", `/api/env/history?limit=150${envFilter ? "&source=" + envFilter : ""}`)]);
    envCur = cur;
    // Which room? (only when the house has more than one)
    const multi = cur.rooms && cur.rooms.length > 1;
    el("env-scope").classList.toggle("hidden", !multi);
    if (multi) {
      el("env-scope").innerHTML = `<div class="flex items-center gap-2"><span class="text-xs text-mute">Change</span><select id="env-room" class="bg-slate-700 rounded-lg px-2 py-2 text-sm">${cur.rooms.map((r, i) => `<option value="${i ? r.id : ""}"${(i ? r.id : "") === envRoom ? " selected" : ""}>${esc(i ? r.name : r.name + " and the weather")}</option>`).join("")}</select><span class="text-xs text-mute">Weather, sun and the front door apply to the whole world.</span></div>`;
      el("env-room").onchange = (e) => { envRoom = e.target.value; envDirty.clear(); loadEnv(); };
      const doors = cur.doors || [];
      el("env-doors").classList.remove("hidden");
      el("env-doors").innerHTML = `<div class="text-xs uppercase tracking-wider text-mute mb-1">Doors <span class="normal-case">(pets open any door that is not locked)</span></div>` + doors.map((d) => {
        const name = (id) => (cur.rooms.find((r) => r.id === id) || { name: id }).name;
        return `<div class="flex items-center gap-2 text-sm"><span class="flex-1">${esc(name(d.a))} ↔ ${esc(name(d.b))}</span><span class="text-xs ${d.locked ? "text-amber-300" : "text-mute"}">${d.locked ? "locked" : d.open ? "open" : "shut"}</span><button data-lock="${d.id}" data-to="${d.locked ? "false" : "true"}" class="${BTN}">${d.locked ? "Unlock" : "Lock"}</button></div>`;
      }).join("");
      el("env-doors").onclick = async (e) => { const b = e.target.closest("[data-lock]"); if (!b) return; try { await api("POST", "/api/env", { field: "doorLocked", door: b.dataset.lock, value: b.dataset.to === "true" }); await loadEnv(); } catch (err) { el("env-note").textContent = err.message; } };
    }
    const scoped = roomScoped(), room = scoped ? cur.rooms.find((r) => r.id === envRoom) : null;
    for (const x of FIELDS) {
      const row = el("env-controls").querySelector(`[data-row="${x.f}"]`);
      if (row) row.style.display = scoped && !ROOM_FIELDS.includes(x.f) ? "none" : "";
      const v = scoped && ROOM_FIELDS.includes(x.f) ? room[x.f] : cur.env[x.f], pinned = scoped && ROOM_FIELDS.includes(x.f) ? room.pinned.includes(x.f) : x.f in cur.overrides;
      el("env-controls").querySelector(`[data-cur="${x.f}"]`).innerHTML = `${esc(showVal(x, v))} ${pinned ? '<span title="pinned">📌</span>' : '<span class="text-mute">auto</span>'}`;
      const c = el("env-controls").querySelector(`[data-ctl="${x.f}"]`);
      if (!envDirty.has(x.f) && document.activeElement !== c) c.value = x.kind === "bool" ? String(!!v) : x.fromEnv ? x.fromEnv(v) : v;
    }
    el("env-filter").querySelectorAll("button").forEach((b) => {
      const on = b.dataset.src === envFilter;
      b.classList.toggle("bg-accent", on); b.classList.toggle("text-emerald-950", on); b.classList.toggle("bg-slate-700", !on);
    });
    const who = { human: "you", teacher: "Teacher", auto: "auto" };
    el("env-history").innerHTML = hist.map((r) => {
      const x = FIELDS.find((y) => y.f === r.field);
      const what = r.mode === "auto" && r.source !== "auto" ? "released to auto" : `→ ${esc(x ? showVal(x, r.to) : r.to)}`;
      const color = r.source === "teacher" ? "text-teal-300" : r.source === "human" ? "text-slate-100" : "text-mute";
      return `<li class="py-1.5 border-b border-line"><span class="text-mute tabular-nums mr-1.5">D${r.day} ${p2(r.hour)}:${p2(r.minute)}</span><span class="${color}">${esc(fieldLabel[r.field] || r.field)} ${what}</span> <span class="text-mute text-xs">· ${who[r.source] || r.source}${r.reason ? " · " + esc(r.reason) : ""}</span></li>`;
    }).join("") || '<li class="text-mute py-2">No changes yet.</li>';
  }

  // ================= Teacher =================
  const KIND = { lesson: "teach", observe: "watch", env: "room" };
  const STATUS_COLOR = { pending: "text-mute", done: "text-accent", missed: "text-amber-400", cancelled: "text-mute" };
  const petName = (id) => { const p = ((S() && S().pets) || []).find((x) => x.id === id); return p ? p.name : id === "all" ? "everyone" : id; };

  async function loadTeacher() {
    const [t, log] = await Promise.all([api("GET", "/api/teacher"), api("GET", "/api/teacher/log?limit=40")]);
    const busy = t.working ? "thinking…" : t.active ? { lesson: "going to teach", observe: "watching", env: "going to the room controls", answer: "going to answer a pet" }[t.active.kind] : "wandering";
    el("t-status").innerHTML = !t.enabled ? '<span class="text-mute">paused</span>' : `<span class="text-teal-300">${busy}</span>`;
    el("t-toggle").textContent = t.enabled ? "Pause teacher" : "Resume teacher";
    const untilReview = Math.max(0, t.nextReviewMin - t.nowMin);
    el("t-meta").innerHTML = [
      `Now ${clock(t.nowMin)}${t.plan ? ` · plan v${t.plan.version}` : " · no plan yet"}`,
      t.plan ? `Next review ${clock(t.nextReviewMin)} (in ${untilReview >= 60 ? (untilReview / 60).toFixed(1) + " h" : untilReview + " min"}, every ${t.reviewEveryMin / 60} h of simulated time)` : "",
      `Model calls this hour: ${t.guard.callsLastHour} of ${t.guard.max} (a call-count guard, not a spending limit)`,
      `${t.stats.lessons} lessons · ${t.stats.answers} answers · ${t.stats.reviews} reviews · ${t.stats.envChanges} room changes · ${t.stats.missed} missed`,
      t.llmAvailable ? "" : "No AI model is available, so the teacher is only wandering.",
    ].filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join("");
    el("t-error").textContent = t.lastError || "";

    const plan = t.plan;
    el("t-long").innerHTML = plan && plan.long.length ? (plan.summary ? `<div class="text-xs text-mute">${esc(plan.summary)}</div>` : "") + plan.long.map((g) =>
      `<div class="rounded-lg bg-ink/60 p-2"><div class="font-semibold">${esc(g.goal)}</div><div class="text-xs text-mute">${esc(g.why)}</div>` +
      (g.progress ? `<div class="text-xs mt-1"><span class="text-mute">Progress:</span> ${esc(g.progress)}</div>` : "") +
      Object.entries(g.focus || {}).map(([id, v]) => `<div class="text-xs"><span class="text-mute">${esc(petName(id))}:</span> ${esc(v)}</div>`).join("") + `</div>`).join("") : '<div class="text-mute">The plan is written when the first model call succeeds.</div>';

    const agenda = plan ? plan.agenda.slice().sort((a, b) => a.atMin - b.atMin) : [];
    el("t-agenda").innerHTML = agenda.map((a) => {
      const now = t.active && t.active.itemId === a.id;
      const env = a.env ? ` <span class="text-teal-300">[${a.env.value === "auto" ? "release " : "set "}${esc(a.env.field)}${a.env.value === "auto" ? "" : " = " + esc(String(a.env.value))}]</span>` : "";
      return `<li class="py-2 border-b border-line ${now ? "bg-teal-900/20" : ""}"><div class="flex items-baseline gap-2"><span class="text-mute tabular-nums text-xs">${clock(a.atMin)}</span><span class="text-xs px-1.5 rounded bg-slate-700">${KIND[a.kind] || a.kind}</span><span class="font-semibold flex-1">${esc(a.topic)}</span><span class="text-xs ${STATUS_COLOR[a.status]}">${now ? "now" : a.status}</span></div>` +
        `<div class="text-xs text-mute">to ${esc(petName(a.target))}${a.where !== "near_target" ? " at " + esc(a.where) : ""}${env}</div>${a.outline ? `<div class="text-xs mt-0.5">${esc(a.outline)}</div>` : ""}${a.result ? `<div class="text-xs text-mute">${esc(a.result)}</div>` : ""}</li>`;
    }).join("") || '<li class="text-mute py-2">Nothing planned yet.</li>';

    el("t-questions").innerHTML = t.questions.slice().reverse().map((q) =>
      `<li class="py-2 border-b border-line"><div class="text-xs text-mute tabular-nums">${clock(q.askedMin)} · ${esc(petName(q.petId))} · ${q.status}</div><div>“${esc(q.text)}”</div>` +
      (q.answer ? `<div class="text-xs text-teal-300 mt-0.5">${esc(q.answer)}${q.env ? ` <span class="text-mute">[${esc(q.env.field)} → ${esc(String(q.env.value))}]</span>` : ""}</div>` : "") + `</li>`).join("") || '<li class="text-mute py-2">No questions yet. Pets ask rarely, when they are really puzzled.</li>';

    el("t-journal").innerHTML = t.journal.slice().reverse().map((j) =>
      `<div class="rounded-lg bg-ink/60 p-2"><div class="text-xs text-mute">${clock(j.atMin)} · ${j.kind === "initial" ? "first plan" : "review"}</div><div>${esc(j.summary)}</div>` +
      Object.entries(j.petNotes || {}).map(([id, v]) => `<div class="text-xs"><span class="text-mute">${esc(petName(id))}:</span> ${esc(v)}</div>`).join("") + `</div>`).join("") || '<div class="text-mute">No reviews yet.</div>';

    const label = { plan: "wrote the plan", review: "reviewed", lesson: "taught", answer: "answered", env: "changed the room", observe: "watched", question: "was asked", missed: "missed" };
    el("t-log").innerHTML = log.map((r) => {
      const body = r.type === "lesson" ? `${esc(petName(r.target))}: “${esc(r.text)}”` : r.type === "answer" ? `${esc(petName(r.pet))} asked “${esc(r.text)}” → “${esc(r.answer)}”${r.env ? " · " + esc(r.env) : ""}` :
        r.type === "env" ? `${esc(r.did)}${r.reason ? " (" + esc(r.reason) + ")" : ""}` : r.type === "observe" ? esc(r.note) : r.type === "question" ? `${esc(petName(r.pet))}: “${esc(r.text)}”` : esc(r.summary || r.topic || "");
      return `<li class="py-1.5 border-b border-line"><span class="text-mute tabular-nums">D${r.day} ${p2(r.hour)}:${p2(r.minute)}</span> <span class="text-teal-300">${label[r.type] || r.type}</span> ${body}</li>`;
    }).join("") || '<li class="text-mute">Nothing yet.</li>';
    window.__teacher = t;
  }

  function wireTeacher() {
    const act = (id, url, body) => (el(id).onclick = async () => { try { await api("POST", url, body ? body() : {}); await loadTeacher(); } catch (e) { el("t-error").textContent = e.message; } });
    act("t-toggle", "/api/teacher/enable", () => ({ enabled: !(window.__teacher && window.__teacher.enabled) }));
    act("t-review", "/api/teacher/review-now");
    el("t-regen").onclick = async () => {
      if (!confirm("Throw away the current plan and have the teacher write a new one?")) return;
      try { await api("POST", "/api/teacher/regenerate", {}); await loadTeacher(); } catch (e) { el("t-error").textContent = e.message; }
    };
  }

  // ================= Saves and brains =================
  async function loadSaves() {
    const [saves, brains] = await Promise.all([api("GET", "/api/saves"), api("GET", "/api/brains")]);
    el("save-list").innerHTML = saves.map((s) =>
      `<li class="rounded-lg bg-ink/60 p-3" data-save="${esc(s.id)}"><div class="flex items-baseline gap-2"><span class="font-semibold flex-1 break-words">${esc(s.name)}</span>${s.auto ? '<span class="text-xs text-mute">auto backup</span>' : ""}</div>` +
      `<div class="text-xs text-mute">${esc(s.simTime)} · ${esc((s.pets || []).join(", "))} · ${bytes(s.bytes)} · saved ${new Date(s.createdAt).toLocaleString()}</div>` +
      `<div class="flex gap-2 mt-2"><button data-load class="${BTN} flex-1">Load</button><a href="/api/saves/${esc(s.id)}/download" download class="${BTN}">Download</a><button data-rename class="${BTN}">Rename</button><button data-del class="${BTN} text-red-300">Delete</button></div></li>`).join("") || '<li class="text-mute">No saves yet.</li>';
    el("brain-list").innerHTML = brains.map((b) =>
      `<li class="rounded-lg bg-ink/60 p-3" data-brain="${esc(b.id)}"><div class="font-semibold break-words">${esc(b.label)}</div>` +
      `<div class="text-xs text-mute">${esc(b.name)} · day ${b.simDay} · ${bytes(b.bytes)} · ${b.savedAt ? new Date(b.savedAt).toLocaleString() : ""}</div>` +
      `<div class="flex flex-wrap gap-2 mt-2 items-center"><select data-target class="bg-slate-700 rounded-lg px-2 py-2 text-xs"><option value="new">Add as a new pet</option>${((S() && S().pets) || []).map((p) => `<option value="${esc(p.id)}">Replace ${esc(p.name)}'s brain</option>`).join("")}</select>` +
      `<button data-apply class="${BTN}">Apply</button><a href="/api/brains/${esc(b.id)}" download class="${BTN}">Download</a><button data-bdel class="${BTN} text-red-300">Delete</button></div></li>`).join("") || '<li class="text-mute">No saved brains yet.</li>';
  }

  function wireSaves() {
    const note = (id, t) => { el(id).textContent = t; };
    el("save-go").onclick = async () => {
      const btn = el("save-go"); btn.disabled = true; note("save-note", "saving…");
      try { const s = await api("POST", "/api/saves", { name: el("save-name").value.trim() }); el("save-name").value = ""; note("save-note", `Saved “${s.name}” at ${s.simTime}.`); await loadSaves(); }
      catch (e) { note("save-note", e.message); } finally { btn.disabled = false; }
    };
    const download = (id) => { const a = document.createElement("a"); a.href = `/api/saves/${id}/download`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); };
    el("save-dl").onclick = async () => {
      const btn = el("save-dl"); btn.disabled = true; note("save-note", "saving…");
      try { const s = await api("POST", "/api/saves", { name: el("save-name").value.trim() }); el("save-name").value = ""; note("save-note", `Saved “${s.name}” at ${s.simTime}; the file is downloading.`); await loadSaves(); download(s.id); }
      catch (e) { note("save-note", e.message); } finally { btn.disabled = false; }
    };
    el("save-up").onclick = () => el("save-file").click();
    el("save-file").onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
      if (f.size > 300 * 1048576) { note("save-note", "That file is bigger than the 300 MB limit."); return; }
      const btn = el("save-up"); btn.disabled = true; note("save-note", `reading ${f.name} (${bytes(f.size)})…`);
      try {
        const r = await fetch("/api/saves/import", { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name) }, body: f });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `upload failed (${r.status})`);
        await loadSaves();
        note("save-note", `Added “${d.name}” (${d.simTime || "day " + d.simDay}, ${(d.pets || []).join(", ")}).`);
        if (confirm(`Load “${d.name}” now? This replaces the live simulation (a backup of it is kept) and leaves it paused. Press Cancel to keep it in the list for later.`)) {
          note("save-note", "loading…"); await api("POST", `/api/saves/${d.id}/load`, {}); // the server tells every page to reload
        }
      } catch (err) { note("save-note", err.message); } finally { btn.disabled = false; }
    };
    el("save-list").onclick = async (e) => {
      const li = e.target.closest("[data-save]"); if (!li) return;
      const id = li.dataset.save, name = li.querySelector(".font-semibold").textContent;
      try {
        if (e.target.closest("[data-load]")) {
          if (!confirm(`Load “${name}”? This replaces the live simulation (a backup of it is kept) and leaves it paused.`)) return;
          note("save-note", "loading…"); await api("POST", `/api/saves/${id}/load`, {}); // the server tells every page to reload
        } else if (e.target.closest("[data-rename]")) {
          const n = prompt("New name", name); if (n && n.trim()) { await api("POST", `/api/saves/${id}/rename`, { name: n.trim() }); await loadSaves(); }
        } else if (e.target.closest("[data-del]")) {
          if (confirm(`Delete “${name}” for good?`)) { await api("DELETE", `/api/saves/${id}`); await loadSaves(); }
        }
      } catch (err) { note("save-note", err.message); }
    };
    el("brain-list").onclick = async (e) => {
      const li = e.target.closest("[data-brain]"); if (!li) return;
      const id = li.dataset.brain, label = li.querySelector(".font-semibold").textContent;
      try {
        if (e.target.closest("[data-apply]")) {
          const target = li.querySelector("[data-target]").value;
          const body = target === "new" ? { mode: "new" } : { mode: "replace", petId: target, adoptIdentity: confirm(`Also take the saved name and colour of “${label}”? (Cancel keeps this pet's own name and colour.)`) };
          if (target !== "new" && !confirm(`Replace the personality and memories of ${petName(target)} with “${label}”? This cannot be undone (save the simulation first if unsure).`)) return;
          await api("POST", `/api/brains/${id}/apply`, body); note("brain-note", target === "new" ? "Added as a new pet." : "Brain applied.");
        } else if (e.target.closest("[data-bdel]")) {
          if (confirm(`Delete the saved brain “${label}”?`)) { await api("DELETE", `/api/brains/${id}`); await loadSaves(); }
        }
      } catch (err) { note("brain-note", err.message); }
    };
    el("brain-upload").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        if (f.size > 2_000_000) throw new Error("that file is too large to be a brain");
        const r = await api("POST", "/api/brains/upload", JSON.parse(await f.text()));
        note("brain-note", `Uploaded “${r.label}”. Apply it from the list.`); await loadSaves();
      } catch (err) { note("brain-note", err instanceof SyntaxError ? "that is not a JSON file" : err.message); }
      e.target.value = "";
    };
  }

  // ================= brain buttons on pet cards =================
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-brain-save]"); if (!b) return;
    const id = b.dataset.brainSave, note = document.querySelector(`[data-brain-note="${id}"]`);
    const label = prompt("Name this brain save", `${petName(id)} day ${(S() && S().day) || ""}`);
    if (label === null) return;
    try { const r = await api("POST", `/api/pets/${id}/brain/save`, { label: label.trim() }); if (note) note.textContent = `Saved “${r.label}” to the brain library (Saves tab).`; }
    catch (err) { if (note) note.textContent = err.message; }
  });

  // ================= pet habits =================
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-reset-rules]"); if (!b) return;
    const id = b.dataset.resetRules;
    if (!confirm(`Put ${petName(id)}'s habits back to the usual values and cancel any trial?`)) return;
    try { await api("POST", `/api/pets/${id}/rules/reset`, {}); b.textContent = "Habits reset"; } catch (err) { b.textContent = err.message; }
  });
  async function loadSettings() {
    const box = el("rule-learning"); if (!box || box.dataset.wired) return;
    box.dataset.wired = "1";
    try { box.checked = (await api("GET", "/api/settings")).ruleLearning; } catch (e) { /* leave unchecked */ }
    box.onchange = async () => {
      try { const r = await api("POST", "/api/settings", { ruleLearning: box.checked }); el("rule-note").textContent = r.ruleLearning ? "Pets may now try tuning their habits." : "Pets will not start any new habit trial (habits already kept stay)."; }
      catch (err) { box.checked = !box.checked; el("rule-note").textContent = err.message; }
    };
  }

  // ================= tab switching and refresh =================
  const loaders = { env: loadEnv, teacher: loadTeacher, saves: loadSaves, pets: loadSettings };
  let wired = false;
  function refresh() {
    const name = window.activeTab;
    if (!loaders[name]) return;
    if (!wired) { wireTeacher(); wireSaves(); wired = true; }
    loaders[name]().catch((e) => console.error(name, e));
  }
  window.onTab = refresh;
  setInterval(() => { if (!document.hidden && window.activeTab !== "saves") refresh(); }, 4000);
  refresh();
})();
