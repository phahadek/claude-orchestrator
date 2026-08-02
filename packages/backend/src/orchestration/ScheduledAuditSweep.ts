import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import {
  runTestCommands,
  type TestCommandResult,
} from '../session/test-runner';
import { getTaskBackend } from '../tasks/TaskBackend';
import { toCanonicalStatus } from '../tasks/statusCanonical';
import { getAuditFindingDedup, upsertAuditFindingDedup } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import type { Scheduler } from './Scheduler';

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_RETRY_CAP = 2;
const TASK_TYPE = '💻 Code';

// ── Worktree isolation ──────────────────────────────────────────────────────
//
// Nested at least one path segment deeper than `.claude/worktrees/<name>` so
// it never matches WorktreeReconciler's exact `worktreesDir/<sessionId>`
// check (WorktreeReconciler.ts:91-121) — that reconciler force-removes any
// git-registered worktree directly under `.claude/worktrees/` whose name
// isn't a live `sessions` row, and this sweep is never a dispatched session
// (no `sessions` row backs it).

/** The dedicated worktree path for a project's scheduled audit sweep — never the shared projectDir. */
export function getAuditWorktreePath(
  project: Pick<ProjectConfig, 'projectDir' | 'id'>,
): string {
  return path.join(
    project.projectDir,
    '.claude',
    'worktrees',
    'scheduled-audit',
    project.id,
  );
}

/** Runs a git command; injectable so tests can assert cwd without touching a real repo. */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd });
  return { stdout, stderr };
};

async function fsExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a dedicated worktree at `worktreePath` (never `project.projectDir`)
 * is checked out to the project's own base branch, fresh — `fetch` always
 * runs first so the branch's `.claude-orchestrator.yml` is read without any
 * caching. `git worktree add`/`fetch` necessarily run with cwd=projectDir
 * (the git-worktree mechanism operates from an existing worktree of the same
 * repo) but every subsequent checkout/reset/clean and all analyze-command
 * execution run with cwd=worktreePath — the shared projectDir is never used
 * for those.
 */
export async function ensureAuditWorktree(
  project: ProjectConfig,
  worktreePath: string,
  gitRunner: GitRunner,
): Promise<void> {
  const baseBranch = project.baseBranch || 'dev';
  await gitRunner(['fetch', 'origin', baseBranch], project.projectDir);

  const exists = await fsExists(worktreePath);
  if (!exists) {
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
    await gitRunner(
      [
        'worktree',
        'add',
        '--force',
        '--detach',
        worktreePath,
        `origin/${baseBranch}`,
      ],
      project.projectDir,
    );
    return;
  }

  try {
    await gitRunner(['reset', '--hard', `origin/${baseBranch}`], worktreePath);
    await gitRunner(['clean', '-fd'], worktreePath);
  } catch (err) {
    // Worktree dir exists but is no longer a valid checkout (e.g. manually
    // disturbed) — reclaim it and re-add fresh rather than getting stuck.
    logger.warn(
      `[ScheduledAuditSweep] project ${project.id}: existing audit worktree at ${worktreePath} failed to reset (${err instanceof Error ? err.message : err}) — recreating`,
    );
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
    try {
      await gitRunner(['worktree', 'prune'], project.projectDir);
    } catch {
      // best-effort
    }
    await gitRunner(
      [
        'worktree',
        'add',
        '--force',
        '--detach',
        worktreePath,
        `origin/${baseBranch}`,
      ],
      project.projectDir,
    );
  }
}

// ── Analyze-command execution with bounded transient-failure retry ─────────

type AnalyzeCommandRunner = (
  cwd: string,
  command: string,
  timeoutSec: number,
  maxRssMb: number,
) => Promise<TestCommandResult>;

const defaultRunAnalyzeCommand: AnalyzeCommandRunner = (
  cwd,
  command,
  timeoutSec,
  maxRssMb,
) => runTestCommands(cwd, [command], timeoutSec, () => {}, { maxRssMb });

interface AnalyzeCommandOutcome {
  command: string;
  output: string;
  /** True only when the command was still timing out / OOM-killing after the retry cap was spent — this run skips it. */
  transientFailure: boolean;
}

/**
 * Runs one analyze command, retrying up to `retryCap` times on a transient
 * failure (timeout or OOM-kill) — mirroring StalledPRReconciler's generic
 * DEFAULT_RETRY_CAP idiom. A non-zero exit that is neither a timeout nor an
 * OOM-kill (e.g. `npm audit` exiting non-zero because it found advisories)
 * is not transient — its output still carries the JSON payload to parse and
 * is returned as-is, not retried.
 */
