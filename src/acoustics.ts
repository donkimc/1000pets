// How sight and sound get around walls. A wall stops sight; a wall or shut door muffles sound a lot but not entirely;
// and sound finds its way through an open doorway, so a pet that hears a charger in the next room hears it coming
// from the door. These are physical facts about the world, used by the sensors: a pet only ever receives the result.
import { blockedAt, centerOf, chargersOf, pointInRect, type Layout, type RoomObject } from "./layout.js";

export interface Pt { x: number; y: number }
export const WALL_MUFFLE = 0.35; // loudness left after sound passes through one wall or shut door
const CELL = 20;
const SHUT_DETOUR = 300; // a shut door adds this much to how far a sound seems to have come

/** How many separate walls or shut doors lie between two points. 0 means a clear line. */
export function crossings(layout: Layout, a: Pt, b: Pt, shut: readonly string[] = []): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / 6));
  const rects = [...layout.walls, ...shut.map((id) => layout.doorRects[id]).filter(Boolean)];
  if (!rects.length) return 0;
  let count = 0, inside = false;
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n, y = a.y + ((b.y - a.y) * i) / n;
    const now = rects.some((r) => pointInRect(x, y, r));
    if (now && !inside) count++;
    inside = now;
  }
  return count;
}

type Field = Float64Array;

export class Acoustics {
  private cols: number;
  private rows: number;
  private open = new Map<string, Field>();
  private shutFields = new Map<string, Field>();

  constructor(private layout: Layout) {
    this.cols = Math.ceil(layout.width / CELL);
    this.rows = Math.ceil(layout.height / CELL);
  }

  /** Walking distance from a source to every cell, going round walls; Infinity where there is no way. */
  private field(src: Pt, shut: readonly string[]): Field {
    const { cols, rows, layout } = this;
    const dist = new Float64Array(cols * rows).fill(Infinity);
    const passable = (c: number, r: number) => !blockedAt(layout, c * CELL + CELL / 2, r * CELL + CELL / 2, 6, shut);
    const sc = Math.min(cols - 1, Math.max(0, Math.floor(src.x / CELL))), sr = Math.min(rows - 1, Math.max(0, Math.floor(src.y / CELL)));
    // Dijkstra with a simple bucket queue (all edge costs are 1 or 1.414 cells).
    const heap: { k: number; d: number }[] = [{ k: sr * cols + sc, d: 0 }];
    dist[sr * cols + sc] = 0;
    const push = (k: number, d: number) => { heap.push({ k, d }); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].d <= heap[i].d) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].d < heap[m].d) m = l; if (r < heap.length && heap[r].d < heap[m].d) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const pass = new Map<number, boolean>();
    const ok = (c: number, r: number) => { const k = r * cols + c; let v = pass.get(k); if (v === undefined) { v = passable(c, r); pass.set(k, v); } return v; };
    while (heap.length) {
      const { k, d } = pop();
      if (d > dist[k]) continue;
      const c = k % cols, r = Math.floor(k / cols);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        if (!ok(nc, nr) && !(nc === sc && nr === sr)) continue;
        if (dc && dr && (!ok(c + dc, r) || !ok(c, r + dr))) continue;
        const nd = d + (dc && dr ? 1.414 : 1) * CELL;
        const nk = nr * cols + nc;
        if (nd < dist[nk]) { dist[nk] = nd; push(nk, nd); }
      }
    }
    return dist;
  }

  private fieldFor(src: RoomObject, shut: readonly string[]): Field {
    const c = centerOf(src);
    if (!shut.length) {
      let f = this.open.get(src.id);
      if (!f) { f = this.field(c, []); this.open.set(src.id, f); }
      return f;
    }
    const key = `${src.id}|${[...shut].sort().join(",")}`;
    let f = this.shutFields.get(key);
    if (!f) {
      if (this.shutFields.size > 64) this.shutFields.clear();
      f = this.field(c, shut);
      this.shutFields.set(key, f);
    }
    return f;
  }

  private at(f: Field, p: Pt): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / CELL))), r = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / CELL)));
    return f[r * this.cols + c];
  }

  /** The direction (world angle) a sound from `src` seems to come from at p: straight at it if the line is clear, else along the way round. */
  directionTo(src: RoomObject, p: Pt, shut: readonly string[] = []): number {
    const c = centerOf(src);
    if (crossings(this.layout, p, c) === 0) return Math.atan2(c.y - p.y, c.x - p.x);
    const f = this.fieldFor(src, []);
    let best = Infinity, bx = c.x, by = c.y;
    for (let k = 0; k < 16; k++) { // the open cell within a short step that is nearest the source by the way round
      const a = (k / 16) * 2 * Math.PI;
      for (const step of [50, 90]) {
        const q = { x: p.x + Math.cos(a) * step, y: p.y + Math.sin(a) * step };
        if (q.x < 0 || q.y < 0 || q.x >= this.layout.width || q.y >= this.layout.height) continue;
        const v = this.at(f, q);
        if (v < best) { best = v; bx = q.x; by = q.y; }
      }
    }
    void shut;
    return Math.atan2(by - p.y, bx - p.x);
  }

  /** How far a sound from `src` seems to have come, going round walls; a shut door on the way adds to it. Infinity if it cannot reach. */
  pathDistance(src: RoomObject, p: Pt, shut: readonly string[] = []): number {
    const c = centerOf(src);
    if (crossings(this.layout, p, c, shut) === 0) return Math.hypot(c.x - p.x, c.y - p.y);
    const around = this.at(this.fieldFor(src, shut), p);
    if (Number.isFinite(around)) return around;
    const through = this.at(this.fieldFor(src, []), p);
    return Number.isFinite(through) ? through + SHUT_DETOUR : Infinity;
  }
}

export const chargerSources = chargersOf;
