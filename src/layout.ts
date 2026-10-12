// The floor plan: rooms, the doors between them, and what stands in each. Everything about the shape of the
// world lives here as data, so the simulation, sensors, Teacher and the browser all read the same plan.
//
// Rooms are rectangles that tile the house. A wall runs along every edge two rooms share, thickened and
// interrupted by a door gap wherever a door is. The outer boundary is not a wall object: it is the edge of the
// walkable area (pets are kept inside it), and an exterior door is just an object flush with it.

export type ObjectKind =
  | "window" | "door" | "plant" | "table" | "bed" | "charger" | "heater" | "lamp"
  | "sofa" | "shelf" | "counter" | "fridge" | "desk" | "wardrobe" | "rug";

export interface RoomObject { id: string; kind: ObjectKind; x: number; y: number; w: number; h: number; room?: string; pitch?: number }

export type Shape =
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "rect"; x: number; y: number; w: number; h: number };

export interface Rect { x: number; y: number; w: number; h: number }

export type Floor = "wood" | "tile" | "carpet" | "stone";
export interface RoomDef { id: string; name: string; x: number; y: number; w: number; h: number; floor: Floor; puzzle?: boolean } // puzzle: a maze room, with no charger, that pets must find their own way out of

/** A door between two rooms, set into the wall along `line` (a fixed x for a vertical wall, a fixed y for a horizontal one), centred at `at`. */
export interface DoorDef {
  id: string; a: string; b: string; orient: "v" | "h"; line: number; at: number; width: number;
  oneWay?: { from: string }; // pets can only open it from this room: once through, they cannot open it again from the other side (a person or the Teacher can)
  emergency?: boolean; // starts locked; only the Teacher opens it, to let a trapped pet out
}

export interface LayoutSpec { id: string; width: number; height: number; rooms: RoomDef[]; doors: DoorDef[]; objects: RoomObject[]; extraWalls?: Rect[] } // extraWalls: walls inside rooms, such as a maze

export interface Layout extends LayoutSpec {
  walls: Rect[]; // interior walls, with a gap at every door
  doorRects: Record<string, Rect>; // the opening of each door: solid while it is shut
  solids: Shape[]; // furniture a pet cannot walk through
}

export const WALL_T = 12; // wall thickness

/** Plant and lamp are drawn as circles centred on (x, y); everything else is a rectangle with (x, y) as its corner. */
export function shapeOf(o: RoomObject): Shape {
  return o.kind === "plant" || o.kind === "lamp"
    ? { type: "circle", cx: o.x, cy: o.y, r: o.w / 2 }
    : { type: "rect", x: o.x, y: o.y, w: o.w, h: o.h };
}

