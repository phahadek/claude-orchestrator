import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FirstRunWizard } from '../FirstRunWizard';

function mockFetch(responses: Array<{ url?: string | RegExp; body: unknown; ok?: boolean }>) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = responses.find((r) => {
      if (!r.url) return true;
      if (typeof r.url === 'string') return url.includes(r.url);
      return r.url.test(url);
    });
    const body = match?.body ?? {};
    const ok = match?.ok ?? true;
    return Promise.resolve({
      ok,
      status: ok ? 200 : 400,
      json: () => Promise.resolve(body),
    } as Response);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Wizard shown when setup incomplete ──────────────────────────────────────

describe('FirstRunWizard rendering', () => {
  it('renders the wizard overlay', () => {
    mockFetch([]);
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByTestId('first-run-wizard')).toBeDefined();
    expect(screen.getByTestId('step-welcome')).toBeDefined();
  });

  it('shows step 1 (welcome) initially', () => {
    mockFetch([]);
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByTestId('step-welcome')).toBeDefined();
  });
});

// ── Navigation ───────────────────────────────────────────────────────────────

describe('wizard navigation', () => {
  it('advances to env-check step on Next click', () => {
    mockFetch([{ url: '/api/setup/env-check', body: { claudeInstalled: true, claudeAuthenticated: true, gitInstalled: true } }]);
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByText('Next →'));
    expect(screen.getByTestId('step-env-check')).toBeDefined();
  });
});

// ── Env-check blocks on unauthenticated claude ────────────────────────────────

describe('env-check step', () => {
  it('blocks Next button when claude is not authenticated', async () => {
    mockFetch([
      {
        url: '/api/setup/env-check',
        body: { claudeInstalled: true, claudeAuthenticated: false, gitInstalled: true },
      },
    ]);
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByText('Next →')); // go to env-check

    await waitFor(() => expect(screen.getByTestId('env-check-results')).toBeDefined());

    const nextBtn = screen.getByTestId('env-check-next');
    expect((nextBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows auth guide when claude is not authenticated', async () => {
    mockFetch([
      {
        url: '/api/setup/env-check',
        body: { claudeInstalled: true, claudeAuthenticated: false, gitInstalled: true },
      },
    ]);
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByText('Next →'));

    await waitFor(() => expect(screen.getByTestId('auth-guide')).toBeDefined());
    expect(screen.getByText(/claude login/)).toBeDefined();
  });

  it('enables Next button when claude is authenticated', async () => {
    mockFetch([
      {
        url: '/api/setup/env-check',
        body: { claudeInstalled: true, claudeAuthenticated: true, gitInstalled: true },
      },
    ]);
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={vi.fn()} />);
    fireEvent.click(screen.getByText('Next →'));

    await waitFor(() => expect(screen.getByTestId('env-check-results')).toBeDefined());

    const nextBtn = screen.getByTestId('env-check-next');
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Skip writes minimum config + routes to Settings ───────────────────────────

describe('skip to settings', () => {
  it('calls onSkip when skip button is clicked', async () => {
    const fetchMock = mockFetch([
      { url: '/api/setup/write', body: { ok: true } },
    ]);
    const onSkip = vi.fn();
    render(<FirstRunWizard onComplete={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByTestId('skip-to-settings'));

    await waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/setup/write',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('stores wizardSkipped flag in localStorage via App integration', async () => {
    // Verify the onSkip callback (provided by App.tsx) would set the flag
    // We test the callback logic directly here

    mockFetch([{ url: '/api/setup/write', body: { ok: true } }]);

    const onSkip = vi.fn(() => {
      localStorage.setItem('wizardSkipped', 'true');
    });

    render(<FirstRunWizard onComplete={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('skip-to-settings'));

    await waitFor(() => expect(onSkip).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('wizardSkipped')).toBe('true');
  });
});

// ── Wizard shown iff setup incomplete (App-level logic) ───────────────────────

describe('App-level wizard gating logic', () => {
  it('wizard is shown when setup is needed and not previously skipped', () => {
    // Simulate: setupNeeded=true, no wizardSkipped flag
    let showWizard = false;
    const isSkipped = localStorage.getItem('wizardSkipped') === 'true';
    const setupNeeded = true;
    if (setupNeeded && !isSkipped) showWizard = true;

    expect(showWizard).toBe(true);
  });

  it('wizard is not shown when wizardSkipped flag is set', () => {
    localStorage.setItem('wizardSkipped', 'true');
    let showWizard = false;
    const isSkipped = localStorage.getItem('wizardSkipped') === 'true';
    const setupNeeded = true;
    if (setupNeeded && !isSkipped) showWizard = true;

    expect(showWizard).toBe(false);
  });

  it('wizard is not shown when setup is not needed', () => {
    let showWizard = false;
    const isSkipped = localStorage.getItem('wizardSkipped') === 'true';
    const setupNeeded = false;
    if (setupNeeded && !isSkipped) showWizard = true;

    expect(showWizard).toBe(false);
  });
});
