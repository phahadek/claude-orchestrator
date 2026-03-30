import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../permissions/PermissionEngine';
import type { PermissionRule } from '../db/types';

function rule(overrides: Partial<PermissionRule> & Pick<PermissionRule, 'pattern' | 'decision'>): PermissionRule {
  return {
    id: 1,
    order_index: 0,
    match_type: 'glob',
    label: null,
    enabled: 1,
    ...overrides,
  };
}

describe('PermissionEngine', () => {
  it('returns escalate when no rules match', () => {
    const engine = new PermissionEngine([]);
    expect(engine.evaluate('Read', '{}')).toBe('escalate');
  });

  it('returns allow when a glob rule matches the tool name', () => {
    const engine = new PermissionEngine([
      rule({ pattern: 'Read', decision: 'allow' }),
    ]);
    expect(engine.evaluate('Read', '{}')).toBe('allow');
  });

  it('returns deny when a glob rule matches', () => {
    const engine = new PermissionEngine([
      rule({ pattern: 'Bash*', decision: 'deny' }),
    ]);
    expect(engine.evaluate('Bash', '{"command":"rm -rf"}')).toBe('deny');
  });

  it('respects order_index — first matching rule wins', () => {
    const engine = new PermissionEngine([
      rule({ order_index: 1, pattern: 'Read', decision: 'deny' }),
      rule({ order_index: 0, pattern: 'Read', decision: 'allow' }),
    ]);
    expect(engine.evaluate('Read', '{}')).toBe('allow');
  });

  it('skips disabled rules', () => {
    const engine = new PermissionEngine([
      rule({ pattern: 'Read', decision: 'allow', enabled: 0 }),
    ]);
    expect(engine.evaluate('Read', '{}')).toBe('escalate');
  });

  it('matches with regex match_type', () => {
    const engine = new PermissionEngine([
      rule({ pattern: 'Bash.*rm', match_type: 'regex', decision: 'deny' }),
    ]);
    expect(engine.evaluate('Bash', '{"command":"rm -rf /tmp"}')).toBe('deny');
  });

  it('handles invalid regex gracefully (no match)', () => {
    const engine = new PermissionEngine([
      rule({ pattern: '[invalid', match_type: 'regex', decision: 'allow' }),
    ]);
    expect(engine.evaluate('Read', '{}')).toBe('escalate');
  });
});
