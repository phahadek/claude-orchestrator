import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ProjectFormModal,
  type ProjectFormValues,
} from '../components/Settings/ProjectFormModal';
import { projectsApi } from '../api/projects';
import type {
  GithubTaskSourceConfig,
  NonMilestoneSourceConfig,
} from '../api/projects';
import styles from './SetupWizard.module.css';

type WizardStep = 'welcome' | 'env-check' | 'credentials' | 'project' | 'done';

interface EnvCheckResult {
  claudeInstalled: boolean;
  claudeAuthenticated: boolean;
  gitInstalled: boolean;
}

interface ValidationState {
  github: 'idle' | 'checking' | 'ok' | 'error';
  githubMsg: string;
  notion: 'idle' | 'checking' | 'ok' | 'error';
  notionMsg: string;
}

interface Props {
  onComplete: (goToSettings?: boolean) => void;
}

const STEPS: WizardStep[] = [
  'welcome',
  'env-check',
  'credentials',
  'project',
  'done',
];
const STEP_LABELS = ['Welcome', 'Env', 'Credentials', 'Project', 'Done'];

function toCreatePayload(values: ProjectFormValues) {
  const rawCfg = values.nonMilestoneSourceConfigRaw.trim();
  const nonMilestoneSourceConfig: NonMilestoneSourceConfig | null = rawCfg
    ? (JSON.parse(rawCfg) as NonMilestoneSourceConfig)
    : null;

  let taskSourceConfig: string | null = null;
  if (values.taskSource === 'github') {
    const ownerRepo = values.githubOwnerRepo.trim();
    const [owner, repo] = ownerRepo.split('/');
    const cfg: GithubTaskSourceConfig = {
      owner,
      repo,
      defaultMilestone: values.githubDefaultMilestone ?? null,
    };
    taskSourceConfig = JSON.stringify(cfg);
  }

  return {
    name: values.name.trim(),
    projectDir: values.projectDir.trim(),
    contextUrl: values.contextUrl.trim() || null,
    githubRepo:
      values.gitMode !== 'local-only' ? values.githubRepo.trim() || null : null,
    taskSource: values.taskSource,
    taskSourceConfig,
    gitMode: values.gitMode,
    autoLaunchEnabled: values.autoLaunchEnabled,
    autoLaunchMilestoneId: values.autoLaunchMilestoneId.trim() || null,
    autoMergeEnabled:
      values.gitMode !== 'local-only' ? values.autoMergeEnabled : false,
    nonMilestoneSourceConfig,
    dataResidencyConfirmed: values.dataResidencyConfirmed,
    baseBranch: values.baseBranch || 'dev',
  };
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<T>;
}

