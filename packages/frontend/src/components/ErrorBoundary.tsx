import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryProps {
  name: string;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onReset?: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.name}]`, error, info);
  }

  handleReset = (): void => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
    this.props.onReset?.();
  };

  handleReload = (): void => {
    window.location.reload();
  };

  handleCopyDetails = (): void => {
    const { error } = this.state;
    if (!error) return;
    const text = `[${this.props.name}] ${error.name}: ${error.message}\n${error.stack ?? ''}`;
    void navigator.clipboard?.writeText(text).catch(() => {
      /* clipboard unavailable — silently ignore */
    });
  };

  render(): ReactNode {
    const { error, resetKey } = this.state;
    if (!error) {
      return <Fragment key={resetKey}>{this.props.children}</Fragment>;
    }
    if (this.props.fallback) {
      return this.props.fallback(error, this.handleReset);
    }
    return (
      <div className={styles.boundary} role="alert">
        <h3 className={styles.title}>Error in {this.props.name}</h3>
        <p className={styles.message}>
          <strong>{error.name}:</strong> {error.message}
        </p>
        <div className={styles.actions}>
          <button type="button" onClick={this.handleReset}>Reset</button>
          <button type="button" onClick={this.handleReload}>Reload page</button>
          <button type="button" onClick={this.handleCopyDetails}>Copy details</button>
        </div>
      </div>
    );
  }
}

export const appRootFallback = (error: Error, reset: () => void): ReactNode => (
  <div className={styles.appRoot} role="alert">
    <h1>Something went wrong.</h1>
    <p>
      <strong>{error.name}:</strong> {error.message}
    </p>
    <div className={styles.actions}>
      <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      <button type="button" onClick={reset}>Try again</button>
    </div>
  </div>
);
