// The usage ledger: what the models were asked, by what, and what it cost. Every call the gateway makes is added here,
// rolled up by simulated day, by kind of call, by pet and by provider, so the dashboard can show where the tokens go
// and a change meant to save them can be measured. It only observes: it never changes what a call does.
import type { CallRecord } from "./llm.js";

export interface Bucket { calls: number; fails: number; tokensIn: number; tokensOut: number; cachedIn: number; costUsd: number; ms: number }
export interface DayUsage { total: Bucket; kind: Record<string, Bucket>; pet: Record<string, Bucket>; provider: Record<string, Bucket> }
export interface UsageData { v: 1; days: Record<string, DayUsage> }
export interface RecentCall extends CallRecord { day: number }

export const newBucket = (): Bucket => ({ calls: 0, fails: 0, tokensIn: 0, tokensOut: 0, cachedIn: 0, costUsd: 0, ms: 0 });
const RECENT_KEPT = 600;
const HOUR_MS = 3_600_000;

function bump(b: Bucket, r: CallRecord) {
  if (r.ok) { b.calls++; b.tokensIn += r.tokensIn; b.tokensOut += r.tokensOut; b.cachedIn += r.cachedIn; b.costUsd += r.costUsd; b.ms += r.ms; }
  else b.fails++;
}
const into = (m: Record<string, Bucket>, key: string, r: CallRecord) => bump((m[key] ??= newBucket()), r);
const sum = (a: Bucket, b: Bucket): Bucket => ({ calls: a.calls + b.calls, fails: a.fails + b.fails, tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, cachedIn: a.cachedIn + b.cachedIn, costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms });
const tokens = (b: Bucket) => b.tokensIn + b.tokensOut;

export interface UsageView {
  total: Bucket;
  byKind: (Bucket & { kind: string; share: number })[];
  byPet: (Bucket & { pet: string })[];
  byProvider: (Bucket & { provider: string })[];
  perDay: { day: number; tokens: number; costUsd: number; calls: number }[];
  lastHour: { calls: number; tokens: number; costUsd: number; byKind: { kind: string; tokens: number }[] };
  projection: { ready: boolean; tokensPerDay: number; costPerDay: number; hoursLeft: number | null }; // at the last hour's pace, per real day, and how long the budget lasts (ready once there are enough calls to call it a pace)
  recent: RecentCall[];
}

export class UsageLedger {
  data: UsageData = { v: 1, days: {} };
  private recent: RecentCall[] = [];

  static from(data: UsageData | null | undefined): UsageLedger {
    const l = new UsageLedger();
    if (data && data.v === 1 && data.days && typeof data.days === "object") l.data = data;
    return l;
  }

  add(rec: CallRecord, simDay: number): void {
    const d = (this.data.days[String(simDay)] ??= { total: newBucket(), kind: {}, pet: {}, provider: {} });
    bump(d.total, rec);
    into(d.kind, rec.kind, rec);
    if (rec.pet) into(d.pet, rec.pet, rec);
    into(d.provider, rec.provider, rec);
    this.recent.push({ ...rec, day: simDay });
    if (this.recent.length > RECENT_KEPT) this.recent.splice(0, this.recent.length - RECENT_KEPT);
  }

  /** `budget` is what is left of the pets' paid-model ceiling, so the view can say how long it lasts at the current pace. */
  view(now: number, budget?: { budgetUsd: number; spentUsd: number }): UsageView {
    const merge = (pick: (d: DayUsage) => Record<string, Bucket>) => {
      const out: Record<string, Bucket> = {};
      for (const d of Object.values(this.data.days)) for (const [k, b] of Object.entries(pick(d))) out[k] = sum(out[k] ?? newBucket(), b);
      return out;
    };
    let total = newBucket();
    for (const d of Object.values(this.data.days)) total = sum(total, d.total);
    const grand = Math.max(1, tokens(total));
    const byKind = Object.entries(merge((d) => d.kind)).map(([kind, b]) => ({ kind, ...b, share: tokens(b) / grand })).sort((a, b) => tokens(b) - tokens(a));
    const byPet = Object.entries(merge((d) => d.pet)).map(([pet, b]) => ({ pet, ...b })).sort((a, b) => tokens(b) - tokens(a));
    const byProvider = Object.entries(merge((d) => d.provider)).map(([provider, b]) => ({ provider, ...b })).sort((a, b) => tokens(b) - tokens(a));
    const perDay = Object.entries(this.data.days).map(([day, d]) => ({ day: Number(day), tokens: tokens(d.total), costUsd: d.total.costUsd, calls: d.total.calls })).sort((a, b) => a.day - b.day).slice(-30);
    const hour = this.recent.filter((r) => r.ok && now - r.at < HOUR_MS);
    const hourKinds = new Map<string, number>();
    for (const r of hour) hourKinds.set(r.kind, (hourKinds.get(r.kind) ?? 0) + r.tokensIn + r.tokensOut);
    const lastHour = {
      calls: hour.length, tokens: hour.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0), costUsd: hour.reduce((n, r) => n + r.costUsd, 0),
      byKind: [...hourKinds].map(([kind, t]) => ({ kind, tokens: t })).sort((a, b) => b.tokens - a.tokens),
    };
    // The pace is only trustworthy once there is a good part of an hour of calls to go on.
    const spanMs = hour.length ? Math.max(60_000, now - hour[0].at) : 0;
    const perHourScale = spanMs ? HOUR_MS / Math.min(HOUR_MS, spanMs) : 0;
    const costPerHour = lastHour.costUsd * perHourScale;
    const petCostPerHour = hour.filter((r) => !r.teacher).reduce((n, r) => n + r.costUsd, 0) * perHourScale;
    const ready = hour.length >= 10;
    return {
      total, byKind, byPet, byProvider, perDay, lastHour,
      projection: {
        ready, tokensPerDay: Math.round(lastHour.tokens * perHourScale * 24), costPerDay: costPerHour * 24,
        hoursLeft: ready && budget && petCostPerHour > 0 ? Math.max(0, (budget.budgetUsd - budget.spentUsd) / petCostPerHour) : null,
      },
      recent: this.recent.slice(-40).reverse(),
    };
  }
}
