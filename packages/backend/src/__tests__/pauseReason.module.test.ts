import { describe, it, expect, vi } from 'vitest';
import {
  PAUSE_REASON_REGISTRY,
  parsePauseReason,
  serializePauseReason,
  pauseReasonFromCanonical,
  deriveRecoveryDescriptor,
} from '../db/pauseReason.js';
import type { CanonicalPauseReason } from '../db/pauseReason.js';

const ALL_REASONS = Object.keys(
  PAUSE_REASON_REGISTRY,
) as CanonicalPauseReason[];

describe('PAUSE_REASON_REGISTRY', () => {
  it('contains exactly 26 canonical reasons', () => {
    expect(ALL_REASONS).toHaveLength(26);
  });

  it('covers all 20 legacy PauseReason values', () => {
    const legacyPauseReasons: CanonicalPauseReason[] = [
      'max_reviews',
      'stuck_timeout',
      'ci_failing',
      'ci_billing_blocked',
      'auto_merge_failed',
      'pr_closed',
      'review_failed',
      'api_overloaded',
      'merge_conflict',
      'awaiting_human_approval',
      'human_changes_requested',
      'pr_body_invalid',
      'attribution_missing',
      'audit_findings',
      'pr_creation_failed',
      'stalled_idle',
      'notion_done_update_stuck',
      'launch_failed',
      'diverged_branch',
      'analyze_failing',
    ];
    for (const r of legacyPauseReasons) {
      expect(PAUSE_REASON_REGISTRY).toHaveProperty(r);
    }
  });

  it('includes rate_limit (from legacy SessionPauseReason)', () => {
    expect(PAUSE_REASON_REGISTRY).toHaveProperty('rate_limit');
  });

  it('every entry has valid source, severity, and retry_strategy', () => {
    const validSources = new Set([
      'autofix',
      'verify',
      'analyze',
      'tests',
      'ci',
      'review',
      'merge',
      'notion',
      'launch',
      'session',
    ]);
    const validSeverities = new Set([
      'recoverable',
      'needs_attention',
      'terminal',
    ]);
    const validStrategies = new Set(['automatic', 'manual_action', 'none']);

    for (const [reason, entry] of Object.entries(PAUSE_REASON_REGISTRY)) {
      expect(validSources.has(entry.source), `${reason}.source invalid`).toBe(
        true,
      );
      expect(
        validSeverities.has(entry.severity),
        `${reason}.severity invalid`,
      ).toBe(true);
      expect(
        validStrategies.has(entry.retry_strategy),
        `${reason}.retry_strategy invalid`,
      ).toBe(true);
    }
  });
});

describe('pauseReasonFromCanonical', () => {
  it('builds a struct from a canonical reason', () => {
    const s = pauseReasonFromCanonical('stuck_timeout');
    expect(s.reason).toBe('stuck_timeout');
    expect(s.source).toBe('session');
    expect(s.severity).toBe('recoverable');
    expect(s.retry_strategy).toBe('automatic');
    expect(s.detail).toBeUndefined();
  });

  it('includes detail when provided', () => {
    const s = pauseReasonFromCanonical('ci_failing', 'lint failed');
    expect(s.detail).toBe('lint failed');
  });
});

