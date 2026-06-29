import { useState } from 'react';
import { authedFetch } from '../../api/projects';
import styles from './UpdateBanner.module.css';

interface Props {
  version: string;
  releaseNotesUrl: string;
  onDismiss: (version: string) => void;
}

export function UpdateBanner({ version, releaseNotesUrl, onDismiss }: Props) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    try {
      const res = await authedFetch('/api/update/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Install failed');
        setInstalling(false);
      }
      // Backend will exit — no further action needed on success
    } catch (err) {
      setError((err as Error).message);
      setInstalling(false);
    }
  }

  async function handleDismiss() {
    try {
      await authedFetch('/api/update/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
    } catch {
      // best effort
    }
    onDismiss(version);
  }

  return (
    <div className={styles.banner} role="banner" aria-label="Update available">
      <span className={styles.icon}>⬆️</span>
      <span className={styles.message}>
        <span className={styles.version}>{version}</span> is available.
        <a
          href={releaseNotesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
        >
          Release notes
        </a>
        {error && (
          <span style={{ color: 'var(--color-error, #f38ba8)', marginLeft: 8 }}>
            {error}
          </span>
        )}
      </span>
      <div className={styles.actions}>
        <button
          className={styles.installBtn}
          onClick={() => void handleInstall()}
          disabled={installing}
        >
          {installing ? 'Installing…' : 'Install now'}
        </button>
        <button
          className={styles.dismissBtn}
          onClick={() => void handleDismiss()}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
