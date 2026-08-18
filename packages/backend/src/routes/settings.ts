import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAllSettings } from '../db/queries';
import { runtimeSettings } from '../config';
import {
  typedGetSetting,
  typedSetSetting,
  type SettingKey,
  type Settings,
} from '../config/settings';
import { reapplySessionCgroupLimits } from '../session/sessionCgroup';
import { getCapabilityDispositionEvents } from '../audit/AuditLog';
import { isGrantable } from '../session/orchestrator-config';

let _reviewOrchestrator: { drain(): Promise<void> } | null = null;
export function setReviewOrchestrator(orch: { drain(): Promise<void> }): void {
  _reviewOrchestrator = orch;
}

const router = Router();

const SETTING_KEYS = [
  'max_concurrent_code_sessions',
  'max_concurrent_planning_sessions',
  'max_concurrent_verify_sessions',
  'auto_review_concurrency',
  'auto_review',
  'card_preview_lines',
  'code_session_model',
  'review_session_model',
  'code_session_effort',
  'review_session_effort',
  'session_mode',
  'auto_launch_concurrency',
  'auto_launch_poll_interval_ms',
  'hourly_usage_pause_threshold_percent',
  'weekly_usage_pause_threshold_percent',
  'min_host_free_memory_mb',
  'per_session_reserve_mb',
  'session_cgroup_prod_reserve_mb',
  'session_cgroup_memory_high_fraction',
  'session_cgroup_deny_swap',
  'session_notify_threshold_seconds',
  'session_pause_threshold_seconds',
  'session_inert_threshold_seconds',
  'session_hard_stop_window_seconds',
  'ci_poll_interval_seconds',
  'ci_poll_max_minutes',
  'max_review_iterations',
  'pr_boot_sweep_merged_lookback_days',
  'auto_archive_enabled',
  'auto_archive_grace_minutes',
  'auto_archive_sweep_interval_minutes',
  'large_task_model',
  'large_task_effort',
  'planning_session_model',
  'planning_session_effort',
  'ops_session_model',
  'ops_session_effort',
  'gate_verify_session_model',
  'gate_verify_session_effort',
  'investigate_session_model',
  'investigate_session_effort',
  'groom_session_model',
  'groom_session_effort',
  'design_session_model',
  'design_session_effort',
  'docs_session_model',
  'docs_session_effort',
  'tier3_classifier_model',
  'capability_auto_approve_allowlist',
  'milestone_attention_aging_threshold_seconds',
  'milestone_attention_flat_convergence_window_seconds',
  'decision_pick_one_paragraph_threshold',
] as const satisfies readonly SettingKey[];

type RouteSettingKey = (typeof SETTING_KEYS)[number];

