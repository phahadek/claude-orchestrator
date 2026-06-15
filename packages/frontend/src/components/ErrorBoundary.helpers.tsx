import type { ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

export const appRootFallback = (error: Error, reset: () => void): ReactNode => (
  <div className={styles.appRoot} role="alert">
    <h1>Something went wrong.</h1>
    <p>
      <strong>{error.name}:</strong> {error.message}
    </p>
    <div className={styles.actions}>
      <button type="button" onClick={() => window.location.reload()}>
        Reload page
      </button>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  </div>
);
