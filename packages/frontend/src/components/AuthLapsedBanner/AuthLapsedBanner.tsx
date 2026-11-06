import { useState } from 'react';
import { apiRequest } from '../../api/projects';
import styles from './AuthLapsedBanner.module.css';

export function AuthLapsedBanner() {
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  const recheck = () => {
    setChecking(true);
    setFailed(false);
    apiRequest<{ outcome: string }>('/api/auth-lapse/recheck', {
      method: 'POST',
    })
      .then((res) => setFailed(res.outcome !== 'success'))
      .catch(() => setFailed(true))
      .finally(() => setChecking(false));
  };

  return (
    <div
      className={styles.banner}
      role="alert"
      aria-label="CLI authentication lapsed"
    >
      <span className={styles.icon}>🔑</span>
      <span className={styles.message}>
        Claude CLI authentication has lapsed — new work and nudges are paused
        until it is restored.
        {failed && ' Still failing; will retry automatically.'}
      </span>
      <button className={styles.btn} onClick={recheck} disabled={checking}>
        {checking ? 'Checking…' : 'Recheck auth now'}
      </button>
    </div>
  );
}
