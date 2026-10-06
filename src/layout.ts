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
export interface RoomDef { id: string; name: string; x: number; y: number; w: number; h: number; floor: Floor }

/** A door between two rooms, set into the wall along `line` (a fixed x for a vertical wall, a fixed y for a horizontal one), centred at `at`. */
export interface DoorDef { id: string; a: string; b: string; orient: "v" | "h"; line: number; at: number; width: number }

export interface LayoutSpec { id: string; width: number; height: number; rooms: RoomDef[]; doors: DoorDef[]; objects: RoomObject[] }

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
  const solids = spec.objects.filter((o) => SOLID_KINDS.includes(o.kind)).map(shapeOf);
  return { ...spec, walls, doorRects, solids };
}

export function roomAt(layout: Pick<Layout, "rooms">, x: number, y: number): RoomDef | null {
  return layout.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ?? null;
}

/** What stops a body of radius `r` at (x, y), if anything: the edge of the house or a wall, a shut door, or furniture. `shut` lists the doors that are closed. */
export function blockedAt(layout: Layout, x: number, y: number, r: number, shut: ReadonlySet<string> | readonly string[] = []): "wall" | "door" | "object" | null {
  if (x < r || y < r || x > layout.width - r || y > layout.height - r) return "wall";
  for (const w of layout.walls) if (circleHitsRect(x, y, r, w)) return "wall";
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
    { id: "door-living-kitchen", a: "living", b: "kitchen", orient: "v", line: 1000, at: 450, width: 90 },
    { id: "door-living-bedroom", a: "living", b: "bedroom", orient: "h", line: 700, at: 700, width: 90 },
    { id: "door-kitchen-study", a: "kitchen", b: "study", orient: "h", line: 700, at: 1500, width: 90 },
    { id: "door-bedroom-study", a: "bedroom", b: "study", orient: "v", line: 1000, at: 1100, width: 90 },
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

export const LAYOUTS: Record<string, Layout> = { legacy: LEGACY, house: HOUSE };
