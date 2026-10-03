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
}

export interface LlmResult { text: string; provider: string; model: string; tokensIn: number; tokensOut: number }

export interface ProviderStats {
  name: string;
  model: string;
  calls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  spendUsd: number;
  cooldownUntil: number; // epoch ms
  lastError: string;
  lastErrorAt: number;
  lastRemaining: { requests?: string; tokens?: string };
}

export class LlmUnavailable extends Error {}

type FetchFn = typeof fetch;

export class LlmGateway {
  private stats = new Map<string, ProviderStats>();
  private recent = new Map<string, number[]>(); // request timestamps for the rpm ceiling
  private consecutiveErrors = new Map<string, number>();

  constructor(
    private providers: ProviderConfig[],
    private opts: { fetchFn?: FetchFn; now?: () => number; timeoutMs?: number } = {},
  ) {
    for (const p of providers) {
      this.stats.set(p.name, {
        name: p.name, model: p.model, calls: 0, failures: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0,
        cooldownUntil: 0, lastError: "", lastErrorAt: 0, lastRemaining: {},
      });
      this.recent.set(p.name, []);
    }
  }

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  get enabled(): boolean { return this.providers.length > 0; }

  snapshot(): ProviderStats[] { return [...this.stats.values()].map((s) => ({ ...s })); }

  /** Restore counters (not cooldowns) saved by a previous run. */
  restore(saved: ProviderStats[] | null) {
    for (const s of saved ?? []) {
      const cur = this.stats.get(s.name);
      if (cur) Object.assign(cur, { calls: s.calls, failures: s.failures, tokensIn: s.tokensIn, tokensOut: s.tokensOut, spendUsd: s.spendUsd });
    }
  }

  private available(p: ProviderConfig): string | null {
    const st = this.stats.get(p.name)!;
    const now = this.now();
    if (now < st.cooldownUntil) return `cooling down for ${Math.ceil((st.cooldownUntil - now) / 1000)}s`;
    if (p.budgetUsd !== undefined && st.spendUsd >= p.budgetUsd) return "budget reached";
    const window = this.recent.get(p.name)!.filter((t) => now - t < 60_000);
    this.recent.set(p.name, window);
    if (window.length >= p.rpm) return "client rpm ceiling";
    return null;
  }

  async complete(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<LlmResult> {
    const reasons: string[] = [];
    for (const p of this.providers) {
      const why = this.available(p);
      if (why) { reasons.push(`${p.name}: ${why}`); continue; }
      try {
        return await this.callProvider(p, messages, opts);
      } catch (e: any) {
        reasons.push(`${p.name}: ${e.message}`);
      }
    }
    throw new LlmUnavailable(reasons.join("; ") || "no providers configured");
  }

  private fail(p: ProviderConfig, message: string, cooldownMs: number) {
    const st = this.stats.get(p.name)!;
    st.failures++;
    st.lastError = message.slice(0, 300);
    st.lastErrorAt = this.now();
    console.warn(`llm ${p.name} failed: ${st.lastError}`);
    if (cooldownMs > 0) st.cooldownUntil = Math.max(st.cooldownUntil, this.now() + cooldownMs);
  }

  private async callProvider(p: ProviderConfig, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number }): Promise<LlmResult> {
    const st = this.stats.get(p.name)!;
    this.recent.get(p.name)!.push(this.now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await (this.opts.fetchFn ?? fetch)(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model, messages, max_tokens: opts.maxTokens ?? 500, temperature: opts.temperature ?? 0.7, ...p.extraBody }),
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
    st.calls++;
    st.tokensIn += tokensIn;
    st.tokensOut += tokensOut;
    st.spendUsd += (tokensIn * p.priceInPerM + tokensOut * p.priceOutPerM) / 1e6;
    return { text, provider: p.name, model: p.model, tokensIn, tokensOut };
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
      budgetUsd: Number(env.DEEPSEEK_BUDGET_USD ?? 4),
    });
  }
  return new LlmGateway(providers);
}
