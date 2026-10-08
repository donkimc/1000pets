// LLM gateway: tries providers in order (Groq first, DeepSeek as fallback), honours each provider's own
// rate-limit replies, and tracks usage and DeepSeek spend. Never blocks the simulation: callers await it
// off the tick path and simply skip a thought if nothing is available.

export interface ChatMessage { role: "system" | "user"; content: string }

export interface ProviderConfig {
  name: string;
  baseUrl: string; // OpenAI-compatible, e.g. https://api.groq.com/openai/v1
  apiKey: string;
  model: string;
  extraBody?: Record<string, unknown>;
  priceInPerM: number; // USD per million input tokens (0 = free tier)
  priceOutPerM: number;
  rpm: number; // client-side requests-per-minute ceiling
  budgetUsd?: number; // stop using this provider once estimated spend reaches this
  timeoutMs?: number; // per-request timeout for this provider (default: gateway timeout, 30s)
  maxConcurrent?: number; // calls allowed at once; when full the provider counts as busy and the next one is tried
}

export interface LlmResult {
  text: string; provider: string; model: string; tokensIn: number; tokensOut: number;
  cachedIn?: number; // input tokens the provider served from its prompt cache (billed at a fraction), where it says
  costUsd?: number; // estimated from the list price
  ms?: number; // how long the call took
}

/** What a call was for, so spending can be told apart: "thought", "deep", "reply", "speech", "dream", "gist", "teacher-plan", ... */
export interface CallTag { kind: string; pet?: string }

/** One finished (or failed) attempt at one provider, as handed to `onCall`. */
export interface CallRecord {
  at: number; // epoch ms
  kind: string;
  pet?: string;
  provider: string;
  model: string;
  ok: boolean;
  teacher: boolean;
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  costUsd: number;
  ms: number;
  error?: string;
}

export interface ProviderStats {
  name: string;
  model: string;
  calls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  spendUsd: number; // counts toward the provider's budget ceiling (pets' thinking and speech)
  teacherCalls: number; // the AI teacher is accounted separately and is not limited by the ceiling
  teacherSpendUsd: number;
  cooldownUntil: number; // epoch ms
  lastError: string;
  lastErrorAt: number;
  lastRemaining: { requests?: string; tokens?: string };
  budgetUsd?: number; // the provider's ceiling, filled in by snapshot()
}

export class LlmUnavailable extends Error {}

export interface CompleteOpts {
  maxTokens?: number;
  temperature?: number;
  json?: boolean; // ask the provider for a JSON object reply
  timeoutMs?: number; // overrides the provider's own timeout for this call
  providers?: string[]; // only these providers, in this order
  account?: "teacher"; // teacher calls are tracked separately and ignore the budget ceiling
  waitMs?: number; // if every provider is merely busy (not failing), wait up to this long for one to free up instead of giving up
  tag?: CallTag; // what the call is for (spending is reported by it)
  patienceMs?: number; // join the line for the first (preferred) provider if it is busy, up to this long, before trying the others; first come, first served
}

type FetchFn = typeof fetch;

