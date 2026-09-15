import type { SessionState } from '../hooks/useSessionStore';

interface ReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface ReviewResult {
  verdict:
    | 'approved'
    | 'needs_changes'
    | 'incomplete'
    | 'error'
    | 'pass'
    | 'fail';
  dimensions: ReviewDimension[];
  summary: string;
  errorDetail?: string;
}

function extractJsonCandidate(text: string): string | null {
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const REVIEW_VERDICT_TOOL_NAME = 'mcp__orchestrator__review_verdict';

function toReviewResult(
  parsed: Record<string, unknown>,
): ReviewResult | null {
  if (
    typeof parsed.verdict === 'string' &&
    Array.isArray(parsed.dimensions) &&
    typeof parsed.summary === 'string'
  ) {
    return {
      verdict: parsed.verdict as ReviewResult['verdict'],
      dimensions: parsed.dimensions as ReviewDimension[],
      summary: parsed.summary,
    };
  }
  return null;
}

export function parseReviewResultFromEvents(
  events: SessionState['events'],
): ReviewResult | null {
  let lastTextParts: string[] = [];
  let lastToolResult: ReviewResult | null = null;
  for (const event of events) {
    if (event.eventType !== 'text') continue;
    try {
      const payload = JSON.parse(event.content) as Record<string, unknown>;
      if (payload.type !== 'assistant') continue;
      const msg = payload.message as Record<string, unknown> | undefined;
      const content = (msg ? msg.content : payload.content) as
        | Array<Record<string, unknown>>
        | undefined;
      if (!Array.isArray(content)) continue;

      const parts = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string);
      if (parts.length > 0) lastTextParts = parts;

      for (const block of content) {
        if (block.type !== 'tool_use' || block.name !== REVIEW_VERDICT_TOOL_NAME) {
          continue;
        }
        let input: unknown = block.input;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            continue;
          }
        }
        if (typeof input !== 'object' || input === null) continue;
        const result = toReviewResult(input as Record<string, unknown>);
        if (result) lastToolResult = result;
      }
    } catch {
      // skip unparseable events
    }
  }

  if (lastToolResult) return lastToolResult;

  const combined = lastTextParts.join('').trim();
  if (!combined) return null;

  const candidate = extractJsonCandidate(combined);
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return toReviewResult(parsed);
  } catch {
    // not a verdict JSON block
  }

  return null;
}
