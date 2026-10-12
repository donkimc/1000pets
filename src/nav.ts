// Path finding for the bodies that know the whole plan: the Teacher, and the human when they tap the map.
// Pets do not use this: they have no map and find their way from what they sense.
import { blockedAt, type Layout } from "./layout.js";

export interface Pt { x: number; y: number }
const CELL = 20;

/** Whether a body of radius r can walk the straight line from a to b. */
export function lineClear(layout: Layout, a: Pt, b: Pt, r: number, shut: readonly string[] = []): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / 8));
  for (let i = 0; i <= n; i++) if (blockedAt(layout, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n, r, shut)) return false;
  return true;
}

/** Shortest walkable route from `from` to `to` as a list of waypoints (not including the start), or null if there is none. Doors count as open unless listed in `shut`. */
export function findPath(layout: Layout, from: Pt, to: Pt, r = 22, shut: readonly string[] = []): Pt[] | null {
  const cols = Math.ceil(layout.width / CELL), rows = Math.ceil(layout.height / CELL);
  const cellOf = (p: Pt) => ({ c: Math.min(cols - 1, Math.max(0, Math.floor(p.x / CELL))), r: Math.min(rows - 1, Math.max(0, Math.floor(p.y / CELL))) });
  const centre = (c: number, rr: number): Pt => ({ x: c * CELL + CELL / 2, y: rr * CELL + CELL / 2 });
  const free = new Map<number, boolean>();
  const ok = (c: number, rr: number) => {
    const k = rr * cols + c;
    let v = free.get(k);
    if (v === undefined) { const p = centre(c, rr); v = !blockedAt(layout, p.x, p.y, r, shut); free.set(k, v); }
    return v;
  };
  const s = cellOf(from);
  let g = cellOf(to);
  if (!ok(g.c, g.r)) { // the goal is inside something: aim for the nearest open cell
    let best: { c: number; r: number } | null = null, bd = Infinity;
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
      const c = g.c + dc, rr = g.r + dr;
      if (c < 0 || rr < 0 || c >= cols || rr >= rows || !ok(c, rr)) continue;
      const d = dc * dc + dr * dr;
      if (d < bd) { bd = d; best = { c, r: rr }; }
    }
    if (!best) return null;
    g = best;
  }
  const key = (c: number, rr: number) => rr * cols + c;
  const gScore = new Map<number, number>([[key(s.c, s.r), 0]]);
  const prev = new Map<number, number>();
  const open: { k: number; f: number }[] = [{ k: key(s.c, s.r), f: 0 }];
  const closed = new Set<number>();
  const h = (c: number, rr: number) => Math.hypot(c - g.c, rr - g.r);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const { k } = open.splice(bi, 1)[0];
    if (closed.has(k)) continue;
    closed.add(k);
    const c = k % cols, rr = Math.floor(k / cols);
    if (c === g.c && rr === g.r) {
      const cells: Pt[] = [];
      for (let cur: number | undefined = k; cur !== undefined; cur = prev.get(cur)) cells.push(centre(cur % cols, Math.floor(cur / cols)));
      cells.reverse().shift();
      cells.push({ x: Math.min(layout.width, Math.max(0, to.x)), y: Math.min(layout.height, Math.max(0, to.y)) });
      // Pull the string tight: skip waypoints that can be walked past in a straight line.
      const out: Pt[] = [];
      let at = from, i = 0;
      while (i < cells.length) {
        let j = cells.length - 1;
        while (j > i && !lineClear(layout, at, cells[j], r, shut)) j--;
        out.push(cells[j]);
        at = cells[j];
        i = j + 1;
      }
      return out;
    }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dc && !dr) continue;
      const nc = c + dc, nr = rr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || !ok(nc, nr)) continue;
      if (dc && dr && (!ok(c + dc, rr) || !ok(c, rr + dr))) continue; // no cutting corners
      const nk = key(nc, nr);
      const ng = (gScore.get(k) ?? 0) + (dc && dr ? 1.414 : 1);
      if (ng < (gScore.get(nk) ?? Infinity)) { gScore.set(nk, ng); prev.set(nk, k); open.push({ k: nk, f: ng + h(nc, nr) }); }
    }
  }
  return null;
}