export class LlmGateway {
  /** Called after every attempt at a provider, successful or not (the usage ledger listens). */
  onCall?: (rec: CallRecord) => void;
  private stats = new Map<string, ProviderStats>();
  private recent = new Map<string, number[]>(); // request timestamps for the rpm ceiling
  private consecutiveErrors = new Map<string, number>();
  // First-in, first-out line for providers that serve one request (or a few) at a time, like a local model.
  private slots = new Map<string, { inflight: number; queue: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }[] }>();

  constructor(
    private providers: ProviderConfig[],
    private opts: { fetchFn?: FetchFn; now?: () => number; timeoutMs?: number } = {},
  ) {
    for (const p of providers) {
      this.stats.set(p.name, {
        name: p.name, model: p.model, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0, teacherCalls: 0, teacherSpendUsd: 0,
        cooldownUntil: 0, lastError: "", lastErrorAt: 0, lastRemaining: {},
      });
      this.recent.set(p.name, []);
    }
  }

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  get enabled(): boolean { return this.providers.length > 0; }

  snapshot(): ProviderStats[] {
    return [...this.stats.values()].map((s) => ({ ...s, budgetUsd: this.providers.find((p) => p.name === s.name)?.budgetUsd }));
  }

  /** Restore counters (not cooldowns) saved by a previous run. */
  restore(saved: ProviderStats[] | null) {
    for (const s of saved ?? []) {
      const cur = this.stats.get(s.name);
      if (cur) Object.assign(cur, { calls: s.calls, failures: s.failures, tokensIn: s.tokensIn, tokensOut: s.tokensOut, spendUsd: s.spendUsd, teacherCalls: s.teacherCalls ?? 0, teacherSpendUsd: s.teacherSpendUsd ?? 0 });
    }
  }

  private slotsOf(name: string) {
    let s = this.slots.get(name);
    if (!s) this.slots.set(name, (s = { inflight: 0, queue: [] }));
    return s;
  }

  /** Take a place at the provider: at once if one is free, otherwise wait in line up to waitMs. False if the wait runs out. */
  private take(p: ProviderConfig, waitMs: number): Promise<boolean> {
    if (!p.maxConcurrent) return Promise.resolve(true);
    const s = this.slotsOf(p.name);
    if (s.inflight < p.maxConcurrent) {
      s.inflight++;
      return Promise.resolve(true);
    }
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = {
        resolve: (ok: boolean) => { clearTimeout(w.timer); resolve(ok); },
        timer: setTimeout(() => { s.queue.splice(s.queue.indexOf(w), 1); resolve(false); }, waitMs),
      };
      s.queue.push(w);
    });
  }

  /** Give the place to whoever has waited longest, or free it. */
  private release(p: ProviderConfig): void {
    if (!p.maxConcurrent) return;
    const s = this.slotsOf(p.name);
    const next = s.queue.shift();
    if (next) next.resolve(true); // the place passes straight on, so nobody can jump the line
    else s.inflight--;
  }

  /** How many calls are waiting in line for a provider (for the dashboard and tests). */
  queued(name: string): number {
    return this.slots.get(name)?.queue.length ?? 0;
  }

  private available(p: ProviderConfig, ignoreBudget = false, ignoreBusy = false): string | null {
    const st = this.stats.get(p.name)!;
    const now = this.now();
    if (now < st.cooldownUntil) return `cooling down for ${Math.ceil((st.cooldownUntil - now) / 1000)}s`;
    if (!ignoreBudget && p.budgetUsd !== undefined && st.spendUsd >= p.budgetUsd) return "budget reached";
    const window = this.recent.get(p.name)!.filter((t) => now - t < 60_000);
    this.recent.set(p.name, window);
    if (window.length >= p.rpm) return "client rpm ceiling";
    if (!ignoreBusy && p.maxConcurrent && this.slotsOf(p.name).inflight >= p.maxConcurrent) return "busy";
    return null;
  }

  async complete(messages: ChatMessage[], opts: CompleteOpts = {}): Promise<LlmResult> {
    const order = opts.providers
      ? opts.providers.map((n) => this.providers.find((p) => p.name === n)).filter((p): p is ProviderConfig => !!p)
      : this.providers;
    const deadline = Date.now() + (opts.waitMs ?? 0);
    for (;;) {
      const reasons: string[] = [];
      let busy = false;
      for (const [i, p] of order.entries()) {
        const teacher = opts.account === "teacher";
        const why = this.available(p, teacher);
        let held = false;
        if (!why) {
          held = await this.take(p, 0);
        } else if (why === "busy" && i === 0 && (opts.patienceMs ?? 0) > 0) {
          // The preferred provider is busy: join the line for it instead of moving on at once.
          held = await this.take(p, opts.patienceMs!);
          const later = held ? this.available(p, teacher, true) : null; // it may have started cooling down while we waited
          if (later) {
            this.release(p);
            held = false;
            reasons.push(`${p.name}: ${later}`);
            continue;
          }
        } else {
          reasons.push(`${p.name}: ${why}`);
          if (why === "busy") busy = true;
          continue;
        }
        if (!held) {
          reasons.push(`${p.name}: busy`);
          busy = true;
          continue;
        }
        const t0 = Date.now();
        try {
          const r = await this.callProvider(p, messages, opts);
          r.ms = Date.now() - t0;
          this.report(p, opts, r, r.ms);
          return r;
        } catch (e: any) {
          reasons.push(`${p.name}: ${e.message}`);
          this.report(p, opts, null, Date.now() - t0, e.message);
        } finally {
          this.release(p);
        }
      }
      // A busy provider will free up soon; a slow background job may choose to wait for it.
      if (busy && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new LlmUnavailable(reasons.join("; ") || "no providers configured");
    }
  }

  private report(p: ProviderConfig, opts: CompleteOpts, r: LlmResult | null, ms: number, error?: string) {
    if (!this.onCall) return;
    try {
      this.onCall({
        at: this.now(), kind: opts.tag?.kind ?? "other", ...(opts.tag?.pet ? { pet: opts.tag.pet } : {}), provider: p.name, model: p.model,
        ok: !!r, teacher: opts.account === "teacher", tokensIn: r?.tokensIn ?? 0, tokensOut: r?.tokensOut ?? 0, cachedIn: r?.cachedIn ?? 0, costUsd: r?.costUsd ?? 0, ms,
        ...(error ? { error: String(error).slice(0, 80) } : {}),
      });
    } catch (e) {
      console.warn("usage ledger failed", e);
    }
  }

  private fail(p: ProviderConfig, message: string, cooldownMs: number) {
    const st = this.stats.get(p.name)!;
    st.failures++;
    st.lastError = message.slice(0, 300);
    st.lastErrorAt = this.now();
    console.warn(`llm ${p.name} failed: ${st.lastError}`);
    if (cooldownMs > 0) st.cooldownUntil = Math.max(st.cooldownUntil, this.now() + cooldownMs);
  }

  /** One tiny live call to a single provider, ignoring cooldowns, to check its key and model. */
  async ping(name: string): Promise<{ ok: boolean; provider: string; model?: string; reply?: string; error?: string }> {
    const p = this.providers.find((x) => x.name === name);
    if (!p) return { ok: false, provider: name, error: "provider not configured (is its API key set?)" };
    try {
      const r = await this.callProvider(p, [{ role: "user", content: "Reply with the single word: ok" }], { maxTokens: 200, temperature: 0 });
      return { ok: true, provider: p.name, model: r.model, reply: r.text.trim().slice(0, 40) };
    } catch (e: any) {
      return { ok: false, provider: p.name, model: p.model, error: this.stats.get(p.name)!.lastError || e.message };
    }
  }

  private async callProvider(p: ProviderConfig, messages: ChatMessage[], opts: CompleteOpts): Promise<LlmResult> {
    return this.doCall(p, messages, opts);
  }

  private async doCall(p: ProviderConfig, messages: ChatMessage[], opts: CompleteOpts): Promise<LlmResult> {
    const st = this.stats.get(p.name)!;
    this.recent.get(p.name)!.push(this.now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? p.timeoutMs ?? this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await (this.opts.fetchFn ?? fetch)(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model, messages, max_tokens: opts.maxTokens ?? 500, temperature: opts.temperature ?? 0.7, ...(opts.json ? { response_format: { type: "json_object" } } : {}), ...p.extraBody }),
        signal: ctl.signal,
      });
    } catch (e: any) {
      const n = (this.consecutiveErrors.get(p.name) ?? 0) + 1;
      this.consecutiveErrors.set(p.name, n);
      this.fail(p, `network: ${e.message}`, Math.min(300_000, 10_000 * 2 ** (n - 1)));
      throw new Error(`network error`);
    } finally {
      clearTimeout(timer);
    }

    st.lastRemaining = { requests: res.headers.get("x-ratelimit-remaining-requests") ?? undefined, tokens: res.headers.get("x-ratelimit-remaining-tokens") ?? undefined };

    if (res.status === 429) {
      // Respect the provider's own retry-after (this is how a daily limit shows up too).
      const retry = Number(res.headers.get("retry-after"));
      const ms = Math.min(24 * 3600_000, (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1000);
      this.fail(p, `429 rate limited, retry in ${Math.round(ms / 1000)}s`, ms);
      throw new Error("rate limited");
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      const n = (this.consecutiveErrors.get(p.name) ?? 0) + 1;
      this.consecutiveErrors.set(p.name, n);
      // A bad key will not fix itself, so wait 10 minutes; other 4xx back off harder each time; 5xx retry sooner.
      const auth = res.status === 401 || res.status === 403;
      this.fail(p, `HTTP ${res.status}: ${body}`, auth ? 600_000 : Math.min(600_000, (res.status >= 500 ? 10_000 : 30_000) * 2 ** (n - 1)));
      throw new Error(`HTTP ${res.status}`);
    }

    const data: any = await res.json().catch(() => null);
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      this.fail(p, "empty completion (possibly ran out of tokens while reasoning)", 0);
      throw new Error("empty completion");
    }
    this.consecutiveErrors.set(p.name, 0);
    const tokensIn = Number(data?.usage?.prompt_tokens) || 0;
    const tokensOut = Number(data?.usage?.completion_tokens) || 0;
    // DeepSeek reports how much of the prompt it had cached; others use the OpenAI field names.
    const cachedIn = Number(data?.usage?.prompt_cache_hit_tokens ?? data?.usage?.prompt_tokens_details?.cached_tokens) || 0;
    st.calls++;
    st.tokensIn += tokensIn;
    st.tokensOut += tokensOut;
    const cost = (tokensIn * p.priceInPerM + tokensOut * p.priceOutPerM) / 1e6;
    if (opts.account === "teacher") {
      st.teacherCalls++;
      st.teacherSpendUsd += cost;
    } else st.spendUsd += cost;
    return { text, provider: p.name, model: p.model, tokensIn, tokensOut, cachedIn, costUsd: cost };
  }
}

