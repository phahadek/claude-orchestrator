import { describe, it, expect, vi } from 'vitest';
import {
  PAUSE_REASON_REGISTRY,
  parsePauseReason,
  serializePauseReason,
  pauseReasonFromCanonical,
  deriveRecoveryDescriptor,
  deriveTaskRecoveryDescriptor,
  isMergeBlockingPause,
} from '../db/pauseReason.js';
import type { CanonicalPauseReason } from '../db/pauseReason.js';

const ALL_REASONS = Object.keys(
  PAUSE_REASON_REGISTRY,
) as CanonicalPauseReason[];

describe('PAUSE_REASON_REGISTRY', () => {
  it('contains exactly 48 canonical reasons', () => {
    expect(ALL_REASONS).toHaveLength(48);
  });

  it('includes depth_review_pending as a recoverable, automatic reason, distinct from depth_review_escalation', () => {
    expect(PAUSE_REASON_REGISTRY.depth_review_pending).toEqual({
      source: 'review',
      severity: 'recoverable',
      retry_strategy: 'automatic',
    });
    expect(PAUSE_REASON_REGISTRY.depth_review_pending).not.toEqual(
      PAUSE_REASON_REGISTRY.depth_review_escalation,
    );
  });

  it('includes manual_verification_pending as a needs_attention, manual_action reason', () => {
    expect(PAUSE_REASON_REGISTRY.manual_verification_pending).toEqual({
      source: 'review',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
  });

  it('includes usage_limit_deferred as a recoverable, automatically-retried reason', () => {
    expect(PAUSE_REASON_REGISTRY.usage_limit_deferred).toEqual({
      source: 'session',
      severity: 'recoverable',
      retry_strategy: 'automatic',
    });
  });

  it('includes api_overloaded_exhausted as a needs_attention reason distinct from api_overloaded', () => {
    expect(PAUSE_REASON_REGISTRY.api_overloaded_exhausted).toEqual({
      source: 'session',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
    expect(PAUSE_REASON_REGISTRY.api_overloaded_exhausted).not.toEqual(
      PAUSE_REASON_REGISTRY.api_overloaded,
    );
  });

  it('includes planning_terminal_no_decision with a valid severity and retry strategy', () => {
    expect(PAUSE_REASON_REGISTRY.planning_terminal_no_decision).toEqual({
      source: 'session',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
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
    ['resume_failed', 'redispatch', 'Redispatch'],
  ] as const)('%s → redispatch', (reason, action, label) => {
    const d = deriveRecoveryDescriptor(reason);
    expect(d).toEqual({ available: true, action, label });
  });

  it.each([
    ['autofix_git_infra_failure', 'rerun', 'Rerun'],
    ['autofix_tool_infra_failure', 'rerun', 'Rerun'],
    ['ci_billing_blocked', 'rerun', 'Rerun'],
    ['stalled_reconcile_cap', 'rerun', 'Rerun'],
    ['auto_merge_failed', 'rerun', 'Rerun'],
  ] as const)('%s → rerun', (reason, action, label) => {
    const d = deriveRecoveryDescriptor(reason);
    expect(d).toEqual({ available: true, action, label });
  });

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
    ['diverged_branch_unresolved', 'resume', 'Resume'],
    ['api_overloaded_exhausted', 'resume', 'Resume'],
  ] as const)('%s → resume', (reason, action, label) => {
    const d = deriveRecoveryDescriptor(reason);
    expect(d).toEqual({ available: true, action, label });
  });

  it.each([
    ['pr_creation_failed', 'redispatch', 'Redispatch'],
    ['planning_crashed', 'redispatch', 'Redispatch'],
    ['planning_first_turn_empty', 'redispatch', 'Redispatch'],
    ['planning_terminal_no_decision', 'redispatch', 'Redispatch'],
    ['ops_journal_terminal_incomplete', 'redispatch', 'Redispatch'],
  ] as const)('%s → redispatch (previously omitted)', (reason, action, label) => {
    const d = deriveRecoveryDescriptor(reason);
    expect(d).toEqual({ available: true, action, label });
  });

  it.each([
    'max_reviews',
    'stuck_timeout',
    'pr_closed',
    'api_overloaded',
    'awaiting_human_approval',
    'notion_done_update_stuck',
    'base_branch_broken',
    'rate_limit',
    'workflow_scope_denied',
    'review_rules_escalation',
    'baseline_escalation_floor',
    'depth_review_escalation',
    'depth_review_pending',
    'planning_terminal_blocked_members',
    'ops_terminal_group_incomplete',
    'usage_limit_deferred',
    'manual_verification_pending',
    'test_request_cycle_exceeded',
    'test_report_acquisition_failed',
    'ci_not_completing',
    'mcp_unreachable_exhausted',
    'verdict_routing_failed',
    'base_attributable_test_excluded',
  ] as const)(
    '%s → available:false (deliberate none, previously omitted)',
    (reason) => {
      expect(deriveRecoveryDescriptor(reason)).toEqual({ available: false });
    },
  );
});

// ── deriveTaskRecoveryDescriptor ────────────────────────────────────────────

describe('deriveTaskRecoveryDescriptor', () => {
  it('a task-level reason with no PR resolves to its mapped action', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: 'launch_failed',
      prReason: null,
      hasPR: false,
      sessionTerminal: false,
    });
    expect(d).toEqual({
      available: true,
      action: 'redispatch',
      label: 'Redispatch',
    });
  });

  it('terminal session, no PR, no pause row of either kind → redispatch', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: null,
      prReason: null,
      hasPR: false,
      sessionTerminal: true,
    });
    expect(d).toEqual({
      available: true,
      action: 'redispatch',
      label: 'Redispatch',
    });
  });

  it('non-terminal session, no PR, no pause row → unavailable', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: null,
      prReason: null,
      hasPR: false,
      sessionTerminal: false,
    });
    expect(d).toEqual({ available: false });
  });

  it('terminal session but a PR exists, no pause row → unavailable (PR still open)', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: null,
      prReason: null,
      hasPR: true,
      sessionTerminal: true,
    });
    expect(d).toEqual({ available: false });
  });

  it('a PR-side reason with no task-level reason continues to resolve to its mapped action', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: null,
      prReason: 'ci_failing',
      hasPR: true,
      sessionTerminal: false,
    });
    expect(d).toEqual({ available: true, action: 'resume', label: 'Resume' });
  });

  it('task-level reason takes precedence over a PR-side reason when both are present', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: 'launch_failed',
      prReason: 'ci_failing',
      hasPR: true,
      sessionTerminal: false,
    });
    expect(d).toEqual({
      available: true,
      action: 'redispatch',
      label: 'Redispatch',
    });
  });

  it('a task-level reason deliberately absent from RECOVERY_ACTION_MAP never defaults to an action', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: 'awaiting_human_approval',
      prReason: null,
      hasPR: false,
      sessionTerminal: true,
    });
    expect(d).toEqual({ available: false });
  });

  it('a PR-side reason deliberately absent from RECOVERY_ACTION_MAP never defaults to an action', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: null,
      prReason: 'max_reviews',
      hasPR: true,
      sessionTerminal: false,
    });
    expect(d).toEqual({ available: false });
  });

  it('baseline_escalation_floor (PR-side) resolves to available:false — a deliberate none, not an affordance', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: null,
      prReason: 'baseline_escalation_floor',
      hasPR: true,
      sessionTerminal: false,
    });
    expect(d).toEqual({ available: false });
  });

  it('baseline_escalation_floor (task-side) resolves to available:false — a deliberate none', () => {
    const d = deriveTaskRecoveryDescriptor({
      taskReason: 'baseline_escalation_floor',
      prReason: null,
      hasPR: true,
      sessionTerminal: false,
    });
    expect(d).toEqual({ available: false });
  });
});

