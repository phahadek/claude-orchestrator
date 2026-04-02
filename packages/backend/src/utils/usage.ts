export interface PlanUsage {
  usedTokens: number;   // total tokens consumed in current billing period
  capTokens: number;    // plan cap
  percentUsed: number;  // usedTokens / capTokens * 100
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

export function formatUtilization(percent: number): string {
  return `${Math.round(percent)}%`;
}