export function centerOf(o: RoomObject): { x: number; y: number } {
  const s = shapeOf(o);
  return s.type === "circle" ? { x: s.cx, y: s.cy } : { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** Objects a pet cannot walk through. The window, exterior door, charger pad and rug are flush with walls or the floor. */
const SOLID_KINDS: readonly ObjectKind[] = ["plant", "table", "bed", "heater", "lamp", "sofa", "shelf", "counter", "fridge", "desk", "wardrobe"];

export function circleHitsShape(x: number, y: number, r: number, s: Shape): boolean {
  if (s.type === "circle") return Math.hypot(x - s.cx, y - s.cy) < r + s.r;
  const nx = Math.max(s.x, Math.min(x, s.x + s.w));
  const ny = Math.max(s.y, Math.min(y, s.y + s.h));
  return Math.hypot(x - nx, y - ny) < r;
}

export function pointInShape(x: number, y: number, s: Shape): boolean {
  return s.type === "circle"
    ? Math.hypot(x - s.cx, y - s.cy) < s.r
    : x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function circleHitsRect(x: number, y: number, r: number, k: Rect): boolean {
  return circleHitsShape(x, y, r, { type: "rect", ...k });
}

type Interval = [number, number];
function union(list: Interval[]): Interval[] {
  const s = [...list].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 0.001) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Computes the walls (with door gaps) and furniture shapes from a plan. */
export function buildLayout(spec: LayoutSpec): Layout {
  const { width, height } = spec;
  const vertical = new Map<number, Interval[]>(); // x -> spans of y that are an interior edge
  const horizontal = new Map<number, Interval[]>();
  const add = (m: Map<number, Interval[]>, line: number, a: number, b: number) => { (m.get(line) ?? m.set(line, []).get(line)!).push([a, b]); };
  for (const r of spec.rooms) {
    for (const x of [r.x, r.x + r.w]) if (x > 0 && x < width) add(vertical, x, r.y, r.y + r.h);
    for (const y of [r.y, r.y + r.h]) if (y > 0 && y < height) add(horizontal, y, r.x, r.x + r.w);
  }
  const walls: Rect[] = [];
  const doorRects: Record<string, Rect> = {};
  const cut = (orient: "v" | "h", line: number, spans: Interval[]) => {
    const gaps = spec.doors.filter((d) => d.orient === orient && d.line === line).map((d): Interval => [d.at - d.width / 2, d.at + d.width / 2]);
    for (const [a, b] of union(spans)) {
      let from = a;
      for (const [g0, g1] of gaps.filter(([g0, g1]) => g1 > a && g0 < b).sort((p, q) => p[0] - q[0])) {
        if (g0 > from) walls.push(orient === "v" ? { x: line - WALL_T / 2, y: from, w: WALL_T, h: g0 - from } : { x: from, y: line - WALL_T / 2, w: g0 - from, h: WALL_T });
        from = Math.max(from, g1);
      }
      if (b > from) walls.push(orient === "v" ? { x: line - WALL_T / 2, y: from, w: WALL_T, h: b - from } : { x: from, y: line - WALL_T / 2, w: b - from, h: WALL_T });
    }
  };
  for (const [line, spans] of vertical) cut("v", line, spans);
  for (const [line, spans] of horizontal) cut("h", line, spans);
  for (const d of spec.doors) {
    doorRects[d.id] = d.orient === "v"
      ? { x: d.line - WALL_T / 2, y: d.at - d.width / 2, w: WALL_T, h: d.width }
      : { x: d.at - d.width / 2, y: d.line - WALL_T / 2, w: d.width, h: WALL_T };
  }
  walls.push(...(spec.extraWalls ?? []).map((w) => ({ ...w })));
  const solids = spec.objects.filter((o) => SOLID_KINDS.includes(o.kind)).map(shapeOf);
  return { ...spec, walls, doorRects, solids };
}

export function roomAt(layout: Pick<Layout, "rooms">, x: number, y: number): RoomDef | null {
  return layout.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ?? null;
}

// ---- finding walls quickly: a maze has hundreds of them, and sight, sound and movement ask about walls many times a tick ----
const CELL = 100;
class WallIndex {
  private buckets = new Map<number, number[]>();
  constructor(private walls: readonly Rect[]) {
    walls.forEach((w, i) => {
      for (let cx = Math.floor(w.x / CELL); cx <= Math.floor((w.x + w.w) / CELL); cx++) for (let cy = Math.floor(w.y / CELL); cy <= Math.floor((w.y + w.h) / CELL); cy++) {
        const k = (cx + 64) * 4096 + (cy + 64);
        (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!).push(i);
      }
    });
  }
  /** The walls that could be within `r` of this point. */
  near(x: number, y: number, r: number): Rect[] {
    const out: Rect[] = [], seen = new Set<number>();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
      for (const i of this.buckets.get((cx + 64) * 4096 + (cy + 64)) ?? []) if (!seen.has(i)) { seen.add(i); out.push(this.walls[i]); }
    }
    return out;
  }
}
const indexes = new WeakMap<readonly Rect[], WallIndex>();
const indexOf = (layout: Pick<Layout, "walls">) => { let i = indexes.get(layout.walls); if (!i) indexes.set(layout.walls, (i = new WallIndex(layout.walls))); return i; };

/** The walls within `r` of a point (a short list, whatever the size of the house). */
export const wallsNear = (layout: Pick<Layout, "walls">, x: number, y: number, r: number): Rect[] => indexOf(layout).near(x, y, r);
/** Is this point inside a wall? */
export const wallAt = (layout: Pick<Layout, "walls">, x: number, y: number): boolean => indexOf(layout).near(x, y, 0).some((w) => pointInRect(x, y, w));

/** What stops a body of radius `r` at (x, y), if anything: the edge of the house or a wall, a shut door, or furniture. `shut` lists the doors that are closed. */
export function blockedAt(layout: Layout, x: number, y: number, r: number, shut: ReadonlySet<string> | readonly string[] = []): "wall" | "door" | "object" | null {
  if (x < r || y < r || x > layout.width - r || y > layout.height - r) return "wall";
  for (const w of wallsNear(layout, x, y, r)) if (circleHitsRect(x, y, r, w)) return "wall";
  for (const id of shut) { const d = layout.doorRects[id]; if (d && circleHitsRect(x, y, r, d)) return "door"; }
  for (const s of layout.solids) if (circleHitsShape(x, y, r, s)) return "object";
  return null;
}

export const chargersOf = (layout: Pick<Layout, "objects">): RoomObject[] => layout.objects.filter((o) => o.kind === "charger");
export const objectById = (layout: Pick<Layout, "objects">, id: string): RoomObject | undefined => layout.objects.find((o) => o.id === id);

// ---- the single room the simulation began with: kept exactly, so older saves and tests still make sense ----
export const LEGACY: Layout = buildLayout({
  id: "legacy",
  width: 1000,
  height: 700,
  rooms: [{ id: "main", name: "Room", x: 0, y: 0, w: 1000, h: 700, floor: "wood" }],
  doors: [],
  objects: [
    { id: "window", kind: "window", x: 650, y: 0, w: 200, h: 12 },
    { id: "door", kind: "door", x: 880, y: 688, w: 80, h: 12 },
    { id: "plant", kind: "plant", x: 500, y: 200, w: 40, h: 40 },
    { id: "table", kind: "table", x: 400, y: 350, w: 140, h: 80 },
    { id: "bed", kind: "bed", x: 60, y: 500, w: 160, h: 120 },
    { id: "charger", kind: "charger", x: 900, y: 70, w: 40, h: 40 },
    { id: "heater", kind: "heater", x: 40, y: 60, w: 70, h: 24 },
    { id: "lamp", kind: "lamp", x: 300, y: 150, w: 30, h: 30 },
  ].map((o) => ({ ...o, room: "main" })) as RoomObject[],
});

// ---- the house: four rooms of 1000 x 700, each with its own charger, window, heater and lamp, joined by four doors ----
// Living room is the original room (same coordinates), so what the pets learned there still holds.
const o = (room: string, id: string, kind: ObjectKind, x: number, y: number, w: number, h: number, extra: Partial<RoomObject> = {}): RoomObject => ({ id, kind, x, y, w, h, room, ...extra });

export const HOUSE: Layout = buildLayout({
  id: "house",
  width: 2000,
  height: 1400,
  rooms: [
    { id: "living", name: "Living room", x: 0, y: 0, w: 1000, h: 700, floor: "wood" },
    { id: "kitchen", name: "Kitchen", x: 1000, y: 0, w: 1000, h: 700, floor: "tile" },
    { id: "bedroom", name: "Bedroom", x: 0, y: 700, w: 1000, h: 700, floor: "carpet" },
    { id: "study", name: "Study", x: 1000, y: 700, w: 1000, h: 700, floor: "stone" },
  ],
  doors: [
    { id: "door-living-kitchen", a: "living", b: "kitchen", orient: "v", line: 1000, at: 450, width: 120 },
    { id: "door-living-bedroom", a: "living", b: "bedroom", orient: "h", line: 700, at: 700, width: 120 },
    { id: "door-kitchen-study", a: "kitchen", b: "study", orient: "h", line: 700, at: 1500, width: 120 },
    { id: "door-bedroom-study", a: "bedroom", b: "study", orient: "v", line: 1000, at: 1100, width: 120 },
  ],
  objects: [
    // living room: the original room, with its outside door replaced by a door to the bedroom
    o("living", "window", "window", 650, 0, 200, 12),
    o("living", "plant", "plant", 500, 200, 40, 40),
    o("living", "table", "table", 400, 350, 140, 80),
    o("living", "sofa", "sofa", 80, 300, 70, 190),
    o("living", "charger", "charger", 900, 70, 40, 40, { pitch: 534 }),
    o("living", "heater", "heater", 40, 60, 70, 24),
    o("living", "lamp", "lamp", 300, 150, 30, 30),
    // kitchen
    o("kitchen", "window-kitchen", "window", 1300, 0, 200, 12),
    o("kitchen", "counter", "counter", 1640, 30, 300, 60),
    o("kitchen", "fridge", "fridge", 1930, 150, 50, 80),
    o("kitchen", "table-kitchen", "table", 1300, 300, 160, 100),
    o("kitchen", "plant-kitchen", "plant", 1100, 580, 40, 40),
    o("kitchen", "charger-kitchen", "charger", 1100, 90, 40, 40, { pitch: 449 }),
    o("kitchen", "heater-kitchen", "heater", 1900, 400, 24, 80),
    o("kitchen", "lamp-kitchen", "lamp", 1560, 200, 30, 30),
    o("kitchen", "door-front", "door", 1988, 560, 12, 80),
    // bedroom
    o("bedroom", "window-bedroom", "window", 200, 1388, 200, 12),
    o("bedroom", "bed-bedroom", "bed", 60, 1180, 160, 120),
    o("bedroom", "wardrobe", "wardrobe", 700, 1290, 200, 90),
    o("bedroom", "plant-bedroom", "plant", 900, 900, 40, 40),
    o("bedroom", "charger-bedroom", "charger", 800, 780, 40, 40, { pitch: 337 }),
    o("bedroom", "heater-bedroom", "heater", 40, 780, 70, 24),
    o("bedroom", "lamp-bedroom", "lamp", 500, 1000, 30, 30),
    o("bedroom", "rug-bedroom", "rug", 280, 920, 300, 200),
    // study
    o("study", "window-study", "window", 1700, 1388, 200, 12),
    o("study", "shelf", "shelf", 1040, 740, 300, 50),
    o("study", "desk", "desk", 1600, 1150, 200, 90),
    o("study", "plant-study", "plant", 1100, 1250, 40, 40),
    o("study", "charger-study", "charger", 1860, 1260, 40, 40, { pitch: 635 }),
    o("study", "heater-study", "heater", 1920, 900, 24, 80),
    o("study", "lamp-study", "lamp", 1300, 1000, 30, 30),
    o("study", "rug-study", "rug", 1300, 1060, 260, 160),
  ],
});

// ---- mazes: a room whose floor is a set of corridors, and a way out that must be found ----
export type Side = "top" | "bottom" | "left" | "right";
export interface MazeSpec {
  x: number; y: number; cols: number; rows: number; cell?: number; // the area it fills, in cells of `cell` units (100: a corridor is a cell wide, less the wall)
  seed: number; minRoute?: number; // a perfect maze (one way between any two cells); reseeded until the way through is at least minRoute cells
  entrance: { side: Side; index: number }; exit: { side: Side; index: number }; // which cell along a side of the area
}
export interface Maze { walls: Rect[]; cols: number; rows: number; cell: number; entrance: number; exit: number; route: number[]; passages: [number, number][] }

/** Where a door sits on the edge of the maze area for a given cell along that side. */
export function mazeDoor(spec: Pick<MazeSpec, "x" | "y" | "cols" | "rows" | "cell">, at: { side: Side; index: number }): { orient: "v" | "h"; line: number; at: number } {
  const cell = spec.cell ?? 100;
  if (at.side === "top") return { orient: "h", line: spec.y, at: spec.x + at.index * cell + cell / 2 };
  if (at.side === "bottom") return { orient: "h", line: spec.y + spec.rows * cell, at: spec.x + at.index * cell + cell / 2 };
  if (at.side === "left") return { orient: "v", line: spec.x, at: spec.y + at.index * cell + cell / 2 };
  return { orient: "v", line: spec.x + spec.cols * cell, at: spec.y + at.index * cell + cell / 2 };
}
const cellAt = (spec: Pick<MazeSpec, "cols" | "rows">, a: { side: Side; index: number }) => (a.side === "top" ? a.index : a.side === "bottom" ? (spec.rows - 1) * spec.cols + a.index : a.side === "left" ? a.index * spec.cols : a.index * spec.cols + spec.cols - 1);

export function makeMaze(spec: MazeSpec): Maze {
  const cell = spec.cell ?? 100, { cols, rows } = spec;
  const entrance = cellAt(spec, spec.entrance), exit = cellAt(spec, spec.exit);
  for (let attempt = 0; attempt < 400; attempt++) {
    let s = (spec.seed + attempt * 7919) * 2654435761 % 2147483647 || 1;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const seen = new Set<number>([0]), stack = [0], passages: [number, number][] = [];
    while (stack.length) {
      const u = stack[stack.length - 1], c = u % cols, r = Math.floor(u / cols);
      const next = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]].filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows && !seen.has(y * cols + x));
      if (!next.length) { stack.pop(); continue; }
      const [x, y] = next[Math.floor(rnd() * next.length)], v = y * cols + x;
      seen.add(v); stack.push(v); passages.push(u < v ? [u, v] : [v, u]);
    }
    const open = new Set(passages.map(([a, b]) => `${a}-${b}`));
    // the way through: the one route from the entrance cell to the exit cell
    const adj = new Map<number, number[]>();
    for (const [a, b] of passages) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
    const prev = new Map<number, number>([[entrance, -1]]), q = [entrance];
    while (q.length) { const u = q.shift()!; for (const v of adj.get(u) ?? []) if (!prev.has(v)) { prev.set(v, u); q.push(v); } }
    const route: number[] = [];
    for (let u = exit; u !== -1; u = prev.get(u)!) route.unshift(u);
    if (route.length < (spec.minRoute ?? 0) && attempt < 399) continue;
    const walls: Rect[] = [], T = WALL_T;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const u = r * cols + c;
      if (c + 1 < cols && !open.has(`${u}-${u + 1}`)) walls.push({ x: spec.x + (c + 1) * cell - T / 2, y: spec.y + r * cell - T / 2, w: T, h: cell + T });
      if (r + 1 < rows && !open.has(`${u}-${u + cols}`)) walls.push({ x: spec.x + c * cell - T / 2, y: spec.y + (r + 1) * cell - T / 2, w: cell + T, h: T });
    }
    return { walls, cols, rows, cell, entrance, exit, route, passages };
  }
  throw new Error("no maze");
}

