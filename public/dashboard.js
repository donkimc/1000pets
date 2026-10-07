// Dashboard tab: key indicators, charts from the recorded metrics, speech stats, spending, storage and thoughts.
// Colours: each pet keeps its own validated palette colour everywhere (colour follows the entity).
(() => {
  const SURFACE = "#1a2027", GRID = "#26303a", MUTE = "#8a96a3", INK = "#e8edf2";
  const ENV = { indoor: "#9085e9", outdoor: "#e66767", sun: "#c98500" };
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  let rangeHours = 24, dash = null, thoughtPet = "", thoughtSys = 0;

  const when = (r) => `D${r.day} ${pad(r.hour)}:${pad(r.minute)}`;
  const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m` : s >= 60 ? `${Math.floor(s / 60)} m ${s % 60} s` : `${s} s`);
  const fmtSim = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`);
  const fmtBytes = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : b > 1024 ? Math.round(b / 1024) + " KB" : b + " B");

  function niceTicks(lo, hi) {
    if (hi - lo < 1e-9) hi = lo + 1;
    const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  // ---- line chart with legend, end dots, crosshair tooltip and a table view ----
  function lineChart(el, cfg) {
    const W = 340, H = 170, L = 34, R = 12, T = 8, B = 22;
    const rows = cfg.rows; // [{label, x, values:[..per series]}]
    if (rows.length < 2) { el.innerHTML = `<div class="text-sm text-mute py-6 text-center">Collecting data… a point is recorded every 15 simulated minutes.</div>`; return; }
    const vals = rows.flatMap((r) => r.values).filter((v) => v != null);
    const ticks = cfg.ticks || niceTicks(Math.min(...vals), Math.max(...vals));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const x0 = rows[0].x, x1 = rows[rows.length - 1].x;
    const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="${esc(cfg.title)}">`;
    for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${GRID}" stroke-width="1"/><text x="${L - 5}" y="${Y(t) + 3}" text-anchor="end" font-size="9" fill="${MUTE}">${cfg.yFmt ? cfg.yFmt(t) : t}</text>`;
    for (const i of [0, Math.floor(rows.length / 2), rows.length - 1]) svg += `<text x="${X(rows[i].x)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"}" font-size="9" fill="${MUTE}">${rows[i].label}</text>`;
    cfg.series.forEach((s, si) => {
      const pts = rows.filter((r) => r.values[si] != null).map((r) => [X(r.x), Y(r.values[si])]);
      if (!pts.length) return;
      const path = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
      if (cfg.area) svg += `<path d="${path} L${pts[pts.length - 1][0]} ${Y(lo)} L${pts[0][0]} ${Y(lo)} Z" fill="${s.color}" opacity=".12"/>`;
      svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const e = pts[pts.length - 1];
      svg += `<circle cx="${e[0]}" cy="${e[1]}" r="4.5" fill="${s.color}" stroke="${SURFACE}" stroke-width="2"/>`;
    });
    svg += `<line data-cross x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="${MUTE}" stroke-width="1" style="display:none"/><rect data-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" style="touch-action:pan-y"/></svg>`;
    const legend = cfg.series.length > 1 ? `<div class="flex flex-wrap gap-x-3 gap-y-1 mb-1 text-xs text-slate-300">${cfg.series.map((s) => `<span class="inline-flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>` : "";
    const sample = rows.filter((_, i) => i % Math.max(1, Math.ceil(rows.length / 10)) === 0 || i === rows.length - 1);
    const table = `<table class="hidden w-full text-xs mt-2" data-table><thead><tr><th class="text-left text-mute font-normal">Time</th>${cfg.series.map((s) => `<th class="text-right text-mute font-normal">${esc(s.name)}</th>`).join("")}</tr></thead><tbody>${sample.map((r) => `<tr class="border-t border-line"><td class="py-0.5">${r.label}</td>${r.values.map((v) => `<td class="text-right tabular-nums">${v == null ? "–" : cfg.yFmt ? cfg.yFmt(v) : v}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    el.innerHTML = `${legend}<div class="relative">${svg}<div data-tip class="hidden absolute pointer-events-none rounded-lg bg-slate-900 border border-line px-2 py-1 text-xs whitespace-nowrap z-10"></div></div><button data-tbl class="text-xs text-mute underline mt-1">Table view</button>${table}`;
    const hit = el.querySelector("[data-hit]"), cross = el.querySelector("[data-cross]"), tip = el.querySelector("[data-tip]"), box = el.querySelector("svg");
    const move = (ev) => {
      const r = box.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
      let best = 0; for (let i = 0; i < rows.length; i++) if (Math.abs(X(rows[i].x) - px) < Math.abs(X(rows[best].x) - px)) best = i;
      const row = rows[best], cx = X(row.x);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.style.display = "";
      tip.innerHTML = `<div class="text-mute">${row.label}</div>` + cfg.series.map((s, i) => `<div><span class="inline-block w-2 h-2 rounded-full mr-1" style="background:${s.color}"></span>${esc(s.name)}: <b>${row.values[i] == null ? "–" : cfg.yFmt ? cfg.yFmt(row.values[i]) : row.values[i]}</b></div>`).join("");
      tip.classList.remove("hidden");
      const w = tip.offsetWidth, left = (cx / W) * r.width;
      tip.style.left = Math.max(0, Math.min(r.width - w, left - w / 2)) + "px"; tip.style.top = "0px";
    };
    hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => { cross.style.display = "none"; tip.classList.add("hidden"); });
    el.querySelector("[data-tbl]").onclick = () => el.querySelector("[data-table]").classList.toggle("hidden");
  }

  const tile = (label, value, sub) => `<div class="bg-ink/60 rounded-lg p-3"><div class="text-xs text-mute">${label}</div><div class="text-2xl font-semibold leading-tight">${value}</div>${sub ? `<div class="text-xs text-mute">${sub}</div>` : ""}</div>`;

  function renderKpis(d, llm) {
    const s1 = d.pets.reduce((a, p) => a + p.stats.s1Thoughts, 0), s2 = d.pets.reduce((a, p) => a + p.stats.s2Thoughts, 0);
    const avg = d.pets.length ? Math.round(d.pets.reduce((a, p) => a + p.energy, 0) / d.pets.length) : 0;
    const calls = llm.providers.reduce((a, p) => a + p.calls, 0), spend = llm.providers.reduce((a, p) => a + p.spendUsd, 0);
    $("kpis").innerHTML = [
      tile("Simulated", `Day ${d.day}`, `${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)} · ${d.speed}×${d.paused ? " · paused" : ""}`),
      tile("Server uptime", fmtDur(d.uptimeSec), `${d.memMB} MB memory`),
      tile("Average battery", avg + "%", d.pets.map((p) => `${p.name} ${p.energy}%`).join(" · ")),
      tile("Fast thoughts (S1)", s1.toLocaleString(), "behaviour changes"),
      tile("Slow thoughts (S2)", s2.toLocaleString(), "model calls for thinking"),
      tile("Spoken aloud", d.comms.total.toLocaleString(), `${d.comms.fromHuman} from you`),
      tile("Model calls", calls.toLocaleString(), llm.providers.map((p) => `${p.name} ${p.calls}`).join(" · ")),
      tile("DeepSeek spend", "$" + (llm.providers.find((p) => p.name === "deepseek")?.spendUsd ?? 0).toFixed(3), `total $${spend.toFixed(3)}`),
    ].join("");
  }

  const GROUPS = [["Sleeping", ["sleep"]], ["Charging", ["charge"]], ["Seeking light", ["seek_light"]], ["Following the tone", ["follow_tone"]], ["Exploring", ["wander", "approach_object", "inspect", "pause"]], ["With others", ["approach_pet", "socialize"]], ["Avoiding", ["avoid"]], ["Powered down", ["dormant"]]];
  function renderActivity(d) {
    $("activity").innerHTML = d.pets.map((p) => {
      const total = Object.values(p.stats.actionSec).reduce((a, b) => a + b, 0) || 1;
      const rows = GROUPS.map(([name, acts]) => [name, acts.reduce((a, k) => a + (p.stats.actionSec[k] || 0), 0)]).filter(([, v]) => v > 0);
      return `<div class="mb-3"><div class="flex items-center gap-1.5 mb-1"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${p.color}"></span><span class="font-semibold text-sm">${esc(p.name)}</span><span class="text-xs text-mute">${fmtSim(total)} observed</span></div>${rows.map(([name, v]) => `<div class="flex items-center gap-2 text-xs"><span class="w-24 text-slate-300">${name}</span><div class="flex-1 h-2 bg-slate-700/60 rounded"><div class="h-2 rounded-r" style="width:${Math.max(1, Math.round((v / total) * 100))}%;background:${p.color};border-radius:0 4px 4px 0"></div></div><span class="w-10 text-right tabular-nums">${Math.round((v / total) * 100)}%</span></div>`).join("") || '<div class="text-xs text-mute">no data yet</div>'}</div>`;
    }).join("");
  }

  // ---- rooms: where the pets are and have been (only when the house has more than one room) ----
  const FLOOR_COLOR = { wood: "#b08d57", tile: "#5fa8c0", carpet: "#a58ad0", stone: "#8b95a1" };
  const ROOM_ORDER = (d) => d.rooms.map((r) => r.id);
  const roomColor = (d, id) => FLOOR_COLOR[(d.rooms.find((r) => r.id === id) || {}).floor] || "#667";
  const roomName = (d, id) => (d.rooms.find((r) => r.id === id) || { name: id }).name;

  function renderRooms(d, rows) {
    const show = d.rooms && d.rooms.length > 1;
    $("rooms-dash").classList.toggle("hidden", !show);
    if (!show) return;
    $("room-now").innerHTML = `<div class="grid grid-cols-2 gap-2">${d.rooms.map((r) => {
      const total = d.pets.reduce((a, p) => a + Object.values((p.stats.roomSec || {})).reduce((x, y) => x + y, 0), 0) || 1;
      const here = d.pets.reduce((a, p) => a + ((p.stats.roomSec || {})[r.id] || 0), 0);
      return `<div class="bg-ink/60 rounded-lg p-3" style="border-left:4px solid ${roomColor(d, r.id)}"><div class="font-semibold text-sm">${esc(r.name)}</div>` +
        `<div class="text-xs text-slate-300 min-h-4">${r.pets.length ? esc(r.pets.join(", ")) : '<span class="text-mute">nobody here</span>'}</div>` +
        `<div class="text-xs text-mute mt-1">${r.indoorTemp.toFixed(1)} °C · lamp ${r.lampOn ? "on" : "off"} · heater ${r.heaterOn ? "on" : "off"} · curtain ${r.curtainOpen ? "open" : "closed"}</div>` +
        `<div class="text-xs text-mute">${Math.round((here / total) * 100)}% of all pet time</div></div>`;
    }).join("")}</div>`;
    const legend = `<div class="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-xs text-slate-300">${d.rooms.map((r) => `<span class="inline-flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm" style="background:${roomColor(d, r.id)}"></span>${esc(r.name)}</span>`).join("")}</div>`;
    $("room-time").innerHTML = legend + d.pets.map((p) => {
      const rs = p.stats.roomSec || {}, total = Object.values(rs).reduce((a, b) => a + b, 0) || 1;
      const bar = ROOM_ORDER(d).map((id) => `<div title="${esc(roomName(d, id))} ${Math.round(((rs[id] || 0) / total) * 100)}%" style="width:${((rs[id] || 0) / total) * 100}%;background:${roomColor(d, id)}"></div>`).join("");
      const charge = ROOM_ORDER(d).filter((id) => (p.stats.chargeSec || {})[id]).map((id) => `${esc(roomName(d, id))} ${fmtSim(p.stats.chargeSec[id])}`).join(" · ");
      return `<div class="mb-3"><div class="flex items-center gap-1.5 mb-1"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${p.color}"></span><span class="font-semibold text-sm">${esc(p.name)}</span><span class="text-xs text-mute">${p.stats.crossings || 0} room changes · ${p.stats.doorsOpened || 0} doors opened by itself</span></div>` +
        `<div class="flex h-3 rounded overflow-hidden bg-slate-700/60">${bar}</div>` +
        `<div class="flex flex-wrap gap-x-3 text-xs text-slate-300 mt-1">${ROOM_ORDER(d).map((id) => `<span>${esc(roomName(d, id))} ${Math.round(((rs[id] || 0) / total) * 100)}%</span>`).join("")}</div>` +
        `<div class="text-xs text-mute">${charge ? "Charged in: " + charge : "no charging recorded yet"}</div></div>`;
    }).join("");
    // a strip per pet: one block per sample, coloured by the room it was in
    const n = rows.length;
    if (n < 2) { $("room-strip").innerHTML = '<div class="text-sm text-mute py-4 text-center">Collecting data… a point is recorded every 15 simulated minutes.</div>'; }
    else {
      const W = 340, rowH = 16, gap = 8, L = 46, H = d.pets.length * (rowH + gap) + 16, bw = (W - L - 4) / n;
      let svg = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="Which room each pet was in over time">`;
      d.pets.forEach((p, i) => {
        const y = i * (rowH + gap);
        svg += `<text x="${L - 6}" y="${y + rowH - 4}" text-anchor="end" font-size="10" fill="${p.color}">${esc(p.name)}</text>`;
        rows.forEach((r, k) => {
          const q = r.pets.find((x) => x.id === p.id), room = q && q.room;
          svg += `<rect x="${(L + k * bw).toFixed(1)}" y="${y}" width="${Math.max(0.6, bw + 0.2).toFixed(1)}" height="${rowH}" fill="${room ? roomColor(d, room) : "#2a323b"}"><title>${esc(p.name)} · ${when(r)} · ${room ? esc(roomName(d, room)) : "?"}</title></rect>`;
        });
      });
      svg += `<text x="${L}" y="${H - 3}" font-size="9" fill="${MUTE}">${when(rows[0])}</text><text x="${W - 4}" y="${H - 3}" text-anchor="end" font-size="9" fill="${MUTE}">${when(rows[n - 1])}</text></svg>`;
      $("room-strip").innerHTML = svg;
    }
    const withTemps = rows.filter((r) => r.env && r.env.rooms);
    lineChart($("chart-roomtemp"), {
      title: "Temperature by room", yFmt: (v) => v.toFixed(1) + "°",
      series: [...d.rooms.map((r) => ({ name: r.name, color: roomColor(d, r.id) })), { name: "Outdoor", color: ENV.outdoor }],
      rows: withTemps.map((r) => ({ x: r.simMinute, label: when(r), values: [...d.rooms.map((rm) => r.env.rooms[rm.id] ?? null), r.env.outdoorTemp] })),
    });
  }

  function renderSpeech(d) {
    const c = d.comms;
    $("speech").innerHTML = `<div class="grid grid-cols-2 gap-2 mb-3">${[
      tile("Pet-started", c.petInitiative, "unprompted"), tile("Replies", c.petReplies, "pets answering"),
      tile("Last real hour", c.lastRealHour, "pet utterances"), tile("Last sim day", c.lastSimDay, "pet utterances"),
    ].join("")}</div>` + d.pets.map((p) => {
      const mx = Math.max(1, ...d.pets.map((q) => Math.max(q.stats.spoke, q.stats.heard)));
      const row = (label, v) => `<div class="flex items-center gap-2 text-xs"><span class="w-12 text-slate-300">${label}</span><div class="flex-1 h-2 bg-slate-700/60 rounded"><div class="h-2" style="width:${Math.round((v / mx) * 100)}%;background:${p.color};border-radius:0 4px 4px 0"></div></div><span class="w-8 text-right tabular-nums">${v}</span></div>`;
      return `<div class="mb-2"><div class="flex items-center gap-1.5 mb-0.5"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${p.color}"></span><span class="text-sm font-semibold">${esc(p.name)}</span><span class="text-xs text-mute">${p.stats.s2Thoughts} slow thoughts · ${p.beliefs} beliefs · ${p.claims} claims heard</span></div>${row("spoke", p.stats.spoke)}${row("heard", p.stats.heard)}</div>`;
    }).join("");
  }

  function renderStorage(d) {
    $("storage").innerHTML = d.storage.slice(0, 12).map((f) => `<div class="flex justify-between text-xs py-0.5 border-b border-line"><span class="text-slate-300 truncate">${esc(f.name)}</span><span class="text-mute tabular-nums">${fmtBytes(f.bytes)}</span></div>`).join("") || '<div class="text-xs text-mute">nothing saved yet</div>';
  }

  function renderCharts(d, rows) {
    const label = (r) => when(r);
    lineChart($("chart-battery"), {
      title: "Battery by pet", ticks: [0, 25, 50, 75, 100], yFmt: (v) => Math.round(v) + "%",
      series: d.pets.map((p) => ({ name: p.name, color: p.color })),
      rows: rows.map((r) => ({ x: r.simMinute, label: label(r), values: d.pets.map((p) => r.pets.find((q) => q.id === p.id)?.energy ?? null) })),
    });
    lineChart($("chart-surprise"), {
      title: "Biggest surprise per pet in each 15 minutes", ticks: [0, 0.25, 0.5, 0.75, 1], yFmt: (v) => v.toFixed(2),
      series: d.pets.map((p) => ({ name: p.name, color: p.color })),
      rows: rows.map((r) => ({ x: r.simMinute, label: label(r), values: d.pets.map((p) => r.pets.find((q) => q.id === p.id)?.surprise ?? null) })),
    });
    lineChart($("chart-temp"), {
      title: "Temperature", yFmt: (v) => v.toFixed(1) + "°",
      series: [{ name: "Indoor", color: ENV.indoor }, { name: "Outdoor", color: ENV.outdoor }],
      rows: rows.map((r) => ({ x: r.simMinute, label: label(r), values: [r.env.indoorTemp, r.env.outdoorTemp] })),
    });
    lineChart($("chart-sun"), {
      title: "Sunlight", ticks: [0, 25, 50, 75, 100], yFmt: (v) => Math.round(v) + "%", area: true,
      series: [{ name: "Sunlight", color: ENV.sun }],
      rows: rows.map((r) => ({ x: r.simMinute, label: label(r), values: [r.env.sun * 100] })),
    });
    const needs = $("needs-pet").value || d.pets[0]?.id, np = d.pets.find((p) => p.id === needs);
    if (np) lineChart($("chart-needs"), {
      title: `${np.name}'s needs`, ticks: [0, 25, 50, 75, 100], yFmt: (v) => Math.round(v) + "%",
      series: [{ name: "Curiosity", color: "#c98500" }, { name: "Social", color: "#d55181" }, { name: "Rest", color: "#9085e9" }],
      rows: rows.map((r) => { const q = r.pets.find((x) => x.id === np.id); return { x: r.simMinute, label: label(r), values: q ? [q.curiosity * 100, q.social * 100, q.rest * 100] : [null, null, null] }; }),
    });
  }

  async function loadThoughts() {
    const q = new URLSearchParams({ limit: 40 }); if (thoughtPet) q.set("pet", thoughtPet); if (thoughtSys) q.set("system", thoughtSys);
    const list = await fetch("/api/thoughts?" + q).then((r) => r.json());
    const pets = Object.fromEntries((dash?.pets || []).map((p) => [p.id, p]));
    $("dthoughts").innerHTML = list.map((t) => {
      const p = pets[t.pet] || { name: t.pet, color: "#999" };
      const head = `<span class="text-mute tabular-nums">D${t.day} ${pad(t.hour)}:${pad(t.minute)}:${pad(Math.floor(t.tSec % 60))}</span> <span class="inline-block w-2 h-2 rounded-full" style="background:${p.color}"></span> <b>${esc(p.name)}</b>`;
      if (t.system === 3 && t.stage === "habit") return `<li class="py-1 border-b border-line">${head} <span class="text-teal-300">habit</span> ${esc(t.event.type === "trial_started" ? `trying ${t.event.knob} ${t.event.from} → ${t.event.to}: ${t.event.reason}` : `${t.event.type} ${t.event.knob} ${t.event.from} → ${t.event.to}: ${t.event.why}`)}</li>`;
      if (t.system === 3 && t.stage === "surprise") return `<li class="py-1 border-b border-line">${head} <span class="text-amber-300">surprise</span> ${esc(t.surprise.why)} <span class="text-mute">(${Math.round(t.surprise.score * 100)}%)</span></li>`;
      if (t.system === 3 && (t.stage === "dream" || t.stage === "dream_narration")) return `<li class="py-1 border-b border-line">${head} <span class="text-violet-300">dream</span> <span class="italic">“${esc(t.dream.narrative)}”</span><div class="text-mute">${t.stage === "dream_narration" ? "narrated by " + esc(t.provider || "") + " · " : ""}worry: ${esc(t.dream.worry)}</div></li>`;
      if (t.system === 3) return `<li class="py-1 border-b border-line">${head} <span class="text-sky-400">S3 sleep</span> ${sleepText(t)}</li>`;
      return t.system === 2
        ? `<li class="py-1 border-b border-line">${head} <span class="text-violet-400">S2${t.deep ? " deep" : ""}</span> ${esc(t.thought)}<div class="text-mute">${esc(t.question)} · ${esc(t.provider)}${t.say ? " · wanted to say: " + esc(t.say.meaning) : ""}</div></li>`
        : `<li class="py-1 border-b border-line">${head} <span class="text-accent">S1</span> ${esc(t.action.replace(/_/g, " "))} <span class="text-mute">— ${esc(t.reason)}</span></li>`;
    }).join("") || '<li class="text-mute py-2">no thoughts yet</li>';
  }

  // A night's consolidation (rule-based) or a gist written while asleep (one model call).
  function sleepText(t) {
    if (t.stage === "gist") return (t.gists || []).map((g) => `thinks: “${esc(g.text)}” <span class="text-mute">(${Math.round(g.confidence * 100)}% sure, provisional)</span>`).join("<br>") + `<div class="text-mute">${esc(t.provider || "")}</div>`;
    const s = t.summary || {}, bits = [];
    if (s.merged) bits.push(`merged ${s.merged} repeated moments`);
    if (s.forgotten) bits.push(`forgot ${s.forgotten} faint ones`);
    if (s.claimsSupported) bits.push(`${s.claimsSupported} things it was told were borne out`);
    if (s.beliefsStrengthened) bits.push(`${s.beliefsStrengthened} beliefs strengthened`);
    if (s.beliefsFaded) bits.push(`${s.beliefsFaded} weak beliefs let go`);
    if (s.gistsStrengthened) bits.push(`${s.gistsStrengthened} patterns strengthened`);
    if (s.gistsDropped) bits.push(`${s.gistsDropped} patterns dropped`);
    if (s.claimsContradicted) bits.push(`${s.claimsContradicted} things it was told found WRONG`);
    if (s.beliefsRefuted) bits.push(`${s.beliefsRefuted} beliefs contradicted by experience`);
    if (s.gistsConflicted) bits.push(`${s.gistsConflicted} patterns merged or weakened`);
    return `consolidated its memories (${s.scenesBefore} → ${s.scenesAfter} moments)${bits.length ? ": " + bits.join(", ") : ": nothing needed changing"}`;
  }

  function chips(el, items, current, onPick) {
    el.innerHTML = items.map(([v, label]) => `<button data-v="${v}" class="px-3 py-1.5 rounded-full text-xs ${String(v) === String(current) ? "bg-accent text-emerald-950 font-semibold" : "bg-slate-700"}">${esc(label)}</button>`).join("");
    el.querySelectorAll("button").forEach((b) => (b.onclick = () => onPick(b.dataset.v)));
  }

  async function loadDash() {
    const [d, llm, rows] = await Promise.all([fetch("/api/dashboard").then((r) => r.json()), fetch("/api/llm").then((r) => r.json()), fetch(`/api/metrics?hours=${rangeHours}`).then((r) => r.json())]);
    dash = d;
    const sel = $("needs-pet");
    if (sel.options.length !== d.pets.length) { sel.innerHTML = d.pets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(""); }
    renderKpis(d, llm); renderCharts(d, rows); renderActivity(d); renderRooms(d, rows); renderSpeech(d); renderStorage(d);
    chips($("range"), [[6, "6 h"], [24, "24 h"], [168, "7 days"], [720, "30 days"]], rangeHours, (v) => { rangeHours = Number(v); loadDash(); });
    chips($("tpet"), [["", "All pets"], ...d.pets.map((p) => [p.id, p.name])], thoughtPet, (v) => { thoughtPet = v; loadDash(); });
    chips($("tsys"), [[0, "All"], [1, "S1 fast"], [2, "S2 slow"], [3, "S3 sleep"]], thoughtSys, (v) => { thoughtSys = Number(v); loadDash(); });
    loadThoughts();
  }

  $("needs-pet").onchange = () => loadDash();
  window.dashboardVisible = false;
  window.refreshDashboard = () => { if (window.dashboardVisible) loadDash().catch(console.error); };
  setInterval(() => window.refreshDashboard(), 10000);
  window.refreshDashboard();
})();