export function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<WizardStep>('welcome');

  // Welcome / Import state
  const [importPath, setImportPath] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Env check state
  const [envCheck, setEnvCheck] = useState<EnvCheckResult | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const envPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Credentials state
  const [githubToken, setGithubToken] = useState('');
  const [notionToken, setNotionToken] = useState('');
  const [validation, setValidation] = useState<ValidationState>({
    github: 'idle',
    githubMsg: '',
    notion: 'idle',
    notionMsg: '',
  });
  const [credError, setCredError] = useState<string | null>(null);

  // Project step state
  const [showProjectForm, setShowProjectForm] = useState(false);

  // Skip state
  const [skipLoading, setSkipLoading] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  // Detect .env path on mount
  useEffect(() => {
    const detected =
      typeof window !== 'undefined'
        ? ((window as unknown as Record<string, unknown>).__detectedEnvPath as
            | string
            | undefined)
        : undefined;
    if (detected) setImportPath(detected);
  }, []);

  // Env check polling when on that step
  useEffect(() => {
    if (step !== 'env-check') {
      if (envPollRef.current) clearInterval(envPollRef.current);
      return;
    }

    const doCheck = async () => {
      setEnvLoading(true);
      try {
        const res = await fetch('/api/setup/env-check');
        const data = (await res.json()) as EnvCheckResult;
        setEnvCheck(data);
      } catch {
        // ignore transient
      } finally {
        setEnvLoading(false);
      }
    };

    void doCheck();
    envPollRef.current = setInterval(() => void doCheck(), 3000);
    return () => {
      if (envPollRef.current) clearInterval(envPollRef.current);
    };
  }, [step]);

  const handleImport = useCallback(async () => {
    if (!importPath.trim()) return;
    setImportLoading(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await apiPost<{ imported?: string[]; error?: string }>(
        '/api/setup/import',
        { path: importPath.trim() },
      );
      if (res.error) {
        setImportError(res.error);
      } else {
        setImportResult(
          `Imported: ${(res.imported ?? []).join(', ') || 'nothing new'}`,
        );
      }
    } catch {
      setImportError('Failed to import. Check the path and try again.');
    } finally {
      setImportLoading(false);
    }
  }, [importPath]);

  const handleValidateToken = useCallback(
    async (type: 'github' | 'notion', token: string) => {
      if (!token.trim()) return;
      setValidation((v) => ({
        ...v,
        [type]: 'checking',
        [`${type}Msg`]: 'Checking…',
      }));
      try {
        const res = await apiPost<{ valid: boolean; message: string }>(
          '/api/setup/validate',
          { type, token: token.trim() },
        );
        setValidation((v) => ({
          ...v,
          [type]: res.valid ? 'ok' : 'error',
          [`${type}Msg`]: res.message,
        }));
      } catch {
        setValidation((v) => ({
          ...v,
          [type]: 'error',
          [`${type}Msg`]: 'Request failed',
        }));
      }
    },
    [],
  );

  const handleSaveCredentials = useCallback(async () => {
    if (githubToken.trim() && validation.github !== 'ok') {
      setCredError('Please validate your GitHub PAT first (click "Check").');
      return;
    }
    setCredError(null);
    try {
      await apiPost('/api/setup/save-credentials', {
        githubToken: githubToken.trim() || undefined,
        notionApiKey: notionToken.trim() || undefined,
      });
      setStep('project');
    } catch (err) {
      setCredError(
        err instanceof Error ? err.message : 'Failed to save credentials.',
      );
    }
  }, [githubToken, notionToken, validation.github]);

  const handleProjectCreated = useCallback(
    async (values: ProjectFormValues) => {
      const payload = toCreatePayload(values);
      await projectsApi.create(payload);
      await apiPost('/api/setup/complete');
      setStep('done');
    },
    [],
  );

  const handleSkip = useCallback(async () => {
    setSkipLoading(true);
    try {
      await apiPost('/api/setup/complete');
      onComplete(true);
    } catch {
      onComplete(true);
    } finally {
      setSkipLoading(false);
    }
  }, [onComplete]);

  const canAdvanceEnvCheck =
    envCheck !== null && envCheck.claudeAuthenticated && envCheck.gitInstalled;

  return (
    <div className={styles.overlay} data-testid="setup-wizard">
      <div
        className={`${styles.card}${step === 'project' ? ` ${styles.cardWide}` : ''}`}
      >
        {/* Step indicator */}
        <div className={styles.stepIndicator} aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`${styles.stepDot}${i === stepIndex ? ` ${styles.stepDotActive}` : ''}${i < stepIndex ? ` ${styles.stepDotDone}` : ''}`}
              title={STEP_LABELS[i]}
            />
          ))}
        </div>

        {/* Step: Welcome / Import */}
        {step === 'welcome' && (
          <>
            <h1 className={styles.title}>Welcome to Claude Code Dashboard</h1>
            <p className={styles.subtitle}>
              Let&apos;s get you set up in a few steps. If you have an existing
              install, you can import your config below.
            </p>

            <div className={styles.importSection}>
              <p className={styles.importSectionTitle}>
                Import existing .env (optional)
              </p>
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="/path/to/.env"
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                  aria-label="Path to .env file"
                />
                <button
                  className={styles.btnSecondary}
                  onClick={() => void handleImport()}
                  disabled={importLoading || !importPath.trim()}
                  type="button"
                >
                  {importLoading ? 'Importing…' : 'Import'}
                </button>
              </div>
              {importResult && (
                <p className={styles.importResult}>{importResult}</p>
              )}
              {importError && <p className={styles.errorMsg}>{importError}</p>}
            </div>

            <div className={styles.actions}>
              <button
                className={styles.btnPrimary}
                onClick={() => setStep('env-check')}
                type="button"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {/* Step: Env Check */}
        {step === 'env-check' && (
          <>
            <h1 className={styles.title}>Environment Check</h1>
            <p className={styles.subtitle}>
              Verifying required tools are installed and authenticated.
            </p>

            {envLoading && envCheck === null ? (
              <div className={styles.loading}>Checking environment…</div>
            ) : envCheck ? (
              <>
                <EnvRow
                  icon="🐙"
                  label="git"
                  ok={envCheck.gitInstalled}
                  okText="Installed"
                  failText="Not found — install git and refresh"
                />
                <EnvRow
                  icon="🤖"
                  label="claude CLI"
                  ok={envCheck.claudeInstalled}
                  okText="Installed"
                  failText="Not found — install Claude Code CLI"
                />
                <EnvRow
                  icon="🔑"
                  label="claude login"
                  ok={envCheck.claudeAuthenticated}
                  okText="Authenticated"
                  failText={envCheck.claudeInstalled ? 'Not logged in' : 'N/A'}
                />

                {!envCheck.claudeAuthenticated && envCheck.claudeInstalled && (
                  <div className={styles.claudeAuthGuide} role="alert">
                    <strong>Claude is not authenticated.</strong> Open a
                    terminal and run:
                    <br />
                    <br />
                    <code>claude login</code>
                    <br />
                    <br />
                    Follow the browser prompt to sign in to your Anthropic
                    account. This page will update automatically once
                    you&apos;re logged in.
                  </div>
                )}

                {!envCheck.claudeInstalled && (
                  <div className={styles.claudeAuthGuide} role="alert">
                    <strong>Claude CLI is not installed.</strong> Install it
                    with:
                    <br />
                    <br />
                    <code>npm install -g @anthropic-ai/claude-code</code>
                    <br />
                    <br />
                    Then run <code>claude login</code> to authenticate.
                  </div>
                )}
              </>
            ) : null}

            <div className={styles.actions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setStep('welcome')}
                type="button"
              >
                Back
              </button>
              <button
                className={styles.retryBtn}
                onClick={async () => {
                  setEnvLoading(true);
                  try {
                    const res = await fetch('/api/setup/env-check');
                    const data = (await res.json()) as EnvCheckResult;
                    setEnvCheck(data);
                  } finally {
                    setEnvLoading(false);
                  }
                }}
                type="button"
              >
                Refresh
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => setStep('credentials')}
                disabled={!canAdvanceEnvCheck}
                type="button"
                data-testid="env-check-next"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {/* Step: Credentials */}
        {step === 'credentials' && (
          <>
            <h1 className={styles.title}>Global Credentials</h1>
            <p className={styles.subtitle}>
              Add your credentials. Both fields are optional — you can configure
              them later in Settings.
            </p>

            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-github-pat">
                GitHub Personal Access Token{' '}
                <span style={{ color: 'var(--text-muted, #6c7086)' }}>
                  (optional)
                </span>
              </label>
              <div className={styles.inputRow}>
                <input
                  id="wizard-github-pat"
                  className={styles.input}
                  type="password"
                  placeholder="ghp_…"
                  value={githubToken}
                  onChange={(e) => {
                    setGithubToken(e.target.value);
                    setValidation((v) => ({
                      ...v,
                      github: 'idle',
                      githubMsg: '',
                    }));
                  }}
                  autoComplete="off"
                />
                <button
                  className={styles.retryBtn}
                  onClick={() =>
                    void handleValidateToken('github', githubToken)
                  }
                  disabled={
                    !githubToken.trim() || validation.github === 'checking'
                  }
                  type="button"
                >
                  Check
                </button>
              </div>
              <div className={styles.validationStatus}>
                {validation.github === 'ok' && (
                  <span className={styles.validOk}>
                    ✓ {validation.githubMsg}
                  </span>
                )}
                {validation.github === 'error' && (
                  <span className={styles.validErr}>
                    ✗ {validation.githubMsg}
                  </span>
                )}
                {validation.github === 'checking' && (
                  <span className={styles.validChecking}>Checking…</span>
                )}
                {validation.github === 'idle' && (
                  <a
                    className={styles.tokenLink}
                    href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Claude+Code+Dashboard"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Create a PAT on GitHub →
                  </a>
                )}
              </div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-notion-token">
                Notion Integration Token{' '}
                <span style={{ color: 'var(--text-muted, #6c7086)' }}>
                  (optional)
                </span>
              </label>
              <div className={styles.inputRow}>
                <input
                  id="wizard-notion-token"
                  className={styles.input}
                  type="password"
                  placeholder="ntn_…"
                  value={notionToken}
                  onChange={(e) => {
                    setNotionToken(e.target.value);
                    setValidation((v) => ({
                      ...v,
                      notion: 'idle',
                      notionMsg: '',
                    }));
                  }}
                  autoComplete="off"
                />
                <button
                  className={styles.retryBtn}
                  onClick={() =>
                    void handleValidateToken('notion', notionToken)
                  }
                  disabled={
                    !notionToken.trim() || validation.notion === 'checking'
                  }
                  type="button"
                >
                  Check
                </button>
              </div>
              <div className={styles.validationStatus}>
                {validation.notion === 'ok' && (
                  <span className={styles.validOk}>
                    ✓ {validation.notionMsg}
                  </span>
                )}
                {validation.notion === 'error' && (
                  <span className={styles.validErr}>
                    ✗ {validation.notionMsg}
                  </span>
                )}
                {validation.notion === 'checking' && (
                  <span className={styles.validChecking}>Checking…</span>
                )}
                {validation.notion === 'idle' && notionToken.trim() === '' && (
                  <a
                    className={styles.tokenLink}
                    href="https://www.notion.so/my-integrations"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Create a Notion integration →
                  </a>
                )}
              </div>
            </div>

            {credError && <p className={styles.errorMsg}>{credError}</p>}

            <div className={styles.actions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setStep('env-check')}
                type="button"
              >
                Back
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => void handleSaveCredentials()}
                disabled={
                  githubToken.trim() !== '' && validation.github !== 'ok'
                }
                type="button"
              >
                Continue
              </button>
            </div>
          </>
        )}

        {/* Step: First Project */}
        {step === 'project' && (
          <>
            <h1 className={styles.title}>Add Your First Project</h1>
            <p className={styles.subtitle}>
              Configure your repository and task source. You can add more
              projects later in Settings.
            </p>
            <div className={styles.actions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setStep('credentials')}
                type="button"
              >
                Back
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => setShowProjectForm(true)}
                type="button"
                data-testid="open-project-form"
              >
                Add Project
              </button>
            </div>
            {showProjectForm && (
              <ProjectFormModal
                initialProject={null}
                onCancel={() => setShowProjectForm(false)}
                onSubmit={(values) => handleProjectCreated(values)}
              />
            )}
          </>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <>
            <div className={styles.successIcon}>🎉</div>
            <h1 className={styles.title}>You&apos;re all set!</h1>
            <p className={styles.subtitle}>
              Your dashboard is configured and ready to use.
            </p>
            <div
              className={styles.actions}
              style={{ justifyContent: 'center' }}
            >
              <button
                className={styles.btnPrimary}
                onClick={() => onComplete(false)}
                type="button"
              >
                Open Dashboard
              </button>
            </div>
          </>
        )}

        {/* Skip link — available on all steps except done */}
        {step !== 'done' && (
          <div className={styles.skipRow}>
            <button
              className={styles.skipBtn}
              onClick={() => void handleSkip()}
              disabled={skipLoading}
              type="button"
              data-testid="skip-to-settings"
            >
              {skipLoading ? 'Skipping…' : 'Skip, I’ll configure in Settings'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvRow({
  icon,
  label,
  ok,
  okText,
  failText,
}: {
  icon: string;
  label: string;
  ok: boolean;
  okText: string;
  failText: string;
}) {
  return (
    <div className={styles.envRow}>
      <span className={styles.envIcon}>{icon}</span>
      <span className={styles.envLabel}>{label}</span>
      {ok ? (
        <span className={styles.envStatusOk}>✓ {okText}</span>
      ) : (
        <span className={styles.envStatusFail}>✗ {failText}</span>
      )}
    </div>
  );
}
