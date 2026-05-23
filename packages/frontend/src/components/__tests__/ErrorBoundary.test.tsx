import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';

function Thrower({
  shouldThrow,
  label = 'safe',
}: {
  shouldThrow: boolean;
  label?: string;
}) {
  if (shouldThrow) throw new Error('boom');
  return <div>{label}</div>;
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence React's logged error */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary name="Test">
        <Thrower shouldThrow={false} label="ok" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('ok')).toBeDefined();
  });

  it('renders the fallback UI with the boundary name when a child throws', () => {
    render(
      <ErrorBoundary name="MyBoundary">
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText(/MyBoundary/)).toBeDefined();
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it('logs the boundary name and error to console.error', () => {
    render(
      <ErrorBoundary name="LoggedBoundary">
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );
    const matched = consoleErrorSpy.mock.calls.some(
      (args) =>
        args.some(
          (arg) => typeof arg === 'string' && arg.includes('LoggedBoundary'),
        ) && args.some((arg) => arg instanceof Error && arg.message === 'boom'),
    );
    expect(matched).toBe(true);
  });

  it('Reset re-mounts children when the throw flag is cleared', () => {
    const { rerender } = render(
      <ErrorBoundary name="Test">
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();

    rerender(
      <ErrorBoundary name="Test">
        <Thrower shouldThrow={false} label="recovered" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByText('recovered')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Reload page calls window.location.reload', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, reload },
      configurable: true,
    });

    render(
      <ErrorBoundary name="Test">
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /reload page/i }));
    expect(reload).toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      value: original,
      configurable: true,
    });
  });

  it('a sibling outside the failing boundary continues to render', () => {
    render(
      <div>
        <ErrorBoundary name="Failing">
          <Thrower shouldThrow={true} />
        </ErrorBoundary>
        <div>SiblingContent</div>
      </div>,
    );
    expect(screen.getByText('SiblingContent')).toBeDefined();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('inner boundary catches errors without affecting outer siblings (hierarchical isolation)', () => {
    render(
      <ErrorBoundary name="Outer">
        <div>
          <ErrorBoundary name="Inner">
            <Thrower shouldThrow={true} />
          </ErrorBoundary>
          <div>OuterSibling</div>
        </div>
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Error in Inner/)).toBeDefined();
    expect(screen.getByText('OuterSibling')).toBeDefined();
    expect(screen.queryByText(/Error in Outer/)).toBeNull();
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary
        name="Custom"
        fallback={(error, reset) => (
          <div>
            <span>custom-fallback:{error.message}</span>
            <button type="button" onClick={reset}>
              custom-reset
            </button>
          </div>
        )}
      >
        <Thrower shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom-fallback:boom')).toBeDefined();
    expect(screen.getByRole('button', { name: 'custom-reset' })).toBeDefined();
  });
});
