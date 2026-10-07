// The 3D view: a blocky, Minecraft-ish picture of the same world the simulation runs in 2D.
// It only draws. Positions come from the server; nothing here changes the simulation except what the
// page sends (movement and where to walk).
//
// World (x, y) maps to three.js (x, up, y), so the map's "down" is three's +z, and a pet's heading h points along (cos h, 0, sin h).
import * as THREE from "/vendor/three/three.module.min.js";

const WALL_H = 150;
const EYE = 88;
const WALL_T = 12;

// ---------- small pixel textures, so surfaces look like blocks without any image files ----------
const texCache = new Map();
function pixelTexture(name, paint, size = 16) {
  if (texCache.has(name)) return texCache.get(name);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  paint(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(name, t);
  return t;
}
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const speckle = (g, s, base, spread) => {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  for (let i = 0; i < s * s * 0.5; i++) { const v = Math.round((rnd() - 0.5) * spread); g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`; g.fillRect((rnd() * s) | 0, (rnd() * s) | 0, 1, 1); }
};
const FLOOR_TEX = {
  wood: () => pixelTexture("wood", (g, s) => { speckle(g, s, "#8a6a47", 40); g.fillStyle = "rgba(0,0,0,0.35)"; for (let y = 0; y < s; y += 4) g.fillRect(0, y, s, 1); for (let y = 0; y < s; y += 4) g.fillRect((y * 5) % s, y, 1, 4); }),
  tile: () => pixelTexture("tile", (g, s) => { speckle(g, s, "#9fb4c4", 24); g.fillStyle = "rgba(20,30,40,0.45)"; g.fillRect(0, 0, s, 1); g.fillRect(0, 0, 1, s); g.fillRect(s / 2, 0, 1, s); g.fillRect(0, s / 2, s, 1); }),
  carpet: () => pixelTexture("carpet", (g, s) => speckle(g, s, "#7b6a9c", 70)),
  stone: () => pixelTexture("stone", (g, s) => { speckle(g, s, "#8b9097", 60); g.fillStyle = "rgba(0,0,0,0.3)"; g.fillRect(0, 0, s, 1); g.fillRect(0, s / 2, s, 1); g.fillRect(3, 0, 1, s / 2); g.fillRect(10, s / 2, 1, s / 2); }),
};
const wallTex = () => pixelTexture("wall", (g, s) => { speckle(g, s, "#e6e0d4", 20); g.fillStyle = "rgba(0,0,0,0.12)"; g.fillRect(0, s - 3, s, 3); });
const woodTex = () => pixelTexture("woodbox", (g, s) => { speckle(g, s, "#8a6140", 50); g.fillStyle = "rgba(0,0,0,0.25)"; for (let y = 0; y < s; y += 3) g.fillRect(0, y, s, 1); });
const booksTex = () => pixelTexture("books", (g, s) => { g.fillStyle = "#5a3d24"; g.fillRect(0, 0, s, s); const cols = ["#b0413e", "#3e6fb0", "#4a9a5c", "#d1a63a", "#8a4ea8", "#d9d9d9"]; for (let row = 0; row < 4; row++) { let x = 0; while (x < s) { const w = 1 + ((rnd() * 2) | 0); g.fillStyle = cols[(rnd() * cols.length) | 0]; g.fillRect(x, row * 4 + 1, w, 3); x += w + (rnd() < 0.2 ? 1 : 0); } g.fillStyle = "#3a2615"; g.fillRect(0, row * 4, s, 1); } });

const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const litTex = (tex, color = 0xffffff, rx = 1, ry = 1) => { const t = tex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry); return new THREE.MeshLambertMaterial({ map: t, color }); };
function box(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y + h / 2, z); return m; }

// ---------- furniture, one little builder per kind ----------
const COLORS = { table: 0x8a6a45, bed: 0x6c7fc0, sofa: 0xb35c78, shelf: 0x6b4a2b, counter: 0xa7b1ba, fridge: 0xe3eaee, desk: 0x95734a, wardrobe: 0x6a5238, heater: 0x6a6f75, plant: 0x4caf50, rug: 0x8a3d3d, charger: 0xe0c341, lamp: 0xd9d9d9, door: 0x8b5e3c };

function buildObject(o, parts) {
  const g = new THREE.Group();
  const cx = o.x + o.w / 2, cz = o.y + o.h / 2;
  const kind = o.kind;
  if (kind === "plant") {
    g.position.set(o.x, 0, o.y);
    g.add(box(o.w * 0.7, 18, o.w * 0.7, lam(0xa0522d)));
    const leaf = lam(0x3f9a45);
    g.add(box(o.w * 0.8, 24, o.w * 0.8, leaf, 0, 18, 0), box(o.w * 0.5, 20, o.w * 0.5, lam(0x56b85e), 3, 40, -2), box(o.w * 0.35, 14, o.w * 0.35, leaf, -6, 52, 4));
    return g;
  }
  if (kind === "lamp") {
    g.position.set(o.x, 0, o.y);
    g.add(box(18, 4, 18, lam(0x444444)), box(4, 74, 4, lam(0x555555), 0, 4, 0));
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(18, 16, 18), new THREE.MeshLambertMaterial({ color: 0xfff1b0, emissive: 0x000000 }));
    bulb.position.set(0, 86, 0); g.add(bulb); parts.lamps.push({ room: o.room, bulb });
    return g;
  }
  g.position.set(cx, 0, cz);
  if (kind === "table") {
    const m = litTex(woodTex(), COLORS.table, 3, 2);
    g.add(box(o.w, 8, o.h, m, 0, 44, 0));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(8, 44, 8, m, sx * (o.w / 2 - 8), 0, sz * (o.h / 2 - 8)));
  } else if (kind === "bed") {
    g.add(box(o.w, 18, o.h, lam(0x7a5a3c)), box(o.w - 6, 14, o.h - 6, lam(0xd8dff2), 0, 18, 0), box(o.w * 0.6, 8, o.h - 10, lam(COLORS.bed), o.w * 0.18, 32, 0), box(26, 10, o.h - 16, lam(0xffffff), -o.w / 2 + 22, 32, 0), box(10, 44, o.h, lam(0x5f4328), -o.w / 2 + 5, 0, 0));
  } else if (kind === "sofa") {
    const m = lam(COLORS.sofa), cushion = lam(0xc87190);
    if (o.h > o.w) g.add(box(o.w, 20, o.h, m), box(14, 38, o.h, m, -o.w / 2 + 7, 20, 0), box(o.w - 16, 10, o.h - 14, cushion, 6, 20, 0), box(o.w - 8, 28, 12, m, 0, 20, -o.h / 2 + 6), box(o.w - 8, 28, 12, m, 0, 20, o.h / 2 - 6));
    else g.add(box(o.w, 20, o.h, m), box(o.w, 38, 14, m, 0, 20, -o.h / 2 + 7), box(o.w - 14, 10, o.h - 16, cushion, 0, 20, 6));
  } else if (kind === "shelf") {
    g.add(box(o.w, 118, o.h, [lam(0x5a3d24), lam(0x5a3d24), lam(0x5a3d24), lam(0x5a3d24), litTex(booksTex(), 0xffffff, Math.max(1, o.w / 40), 2), lam(0x5a3d24)]));
  } else if (kind === "counter") {
    g.add(box(o.w, 56, o.h, lam(0x8a97a2)), box(o.w + 4, 6, o.h + 4, lam(0xd4dbe0), 0, 56, 0));
  } else if (kind === "fridge") {
    g.add(box(o.w, 104, o.h, lam(COLORS.fridge)), box(3, 30, 4, lam(0x889199), -o.w / 2 - 1, 56, 8), box(o.w - 4, 1, o.h - 4, lam(0xb4bec5), 0, 60, 0));
  } else if (kind === "desk") {
    const m = litTex(woodTex(), COLORS.desk, 3, 1);
    g.add(box(o.w, 8, o.h, m, 0, 46, 0), box(8, 46, o.h - 6, m, -o.w / 2 + 6, 0, 0), box(8, 46, o.h - 6, m, o.w / 2 - 6, 0, 0), box(34, 26, 4, lam(0x20252b), 0, 54, -4), box(26, 18, 2, new THREE.MeshLambertMaterial({ color: 0x4aa3df, emissive: 0x153a55 }), 0, 58, -1));
  } else if (kind === "wardrobe") {
    g.add(box(o.w, 128, o.h, lam(COLORS.wardrobe)), box(2, 100, 2, lam(0x2d2118), -4, 14, o.h / 2 + 1), box(2, 100, 2, lam(0x2d2118), 4, 14, o.h / 2 + 1));
  } else if (kind === "heater") {
    const glow = new THREE.MeshLambertMaterial({ color: 0x70757b, emissive: 0x000000 });
    g.add(box(o.w, 26, o.h, glow));
    parts.heaters.push({ room: o.room, mat: glow });
  } else if (kind === "rug") {
    g.add(box(o.w, 2, o.h, lam(0x8a3d3d), 0, 0, 0), box(o.w - 24, 3, o.h - 24, lam(0xc9a64a), 0, 0, 0));
  } else if (kind === "charger") {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 4, 16), new THREE.MeshLambertMaterial({ color: 0xe0c341, emissive: 0x6b5a10 }));
    pad.position.set(0, 2, 0); g.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(22, 1.5, 6, 24), new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.6 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 5; g.add(ring); parts.rings.push(ring);
  } else if (kind === "window") {
    return null; // drawn on the wall by the caller
  } else if (kind === "door") {
    g.add(box(o.w, 108, o.h, lam(COLORS.door)), box(o.w + 6, 8, o.h + 2, lam(0x5a3d24), 0, 108, 0));
  } else {
    g.add(box(o.w, 30, o.h, lam(0x999999)));
  }
  return g;
}

// ---------- characters ----------
function label(text, color = "#ffffff", size = 28) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = `bold ${size}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,0.8)"; g.strokeText(text, 128, 32);
  g.fillStyle = color; g.fillText(text, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(70, 17.5, 1); s.renderOrder = 10;
  return s;
}

function bubbleSprite(text) {
  const c = document.createElement("canvas"); c.width = 512; c.height = 256;
  const g = c.getContext("2d");
  g.font = "bold 30px system-ui, sans-serif";
  const words = text.split(" "), lines = []; let cur = "";
  for (const w of words) { if (g.measureText((cur + " " + w).trim()).width > 440) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 5), h = shown.length * 38 + 28, y0 = 256 - h - 24;
  g.fillStyle = "rgba(255,255,255,0.96)"; g.beginPath(); g.roundRect(16, y0, 480, h, 18); g.fill();
  g.beginPath(); g.moveTo(236, y0 + h); g.lineTo(256, y0 + h + 20); g.lineTo(276, y0 + h); g.fill();
  g.fillStyle = "#101418"; g.textAlign = "left"; shown.forEach((l, i) => g.fillText(l, 32, y0 + 44 + i * 38));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(150, 75, 1); s.center.set(0.5, 0); s.renderOrder = 11;
  return s;
}

function makePet(color) {
  const g = new THREE.Group();
  const body = new THREE.Group(); g.add(body);
  const m = lam(color);
  const dark = lam(0x14181d);
  body.add(box(30, 22, 24, m, 0, 8, 0)); // torso, longest along x (forward)
  const head = box(20, 20, 22, m, 20, 22, 0); body.add(head);
  body.add(box(6, 8, 6, m, 18, 42, -7), box(6, 8, 6, m, 18, 42, 7)); // ears
  body.add(box(2, 5, 5, dark, 30.5, 30, -5), box(2, 5, 5, dark, 30.5, 30, 5), box(2, 3, 4, lam(0xffb3b3), 30.5, 24, 0)); // eyes and nose
  body.add(box(8, 8, 6, m, -17, 20, 0)); // tail
  const legs = [];
  for (const [lx, lz] of [[10, -8], [10, 8], [-10, -8], [-10, 8]]) { const l = box(6, 8, 6, m, lx, 0, lz); body.add(l); legs.push(l); }
  g.userData = { body, legs, head };
  return g;
}

function makePerson(shirt, skin, hat) {
  const g = new THREE.Group();
  const body = new THREE.Group(); g.add(body);
  body.add(box(14, 38, 20, lam(0x34495e), 0, 0, -0), box(16, 36, 26, lam(shirt), 0, 38, 0), box(18, 18, 18, lam(skin), 0, 74, 0), box(5, 5, 5, lam(0x14181d), 9.5, 82, -4), box(5, 5, 5, lam(0x14181d), 9.5, 82, 4));
  if (hat) body.add(box(22, 8, 22, lam(hat), 0, 91, 0), box(14, 8, 14, lam(hat), 0, 99, 0));
  g.userData = { body };
  return g;
}

const angleLerp = (a, b, t) => { let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };

export function createWorld3D(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const camera = new THREE.PerspectiveCamera(75, 1, 4, 5000);
  const root = new THREE.Group(); scene.add(root);

  let layout = null, layoutId = null;
  const roomLights = new Map(); // room id -> PointLight
  let parts = { lamps: [], heaters: [], rings: [], windows: [], doors: new Map(), ceilings: [] };
  const chars = new Map(); // "pet:<id>" | "human" | "teacher" -> { group, cur:{x,y,h}, target:{x,y,h}, ... }
  let st = { pets: [], human: null, teacher: null, env: null, rooms: [], doors: [] };
  const view = { mode: "walk", yaw: 0, pitch: 0, follow: null, haveYaw: false };
  let last = performance.now(), lastRendered = 0;

  function clearRoot() {
    while (root.children.length) { const c = root.children[0]; root.remove(c); c.traverse?.((n) => { n.geometry?.dispose?.(); }); }
    for (const l of roomLights.values()) scene.remove(l);
    roomLights.clear();
    parts = { lamps: [], heaters: [], rings: [], windows: [], doors: new Map(), ceilings: [] };
    chars.clear();
  }

  function setLayout(L) {
    if (!L || layoutId === L.id) return;
    layout = L; layoutId = L.id;
    clearRoot();
    const rooms = L.rooms && L.rooms.length ? L.rooms : [{ id: "main", name: "Room", x: 0, y: 0, w: L.width, h: L.height, floor: "wood" }];
    for (const r of rooms) {
      const tex = (FLOOR_TEX[r.floor] || FLOOR_TEX.wood)();
      const fm = litTex(tex, 0xffffff, r.w / 64, r.h / 64);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), fm); floor.rotation.x = -Math.PI / 2; floor.position.set(r.x + r.w / 2, 0, r.y + r.h / 2); root.add(floor);
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshLambertMaterial({ color: 0xcfc8bd, side: THREE.BackSide }));
      ceil.rotation.x = -Math.PI / 2; ceil.position.set(r.x + r.w / 2, WALL_H, r.y + r.h / 2); root.add(ceil); parts.ceilings.push(ceil);
      const light = new THREE.PointLight(0xffffff, 1, 0, 1.2); light.position.set(r.x + r.w / 2, 120, r.y + r.h / 2); scene.add(light); roomLights.set(r.id, light);
    }
    const wm = litTex(wallTex(), 0xffffff, 8, 2);
    const addWall = (x, y, w, h) => { const m = box(w, WALL_H, h, wm, x + w / 2, 0, y + h / 2); root.add(m); };
    for (const w of L.walls || []) addWall(w.x, w.y, w.w, w.h);
    addWall(-WALL_T, -WALL_T, L.width + 2 * WALL_T, WALL_T); addWall(-WALL_T, L.height, L.width + 2 * WALL_T, WALL_T);
    addWall(-WALL_T, 0, WALL_T, L.height); addWall(L.width, 0, WALL_T, L.height);
    // a lintel over every doorway
    for (const d of L.doors || []) {
      const r = L.doorRects[d.id];
      root.add(box(r.w, WALL_H - 112, r.h, wm, r.x + r.w / 2, 112, r.y + r.h / 2));
      const g = new THREE.Group();
      const len = d.width - 6, thick = 6;
      const hinge = d.orient === "h" ? { x: d.at - d.width / 2 + 3, z: d.line } : { x: d.line, z: d.at - d.width / 2 + 3 };
      g.position.set(hinge.x, 0, hinge.z);
      g.rotation.y = d.orient === "h" ? 0 : -Math.PI / 2;
      const pivot = new THREE.Group(); g.add(pivot);
      pivot.add(box(len, 108, thick, litTex(woodTex(), 0xa9743f, 2, 3), len / 2, 0, 0), box(5, 5, 8, lam(0xd8b84a), len - 8, 52, 0));
      root.add(g);
      parts.doors.set(d.id, { pivot, angle: 0, orient: d.orient });
    }
    for (const o of L.objects) {
      if (o.kind === "window") {
        const glass = new THREE.MeshLambertMaterial({ color: 0x9fd4ff, emissive: 0x000000 });
        const horizontal = o.w >= o.h;
        const m = box(horizontal ? o.w : o.h, 64, 3, glass, 0, 0, 0);
        // place the pane flush against the inside of its wall
        const onTop = o.y < 6, onBottom = o.y > L.height - 20, onLeft = o.x < 6;
        const px = horizontal ? o.x + o.w / 2 : onLeft ? 6 : o.x + o.w - 6;
        const pz = horizontal ? (onTop ? 7 : onBottom ? L.height - 7 : o.y) : o.y + o.h / 2;
        m.position.set(px, 58, pz);
        if (!horizontal) m.rotation.y = Math.PI / 2;
        root.add(m);
        parts.windows.push({ room: o.room || rooms[0].id, glass });
        continue;
      }
      const g = buildObject(o, parts);
      if (g) root.add(g);
    }
    // characters
    st.pets.forEach((p) => ensurePet(p));
  }

  function ensurePet(p) {
    const key = "pet:" + p.id;
    if (chars.has(key)) return chars.get(key);
    const group = makePet(parseInt(p.color.slice(1), 16));
    const name = label(p.name); name.position.set(0, 76, 0); group.add(name);
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(30, 3), new THREE.MeshBasicMaterial({ color: 0x4ade80, depthTest: false })); bar.position.set(0, 62, 0); bar.renderOrder = 10; group.add(bar);
    root.add(group);
    const c = { group, kind: "pet", id: p.id, cur: { x: p.x, y: p.y, h: p.heading }, target: { x: p.x, y: p.y, h: p.heading }, bar, name, bubble: null, bubbleText: "", phase: Math.random() * 6 };
    chars.set(key, c);
    return c;
  }
  function ensureNamed(key, maker, text, color, lift) {
    if (chars.has(key)) return chars.get(key);
    const group = maker(); const name = label(text, color); name.position.set(0, lift, 0); group.add(name); root.add(group);
    const c = { group, kind: key, id: key, cur: { x: 0, y: 0, h: 0 }, target: { x: 0, y: 0, h: 0 }, name, bubble: null, bubbleText: "", phase: 0, fresh: true };
    chars.set(key, c); return c;
  }

  function update(state) {
    if (state.layout) setLayout(state.layout);
    st = { ...st, ...state };
    for (const p of state.pets || []) { const c = ensurePet(p); c.target = { x: p.x, y: p.y, h: p.heading }; c.pet = p; }
    if (state.human) { const c = ensureNamed("human", () => makePerson(0xcfd8ff, 0xf1c9a5), "You", "#ffffff", 118); c.target = { x: state.human.x, y: state.human.y, h: state.human.heading }; if (c.fresh) { c.cur = { ...c.target }; c.fresh = false; } c.moving = state.human.moving; }
    if (state.teacher) { const c = ensureNamed("teacher", () => makePerson(0x1fb5a3, 0xe8bf99, 0x0f6f64), "Teacher", "#99f6e4", 124); c.target = { x: state.teacher.x, y: state.teacher.y, h: state.teacher.heading }; if (c.fresh) { c.cur = { ...c.target }; c.fresh = false; } c.moving = state.teacher.moving; }
  }

  // ---------- lights follow the world: daylight through each room's window, and each room's lamp ----------
  function applyEnvironment(dt) {
    const e = st.env; if (!e || !layout) return;
    const rooms = layout.rooms && layout.rooms.length ? layout.rooms : [{ id: "main" }];
    const renv = (id) => { const r = (st.rooms || []).find((x) => x.id === id); return r || e; };
    const sun = e.sunIntensity ?? 0;
    scene.background.setHex(0x0b1020).lerp(new THREE.Color(0x8fc2ee), Math.min(1, sun));
    for (const r of rooms) {
      const re = renv(r.id);
      const hasWin = parts.windows.some((w) => w.room === r.id);
      const day = hasWin ? sun * (re.curtainOpen ? 1 : 0.2) : 0;
      const lamp = re.lampOn ? 1 : 0;
      const light = roomLights.get(r.id); if (!light) continue;
      light.intensity = 1800 * (0.12 + 0.7 * day + 0.75 * lamp);
      light.color.setRGB(1, 0.95 - 0.06 * lamp + 0.05 * day, 0.85 + 0.15 * day - 0.12 * lamp);
    }
    for (const w of parts.windows) {
      const re = renv(w.room);
      const lit = (re.curtainOpen ? 1 : 0.12) * (0.15 + 0.85 * sun);
      w.glass.emissive.setRGB(0.25 * lit, 0.42 * lit, 0.6 * lit); w.glass.color.setHex(re.curtainOpen ? 0x9fd4ff : 0x4a5563);
    }
    for (const l of parts.lamps) { const on = renv(l.room || "main").lampOn; l.bulb.material.emissive.setHex(on ? 0xffd966 : 0x000000); }
    for (const h of parts.heaters) { const on = renv(h.room || "main").heaterOn; h.mat.emissive.setHex(on ? 0xc2410c : 0x000000); }
    const t = performance.now() / 1000;
    parts.rings.forEach((r, i) => { const f = (t * 0.6 + i * 0.3) % 1; r.scale.setScalar(1 + f * 0.9); r.material.opacity = e.beaconOn === false ? 0 : 0.6 * (1 - f); });
    const doorState = Object.fromEntries((st.doors || []).map((d) => [d.id, d]));
    for (const [id, d] of parts.doors) {
      const target = doorState[id]?.open ? -Math.PI * 0.46 : 0;
      d.angle += (target - d.angle) * Math.min(1, dt * 6);
      d.pivot.rotation.y = d.angle;
    }
  }

  function animateCharacters(dt, t) {
    for (const c of chars.values()) {
      const k = Math.min(1, dt * 7);
      if (Math.hypot(c.target.x - c.cur.x, c.target.y - c.cur.y) > 400) { c.cur.x = c.target.x; c.cur.y = c.target.y; }
      const px = c.cur.x, py = c.cur.y;
      c.cur.x += (c.target.x - c.cur.x) * k; c.cur.y += (c.target.y - c.cur.y) * k;
      c.cur.h = angleLerp(c.cur.h, c.target.h, Math.min(1, dt * 9));
      const speed = Math.hypot(c.cur.x - px, c.cur.y - py) / Math.max(dt, 0.001);
      c.group.position.set(c.cur.x, 0, c.cur.y);
      c.group.rotation.y = -c.cur.h;
      const body = c.group.userData.body;
      const walking = speed > 4;
      if (c.kind === "pet") {
        const p = c.pet || {};
        const asleep = p.mode === "sleeping", dormant = p.mode === "dormant";
        body.position.y = asleep ? -4 : walking ? Math.abs(Math.sin(t * 11 + c.phase)) * 3 : Math.sin(t * 2 + c.phase) * 0.6;
        body.scale.y = asleep ? 0.75 : 1;
        c.group.userData.legs.forEach((l, i) => { l.position.y = walking ? (Math.sin(t * 11 + c.phase + (i % 2) * Math.PI) > 0 ? 3 : 0) : 0; });
        c.group.userData.head.rotation.z = asleep ? -0.5 : 0;
        const e = (p.energy ?? 100) / 100;
        c.bar.scale.x = Math.max(0.02, e); c.bar.position.x = -15 * (1 - e);
        c.bar.material.color.setHex(e > 0.5 ? 0x4ade80 : e > 0.25 ? 0xfbbf24 : 0xef4444);
        body.visible = true;
        c.name.material.opacity = dormant ? 0.5 : 1;
        c.group.visible = !(view.mode === "pet" && c.id === (view.follow || (st.pets[0] && st.pets[0].id))); // seen from its own eyes, it does not see itself
      } else {
        body.position.y = walking ? Math.abs(Math.sin(t * 9)) * 2 : 0;
        c.group.visible = !(c.kind === "human" && view.mode === "walk");
      }
      // speech bubbles, from the page's own record of who said what and until when
      const bubbles = opts.bubbles ? opts.bubbles() : {};
      const bid = c.kind === "pet" ? c.id : c.kind;
      const b = bubbles[bid];
      const text = b && b.until > Date.now() ? b.text : "";
      if (text !== c.bubbleText) {
        if (c.bubble) { c.group.remove(c.bubble); c.bubble.material.map.dispose(); c.bubble.material.dispose(); c.bubble = null; }
        c.bubbleText = text;
        if (text) { c.bubble = bubbleSprite(text); c.bubble.position.set(0, c.kind === "pet" ? 84 : 130, 0); c.group.add(c.bubble); }
      }
    }
  }

  // ---------- cameras ----------
  const tmp = new THREE.Vector3();
  function placeCamera() {
    const h = chars.get("human");
    const hide = view.mode === "walk";
    for (const c of parts.ceilings) c.visible = view.mode !== "top";
    if (view.mode === "top" && layout) {
      const fit = Math.max(layout.width / camera.aspect, layout.height) * 0.62 / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.set(layout.width / 2, fit, layout.height / 2 + 1);
      camera.up.set(0, 0, -1); camera.lookAt(layout.width / 2, 0, layout.height / 2);
      camera.up.set(0, 1, 0);
      return;
    }
    camera.up.set(0, 1, 0);
    if (view.mode === "walk" && h) {
      if (!view.haveYaw) { view.yaw = h.cur.h; view.haveYaw = true; }
      camera.position.set(h.cur.x, EYE, h.cur.y);
      tmp.set(h.cur.x + Math.cos(view.yaw) * 100, EYE + Math.sin(view.pitch) * 100, h.cur.y + Math.sin(view.yaw) * 100);
      camera.lookAt(tmp);
    } else if (view.mode === "portrait") {
      const c = chars.get(view.portrait);
      if (!c) return;
      const tall = c.kind !== "pet" && !c.kind.startsWith("pet");
      const d = tall ? 150 : 85, hy = tall ? 62 : 30;
      // Stand on whichever side has the most open floor (not against a wall), preferring the character's front.
      let bestA = c.cur.h + 0.5, bestScore = -1;
      for (let k = 0; k < 24; k++) {
        const a = c.cur.h + 0.5 + (k / 24) * 2 * Math.PI;
        let free = 0;
        for (let r = 20; r <= d + 40; r += 10) {
          const x = c.cur.x + Math.cos(a) * r, y = c.cur.y + Math.sin(a) * r;
          const hit = !layout || x < 10 || y < 10 || x > layout.width - 10 || y > layout.height - 10 || [...(layout.walls || []), ...Object.values(layout.doorRects || {})].some((w) => x > w.x - 12 && x < w.x + w.w + 12 && y > w.y - 12 && y < w.y + w.h + 12) || (layout.solids || []).some((s) => (s.type === "circle" ? Math.hypot(x - s.cx, y - s.cy) < s.r + 14 : x > s.x - 14 && x < s.x + s.w + 14 && y > s.y - 14 && y < s.y + s.h + 14));
          if (hit) break; free = r;
        }
        const facing = Math.cos(a - c.cur.h) * 20; // a little weight toward the front
        if (free + facing > bestScore) { bestScore = free + facing; bestA = a; }
      }
      camera.position.set(c.cur.x + Math.cos(bestA) * d, hy + 8, c.cur.y + Math.sin(bestA) * d);
      camera.lookAt(c.cur.x, hy, c.cur.y);
    } else if (view.mode === "follow" || view.mode === "pet") {
      const c = chars.get("pet:" + (view.follow || (st.pets[0] && st.pets[0].id)));
      if (!c) return;
      if (view.mode === "pet") {
        camera.position.set(c.cur.x + Math.cos(c.cur.h) * 22, 30, c.cur.y + Math.sin(c.cur.h) * 22);
        tmp.set(c.cur.x + Math.cos(c.cur.h) * 200, 24, c.cur.y + Math.sin(c.cur.h) * 200);
        camera.lookAt(tmp);
      } else {
        camera.position.set(c.cur.x - Math.cos(c.cur.h) * 130, 95, c.cur.y - Math.sin(c.cur.h) * 130);
        tmp.set(c.cur.x, 28, c.cur.y);
        camera.lookAt(tmp);
      }
    }
    void hide;
  }

  function resize() {
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.fov = view.mode === "pet" ? 90 : view.mode === "top" ? 50 : 75; camera.updateProjectionMatrix();
  }

  let running = true;
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (opts.visible && !opts.visible()) return;
    if (opts.maxFps && now - lastRendered < 1000 / opts.maxFps) return; // (a slow machine, or taking pictures: draw less often)
    lastRendered = now;
    resize();
    applyEnvironment(dt);
    animateCharacters(dt, now / 1000);
    placeCamera();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  /** World point under a screen position, on the floor (for tapping to walk in the overview). */
  function floorPoint(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) ? { x: hit.x, y: hit.z } : null;
  }

  return {
    update, setLayout, floorPoint, view,
    /** A close-up of one character, from the front (for pictures of the cast). Returns false if there is no such character. */
    portrait(key) {
      const c = chars.get(key);
      if (!c) return false;
      view.mode = "portrait"; view.portrait = key;
      return true;
    },
    setMode(m, petId) { view.mode = m; if (petId) view.follow = petId; if (m === "walk") view.haveYaw = false; },
    look(dyaw, dpitch) { view.yaw += dyaw; view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + dpitch)); view.haveYaw = true; },
    get yaw() { return view.yaw; },
    dispose() { running = false; renderer.dispose(); },
    renderer, scene, camera,
  };
}
