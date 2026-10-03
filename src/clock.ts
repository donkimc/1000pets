// Simulation clock. Simulated time is independent of wall-clock time.
// speed = simulated seconds per real second (1 = normal clock speed).

export const SPEEDS = [1, 10, 100, 1000] as const;

export class SimClock {
  private simMs: number;
  private lastReal: number;
  speed = 1;
  paused = false;

  constructor(startSimMs = 0, now: number = Date.now()) {
    this.simMs = startSimMs;
    this.lastReal = now;
  }

  /** Advance by the real time elapsed since the last call. Returns simulated ms advanced. */
  advance(now: number = Date.now()): number {
    const realDelta = now - this.lastReal;
    this.lastReal = now;
    if (this.paused) return 0;
    const simDelta = realDelta * this.speed;
    this.simMs += simDelta;
    return simDelta;
  }

  get simTimeMs(): number {
    return this.simMs;
  }

  /** Day number (1-based), hour, minute and second of simulated time. Day 1 starts at 00:00:00. */
  get parts(): { day: number; hour: number; minute: number; second: number } {
    const totalSec = Math.floor(this.simMs / 1000);
    return {
      day: Math.floor(totalSec / 86400) + 1,
      hour: Math.floor((totalSec % 86400) / 3600),
      minute: Math.floor((totalSec % 3600) / 60),
      second: totalSec % 60,
    };
  }

  setSpeed(speed: number): void {
    if (!(SPEEDS as readonly number[]).includes(speed)) throw new Error(`invalid speed ${speed}`);
    this.advance();
    this.speed = speed;
  }

  setPaused(paused: boolean): void {
    this.advance();
    this.paused = paused;
  }
}
