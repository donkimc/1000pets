// Getting a trapped pet out of a puzzle room. A maze has a locked emergency door that only the Teacher opens. If a pet has been
// inside a puzzle room too long, or its battery is getting low, the Teacher (by rule, not by asking a model) unlocks that door,
// walks to the pet, says "follow me", and walks it out, waiting for it when it falls behind. Afterwards the door is locked again,
// so the puzzle is still there for the next pet. Everything else about the maze is left to the pet.
import { roomAt, type DoorDef } from "./layout.js";
import { crossings } from "./acoustics.js";
import { findPath, type Pt } from "./nav.js";
import type { PetState } from "./pet.js";
import type { Simulation } from "./sim.js";

export interface RescueConfig { afterMin: number; batteryBelow: number; maxMin: number; cooldownMin: number }
export const DEFAULT_RESCUE: RescueConfig = {
  afterMin: Number(process.env.PUZZLE_RESCUE_MIN ?? 90), // inside a puzzle room this long (simulated minutes)
  batteryBelow: Number(process.env.PUZZLE_RESCUE_BATTERY ?? 30), // ... or its battery is under this (percent)
  maxMin: 40, // give up a rescue that is going nowhere after this long
  cooldownMin: 30, // and leave a pet alone this long before trying again
};

export interface RescueHooks {
  /** Log and apply an unlock or lock of a door, as any other change the Teacher makes. */
  setLocked(door: string, locked: boolean, reason: string): void;
  say(pet: PetState, text: string): void;
}

interface Active { petId: string; roomId: string; door: DoorDef; phase: "going" | "leading"; sinceSec: number; path: Pt[]; step: number; outside: Pt; lostSince?: number }

export class Rescue {
  active: Active | null = null;
  private lastTried = new Map<string, number>();
  /** Pets who have been rescued, in order (for the dashboard and tests). */
  history: { petId: string; atSec: number; roomId: string; why: string; outcome: "out" | "gave up" }[] = [];

  constructor(private sim: Simulation, private hooks: RescueHooks, readonly cfg: RescueConfig = DEFAULT_RESCUE) {}

  /** Pets inside a puzzle room, and for how long, for the Teacher's picture of how everyone is. */
  trapped(): { pet: PetState; roomId: string; minutes: number }[] {
    const L = this.sim.world.layout, out: { pet: PetState; roomId: string; minutes: number }[] = [];
    for (const p of this.sim.pets) {
      const room = roomAt(L, p.x, p.y);
      if (room?.puzzle) out.push({ pet: p, roomId: room.id, minutes: Math.round((this.sim.simSec - (p.roomSince ?? this.sim.simSec)) / 60) });
    }
    return out;
  }

  private pickWho(now: number) {
    for (const t of this.trapped()) {
      if (now - (this.lastTried.get(t.pet.id) ?? -1e9) < this.cfg.cooldownMin * 60) continue;
      const slow = t.minutes >= this.cfg.afterMin, low = t.pet.energy < this.cfg.batteryBelow;
      if (slow || low) return { ...t, why: low ? `its battery is down to ${Math.round(t.pet.energy)}%` : `it has been inside for ${t.minutes} minutes` };
    }
    return null;
  }

  /** Called every Teacher tick. Returns the place the Teacher should walk to (null: stand still), or undefined when there is no rescue and the Teacher goes about its day. */
  tick(): Pt | null | undefined {
    const now = this.sim.simSec, world = this.sim.world, L = world.layout, T = this.sim.teacher;
    if (!this.active) {
      const who = this.pickWho(now);
      if (!who) return undefined;
      const door = L.doors.find((d) => d.emergency && (d.a === who.roomId || d.b === who.roomId));
      if (!door) { this.lastTried.set(who.pet.id, now); return undefined; }
      this.lastTried.set(who.pet.id, now);
      this.hooks.setLocked(door.id, false, `${who.pet.name} is stuck in the ${who.roomId}: ${who.why}`);
      world.setLocked(door.id, false);
      world.openDoor(door.id, now, 3600); // open for the whole rescue
      const r = L.doorRects[door.id], mid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const other = door.a === who.roomId ? door.b : door.a;
      const outside = (door.orient === "h" ? [{ x: mid.x, y: mid.y - 80 }, { x: mid.x, y: mid.y + 80 }] : [{ x: mid.x - 80, y: mid.y }, { x: mid.x + 80, y: mid.y }]).find((q) => roomAt(L, q.x, q.y)?.id === other) ?? mid;
      this.active = { petId: who.pet.id, roomId: who.roomId, door, phase: "going", sinceSec: now, path: [], step: 0, outside };
      this.history.push({ petId: who.pet.id, atSec: now, roomId: who.roomId, why: who.why, outcome: "gave up" });
    }
    const a = this.active, pet = this.sim.pets.find((p) => p.id === a.petId);
    const finish = (out: boolean) => {
      this.history[this.history.length - 1].outcome = out ? "out" : "gave up";
      if (pet) pet.s1.guidedUntil = 0;
      world.setLocked(a.door.id, true); // the way out is shut again for the next pet
      this.hooks.setLocked(a.door.id, true, out ? "the pet is out; the puzzle is closed again" : "the rescue is over; the puzzle is closed again");
      this.active = null;
      return undefined;
    };
    if (!pet || now - a.sinceSec > this.cfg.maxMin * 60) return finish(false);
    const petRoom = roomAt(L, pet.x, pet.y);
    if (!petRoom?.puzzle) return finish(true);
    const dist = Math.hypot(T.x - pet.x, T.y - pet.y);
    if (a.phase === "going") {
      if (dist > 110) return { x: pet.x, y: pet.y }; // walk to it, through the maze
      this.hooks.say(pet, "Follow me. I will show you the way out.");
      pet.s1.guidedUntil = now + this.cfg.maxMin * 60;
      a.path = findPath(L, { x: T.x, y: T.y }, a.outside, 20) ?? [a.outside];
      a.phase = "leading";
    }
    pet.s1.guidedUntil = Math.max(pet.s1.guidedUntil ?? 0, now + 120); // still being led
    // A pet follows what it can see, and in a maze a corridor corner hides the Teacher at once. So the Teacher only goes on while the pet
    // is close and in sight, and goes back to it when it is not (with some slack, so it does not dither at the edge).
    // It waits where it is while the pet comes round the corner, and only goes back to the pet if that is not working.
    const sees = crossings(L, T, pet, world.shutDoors()) === 0;
    a.lostSince = sees && dist < 130 ? undefined : (a.lostSince ?? now);
    if (a.lostSince !== undefined) return now - a.lostSince > 12 || dist > 200 ? { x: pet.x, y: pet.y } : null;
    if (dist > 80) return null; // let it catch up
    while (a.step < a.path.length - 1 && Math.hypot(T.x - a.path[a.step].x, T.y - a.path[a.step].y) < 24) a.step++;
    return a.path[a.step];
  }
}
