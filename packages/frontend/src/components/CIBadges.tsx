import styles from './CIBadges.module.css';

export type PreReviewStage =
  | 'autofix'
  | 'verify'
  | 'analyzing'
  | 'tests'
  | 'awaiting_review'
  | 'blocked_autofix'
  | 'blocked_verify'
  | 'blocked_analyze';

const STAGE_CONFIG: Record<
  PreReviewStage,
  { emoji: string; label: string; compactLabel: string; styleKey: string }
> = {
  autofix: {
    emoji: '⚙',
    label: 'Running autofix',
    compactLabel: 'Autofix',
    styleKey: 'running',
  },
  verify: {
    emoji: '🔍',
    label: 'Running verify',
    compactLabel: 'Verify',
    styleKey: 'running',
  },
  analyzing: {
    emoji: '🔬',
    label: 'Running analyze',
    compactLabel: 'Analyze',
    styleKey: 'running',
  },
  tests: {
    emoji: '🧪',
    label: 'Running tests',
    compactLabel: 'Tests',
    styleKey: 'running',
  },
  awaiting_review: {
    emoji: '⏳',
    label: 'Awaiting review',
    compactLabel: 'Awaiting',
    styleKey: 'awaiting',
  },
  blocked_autofix: {
    emoji: '❌',
    label: 'Autofix failed',
    compactLabel: 'Autofix',
    styleKey: 'blocked',
  },
  blocked_verify: {
    emoji: '❌',
    label: 'Verify failed',
    compactLabel: 'Verify',
    styleKey: 'blocked',
  },
  blocked_analyze: {
    emoji: '❌',
    label: 'Analyze failed',
    compactLabel: 'Analyze',
    styleKey: 'blocked',
  },
};

export interface PipelineStageBadgeProps {
  stage: string | null;
  prState?: string;
  compact?: boolean;
  /** For blocked stages: the failed command to show on hover */
  failedCommand?: string;
}

export function PipelineStageBadge({
  stage,
  prState,
  compact = false,
  failedCommand,
}: PipelineStageBadgeProps) {
  if (!stage) return null;
  if (prState === 'merged' || prState === 'closed') return null;

  const config = STAGE_CONFIG[stage as PreReviewStage];
  if (!config) return null;

  const isRunning = config.styleKey === 'running';
  const isAwaiting = config.styleKey === 'awaiting';
  const isBlocked = config.styleKey === 'blocked';

  const title = failedCommand
    ? `${config.label}: ${failedCommand}`
    : config.label;

  const className = isRunning
    ? styles.pipelineRunningBadge
    : isAwaiting
      ? styles.pipelineAwaitingBadge
      : isBlocked
        ? styles.pipelineBlockedBadge
        : styles.pipelineRunningBadge;

  const text = compact
    ? `${config.emoji} ${config.compactLabel}`
    : `${config.emoji} ${config.label}`;

  return (
    <span className={className} title={title}>
      {isRunning && (
        <span className={styles.pipelineSpinner} aria-hidden="true" />
      )}
      {text}
    </span>
  );
}

export interface CIBadgesProps {
  mergeState: string | null;
  pauseReason?: string | null;
  prState?: string;
  ciChecksUrl?: string;
  failingChecks?: string[];
  awaitingReReview?: boolean;
}

export function CIBadges({
  mergeState,
  pauseReason,
  prState,
  ciChecksUrl,
  failingChecks = [],
  awaitingReReview = false,
}: CIBadgesProps) {
  if (prState === 'merged' || prState === 'closed') return null;

  const showCiFailing =
    mergeState === 'ci_failed' || pauseReason === 'ci_failing';
  const showBillingBlocked = pauseReason === 'ci_billing_blocked';
  const showAnalyzeFailing = pauseReason === 'analyze_failing';
  const showUnstable = mergeState === 'unstable';
  const showRunning = mergeState === 'ci_running';

  if (
    !showCiFailing &&
    !showBillingBlocked &&
    !showAnalyzeFailing &&
    !showUnstable &&
    !showRunning &&
    !awaitingReReview
  )
    return null;

  const ciFailingTitle =
    failingChecks.length > 0
      ? `Failing checks: ${failingChecks.join(', ')}`
      : 'CI checks are failing';
  const ciFailingText =
    '❌ CI failing' +
    (failingChecks.length > 0 ? `: ${failingChecks.join(', ')}` : '');

  return (
    <>
      {showCiFailing &&
        (ciChecksUrl ? (
          <a
            href={ciChecksUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.ciBadge}
            title={ciFailingTitle}
          >
            {ciFailingText}
          </a>
        ) : (
          <span className={styles.ciBadge} title={ciFailingTitle}>
            {ciFailingText}
          </span>
        ))}
      {showBillingBlocked && (
        <span
          className={styles.ciBadge}
          title="GitHub Actions billing/spending limit reached — jobs cannot start. Resolve billing in GitHub settings, then re-run failed jobs."
        >
          ❌ Billing limit — jobs blocked
        </span>
      )}
      {showAnalyzeFailing && (
        <span
          className={styles.ciBadge}
          title="Static analysis gate failed — fix the reported issues and re-push."
        >
          ❌ Analyze failing
        </span>
      )}
      {showUnstable && (
        <span
          className={styles.unstableBadge}
          title="CI is unstable — checks may be failing"
        >
          ⚠ CI unstable
        </span>
      )}
      {showRunning && (
        <span className={styles.runningBadge} title="CI checks are in progress">
          <span className={styles.spinner} aria-hidden="true" />
          CI running
        </span>
      )}
      {awaitingReReview && (
        <span
          className={styles.awaitingReReviewBadge}
          title="A fix was pushed — the pipeline will re-run review when ready."
        >
          ⏳ Fix pushed — awaiting re-review
        </span>
      )}
    </>
  );
}