async function runAnalyzeCommandWithRetry(
  project: ProjectConfig,
  worktreePath: string,
  command: string,
  timeoutSec: number,
  maxRssMb: number,
  retryCap: number,
  runAnalyzeCommand: AnalyzeCommandRunner,
): Promise<AnalyzeCommandOutcome> {
  let attempt = 0;
  let result: TestCommandResult;
  for (;;) {
    attempt++;
    result = await runAnalyzeCommand(
      worktreePath,
      command,
      timeoutSec,
      maxRssMb,
    );
    const transient = Boolean(result.timedOut || result.oomKilled);
    if (!transient) {
      return { command, output: result.output, transientFailure: false };
    }
    if (attempt > retryCap) {
      logger.warn(
        `[ScheduledAuditSweep] project ${project.id}: "${command}" still failing after ${retryCap} retries (timedOut=${result.timedOut ?? false}, oomKilled=${result.oomKilled ?? false}) — skipping this run`,
      );
      recordEvent({
        event_type: 'scheduled_audit_sweep_command_escalated',
        actor_type: 'system',
        actor_id: null,
        project_id: project.id,
        task_id: null,
        payload: {
          command,
          attempts: attempt,
          timedOut: result.timedOut ?? false,
          oomKilled: result.oomKilled ?? false,
        },
      });
      return { command, output: result.output, transientFailure: true };
    }
    logger.info(
      `[ScheduledAuditSweep] project ${project.id}: retrying transient failure for "${command}" (attempt ${attempt}/${retryCap})`,
    );
    recordEvent({
      event_type: 'scheduled_audit_sweep_command_retry',
      actor_type: 'system',
      actor_id: null,
      project_id: project.id,
      task_id: null,
      payload: {
        command,
        attempt,
        timedOut: result.timedOut ?? false,
        oomKilled: result.oomKilled ?? false,
      },
    });
  }
}

// ── Finding parsing ─────────────────────────────────────────────────────────

export interface DependencyVulnerabilityFinding {
  kind: 'vulnerability';
  /** The advisory id (GHSA / npm advisory number) — the finding-identity for dedup. */
  advisoryId: string;
  packageName: string;
  currentRange?: string;
  fixedVersion?: string;
  severity?: string;
  advisoryUrl?: string;
}

interface LicenseFinding {
  kind: 'license';
  packageName: string;
  version: string;
  license: string;
}

export type AuditFinding = DependencyVulnerabilityFinding | LicenseFinding;

/** The dedup key: advisory id for a vulnerability finding, (package, version, license) for a license finding. */
export function findingIdentity(finding: AuditFinding): string {
  return finding.kind === 'vulnerability'
    ? `vuln:${finding.advisoryId}`
    : `license:${finding.packageName}@${finding.version}:${finding.license}`;
}

interface NpmAuditViaEntry {
  source?: number | string;
  url?: string;
  severity?: string;
}

interface NpmAuditVulnerability {
  name: string;
  severity?: string;
  range?: string;
  fixAvailable?: { name: string; version: string } | boolean;
  via: (string | NpmAuditViaEntry)[];
}

interface NpmAuditReport {
  vulnerabilities: Record<string, NpmAuditVulnerability>;
}

function isNpmAuditReport(value: unknown): value is NpmAuditReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = (value as { vulnerabilities?: unknown }).vulnerabilities;
  return typeof v === 'object' && v !== null;
}

interface LicenseCheckerEntry {
  licenses?: string | string[];
}

function isLicenseCheckerReport(
  value: unknown,
): value is Record<string, LicenseCheckerEntry> {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    (e) => typeof e === 'object' && e !== null && 'licenses' in e,
  );
}

function parseNpmAuditFindings(
  report: NpmAuditReport,
): DependencyVulnerabilityFinding[] {
  const findings: DependencyVulnerabilityFinding[] = [];
  for (const vuln of Object.values(report.vulnerabilities)) {
    const fixedVersion =
      typeof vuln.fixAvailable === 'object' && vuln.fixAvailable
        ? vuln.fixAvailable.version
        : undefined;
    for (const via of vuln.via) {
      if (typeof via === 'string') continue; // a bare "depends on <name>" link, not its own advisory
      const advisoryId =
        via.source !== undefined ? String(via.source) : via.url;
      if (!advisoryId) continue;
      findings.push({
        kind: 'vulnerability',
        advisoryId,
        packageName: vuln.name,
        currentRange: vuln.range,
        fixedVersion,
        severity: via.severity ?? vuln.severity,
        advisoryUrl: via.url,
      });
    }
  }
  return findings;
}