// ---- the puzzle house: the same house, but the bedroom and the study are mazes ----
// Pets come in from the living room through a one-way door at the top of the bedroom maze, find the way to its far corner,
// pass through a second one-way door into the study maze, and find their way out of that into the kitchen. There is no charger in
// either maze. Each maze also has a locked emergency door: only the Teacher opens it, to let a trapped pet out.
const MAZE_DOOR = 88; // the width of a corridor opening
const bedroomArea = { x: 0, y: 700, cols: 10, rows: 7, cell: 100 }, studyArea = { x: 1000, y: 700, cols: 10, rows: 7, cell: 100 };
export const BEDROOM_MAZE = makeMaze({ ...bedroomArea, seed: 11, minRoute: 30, entrance: { side: "top", index: 0 }, exit: { side: "right", index: 6 } });
export const STUDY_MAZE = makeMaze({ ...studyArea, seed: 12, minRoute: 30, entrance: { side: "left", index: 6 }, exit: { side: "top", index: 9 } });
const mazeOnly = (o: RoomObject, rooms: string[]) => !rooms.includes(o.room ?? "") || o.kind === "window";

export const PUZZLE: Layout = buildLayout({
  id: "puzzle",
  width: HOUSE.width,
  height: HOUSE.height,
  rooms: HOUSE.rooms.map((r) => (r.id === "bedroom" || r.id === "study" ? { ...r, puzzle: true } : r)),
  doors: [
    HOUSE.doors.find((d) => d.id === "door-living-kitchen")!,
    { id: "door-living-bedroom", a: "living", b: "bedroom", ...mazeDoor(bedroomArea, { side: "top", index: 0 }), width: MAZE_DOOR, oneWay: { from: "living" } }, // in, and no way back
    { id: "door-bedroom-study", a: "bedroom", b: "study", ...mazeDoor(bedroomArea, { side: "right", index: 6 }), width: MAZE_DOOR, oneWay: { from: "bedroom" } },
    { id: "door-kitchen-study", a: "kitchen", b: "study", ...mazeDoor(studyArea, { side: "top", index: 9 }), width: MAZE_DOOR, oneWay: { from: "study" } }, // out, and no way in
    { id: "door-bedroom-emergency", a: "bedroom", b: "living", ...mazeDoor(bedroomArea, { side: "top", index: 3 }), width: MAZE_DOOR, oneWay: { from: "bedroom" }, emergency: true },
    { id: "door-study-emergency", a: "study", b: "kitchen", ...mazeDoor(studyArea, { side: "top", index: 4 }), width: MAZE_DOOR, oneWay: { from: "study" }, emergency: true },
  ],
  objects: HOUSE.objects.filter((o) => mazeOnly(o, ["bedroom", "study"])),
  extraWalls: [...BEDROOM_MAZE.walls, ...STUDY_MAZE.walls],
});