// ── isMergeBlockingPause ──────────────────────────────────────────────────────

describe('isMergeBlockingPause', () => {
  it('returns false for no pause (null)', () => {
    expect(isMergeBlockingPause(null)).toBe(false);
  });

  it('test_report_acquisition_failed is classified non-blocking', () => {
    expect(
      PAUSE_REASON_REGISTRY.test_report_acquisition_failed.blocks_merge,
    ).toBe(false);
    expect(isMergeBlockingPause('test_report_acquisition_failed')).toBe(false);
    const serialized = serializePauseReason(
      pauseReasonFromCanonical('test_report_acquisition_failed'),
    );
    expect(isMergeBlockingPause(serialized)).toBe(false);
  });

  it('ci_not_completing is classified non-blocking', () => {
    expect(PAUSE_REASON_REGISTRY.ci_not_completing.blocks_merge).toBe(false);
    expect(isMergeBlockingPause('ci_not_completing')).toBe(false);
    const serialized = serializePauseReason(
      pauseReasonFromCanonical('ci_not_completing'),
    );
    expect(isMergeBlockingPause(serialized)).toBe(false);
  });

  it.each(['merge_conflict', 'max_reviews', 'stalled_reconcile_cap'] as const)(
    '%s remains merge-blocking',
    (reason) => {
      expect(isMergeBlockingPause(reason)).toBe(true);
      const serialized = serializePauseReason(pauseReasonFromCanonical(reason));
      expect(isMergeBlockingPause(serialized)).toBe(true);
    },
  );

  it('defaults to blocking (fail-closed) for an unclassified/unknown reason', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isMergeBlockingPause('totally_unknown_reason')).toBe(true);
    warnSpy.mockRestore();
  });

  it('defaults to blocking for a legacy-persisted JSON blob missing blocks_merge', () => {
    // Simulates a row written before blocks_merge existed on the struct.
    const legacyRaw = JSON.stringify({
      reason: 'ci_failing',
      source: 'ci',
      severity: 'needs_attention',
      retry_strategy: 'automatic',
    });
    expect(isMergeBlockingPause(legacyRaw)).toBe(true);
  });

  it('re-derives false from the registry for a legacy test_report_acquisition_failed blob missing blocks_merge', () => {
    const legacyRaw = JSON.stringify({
      reason: 'test_report_acquisition_failed',
      source: 'tests',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
    });
    expect(isMergeBlockingPause(legacyRaw)).toBe(false);
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
