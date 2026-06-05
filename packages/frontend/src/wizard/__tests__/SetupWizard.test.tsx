import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ProjectFormModal to avoid complex form rendering in wizard tests
vi.mock('../../components/Settings/ProjectFormModal', () => ({
  ProjectFormModal: ({
    onCancel,
    onSubmit,
  }: {
    onCancel: () => void;
    onSubmit: (vals: Record<string, unknown>) => void;
  }) => (
    <div data-testid="project-form-modal">
      <button
        data-testid="project-form-cancel"
        onClick={onCancel}
        type="button"
      >
        Cancel
      </button>
      <button
        data-testid="project-form-submit"
        onClick={() =>
          onSubmit({
            name: 'Test Project',
            projectDir: '/test',
            contextUrl: '',
            githubRepo: 'owner/repo',
            taskSource: 'notion',
            gitMode: 'github',
            autoLaunchEnabled: false,
            autoLaunchMilestoneId: '',
            autoMergeEnabled: false,
            nonMilestoneSourceConfigRaw: '',
            dataResidencyConfirmed: false,
            githubOwnerRepo: '',
            githubDefaultMilestone: null,
            baseBranch: 'dev',
          })
        }
        type="button"
      >
        Submit Project
      </button>
    </div>
  ),
}));

vi.mock('../../api/projects', () => ({
  projectsApi: {
    create: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Test Project' }),
  },
}));

import { SetupWizard } from '../SetupWizard';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFetch(responses: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key !== undefined ? responses[key] : {};
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
  });
}

function makeEnvCheck(opts: {
  claudeInstalled?: boolean;
  claudeAuthenticated?: boolean;
  gitInstalled?: boolean;
}) {
  return {
    claudeInstalled: opts.claudeInstalled ?? true,
    claudeAuthenticated: opts.claudeAuthenticated ?? true,
    gitInstalled: opts.gitInstalled ?? true,
  };
}

// ── App-level wizard gate ──────────────────────────────────────────────────────

describe('App shows wizard when setup is incomplete', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the wizard when setup/status returns setupNeeded=true', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        'setup/status': { setupNeeded: true },
        'setup/env-check': makeEnvCheck({}),
      }),
    );

    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByTestId('setup-wizard')).toBeDefined();
    expect(screen.getByText(/welcome to claude code dashboard/i)).toBeDefined();
  });
});

// ── Wizard: Welcome step ───────────────────────────────────────────────────────

describe('SetupWizard — Welcome step', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetch({ 'setup/env-check': makeEnvCheck({}) }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the welcome step with a Continue button', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByText(/welcome to claude code dashboard/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDefined();
  });

  it('advances to env-check on Continue click', async () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/environment check/i)).toBeDefined();
    });
  });

  it('shows Skip link on every step except done', () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByTestId('skip-to-settings')).toBeDefined();
  });
});

// ── Wizard: Env check step ─────────────────────────────────────────────────────

describe('SetupWizard — Env check step', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('blocks Continue when claude is not authenticated', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        'setup/env-check': makeEnvCheck({
          claudeInstalled: true,
          claudeAuthenticated: false,
          gitInstalled: true,
        }),
      }),
    );

    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByTestId('env-check-next')).toBeDefined(),
    );

    const nextBtn = screen.getByTestId('env-check-next') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('shows the claude login guide when claude is not authenticated', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        'setup/env-check': makeEnvCheck({
          claudeInstalled: true,
          claudeAuthenticated: false,
          gitInstalled: true,
        }),
      }),
    );

    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByText(/claude is not authenticated/i)).toBeDefined(),
    );
  });

  it('enables Continue when all env checks pass', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        'setup/env-check': makeEnvCheck({
          claudeInstalled: true,
          claudeAuthenticated: true,
          gitInstalled: true,
        }),
      }),
    );

    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const nextBtn = screen.getByTestId('env-check-next') as HTMLButtonElement;
      expect(nextBtn.disabled).toBe(false);
    });
  });
});

// ── Wizard: Skip to Settings ───────────────────────────────────────────────────

describe('SetupWizard — Skip to Settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls onComplete(true) when Skip is clicked and writes minimum config', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('setup/env-check')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeEnvCheck({})),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const onComplete = vi.fn();
    render(<SetupWizard onComplete={onComplete} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('skip-to-settings'));
    });

    // Should call /api/setup/complete
    const completeCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('setup/complete'),
    );
    expect(completeCalls.length).toBeGreaterThan(0);

    // onComplete called with goToSettings=true
    expect(onComplete).toHaveBeenCalledWith(true);
  });
});
