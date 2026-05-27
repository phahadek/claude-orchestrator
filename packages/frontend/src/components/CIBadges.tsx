import styles from './CIBadges.module.css';

export interface CIBadgesProps {
  mergeState: string | null;
  pauseReason?: string | null;
  prState?: string;
  ciChecksUrl?: string;
  failingChecks?: string[];
}

export function CIBadges({
  mergeState,
  pauseReason,
  prState,
  ciChecksUrl,
  failingChecks = [],
}: CIBadgesProps) {
  if (prState === 'merged' || prState === 'closed') return null;

  const showCiFailing =
    mergeState === 'ci_failed' || pauseReason === 'ci_failing';
  const showUnstable = mergeState === 'unstable';

  if (!showCiFailing && !showUnstable) return null;

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
      {showUnstable && (
        <span
          className={styles.unstableBadge}
          title="CI is unstable — checks may be failing"
        >
          ⚠ CI unstable
        </span>
      )}
    </>
  );
}
