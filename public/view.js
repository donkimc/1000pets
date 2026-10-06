// Wires the 3D view to the page: modes, looking around, the minimap and full screen.
import { createWorld3D } from "/world3d.js";

const $ = (id) => document.getElementById(id);
const app = () => window.__app;
const canvas = $("view3d");
const liveVisible = () => !document.querySelector('[data-tab="live"]').classList.contains("hidden");

let w3;
try {
  w3 = createWorld3D(canvas, { bubbles: () => (app() ? app().bubbles : {}), visible: liveVisible });
} catch (e) {
  $("view-note").textContent = "3D is not available in this browser; the map still works.";
  console.error(e);
}

if (w3) {
  window.world3d = w3;
  const setMode = (m) => {
    w3.setMode(m, $("view-pet").value || undefined);
    document.querySelectorAll("#view-modes button").forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle("bg-accent", on); b.classList.toggle("text-emerald-950", on); b.classList.toggle("bg-slate-700", !on); });
    $("view-pet").style.display = m === "follow" || m === "pet" ? "" : "none";
    $("view-note").textContent = m === "top" ? "Tap the floor to walk there" : "";
  };
  document.querySelectorAll("#view-modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("view-pet").onchange = () => w3.setMode(w3.view.mode, $("view-pet").value);
  setMode("walk");

  // pet picker follows the roster
  setInterval(() => {
    const pets = (app() && app().state && app().state.pets) || [], sel = $("view-pet");
    if (sel.options.length !== pets.length) { sel.innerHTML = pets.map((p) => `<option value="${p.id}">${p.name}</option>`).join(""); w3.setMode(w3.view.mode, sel.value); }
  }, 1000);

  // looking around: drag on the picture
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    if (w3.view.mode === "walk") { w3.look(dx * 0.006, -dy * 0.004); if (window.__sendInput) window.__sendInput(); }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (drag && drag.moved < 6 && w3.view.mode === "top") { const p = w3.floorPoint(e.clientX, e.clientY); if (p && app()) app().walkTo(p); }
    drag = null;
  });

  // the minimap, bigger or smaller; full screen
  $("mm-big").onclick = () => $("minimap").classList.toggle("big");
  $("view-fs").onclick = () => {
    const wrap = $("view3d-wrap"), on = wrap.classList.toggle("fs");
    $("view-fs").textContent = on ? "Close" : "Full screen";
    if (on && wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) { $("view3d-wrap").classList.remove("fs"); $("view-fs").textContent = "Full screen"; } });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { $("view3d-wrap").classList.remove("fs"); $("minimap").classList.remove("big"); $("view-fs").textContent = "Full screen"; } });
}
