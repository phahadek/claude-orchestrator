/**
 * Tests for validatePlaybook's agentic-step rules (packages/backend/src/deploy/playbookSchema.ts).
 *
 * AC: an agentic step's command_or_prompt must read as prose (fails
 * looksExecutable()), rejected at load time otherwise; is_prod_mutating:
 * true is rejected on a kind: agentic step.
 */

import { describe, it, expect } from 'vitest';
import { validatePlaybook } from '../playbookSchema';

function playbookWithStep(step: Record<string, unknown>): unknown {
  return {
    steps: [
      {
        id: 'investigate',
        is_prod_mutating: false,
        ...step,
      },
    ],
  };
}

describe('validatePlaybook: agentic step command_or_prompt must be prose', () => {
  it('accepts a prose prompt on an agentic step', () => {
    const result = validatePlaybook(
      playbookWithStep({
        kind: 'agentic',
        command_or_prompt:
          'Investigate whether the newly deployed background worker is processing the queue without excessive retries.',
      }),
    );
    expect('errors' in result).toBe(false);
  });

  it('rejects an agentic step whose command_or_prompt looks like a shell command', () => {
    const result = validatePlaybook(
      playbookWithStep({
        kind: 'agentic',
        command_or_prompt: 'systemctl status worker.service',
      }),
    );
    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors.join('\n')).toMatch(
        /command_or_prompt for an agentic step must be a prose prompt/,
      );
    }
  });
});

describe('validatePlaybook: is_prod_mutating rejected on an agentic step', () => {
  it('rejects is_prod_mutating: true on a kind: agentic step', () => {
    const result = validatePlaybook(
      playbookWithStep({
        kind: 'agentic',
        command_or_prompt: 'Confirm the worker restarted cleanly.',
        is_prod_mutating: true,
      }),
    );
    expect('errors' in result).toBe(true);
    if ('errors' in result) {
      expect(result.errors.join('\n')).toMatch(
        /is_prod_mutating must not be true for an agentic step/,
      );
    }
  });

  it('accepts is_prod_mutating: false on a kind: agentic step', () => {
    const result = validatePlaybook(
      playbookWithStep({
        kind: 'agentic',
        command_or_prompt: 'Confirm the worker restarted cleanly.',
        is_prod_mutating: false,
      }),
    );
    expect('errors' in result).toBe(false);
  });
});
