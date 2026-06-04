import { describe, it, expect } from 'vitest';
import { AgentSession } from '../AgentSession';

describe('AgentSession.contextWindowForModel', () => {
  it('returns 200_000 for a standard model', () => {
    expect(AgentSession.contextWindowForModel('claude-sonnet-4-6')).toBe(200_000);
  });

  it('returns 1_000_000 for a model containing [1m]', () => {
    expect(AgentSession.contextWindowForModel('claude-opus-4-7[1m]')).toBe(1_000_000);
  });

  it('returns 200_000 for null model', () => {
    expect(AgentSession.contextWindowForModel(null)).toBe(200_000);
  });

  it('returns 200_000 for a model with 1m in name but not [1m] bracket form', () => {
    expect(AgentSession.contextWindowForModel('claude-1m-model')).toBe(200_000);
  });

  it('returns 1_000_000 for any model string containing [1m] substring', () => {
    expect(AgentSession.contextWindowForModel('my-model[1m]-variant')).toBe(1_000_000);
  });
});