function parseLicenseCheckerFindings(
  report: Record<string, LicenseCheckerEntry>,
): LicenseFinding[] {
  const findings: LicenseFinding[] = [];
  for (const [key, entry] of Object.entries(report)) {
    const at = key.lastIndexOf('@');
    const packageName = at > 0 ? key.slice(0, at) : key;
    const version = at > 0 ? key.slice(at + 1) : 'unknown';
    const license = Array.isArray(entry.licenses)
      ? entry.licenses.join(', ')
      : (entry.licenses ?? 'UNKNOWN');
    findings.push({ kind: 'license', packageName, version, license });
  }
  return findings;
}

/** Extracts the outermost `{...}` object from noisy command output (a `$ <cmd>` header, stray log lines) and parses it. */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parses one analyze command's captured output into the two known
 * finding-identity shapes (npm-audit-style vulnerability report,
 * license-checker-style license report). Any other command's output — it is
 * not known ahead of time which of a project's configured `analyze` commands
 * are dependency/license-audit commands, see orchestrator-config.ts — simply
 * fails to match either shape and yields no findings.
 */
export function parseAuditFindings(commandOutput: string): AuditFinding[] {
  const parsed = extractJsonObject(commandOutput);
  if (parsed === null) return [];
  if (isNpmAuditReport(parsed)) return parseNpmAuditFindings(parsed);
  if (isLicenseCheckerReport(parsed))
    return parseLicenseCheckerFindings(parsed);
  return [];
}

// ── Task body / title rendering ─────────────────────────────────────────────

function findingTaskTitle(finding: AuditFinding): string {
  return finding.kind === 'vulnerability'
    ? `Dependency audit: fix ${finding.packageName} advisory ${finding.advisoryId}`
    : `Dependency audit: resolve ${finding.packageName}@${finding.version} license (${finding.license})`;
}

/** Renders the dep-bump task body — actionable without re-running the audit by hand. */
export function renderDepBumpTaskBody(finding: AuditFinding): string {
  if (finding.kind === 'vulnerability') {
    return [
      '## Summary',
      `The scheduled dependency-audit sweep found an open advisory against \`${finding.packageName}\` on the base branch.`,
      '',
      '## Finding',
      `- Package: \`${finding.packageName}\``,
      `- Current version/range: \`${finding.currentRange ?? 'unknown'}\``,
      `- Fixed version: \`${finding.fixedVersion ?? 'no fix published yet'}\``,
      `- Severity: ${finding.severity ?? 'unknown'}`,
      `- Advisory: ${finding.advisoryUrl ?? finding.advisoryId}`,
      '',
      '## Automated Tests',
      'No test changes — this task is a dependency version bump.',
    ].join('\n');
  }
  return [
    '## Summary',
    `The scheduled dependency-audit sweep found a disallowed license on the base branch.`,
    '',
    '## Finding',
    `- Package: \`${finding.packageName}\``,
    `- Version: \`${finding.version}\``,
    `- License: ${finding.license}`,
    '',
    '## Automated Tests',
    'No test changes — this task is a dependency license remediation.',
  ].join('\n');
}

// ── Dedup + filing ───────────────────────────────────────────────────────────

async function isTaskStillOpen(
  project: ProjectConfig,
  taskId: string,
): Promise<boolean> {
  const backend = getTaskBackend(project.id);
  const summary = await backend.fetchTaskSummary(taskId);
  if (!summary) return false; // task no longer resolves — treat as not-open, allow refiling
  return toCanonicalStatus(summary.status) !== 'Done';
}

interface FileFindingResult {
  filed: boolean;
  taskId?: string;
}

/**
 * Files a dep-bump Code task for `finding` unless it is already covered by a
 * currently-open task (per the audit_finding_dedup record) — a record whose
 * referenced task has since closed (Done) is stale, not binding, so the
 * finding is refiled fresh.
 */
