import type { SessionState } from '../hooks/useSessionStore';

export interface ReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface ReviewResult {
  verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
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

export function parseReviewResultFromEvents(
  events: SessionState['events'],
): ReviewResult | null {
  let lastTextParts: string[] = [];
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
    } catch {
      // skip unparseable events
    }
  }

  const combined = lastTextParts.join('').trim();
  if (!combined) return null;

  const candidate = extractJsonCandidate(combined);
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
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
  } catch {
    // not a verdict JSON block
  }

  return null;
}
