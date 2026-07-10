export type TokenUsage = {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type ProviderRate = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
};

const DEFAULT_RATES: Record<string, ProviderRate> = {
  anthropic: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75 },
  openai: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 1.25 },
  google: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 5 },
  openrouter: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
};

const MODEL_RATE_OVERRIDES: Record<string, ProviderRate> = {
  "claude-3-5-haiku": { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4, cacheReadUsdPerMillion: 0.08, cacheWriteUsdPerMillion: 1 },
  "claude-3-5-sonnet": { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75 },
  "claude-sonnet-4": { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75 },
  "gpt-4.1": { inputUsdPerMillion: 2, outputUsdPerMillion: 8, cacheReadUsdPerMillion: 0.5 },
  "gpt-4.1-mini": { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6, cacheReadUsdPerMillion: 0.1 },
  "gpt-5": { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 0.125 },
  "gpt-5-mini": { inputUsdPerMillion: 0.25, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.025 },
  "gemini-2.5-pro": { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  "gemini-2.5-flash": { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 },
};

function micros(tokens: number, usdPerMillion: number): bigint {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(usdPerMillion) || usdPerMillion <= 0) {
    return 0n;
  }
  return BigInt(Math.round(tokens * usdPerMillion));
}

export function rateForModel(modelProvider: string, model: string): ProviderRate {
  const normalizedModel = model.trim().toLowerCase();
  const override = Object.entries(MODEL_RATE_OVERRIDES)
    .find(([prefix]) => normalizedModel.startsWith(prefix))?.[1];
  return override ?? DEFAULT_RATES[modelProvider] ?? DEFAULT_RATES.openai;
}

export function estimateUsageCostUsdMicros(modelProvider: string, usage: TokenUsage): bigint {
  const rate = rateForModel(modelProvider, usage.model);
  return (
    micros(usage.inputTokens ?? 0, rate.inputUsdPerMillion) +
    micros(usage.outputTokens ?? 0, rate.outputUsdPerMillion) +
    micros(usage.cacheReadTokens ?? 0, rate.cacheReadUsdPerMillion ?? 0) +
    micros(usage.cacheWriteTokens ?? 0, rate.cacheWriteUsdPerMillion ?? rate.inputUsdPerMillion)
  );
}
