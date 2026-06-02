import styles from './RateLimitBanner.module.css';

interface Props {
  resetAt: string; // ISO-8601
  onDismiss: () => void;
}

export function RateLimitBanner({ resetAt, onDismiss }: Props) {
  const resetDate = new Date(resetAt);
  const resetTime = resetDate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className={styles.banner}
      role="alert"
      aria-label="GitHub API rate limited"
    >
      <span className={styles.icon}>⚠️</span>
      <span className={styles.message}>
        GitHub API rate-limited until{' '}
        <span className={styles.resetTime}>{resetTime}</span> — PR state may be
        stale
      </span>
      <button className={styles.dismissBtn} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
