import type { PermissionRule } from '../db/types';

export type EngineDecision = 'allow' | 'deny' | 'escalate';

/** Convert a simple glob pattern (* and ?) to a RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*/g, '.*')                   // * → .*
    .replace(/\?/g, '.');                   // ? → .
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Pure stateless evaluator — no DB access, no side effects.
 * Caller fetches rules from SQLite and passes them in.
 */
export class PermissionEngine {
  constructor(private readonly rules: PermissionRule[]) {}

  evaluate(toolName: string, toolArgs: string): EngineDecision {
    const enabled = this.rules
      .filter((r) => r.enabled === 1)
      .sort((a, b) => a.order_index - b.order_index);

    for (const rule of enabled) {
      if (this.matches(rule, toolName, toolArgs)) {
        return rule.decision; // 'allow' | 'deny'
      }
    }

    return 'escalate';
  }

  private matches(rule: PermissionRule, toolName: string, toolArgs: string): boolean {
    const subject = `${toolName} ${toolArgs}`;
    if (rule.match_type === 'glob') {
      const re = globToRegex(rule.pattern);
      return re.test(subject) || re.test(toolName);
    }
    // regex
    try {
      return new RegExp(rule.pattern, 'i').test(subject);
    } catch {
      return false;
    }
  }
}