function applyToRuntime(
  key: RouteSettingKey,
  value: Settings[RouteSettingKey],
): void {
  switch (key) {
    case 'max_concurrent_code_sessions':
      runtimeSettings.max_concurrent_code_sessions = value as number;
      break;
    case 'max_concurrent_planning_sessions':
      runtimeSettings.max_concurrent_planning_sessions = value as number;
      break;
    case 'max_concurrent_verify_sessions':
      runtimeSettings.max_concurrent_verify_sessions = value as number;
      break;
    case 'auto_review_concurrency':
      runtimeSettings.auto_review_concurrency = value as number;
      void _reviewOrchestrator?.drain();
      break;
    case 'auto_review':
      runtimeSettings.auto_review = value as boolean;
      break;
    case 'card_preview_lines':
      runtimeSettings.card_preview_lines = value as number;
      break;
    case 'code_session_model':
      runtimeSettings.code_session_model = value as string;
      break;
    case 'review_session_model':
      runtimeSettings.review_session_model = value as string;
      break;
    case 'code_session_effort':
      runtimeSettings.code_session_effort = value as string;
      break;
    case 'review_session_effort':
      runtimeSettings.review_session_effort = value as string;
      break;
    case 'session_mode':
      runtimeSettings.session_mode = value as 'cli' | 'api';
      break;
    case 'auto_launch_concurrency':
      runtimeSettings.auto_launch_concurrency = value as number;
      break;
    case 'auto_launch_poll_interval_ms':
      runtimeSettings.auto_launch_poll_interval_ms = value as number;
      break;
    case 'hourly_usage_pause_threshold_percent':
      runtimeSettings.hourly_usage_pause_threshold_percent = value as string;
      break;
    case 'weekly_usage_pause_threshold_percent':
      runtimeSettings.weekly_usage_pause_threshold_percent = value as string;
      break;
    case 'min_host_free_memory_mb':
      runtimeSettings.min_host_free_memory_mb = value as number;
      break;
    case 'per_session_reserve_mb':
      runtimeSettings.per_session_reserve_mb = value as number;
      break;
    case 'session_cgroup_prod_reserve_mb':
      runtimeSettings.session_cgroup_prod_reserve_mb = value as number;
      reapplySessionCgroupLimits();
      break;
    case 'session_cgroup_memory_high_fraction':
      runtimeSettings.session_cgroup_memory_high_fraction = value as number;
      reapplySessionCgroupLimits();
      break;
    case 'session_cgroup_deny_swap':
      runtimeSettings.session_cgroup_deny_swap = value as boolean;
      reapplySessionCgroupLimits();
      break;
    case 'session_notify_threshold_seconds':
      runtimeSettings.session_notify_threshold_seconds = value as number;
      break;
    case 'session_pause_threshold_seconds':
      runtimeSettings.session_pause_threshold_seconds = value as number;
      break;
    case 'session_inert_threshold_seconds':
      runtimeSettings.session_inert_threshold_seconds = value as number;
      break;
    case 'session_hard_stop_window_seconds':
      runtimeSettings.session_hard_stop_window_seconds = value as number;
      break;
    case 'ci_poll_interval_seconds':
      runtimeSettings.ci_poll_interval_seconds = value as number;
      break;
    case 'ci_poll_max_minutes':
      runtimeSettings.ci_poll_max_minutes = value as number;
      break;
    case 'max_review_iterations':
      runtimeSettings.max_review_iterations = value as number;
      break;
    case 'pr_boot_sweep_merged_lookback_days':
      runtimeSettings.pr_boot_sweep_merged_lookback_days = value as number;
      break;
    case 'auto_archive_enabled':
      runtimeSettings.auto_archive_enabled = value as boolean;
      break;
    case 'auto_archive_grace_minutes':
      runtimeSettings.auto_archive_grace_minutes = value as number;
      break;
    case 'auto_archive_sweep_interval_minutes':
      runtimeSettings.auto_archive_sweep_interval_minutes = value as number;
      break;
    case 'large_task_model':
      runtimeSettings.large_task_model = value as string;
      break;
    case 'large_task_effort':
      runtimeSettings.large_task_effort = value as string;
      break;
    case 'planning_session_model':
      runtimeSettings.planning_session_model = value as string;
      break;
    case 'planning_session_effort':
      runtimeSettings.planning_session_effort = value as string;
      break;
    case 'ops_session_model':
      runtimeSettings.ops_session_model = value as string;
      break;
    case 'ops_session_effort':
      runtimeSettings.ops_session_effort = value as string;
      break;
    case 'gate_verify_session_model':
      runtimeSettings.gate_verify_session_model = value as string;
      break;
    case 'gate_verify_session_effort':
      runtimeSettings.gate_verify_session_effort = value as string;
      break;
    case 'investigate_session_model':
      runtimeSettings.investigate_session_model = value as string;
      break;
    case 'investigate_session_effort':
      runtimeSettings.investigate_session_effort = value as string;
      break;
    case 'groom_session_model':
      runtimeSettings.groom_session_model = value as string;
      break;
    case 'groom_session_effort':
      runtimeSettings.groom_session_effort = value as string;
      break;
    case 'design_session_model':
      runtimeSettings.design_session_model = value as string;
      break;
    case 'design_session_effort':
      runtimeSettings.design_session_effort = value as string;
      break;
    case 'docs_session_model':
      runtimeSettings.docs_session_model = value as string;
      break;
    case 'docs_session_effort':
      runtimeSettings.docs_session_effort = value as string;
      break;
    case 'tier3_classifier_model':
      runtimeSettings.tier3_classifier_model = value as string;
      break;
    case 'capability_auto_approve_allowlist':
      runtimeSettings.capability_auto_approve_allowlist = value as string[];
      break;
    case 'milestone_attention_aging_threshold_seconds':
      runtimeSettings.milestone_attention_aging_threshold_seconds =
        value as number;
      break;
    case 'milestone_attention_flat_convergence_window_seconds':
      runtimeSettings.milestone_attention_flat_convergence_window_seconds =
        value as number;
      break;
    case 'decision_pick_one_paragraph_threshold':
      runtimeSettings.decision_pick_one_paragraph_threshold = value as number;
      break;
  }
}