// ---- the house plus two maze rooms along its south side ----
// The four rooms stay as they are. A pet can walk from the bedroom into the cellar, through that maze into the
// vault, and out into the study. Both doors in are one-way, and each maze has a locked emergency door back upstairs.
const cellarArea = { x: 0, y: 1400, cols: 10, rows: 7, cell: 100 }, vaultArea = { x: 1000, y: 1400, cols: 10, rows: 7, cell: 100 };
export const CELLAR_MAZE = makeMaze({ ...cellarArea, seed: 21, minRoute: 30, entrance: { side: "top", index: 1 }, exit: { side: "right", index: 6 } });
export const VAULT_MAZE = makeMaze({ ...vaultArea, seed: 22, minRoute: 30, entrance: { side: "left", index: 6 }, exit: { side: "top", index: 8 } });

export const ANNEX: Layout = buildLayout({
  id: "annex",
  width: HOUSE.width,
  height: HOUSE.height + 700,
  rooms: [
    ...HOUSE.rooms,
    { id: "cellar", name: "Cellar", x: 0, y: 1400, w: 1000, h: 700, floor: "stone", puzzle: true },
    { id: "vault", name: "Vault", x: 1000, y: 1400, w: 1000, h: 700, floor: "tile", puzzle: true },
  ],
  doors: [
    ...HOUSE.doors,
    { id: "door-bedroom-cellar", a: "bedroom", b: "cellar", ...mazeDoor(cellarArea, { side: "top", index: 1 }), width: MAZE_DOOR, oneWay: { from: "bedroom" } },
    { id: "door-cellar-vault", a: "cellar", b: "vault", ...mazeDoor(cellarArea, { side: "right", index: 6 }), width: MAZE_DOOR, oneWay: { from: "cellar" } },
    { id: "door-vault-study", a: "vault", b: "study", ...mazeDoor(vaultArea, { side: "top", index: 8 }), width: MAZE_DOOR, oneWay: { from: "vault" } },
    { id: "door-cellar-emergency", a: "cellar", b: "bedroom", ...mazeDoor(cellarArea, { side: "top", index: 5 }), width: MAZE_DOOR, oneWay: { from: "cellar" }, emergency: true },
    { id: "door-vault-emergency", a: "vault", b: "study", ...mazeDoor(vaultArea, { side: "top", index: 3 }), width: MAZE_DOOR, oneWay: { from: "vault" }, emergency: true },
  ],
  objects: [
    ...HOUSE.objects,
    o("cellar", "window-cellar", "window", 200, 2088, 200, 12),
    o("vault", "window-vault", "window", 1500, 2088, 200, 12),
  ],
  extraWalls: [...CELLAR_MAZE.walls, ...VAULT_MAZE.walls],
});

export const LAYOUTS: Record<string, Layout> = { legacy: LEGACY, house: HOUSE, puzzle: PUZZLE, annex: ANNEX };