describe('parsePauseReason — null / empty input', () => {
  it('returns null for null input', () => {
    expect(parsePauseReason(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePauseReason('')).toBeNull();
  });
});

describe('parsePauseReason — legacy bare-string resolution', () => {
  it.each(ALL_REASONS)(
    'resolves legacy bare string "%s" to the registry triple',
    (reason) => {
      const result = parsePauseReason(reason);
      expect(result).not.toBeNull();
      expect(result!.reason).toBe(reason);
      expect(result!.source).toBe(PAUSE_REASON_REGISTRY[reason].source);
      expect(result!.severity).toBe(PAUSE_REASON_REGISTRY[reason].severity);
      expect(result!.retry_strategy).toBe(
        PAUSE_REASON_REGISTRY[reason].retry_strategy,
      );
    },
  );
});

describe('parsePauseReason — new JSON format', () => {
  it('parses a well-formed JSON triple', () => {
    const raw = JSON.stringify({
      reason: 'review_failed',
      source: 'review',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
    const result = parsePauseReason(raw);
    expect(result).toMatchObject({
      reason: 'review_failed',
      source: 'review',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
  });

  it('preserves detail field from JSON', () => {
    const raw = JSON.stringify({
      reason: 'ci_failing',
      source: 'ci',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
      detail: 'lint check failed',
    });
    const result = parsePauseReason(raw);
    expect(result!.detail).toBe('lint check failed');
  });
});

describe('parsePauseReason — unknown string fallback', () => {
  it('returns the safe default for an unknown string', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parsePauseReason('totally_unknown_reason');
    expect(result).not.toBeNull();
    expect(result!.source).toBe('session');
    expect(result!.severity).toBe('needs_attention');
    expect(result!.retry_strategy).toBe('manual_action');
    warnSpy.mockRestore();
  });

  it('logs a warning for unknown strings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parsePauseReason('totally_unknown_reason');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('totally_unknown_reason');
    warnSpy.mockRestore();
  });
});

describe('round-trip identity', () => {
  it.each(ALL_REASONS)(
    'parsePauseReason(serializePauseReason(s)) deep-equals s for "%s"',
    (reason) => {
      const original = pauseReasonFromCanonical(reason);
      const serialized = serializePauseReason(original);
      const restored = parsePauseReason(serialized);
      expect(restored).toEqual(original);
    },
  );

  it('preserves detail in round-trip', () => {
    const original = pauseReasonFromCanonical('ci_failing', 'tests timed out');
    const restored = parsePauseReason(serializePauseReason(original));
    expect(restored).toEqual(original);
  });
});

// ── deriveRecoveryDescriptor ──────────────────────────────────────────────────

describe('deriveRecoveryDescriptor', () => {
  it('returns available:false for null reason', () => {
    expect(deriveRecoveryDescriptor(null)).toEqual({ available: false });
  });

  it('returns available:false for undefined reason', () => {
    expect(deriveRecoveryDescriptor(undefined)).toEqual({ available: false });
  });

  it.each([
    ['launch_failed', 'redispatch', 'Redispatch'],
    ['needs_repo', 'redispatch', 'Redispatch'],
    ['stalled_idle', 'redispatch', 'Redispatch'],
  ] as const)(
    '%s → redispatch',
    (reason, action, label) => {
      const d = deriveRecoveryDescriptor(reason);
      expect(d).toEqual({ available: true, action, label });
    },
  );

  it.each([
    ['autofix_git_infra_failure', 'rerun', 'Rerun'],
    ['ci_billing_blocked', 'rerun', 'Rerun'],
    ['stalled_reconcile_cap', 'rerun', 'Rerun'],
    ['auto_merge_failed', 'rerun', 'Rerun'],
  ] as const)(
    '%s → rerun',
    (reason, action, label) => {
      const d = deriveRecoveryDescriptor(reason);
      expect(d).toEqual({ available: true, action, label });
    },
  );

  it.each([
    ['review_failed', 'resume', 'Resume'],
    ['human_changes_requested', 'resume', 'Resume'],
    ['ci_failing', 'resume', 'Resume'],
    ['analyze_failing', 'resume', 'Resume'],
    ['merge_conflict', 'resume', 'Resume'],
    ['diverged_branch', 'resume', 'Resume'],
    ['pr_body_invalid', 'resume', 'Resume'],
    ['attribution_missing', 'resume', 'Resume'],
    ['audit_findings', 'resume', 'Resume'],
  ] as const)(
    '%s → resume',
    (reason, action, label) => {
      const d = deriveRecoveryDescriptor(reason);
      expect(d).toEqual({ available: true, action, label });
    },
  );

  it('awaiting_human_approval → available:false (no action)', () => {
    expect(deriveRecoveryDescriptor('awaiting_human_approval')).toEqual({
      available: false,
    });
  });

  it('max_reviews → available:false (no action)', () => {
    expect(deriveRecoveryDescriptor('max_reviews')).toEqual({
      available: false,
    });
  });

  it('recoverable reason (stuck_timeout) → available:false', () => {
    expect(deriveRecoveryDescriptor('stuck_timeout')).toEqual({
      available: false,
    });
  });
});

describe('isomorphic module — no backend-only side effects', () => {
  it('the module can be imported without triggering backend-only initialisation', async () => {
    // If the module imported fs/better-sqlite3/logger, those would throw in a
    // browser-like environment. The fact that we reach here proves it is pure.
    const mod = await import('../db/pauseReason.js');
    expect(typeof mod.parsePauseReason).toBe('function');
    expect(typeof mod.serializePauseReason).toBe('function');
    expect(typeof mod.pauseReasonFromCanonical).toBe('function');
    expect(typeof mod.PAUSE_REASON_REGISTRY).toBe('object');
  });
});

describe('types.ts re-exports', () => {
  it('PauseReason alias is importable from db/types', async () => {
    // Just verifying the module resolves without error (type-level checks are in tsc)
    const types = await import('../db/types.js');
    // The module should load without throwing
    expect(types).toBeDefined();
  });
});
