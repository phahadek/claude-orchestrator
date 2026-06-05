import { useState, useEffect, useCallback } from 'react';
import type { FormEvent } from 'react';
import { projectsApi } from '../api/projects';
import type { ProjectFormValues } from '../components/Settings/ProjectFormModal';
import styles from './FirstRunWizard.module.css';

type Step = 'welcome' | 'env-check' | 'credentials' | 'first-project' | 'done';

interface EnvStatus {
  claudeInstalled: boolean;
  claudeAuthenticated: boolean;
  gitInstalled: boolean;
}

interface ValidateResult {
  valid: boolean;
  message: string;
}

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

const EMPTY_PROJECT: ProjectFormValues = {
  name: '',
  projectDir: '',
  contextUrl: '',
  githubRepo: '',
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
};

const STEPS: Step[] = ['welcome', 'env-check', 'credentials', 'first-project', 'done'];

function stepIndex(s: Step): number {
  return STEPS.indexOf(s);
}

export function FirstRunWizard({ onComplete, onSkip }: Props) {
  const [step, setStep] = useState<Step>('welcome');

  // Step 1 state
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Step 2 state
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [envLoading, setEnvLoading] = useState(false);

  // Step 3 state
  const [githubToken, setGithubToken] = useState('');
  const [notionToken, setNotionToken] = useState('');
  const [githubValidation, setGithubValidation] = useState<ValidateResult | null>(null);
  const [notionValidation, setNotionValidation] = useState<ValidateResult | null>(null);
  const [githubValidating, setGithubValidating] = useState(false);
  const [notionValidating, setNotionValidating] = useState(false);
  const [credSaving, setCredSaving] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  // Step 4 state
  const [projectValues, setProjectValues] = useState<ProjectFormValues>(EMPTY_PROJECT);
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  // Skip state
  const [skipping, setSkipping] = useState(false);

  const fetchEnvStatus = useCallback(async () => {
    setEnvLoading(true);
    try {
      const res = await fetch('/api/setup/env-check');
      const data = (await res.json()) as EnvStatus;
      setEnvStatus(data);
    } catch {
      setEnvStatus(null);
    } finally {
      setEnvLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === 'env-check' && !envStatus && !envLoading) {
      void fetchEnvStatus();
    }
  }, [step, envStatus, envLoading, fetchEnvStatus]);

  async function handleImport(e: FormEvent) {
    e.preventDefault();
    if (!importPath.trim()) return;
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    try {
      const res = await fetch('/api/setup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: importPath.trim() }),
      });
      const data = (await res.json()) as { imported?: string[]; error?: string };
      if (!res.ok) {
        setImportError(data.error ?? `Error ${res.status}`);
      } else {
        const imported = data.imported ?? [];
        setImportResult(
          imported.length > 0
            ? `Imported: ${imported.join(', ')}`
            : 'No recognised keys found in that file.',
        );
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  async function validateGithub() {
    if (!githubToken.trim()) return;
    setGithubValidating(true);
    setGithubValidation(null);
    try {
      const res = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'github', token: githubToken.trim() }),
      });
      setGithubValidation((await res.json()) as ValidateResult);
    } catch {
      setGithubValidation({ valid: false, message: 'Request failed' });
    } finally {
      setGithubValidating(false);
    }
  }

  async function validateNotion() {
    if (!notionToken.trim()) return;
    setNotionValidating(true);
    setNotionValidation(null);
    try {
      const res = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'notion', token: notionToken.trim() }),
      });
      setNotionValidation((await res.json()) as ValidateResult);
    } catch {
      setNotionValidation({ valid: false, message: 'Request failed' });
    } finally {
      setNotionValidating(false);
    }
  }

  async function saveCredentials() {
    if (!githubToken.trim()) {
      setCredError('GitHub PAT is required.');
      return;
    }
    setCredSaving(true);
    setCredError(null);
    try {
      await fetch('/api/setup/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubToken: githubToken.trim(),
          notionApiKey: notionToken.trim() || undefined,
        }),
      });
      setStep('first-project');
    } catch (err) {
      setCredError(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setCredSaving(false);
    }
  }

  function validateProjectForm(): boolean {
    const errs: Record<string, string> = {};
    if (!projectValues.name.trim()) errs.name = 'Name is required';
    if (!projectValues.projectDir.trim()) errs.projectDir = 'Project Dir is required';
    if (projectValues.taskSource === 'github') {
      if (!projectValues.githubOwnerRepo.trim()) {
        errs.githubOwnerRepo = 'Repository is required (owner/repo)';
      } else if (!/^[^/]+\/[^/]+$/.test(projectValues.githubOwnerRepo.trim())) {
        errs.githubOwnerRepo = 'Must be in owner/repo format';
      }
    }
    setProjectErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleCreateProject(e: FormEvent) {
    e.preventDefault();
    if (!validateProjectForm()) return;
    setProjectSaving(true);
    setProjectError(null);
    try {
      const rawCfg = projectValues.nonMilestoneSourceConfigRaw.trim();
      let taskSourceConfig: string | null = null;
      if (projectValues.taskSource === 'github') {
        const [owner, repo] = projectValues.githubOwnerRepo.trim().split('/');
        taskSourceConfig = JSON.stringify({ owner, repo, defaultMilestone: null });
      }
      await projectsApi.create({
        name: projectValues.name.trim(),
        projectDir: projectValues.projectDir.trim(),
        contextUrl: projectValues.contextUrl.trim() || null,
        githubRepo: projectValues.gitMode !== 'local-only'
          ? projectValues.githubRepo.trim() || null
          : null,
        taskSource: projectValues.taskSource,
        taskSourceConfig,
        gitMode: projectValues.gitMode,
        autoLaunchEnabled: projectValues.autoLaunchEnabled,
        autoMergeEnabled:
          projectValues.gitMode !== 'local-only' ? projectValues.autoMergeEnabled : false,
        baseBranch: projectValues.baseBranch || 'dev',
        ...(rawCfg
          ? {
              nonMilestoneSourceConfig: JSON.parse(rawCfg) as Record<string, unknown>,
            }
          : {}),
      });
      setStep('done');
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setProjectSaving(false);
    }
  }

  async function handleSkip() {
    setSkipping(true);
    try {
      await fetch('/api/setup/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubToken: githubToken.trim() || undefined,
          notionApiKey: notionToken.trim() || undefined,
        }),
      });
    } catch {
      // Best effort — proceed anyway
    }
    setSkipping(false);
    onSkip();
  }

  const currentIdx = stepIndex(step);
  const totalSteps = STEPS.length - 1; // 'done' is not a numbered step

  return (
    <div className={styles.overlay} data-testid="first-run-wizard">
      <div className={styles.wizard}>
        <div className={styles.wizardHeader}>
          <h1 className={styles.wizardTitle}>Welcome to Claude Orchestrator</h1>
          {step !== 'done' && (
            <div className={styles.progressRow}>
              <span className={styles.progressLabel}>
                Step {currentIdx + 1} of {totalSteps}
              </span>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${((currentIdx + 1) / totalSteps) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className={styles.wizardBody}>
          {/* ── Step 1: Welcome ── */}
          {step === 'welcome' && (
            <div data-testid="step-welcome">
              <h2 className={styles.stepTitle}>Get started</h2>
              <p className={styles.stepDesc}>
                Let's configure Claude Orchestrator in a few steps. If you have an
                existing setup, you can import your credentials from a <code>.env</code> file.
              </p>

              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Import from .env (optional)</h3>
                <form onSubmit={(e) => void handleImport(e)} className={styles.inlineForm}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="/path/to/your/.env"
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                  />
                  <button
                    type="submit"
                    className={styles.btnSecondary}
                    disabled={importing || !importPath.trim()}
                  >
                    {importing ? 'Importing…' : 'Import'}
                  </button>
                </form>
                {importResult && (
                  <p className={styles.successText} data-testid="import-result">
                    {importResult}
                  </p>
                )}
                {importError && (
                  <p className={styles.errorText} data-testid="import-error">
                    {importError}
                  </p>
                )}
              </div>

              <div className={styles.stepActions}>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={() => setStep('env-check')}
                >
                  Next →
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Env Check ── */}
          {step === 'env-check' && (
            <div data-testid="step-env-check">
              <h2 className={styles.stepTitle}>Environment check</h2>
              <p className={styles.stepDesc}>
                Claude Orchestrator requires Claude CLI (authenticated) and Git.
              </p>

              {envLoading && <p className={styles.muted}>Checking environment…</p>}

              {envStatus && (
                <div className={styles.checkList} data-testid="env-check-results">
                  <div className={styles.checkItem}>
                    <span className={envStatus.claudeInstalled ? styles.checkOk : styles.checkFail}>
                      {envStatus.claudeInstalled ? '✓' : '✗'}
                    </span>
                    <span>Claude CLI installed</span>
                  </div>
                  <div className={styles.checkItem}>
                    <span
                      className={
                        envStatus.claudeAuthenticated ? styles.checkOk : styles.checkFail
                      }
                    >
                      {envStatus.claudeAuthenticated ? '✓' : '✗'}
                    </span>
                    <span>Claude authenticated</span>
                    {!envStatus.claudeAuthenticated && (
                      <div className={styles.authGuide} data-testid="auth-guide">
                        <p>
                          Run <code className={styles.code}>claude login</code> in your
                          terminal, then click <strong>Re-check</strong>.
                        </p>
                      </div>
                    )}
                  </div>
                  <div className={styles.checkItem}>
                    <span className={envStatus.gitInstalled ? styles.checkOk : styles.checkFail}>
                      {envStatus.gitInstalled ? '✓' : '✗'}
                    </span>
                    <span>Git installed</span>
                    {!envStatus.gitInstalled && (
                      <p className={styles.hint}>
                        Install Git from{' '}
                        <span className={styles.code}>git-scm.com</span> and restart.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {!envLoading && envStatus && (
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => void fetchEnvStatus()}
                >
                  Re-check
                </button>
              )}

              <div className={styles.stepActions}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setStep('welcome')}
                >
                  ← Back
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={!envStatus?.claudeAuthenticated}
                  onClick={() => setStep('credentials')}
                  data-testid="env-check-next"
                >
                  Next →
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Credentials ── */}
          {step === 'credentials' && (
            <div data-testid="step-credentials">
              <h2 className={styles.stepTitle}>Global credentials</h2>
              <p className={styles.stepDesc}>
                Enter your GitHub Personal Access Token. A Notion integration token is
                required only if you use Notion as your task source.
              </p>

              <div className={styles.credField}>
                <label className={styles.label}>
                  GitHub PAT{' '}
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo,read:org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.deepLink}
                  >
                    Create token ↗
                  </a>
                </label>
                <div className={styles.inlineForm}>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="ghp_…"
                    value={githubToken}
                    onChange={(e) => {
                      setGithubToken(e.target.value);
                      setGithubValidation(null);
                    }}
                    data-testid="github-token-input"
                  />
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    disabled={githubValidating || !githubToken.trim()}
                    onClick={() => void validateGithub()}
                    data-testid="validate-github"
                  >
                    {githubValidating ? 'Checking…' : 'Validate'}
                  </button>
                </div>
                {githubValidation && (
                  <p
                    className={
                      githubValidation.valid ? styles.successText : styles.errorText
                    }
                    data-testid="github-validation-result"
                  >
                    {githubValidation.valid ? '✓ ' : '✗ '}
                    {githubValidation.message}
                  </p>
                )}
              </div>

              <div className={styles.credField}>
                <label className={styles.label}>
                  Notion Integration Token (optional){' '}
                  <a
                    href="https://www.notion.so/my-integrations"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.deepLink}
                  >
                    Create integration ↗
                  </a>
                </label>
                <div className={styles.inlineForm}>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="ntn_…"
                    value={notionToken}
                    onChange={(e) => {
                      setNotionToken(e.target.value);
                      setNotionValidation(null);
                    }}
                    data-testid="notion-token-input"
                  />
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    disabled={notionValidating || !notionToken.trim()}
                    onClick={() => void validateNotion()}
                    data-testid="validate-notion"
                  >
                    {notionValidating ? 'Checking…' : 'Validate'}
                  </button>
                </div>
                {notionValidation && (
                  <p
                    className={
                      notionValidation.valid ? styles.successText : styles.errorText
                    }
                    data-testid="notion-validation-result"
                  >
                    {notionValidation.valid ? '✓ ' : '✗ '}
                    {notionValidation.message}
                  </p>
                )}
              </div>

              {credError && <p className={styles.errorText}>{credError}</p>}

              <div className={styles.stepActions}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => setStep('env-check')}
                >
                  ← Back
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={credSaving || !githubToken.trim()}
                  onClick={() => void saveCredentials()}
                  data-testid="credentials-next"
                >
                  {credSaving ? 'Saving…' : 'Next →'}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 4: First Project ── */}
          {step === 'first-project' && (
            <div data-testid="step-first-project">
              <h2 className={styles.stepTitle}>Add your first project</h2>
              <p className={styles.stepDesc}>
                Configure the repository you want to orchestrate.
              </p>

              <form onSubmit={(e) => void handleCreateProject(e)}>
                <div className={styles.formField}>
                  <label className={styles.label}>Name</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={projectValues.name}
                    onChange={(e) =>
                      setProjectValues((v) => ({ ...v, name: e.target.value }))
                    }
                    autoFocus
                  />
                  {projectErrors.name && (
                    <p className={styles.fieldError}>{projectErrors.name}</p>
                  )}
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Project Dir</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={projectValues.projectDir}
                    onChange={(e) =>
                      setProjectValues((v) => ({ ...v, projectDir: e.target.value }))
                    }
                    placeholder="/absolute/path/to/repo"
                  />
                  {projectErrors.projectDir && (
                    <p className={styles.fieldError}>{projectErrors.projectDir}</p>
                  )}
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Base Branch</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={projectValues.baseBranch}
                    onChange={(e) =>
                      setProjectValues((v) => ({ ...v, baseBranch: e.target.value }))
                    }
                    placeholder="main"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Task Source</label>
                  <select
                    className={styles.input}
                    value={projectValues.taskSource}
                    onChange={(e) => {
                      const val = e.target.value as 'notion' | 'yaml' | 'github';
                      setProjectValues((v) => ({ ...v, taskSource: val }));
                    }}
                  >
                    <option value="notion">Notion</option>
                    <option value="yaml">YAML (tasks.yaml in projectDir)</option>
                    <option value="github">GitHub Issues</option>
                  </select>
                </div>

                {projectValues.taskSource === 'github' && (
                  <div className={styles.formField}>
                    <label className={styles.label}>Repository (owner/repo)</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={projectValues.githubOwnerRepo}
                      onChange={(e) =>
                        setProjectValues((v) => ({
                          ...v,
                          githubOwnerRepo: e.target.value,
                        }))
                      }
                      placeholder="owner/repo"
                    />
                    {projectErrors.githubOwnerRepo && (
                      <p className={styles.fieldError}>{projectErrors.githubOwnerRepo}</p>
                    )}
                  </div>
                )}

                <div className={styles.formField}>
                  <label className={styles.label}>Git Mode</label>
                  <select
                    className={styles.input}
                    value={projectValues.gitMode}
                    onChange={(e) =>
                      setProjectValues((v) => ({
                        ...v,
                        gitMode: e.target.value as 'github' | 'local-only',
                      }))
                    }
                  >
                    <option value="github">GitHub (default) — PR-based workflow</option>
                    <option value="local-only">Local only — no GitHub remote</option>
                  </select>
                </div>

                {projectValues.gitMode !== 'local-only' && (
                  <div className={styles.formField}>
                    <label className={styles.label}>GitHub Repo (optional)</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={projectValues.githubRepo}
                      onChange={(e) =>
                        setProjectValues((v) => ({
                          ...v,
                          githubRepo: e.target.value,
                        }))
                      }
                      placeholder="owner/repo"
                    />
                  </div>
                )}

                {projectError && <p className={styles.errorText}>{projectError}</p>}

                <div className={styles.stepActions}>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={() => setStep('credentials')}
                  >
                    ← Back
                  </button>
                  <button
                    type="submit"
                    className={styles.btnPrimary}
                    disabled={projectSaving}
                    data-testid="create-project"
                  >
                    {projectSaving ? 'Creating…' : 'Create Project →'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ── Step 5: Done ── */}
          {step === 'done' && (
            <div data-testid="step-done" className={styles.doneStep}>
              <div className={styles.doneIcon}>✓</div>
              <h2 className={styles.stepTitle}>Setup complete!</h2>
              <p className={styles.stepDesc}>
                Claude Orchestrator is configured and ready to use.
              </p>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={onComplete}
                data-testid="launch-dashboard"
              >
                Launch Dashboard →
              </button>
            </div>
          )}
        </div>

        {/* ── Global skip footer ── */}
        {step !== 'done' && (
          <div className={styles.wizardFooter}>
            <button
              type="button"
              className={styles.skipBtn}
              disabled={skipping}
              onClick={() => void handleSkip()}
              data-testid="skip-to-settings"
            >
              {skipping ? 'Saving…' : 'Skip, I\'ll configure in Settings'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