/** Seed runtimeSettings from DB, falling back to schema defaults for missing/malformed keys. */
export function loadRuntimeSettingsFromDb(): void {
  for (const key of SETTING_KEYS) {
    applyToRuntime(key, typedGetSetting(key));
  }
}

function runtimeSettingsAsRecord(): {
  [K in RouteSettingKey]: Settings[K] extends string[] ? string[] : string;
} {
  return {
    max_concurrent_code_sessions: String(
      runtimeSettings.max_concurrent_code_sessions,
    ),
    max_concurrent_planning_sessions: String(
      runtimeSettings.max_concurrent_planning_sessions,
    ),
    max_concurrent_verify_sessions: String(
      runtimeSettings.max_concurrent_verify_sessions,
    ),
    auto_review_concurrency: String(runtimeSettings.auto_review_concurrency),
    auto_review: String(runtimeSettings.auto_review),
    card_preview_lines: String(runtimeSettings.card_preview_lines),
    code_session_model: runtimeSettings.code_session_model,
    review_session_model: runtimeSettings.review_session_model,
    code_session_effort: runtimeSettings.code_session_effort,
    review_session_effort: runtimeSettings.review_session_effort,
    session_mode: runtimeSettings.session_mode,
    auto_launch_concurrency: String(runtimeSettings.auto_launch_concurrency),
    auto_launch_poll_interval_ms: String(
      runtimeSettings.auto_launch_poll_interval_ms,
    ),
    hourly_usage_pause_threshold_percent:
      runtimeSettings.hourly_usage_pause_threshold_percent,
    weekly_usage_pause_threshold_percent:
      runtimeSettings.weekly_usage_pause_threshold_percent,
    min_host_free_memory_mb: String(runtimeSettings.min_host_free_memory_mb),
    per_session_reserve_mb: String(runtimeSettings.per_session_reserve_mb),
    session_cgroup_prod_reserve_mb: String(
      runtimeSettings.session_cgroup_prod_reserve_mb,
    ),
    session_cgroup_memory_high_fraction: String(
      runtimeSettings.session_cgroup_memory_high_fraction,
    ),
    session_cgroup_deny_swap: String(runtimeSettings.session_cgroup_deny_swap),
    session_notify_threshold_seconds: String(
      runtimeSettings.session_notify_threshold_seconds,
    ),
    session_pause_threshold_seconds: String(
      runtimeSettings.session_pause_threshold_seconds,
    ),
    session_inert_threshold_seconds: String(
      runtimeSettings.session_inert_threshold_seconds,
    ),
    session_hard_stop_window_seconds: String(
      runtimeSettings.session_hard_stop_window_seconds,
    ),
    ci_poll_interval_seconds: String(runtimeSettings.ci_poll_interval_seconds),
    ci_poll_max_minutes: String(runtimeSettings.ci_poll_max_minutes),
    max_review_iterations: String(runtimeSettings.max_review_iterations),
    pr_boot_sweep_merged_lookback_days: String(
      runtimeSettings.pr_boot_sweep_merged_lookback_days,
    ),
    auto_archive_enabled: String(runtimeSettings.auto_archive_enabled),
    auto_archive_grace_minutes: String(
      runtimeSettings.auto_archive_grace_minutes,
    ),
    auto_archive_sweep_interval_minutes: String(
      runtimeSettings.auto_archive_sweep_interval_minutes,
    ),
    large_task_model: runtimeSettings.large_task_model,
    large_task_effort: runtimeSettings.large_task_effort,
    planning_session_model: runtimeSettings.planning_session_model,
    planning_session_effort: runtimeSettings.planning_session_effort,
    ops_session_model: runtimeSettings.ops_session_model,
    ops_session_effort: runtimeSettings.ops_session_effort,
    gate_verify_session_model: runtimeSettings.gate_verify_session_model,
    gate_verify_session_effort: runtimeSettings.gate_verify_session_effort,
    investigate_session_model: runtimeSettings.investigate_session_model,
    investigate_session_effort: runtimeSettings.investigate_session_effort,
    groom_session_model: runtimeSettings.groom_session_model,
    groom_session_effort: runtimeSettings.groom_session_effort,
    design_session_model: runtimeSettings.design_session_model,
    design_session_effort: runtimeSettings.design_session_effort,
    docs_session_model: runtimeSettings.docs_session_model,
    docs_session_effort: runtimeSettings.docs_session_effort,
    tier3_classifier_model: runtimeSettings.tier3_classifier_model,
    capability_auto_approve_allowlist:
      runtimeSettings.capability_auto_approve_allowlist,
    milestone_attention_aging_threshold_seconds: String(
      runtimeSettings.milestone_attention_aging_threshold_seconds,
    ),
    milestone_attention_flat_convergence_window_seconds: String(
      runtimeSettings.milestone_attention_flat_convergence_window_seconds,
    ),
    decision_pick_one_paragraph_threshold: String(
      runtimeSettings.decision_pick_one_paragraph_threshold,
    ),
  };
}