async function fileFindingIfNeeded(
  project: ProjectConfig,
  finding: AuditFinding,
): Promise<FileFindingResult> {
  const identity = findingIdentity(finding);
  const existing = getAuditFindingDedup(project.id, identity);
  if (existing && (await isTaskStillOpen(project, existing.task_id))) {
    return { filed: false, taskId: existing.task_id };
  }

  const databaseId = project.nonMilestoneSourceConfig?.notionDatabaseId;
  if (!databaseId) {
    logger.warn(
      `[ScheduledAuditSweep] project ${project.id}: no non-milestone task database configured — cannot file finding ${identity}`,
    );
    return { filed: false };
  }

  const backend = getTaskBackend(project.id);
  if (!backend.createTask) {
    logger.warn(
      `[ScheduledAuditSweep] project ${project.id}: task backend does not support createTask — cannot file finding ${identity}`,
    );
    return { filed: false };
  }

  const taskId = await backend.createTask({
    databaseId,
    title: findingTaskTitle(finding),
    type: TASK_TYPE,
    body: renderDepBumpTaskBody(finding),
  });

  upsertAuditFindingDedup(
    project.id,
    identity,
    taskId,
    new Date().toISOString(),
  );

  recordEvent({
    event_type: 'scheduled_audit_sweep_finding_filed',
    actor_type: 'system',
    actor_id: null,
    project_id: project.id,
    task_id: taskId,
    payload: { findingIdentity: identity, kind: finding.kind },
  });

  return { filed: true, taskId };
}

// ── Sweep orchestration ──────────────────────────────────────────────────────

export interface AuditSweepDeps {
  listProjects: () => ProjectConfig[];
  gitRunner: GitRunner;
  runAnalyzeCommand: AnalyzeCommandRunner;
  retryCap: number;
}

const defaultDeps: AuditSweepDeps = {
  listProjects: getAllProjects,
  gitRunner: defaultGitRunner,
  runAnalyzeCommand: defaultRunAnalyzeCommand,
  retryCap: DEFAULT_RETRY_CAP,
};

export interface ProjectAuditResult {
  projectId: string;
  findingsSeen: number;
  tasksFiled: number;
}

/**
 * Runs the full sweep for one project: provisions/refreshes a dedicated
 * worktree checked out to the project's own base branch, runs its entire
 * configured `analyze` command list there (never against `project.projectDir`
 * directly), and parses each command's output for the two known
 * finding-identity shapes.
 */
export async function runAuditSweepForProject(
  project: ProjectConfig,
  deps: AuditSweepDeps = defaultDeps,
): Promise<ProjectAuditResult> {
  const worktreePath = getAuditWorktreePath(project);
  let findingsSeen = 0;
  let tasksFiled = 0;

  try {
    await ensureAuditWorktree(project, worktreePath, deps.gitRunner);
  } catch (err) {
    logger.error(
      `[ScheduledAuditSweep] project ${project.id}: failed to provision audit worktree — ${err instanceof Error ? err.message : err}`,
    );
    return { projectId: project.id, findingsSeen, tasksFiled };
  }

  const config = loadOrchestratorConfig(worktreePath);

  for (const command of config.analyze) {
    const outcome = await runAnalyzeCommandWithRetry(
      project,
      worktreePath,
      command,
      config.analyze_timeout_sec,
      config.analyze_max_rss_mb,
      deps.retryCap,
      deps.runAnalyzeCommand,
    );
    if (outcome.transientFailure) continue; // already escalated — skip this command for this run

    for (const finding of parseAuditFindings(outcome.output)) {
      findingsSeen++;
      const result = await fileFindingIfNeeded(project, finding);
      if (result.filed) tasksFiled++;
    }
  }

  return { projectId: project.id, findingsSeen, tasksFiled };
}

async function runScheduledAuditSweepOnce(
  deps: Partial<AuditSweepDeps> = {},
): Promise<{ items_processed: number }> {
  const merged: AuditSweepDeps = { ...defaultDeps, ...deps };
  const projects = merged.listProjects();
  let tasksFiled = 0;

  for (const project of projects) {
    const result = await runAuditSweepForProject(project, merged);
    tasksFiled += result.tasksFiled;
  }

  return { items_processed: tasksFiled };
}

export function register(scheduler: Scheduler): void {
  scheduler.register({
    name: 'scheduled_audit_sweep',
    intervalMs: DEFAULT_INTERVAL_MS,
    concurrency: 'skip-if-running',
    run: async () => runScheduledAuditSweepOnce(),
    onError: (err: unknown) =>
      logger.error(
        '[ScheduledAuditSweep] sweep error:',
        (err as Error).message,
      ),
  });
}
