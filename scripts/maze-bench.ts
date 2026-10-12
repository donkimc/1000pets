// How well do pets find their way out of a maze? Each trial puts a pet in the top-left cell of a random maze (corridors 100 wide
// less the wall) and sees whether, and how fast, it finds the way to the exit door in the far corner and goes through it into a
// lobby. The pet is the real one: its fast rules and its memory, with no slow thinking involved. A pet that learns should get
// faster on later trials of the same maze (--trials 3), which is the thing to look for as the brain is improved.
//
//   npx tsx scripts/maze-bench.ts [--sizes 5x4,8x6,10x7] [--mazes 10] [--minutes 120] [--trials 1] [--door shut|open] [--explore on|off] [--route on|off] [--json out.json]
import { exploreSettings } from "../src/explore.js";
import { routeSettings } from "../src/route.js";
import { readFileSync, writeFileSync } from "node:fs";
import { Simulation } from "../src/sim.js";
import { World } from "../src/world.js";
import { buildLayout, makeMaze, mazeDoor, type Layout, type Maze } from "../src/layout.js";
import type { PetDef } from "../src/pet.js";

const arg = (name: string, d: string) => { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SIZES = arg("sizes", "5x4,8x6,10x7").split(",").map((s) => s.split("x").map(Number) as [number, number]);
const MAZES = Number(arg("mazes", "10")), MINUTES = Number(arg("minutes", "120")), TRIALS = Number(arg("trials", "1")), DOOR = arg("door", "shut");
const roster: PetDef[] = JSON.parse(readFileSync(new URL("../config/pets.json", import.meta.url), "utf8")).slice(0, 1);
const CELL = 100;

export function benchMaze(cols: number, rows: number, seed: number): { layout: Layout; maze: Maze } {
  const W = cols * CELL, H = rows * CELL;
  const spec = { x: 0, y: 0, cols, rows, cell: CELL, seed, minRoute: Math.round(cols * rows * 0.4), entrance: { side: "top" as const, index: 0 }, exit: { side: "right" as const, index: rows - 1 } };
  const maze = makeMaze(spec);
  const layout = buildLayout({
    id: "maze-bench", width: W + 300, height: H,
    rooms: [{ id: "maze", name: "Maze", x: 0, y: 0, w: W, h: H, floor: "stone", puzzle: true }, { id: "lobby", name: "Lobby", x: W, y: 0, w: 300, h: H, floor: "wood" }],
    doors: [{ id: "exit", a: "maze", b: "lobby", ...mazeDoor(spec, spec.exit), width: 88, oneWay: { from: "maze" } }],
    objects: [{ id: "w", kind: "window", x: W + 10, y: 0, w: 40, h: 12, room: "lobby" }],
    extraWalls: maze.walls,
  });
  return { layout, maze };
}

export interface TrialResult { solvedSec: number | null; walked: number; cells: number }
export function runMaze(cols: number, rows: number, seed: number, trials = 1, minutes = 120, door = "shut"): { shortest: number; trials: TrialResult[] } {
  const { layout, maze } = benchMaze(cols, rows, seed);
  const world = new World(seed, undefined, layout), sim = new Simulation(world, seed, roster);
  if (door === "open") world.openDoor("exit", 0, 1e12);
  const p = sim.pets[0];
  sim.human.x = layout.width - 20; sim.human.y = 20; sim.teacher.x = layout.width - 20; sim.teacher.y = 60;
  const place = () => { p.x = CELL / 2; p.y = CELL / 2; p.heading = Math.PI / 2; p.energy = 100; p.mode = "idle"; p.s1.holdUntil = 0; p.s1.detourUntil = 0; };
  place();
  const startOdo = { ...p.odo };
  const out: TrialResult[] = [];
  let t = 0;
  for (let trial = 0; trial < trials; trial++) {
    if (trial > 0) { place(); p.odo = { ...startOdo }; } // back to the start, knowing where it is by its own reckoning
    const t0 = t, visited = new Set<string>(); let walked = 0, solved: number | null = null;
    while (t - t0 < minutes * 60) {
      t += 5; sim.step(t * 1000);
      p.energy = Math.max(p.energy, 60); // this is not about the battery
      if (p.moved) walked += Math.hypot(p.moved.x, p.moved.y);
      visited.add(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`);
      if (world.roomIdAt(p.x, p.y) === "lobby") { solved = t - t0; break; }
    }
    out.push({ solvedSec: solved, walked: Math.round(walked), cells: visited.size });
  }
  return { shortest: maze.route.length, trials: out };
}

if (process.argv[1] && process.argv[1].endsWith("maze-bench.ts")) {
  exploreSettings.on = arg("explore", "off") === "on";
  routeSettings.on = arg("route", "off") === "on";
  console.log(`exploring by least-trodden ground: ${exploreSettings.on ? "on" : "off"}`);
  const report: Record<string, unknown>[] = [];
  for (const [cols, rows] of SIZES) {
    const runs = Array.from({ length: MAZES }, (_, i) => ({ seed: i + 1, ...runMaze(cols, rows, i + 1, TRIALS, MINUTES, DOOR) }));
    console.log(`\n== ${cols}x${rows} maze (${cols * rows} cells), ${MAZES} mazes, ${TRIALS} trial(s) each, up to ${MINUTES} min per trial, exit door ${DOOR} ==`);
    const row: Record<string, unknown> = { size: `${cols}x${rows}`, mazes: MAZES, trials: TRIALS, byTrial: [] };
    for (let k = 0; k < TRIALS; k++) {
      const ok = runs.filter((r) => r.trials[k].solvedSec !== null);
      const mins = ok.map((r) => r.trials[k].solvedSec! / 60).sort((a, b) => a - b);
      const eff = ok.map((r) => (r.shortest * CELL) / Math.max(1, r.trials[k].walked)).sort((a, b) => a - b);
      const med = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : null);
      const ratio = med(eff) === null ? null : 1 / med(eff)!;
      console.log(`trial ${k + 1}: solved ${ok.length}/${runs.length}; median ${med(mins) === null ? "-" : med(mins)!.toFixed(1)} min; median walked distance ${ratio === null ? "-" : ratio.toFixed(1) + "x"} the shortest route (1x is perfect)`);
      (row.byTrial as unknown[]).push({ trial: k + 1, solved: ok.length, of: runs.length, medianMin: med(mins), medianPathRatio: ratio });
    }
    report.push(row);
  }
  const out = arg("json", "");
  if (out) writeFileSync(out, JSON.stringify({ door: DOOR, minutes: MINUTES, report }, null, 2));
}