/** Build the gateway from environment variables. Missing keys simply leave a provider out. */
export function cleanKey(v: string | undefined): string {
  // Keys pasted into a dashboard often pick up whitespace, a newline, quotes or a "Bearer " prefix.
  return (v ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

export function gatewayFromEnv(raw: NodeJS.ProcessEnv = process.env): LlmGateway {
  const env: NodeJS.ProcessEnv = { ...raw, GROQ_API_KEY: cleanKey(raw.GROQ_API_KEY), DEEPSEEK_API_KEY: cleanKey(raw.DEEPSEEK_API_KEY) };
  const providers: ProviderConfig[] = [];
  // Local model (Ollama, LM Studio, llama.cpp: any OpenAI-compatible server). Tried first; free, no rate limit.
  if (env.LOCAL_LLM_MODEL) {
    providers.push({
      name: "local",
      baseUrl: env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1",
      apiKey: env.LOCAL_LLM_API_KEY || "local",
      model: env.LOCAL_LLM_MODEL,
      priceInPerM: 0,
      priceOutPerM: 0,
      rpm: 30,
      timeoutMs: Number(env.LOCAL_LLM_TIMEOUT_SEC ?? 90) * 1000, // CPU-only inference can be slow
      maxConcurrent: Number(env.LOCAL_LLM_CONCURRENCY ?? 1), // a local server works through requests one at a time; extras queue (or go to the next provider)
      // A small model likes to repeat itself; a mild presence penalty nudges it toward something new. Zero turns it off.
      ...(Number(env.LOCAL_LLM_PRESENCE_PENALTY ?? 0.4) > 0 ? { extraBody: { presence_penalty: Number(env.LOCAL_LLM_PRESENCE_PENALTY ?? 0.4) } } : {}),
    });
  }
  if (env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      baseUrl: env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL ?? "openai/gpt-oss-120b",
      // gpt-oss is a reasoning model: keep reasoning short so the answer fits in the token budget.
      extraBody: { reasoning_effort: "low" },
      priceInPerM: 0,
      priceOutPerM: 0,
      rpm: 25,
    });
  }
  if (env.DEEPSEEK_API_KEY) {
    providers.push({
      name: "deepseek",
      baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: env.DEEPSEEK_API_KEY,
      model: env.DEEPSEEK_MODEL ?? "deepseek-chat",
      priceInPerM: 0.27, // conservative cache-miss prices
      priceOutPerM: 1.1,
      rpm: 30,
      budgetUsd: Number(env.DEEPSEEK_BUDGET_USD ?? 1),
    });
  }
  return new LlmGateway(providers);
}