interface CapabilityAutoAllowSuggestion {
  projectId: string;
  capability: string;
  /** Length of the current unbroken run of operator_approved dispositions for this key. */
  approvedStreak: number;
}

/**
 * Read-only mining pass over the capability_request_disposition audit trail:
 * suggests capabilities an operator has approved by hand often enough
 * (3 consecutive operator_approved dispositions, per key, with zero
 * operator_denied/declined ever recorded against that same key) to be worth
 * adding to `capability_auto_approve_allowlist`. Never writes the allowlist
 * or `GRANT_DENYLIST_PATTERNS` itself — the operator applies a suggestion
 * through the existing Settings UI.
 *
 * Keyed by the exact (project_id, capability) pair, never a coarser
 * tool-name/command-prefix grouping. "Consecutive" is per-key: an
 * auto_approved disposition for the same key (e.g. it was already
 * allowlisted at that point and later removed) breaks the run, since it is
 * not an operator_approved. A key with any operator_denied/declined
 * disposition ever recorded is permanently disqualified from producing a
 * fresh suggestion, regardless of approvals before or after — there is no
 * lift mechanism here (that belongs to the companion disqualification/lift
 * design).
 */
function computeCapabilityAutoAllowSuggestions(): CapabilityAutoAllowSuggestion[] {
  interface KeyState {
    projectId: string;
    capability: string;
    streak: number;
    disqualified: boolean;
  }
  const states = new Map<string, KeyState>();
  const order: string[] = [];

  for (const event of getCapabilityDispositionEvents()) {
    const key = JSON.stringify([event.projectId, event.capability]);
    let state = states.get(key);
    if (!state) {
      state = {
        projectId: event.projectId,
        capability: event.capability,
        streak: 0,
        disqualified: false,
      };
      states.set(key, state);
      order.push(key);
    }
    if (state.disqualified) continue;
    if (
      event.disposition === 'operator_denied' ||
      event.disposition === 'declined'
    ) {
      state.disqualified = true;
      state.streak = 0;
    } else if (event.disposition === 'operator_approved') {
      state.streak += 1;
    } else {
      // auto_approved — not an operator_approved, breaks the consecutive run.
      state.streak = 0;
    }
  }

  const allowlist = new Set(runtimeSettings.capability_auto_approve_allowlist);
  const suggestions: CapabilityAutoAllowSuggestion[] = [];
  for (const key of order) {
    const state = states.get(key);
    if (!state || state.disqualified || state.streak < 3) continue;
    if (allowlist.has(state.capability)) continue;
    if (!isGrantable(state.capability)) continue;
    suggestions.push({
      projectId: state.projectId,
      capability: state.capability,
      approvedStreak: state.streak,
    });
  }
  return suggestions;
}

// GET /api/settings
router.get('/', (_req: Request, res: Response) => {
  res.json({
    ...runtimeSettingsAsRecord(),
    capability_auto_allow_suggestions: computeCapabilityAutoAllowSuggestions(),
  });
});

// PATCH /api/settings — validates each value against the schema before persisting.
// Returns 400 with an error message if any value fails validation (fail-loud, no silent save).
router.patch('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const updated: Partial<Record<RouteSettingKey, unknown>> = {};

  for (const key of SETTING_KEYS) {
    if (key in body && body[key] !== undefined) {
      try {
        // typedSetSetting validates with Zod and throws ZodError for bad values
        const typed = typedSetSetting(key, body[key] as never);
        applyToRuntime(key, typed);
        updated[key] = typed;
      } catch (err) {
        res.status(400).json({
          error: `Invalid value for "${key}": ${(err as Error).message}`,
        });
        return;
      }
    }
  }

  res.json({ updated, current: runtimeSettingsAsRecord() });
});

// Merge all settings from DB (used after startup to override env defaults)
router.get('/all-raw', (_req: Request, res: Response) => {
  res.json(getAllSettings());
});

export default router;
