import { describe, it, expect } from 'vitest';
import { parseReviewResultFromEvents } from './ReviewDetailView.helpers';
import type { SessionState } from '../hooks/useSessionStore';

function textEvent(payload: unknown): SessionState['events'][number] {
  return {
    eventType: 'text',
    content: JSON.stringify(payload),
    timestamp: Date.now(),
  };
}

describe('parseReviewResultFromEvents', () => {
  it('extracts the verdict from a review.verdict tool_use block', () => {
    const events = [
      textEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking at the diff...' },
            {
              type: 'tool_use',
              name: 'mcp__orchestrator__review_verdict',
              input: {
                verdict: 'approved',
                dimensions: [
                  { name: 'correctness', passed: true, notes: 'looks good' },
                ],
                summary: 'All checks pass.',
              },
            },
          ],
        },
      }),
    ];

    const result = parseReviewResultFromEvents(events);
    expect(result).toEqual({
      verdict: 'approved',
      dimensions: [{ name: 'correctness', passed: true, notes: 'looks good' }],
      summary: 'All checks pass.',
    });
  });

  it('falls back to legacy raw-JSON text block when no tool_use is present', () => {
    const events = [
      textEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                verdict: 'needs_changes',
                dimensions: [
                  { name: 'tests', passed: false, notes: 'missing coverage' },
                ],
                summary: 'Needs more tests.',
              }),
            },
          ],
        },
      }),
    ];

    const result = parseReviewResultFromEvents(events);
    expect(result).toEqual({
      verdict: 'needs_changes',
      dimensions: [{ name: 'tests', passed: false, notes: 'missing coverage' }],
      summary: 'Needs more tests.',
    });
  });

  it('returns null when neither a tool_use verdict nor a legacy JSON block is present', () => {
    const events = [
      textEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Still reviewing, hang tight.' }],
        },
      }),
    ];

    const result = parseReviewResultFromEvents(events);
    expect(result).toBeNull();
  });

  it('prefers the most recent review.verdict tool_use call across the event stream', () => {
    const events = [
      textEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'mcp__orchestrator__review_verdict',
              input: {
                verdict: 'incomplete',
                dimensions: [],
                summary: 'First pass.',
              },
            },
          ],
        },
      }),
      textEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'mcp__orchestrator__review_verdict',
              input: {
                verdict: 'approved',
                dimensions: [],
                summary: 'Final pass.',
              },
            },
          ],
        },
      }),
    ];

    const result = parseReviewResultFromEvents(events);
    expect(result?.verdict).toBe('approved');
    expect(result?.summary).toBe('Final pass.');
  });
});
