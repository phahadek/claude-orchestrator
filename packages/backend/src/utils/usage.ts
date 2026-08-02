/**
 * Cost per million tokens in USD, keyed by model family substring.
 * Cache tokens are priced on their own tier per Anthropic's published cache
 * pricing: cache writes (creation) cost 1.25x the base input rate, cache
 * reads cost 0.1x the base input rate.
 */
const MODEL_PRICING: {
  match: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheCreationPerMillion: number;
}[] = [
  {
    match: 'opus',
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
  },
  {
    match: 'sonnet',
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },
  {
    match: 'haiku',
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheCreationPerMillion: 1,
  },
];

/** Default pricing when model is unknown — falls back to Sonnet. */
const DEFAULT_PRICING = MODEL_PRICING[1];

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model?: string | null,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const pricing =
    MODEL_PRICING.find((p) => model?.toLowerCase().includes(p.match)) ??
    DEFAULT_PRICING;
  return (
    (inputTokens * pricing.inputPerMillion +
      outputTokens * pricing.outputPerMillion +
      cacheReadTokens * pricing.cacheReadPerMillion +
      cacheCreationTokens * pricing.cacheCreationPerMillion) /
    1_000_000
  );
}

/**
 * Canonical session-type category map — single source of truth for how the
 * analytics route groups session types. Distinct from sessionPredicates.ts,
 * which encodes operational/dispatch predicates (worktree, PR, concurrency)
 * rather than the cost-accounting taxonomy consumed here.
 */
export const SESSION_TYPE_CATEGORIES = {
  planning: ['groom', 'design', 'ops', 'split'],
  execution: ['standard', 'review', 'docs'],
} as const;

export type SessionTypeCategory = keyof typeof SESSION_TYPE_CATEGORIES;

export function categoryForSessionType(
  sessionType: string,
): SessionTypeCategory {
  return (
    SESSION_TYPE_CATEGORIES.planning as readonly string[]
  ).includes(sessionType)
    ? 'planning'
    : 'execution';
}

export function formatCost(costUsd: number): string {
  if (costUsd < 0.005) return '<$0.01';
  if (costUsd < 1) return `$${costUsd.toFixed(2)}`;
  return `$${costUsd.toFixed(2)}`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}
