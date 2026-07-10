// Semantic tiers. Two consumers currently point at the same model string, but
// the tiers are kept separate so swapping one doesn't accidentally affect the
// other.
//   heavy      — full reply generation (harness loop, swarm synth)
//   classifier — routing / intent / matching / extraction (output not shown to the user)
//   fast       — user-facing conversational replies on the fast tier (CHAT route)
export const OPENROUTER_MODELS = {
  heavy: 'anthropic/claude-sonnet-4.6',
  classifier: 'anthropic/claude-haiku-4.5',
  fast: 'anthropic/claude-haiku-4.5',
} as const;

export type OpenRouterModelTier = keyof typeof OPENROUTER_MODELS;

