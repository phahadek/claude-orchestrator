/** Cost per million tokens in USD, keyed by model family substring. */
const MODEL_PRICING: {
  match: string;
  inputPerMillion: number;
  outputPerMillion: number;
}[] = [
  { match: 'opus', inputPerMillion: 15, outputPerMillion: 75 },
  { match: 'sonnet', inputPerMillion: 3, outputPerMillion: 15 },
  { match: 'haiku', inputPerMillion: 0.8, outputPerMillion: 4 },
];

/** Default pricing when model is unknown — falls back to Sonnet. */
const DEFAULT_PRICING = MODEL_PRICING[1];

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model?: string | null,
): number {
  const pricing =
    MODEL_PRICING.find((p) => model?.toLowerCase().includes(p.match)) ??
    DEFAULT_PRICING;
  return (
    (inputTokens * pricing.inputPerMillion +
      outputTokens * pricing.outputPerMillion) /
    1_000_000
  );
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
