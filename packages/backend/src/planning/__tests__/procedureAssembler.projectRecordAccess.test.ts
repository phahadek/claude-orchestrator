import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

const mockGetProjectById = vi.fn();
vi.mock('../../config', () => ({
  getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
}));

const { mockRecordEvent, mockLoggerWarn } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));
vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));
vi.mock('../../logger', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

import {
  renderProjectRecordAccess,
  findRecordAccessStandDownViolations,
} from '../procedureAssembler';

// resolveConfigDir (reused from groomLoad.ts) walks up from repoRoot looking
// for a sibling `config/projects/` dir, or honors $ORCHESTRATOR_CONFIG_DIR —
// build a real fixture tree so the config-dir resolution runs for real.
function setupFixture(): { reposDir: string; repoDir: string } {
  const reposDir = mkdtempSync(join(tmpdir(), 'project-record-access-'));
  const repoDir = join(reposDir, 'claude-orchestrator');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(reposDir, 'config', 'projects', basename(repoDir)), {
    recursive: true,
  });
  return { reposDir, repoDir };
}

describe('renderProjectRecordAccess', () => {
  let reposDir: string;
  let repoDir: string;
  const originalConfigDirEnv = process.env.ORCHESTRATOR_CONFIG_DIR;

  beforeEach(() => {
    mockGetProjectById.mockReset();
    mockRecordEvent.mockReset();
    mockLoggerWarn.mockReset();
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    ({ reposDir, repoDir } = setupFixture());
  });

  afterEach(() => {
    rmSync(reposDir, { recursive: true, force: true });
    if (originalConfigDirEnv === undefined) {
      delete process.env.ORCHESTRATOR_CONFIG_DIR;
    } else {
      process.env.ORCHESTRATOR_CONFIG_DIR = originalConfigDirEnv;
    }
  });

  function writeGuide(content: string) {
    writeFileSync(
      join(
        reposDir,
        'config',
        'projects',
        basename(repoDir),
        'investigation-guide.md',
      ),
      content,
    );
  }

  it('renders the guide for an ops session when the artifact exists', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    writeGuide('Read the ops audit dashboard at https://example.com/ops.');

    const lines = renderProjectRecordAccess('ops', 'claude-dashboard');

    expect(lines.join('\n')).toContain(
      'Read the ops audit dashboard at https://example.com/ops.',
    );
    expect(mockGetProjectById).toHaveBeenCalledWith('claude-dashboard');
  });

  it('renders the guide for a design session when the artifact exists', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    writeGuide('Design-time record access notes.');

    const lines = renderProjectRecordAccess('design', 'claude-dashboard');

    expect(lines.join('\n')).toContain('Design-time record access notes.');
  });

  it('never renders for groom sessions, even when an artifact exists', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    writeGuide('Should never surface for groom.');

    expect(renderProjectRecordAccess('groom', 'claude-dashboard')).toEqual([]);
    // Kind gate short-circuits before even resolving the project.
    expect(mockGetProjectById).not.toHaveBeenCalled();
  });

  it('resolves the config-dir from the registry projectId via basename(projectDir) — the same key groomLoad/designLoad use', () => {
    // repoDir's basename ("claude-orchestrator") differs from the registry
    // projectId ("claude-dashboard") passed in — the guide only exists at
    // the basename-keyed path, proving resolution goes through projectDir,
    // not the raw projectId.
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    writeGuide('Keyed by config-dir, not by registry id.');

    const lines = renderProjectRecordAccess('ops', 'claude-dashboard');
    expect(lines.join('\n')).toContain(
      'Keyed by config-dir, not by registry id.',
    );
  });

  it('falls back to no section (never throws) for an unknown project', () => {
    mockGetProjectById.mockReturnValue(undefined);

    expect(renderProjectRecordAccess('ops', 'unknown-project')).toEqual([]);
  });

  it('falls back to no section when the project has no guide artifact, but logs a warning and records a missing-guide audit event', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    // No investigation-guide.md written.

    expect(renderProjectRecordAccess('ops', 'claude-dashboard')).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    const event = mockRecordEvent.mock.calls[0][0];
    expect(event.event_type).toBe('project_record_access_guide_missing');
    expect(event.project_id).toBe('claude-dashboard');
    expect(event.payload).toMatchObject({
      workflow: 'ops',
      resolvedPath: join(
        reposDir,
        'config',
        'projects',
        basename(repoDir),
        'investigation-guide.md',
      ),
    });
  });

  it('records the missing-guide signal for a design session too', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });

    expect(renderProjectRecordAccess('design', 'claude-dashboard')).toEqual([]);
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent.mock.calls[0][0].payload).toMatchObject({
      workflow: 'design',
    });
  });

  it('does not emit the missing-guide signal when the guide artifact exists', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    writeGuide('Read the ops audit dashboard at https://example.com/ops.');

    renderProjectRecordAccess('ops', 'claude-dashboard');

    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('never throws even if recordEvent itself throws', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    mockRecordEvent.mockImplementation(() => {
      throw new Error('db unavailable');
    });

    expect(() =>
      renderProjectRecordAccess('ops', 'claude-dashboard'),
    ).not.toThrow();
    expect(renderProjectRecordAccess('ops', 'claude-dashboard')).toEqual([]);
  });

  it('falls back to no section when the central config tree is unreachable', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: join(tmpdir(), 'no-such-config-tree-parent', 'repo'),
    });

    expect(() =>
      renderProjectRecordAccess('ops', 'claude-dashboard'),
    ).not.toThrow();
    expect(renderProjectRecordAccess('ops', 'claude-dashboard')).toEqual([]);
  });

  it('falls back to no section if getProjectById itself throws', () => {
    mockGetProjectById.mockImplementation(() => {
      throw new Error('db unavailable');
    });

    expect(() =>
      renderProjectRecordAccess('ops', 'claude-dashboard'),
    ).not.toThrow();
    expect(renderProjectRecordAccess('ops', 'claude-dashboard')).toEqual([]);
  });

  it('drops a guide that tells a session to stand down instead of requesting the capability, and audits it', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    // The exact wording that shipped in claude-orchestrator's
    // investigation-guide.md (task 3ab22f91-52f3-81a5-a0f4-fcfbd6fba207) —
    // used here only as the regression fixture, not as what the guard
    // matches against (see findRecordAccessStandDownViolations tests below
    // for the behavioural, paraphrase-tolerant assertions).
    writeGuide(
      'Broader reads — another table directly, or anything beyond a single ' +
        "session's own record — are not sandbox-reachable today. That is " +
        'tracked as future work by the M13 read-only-MCP design; it is not ' +
        'something to work around here.',
    );

    expect(renderProjectRecordAccess('ops', 'claude-dashboard')).toEqual([]);
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    const event = mockRecordEvent.mock.calls[0][0];
    expect(event.event_type).toBe(
      'project_record_access_guide_blocks_escalation',
    );
    expect(event.project_id).toBe('claude-dashboard');
    expect(event.payload.workflow).toBe('ops');
    expect(event.payload.violations.length).toBeGreaterThan(0);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('still renders a guide that names a read as hard to reach but points at session.requestCapability', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    writeGuide(
      "Broader reads beyond a single session's own record are not directly " +
        'reachable from this sandbox. Call session.requestCapability naming ' +
        'the exact read you need and an operator will decide.',
    );

    const lines = renderProjectRecordAccess('ops', 'claude-dashboard');
    expect(lines.join('\n')).toContain('session.requestCapability');
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe('findRecordAccessStandDownViolations', () => {
  it('flags the shipped offending wording', () => {
    const violations = findRecordAccessStandDownViolations(
      'Broader reads — another table directly, or anything beyond a single ' +
        "session's own record — are not sandbox-reachable today. That is " +
        'tracked as future work by the M13 read-only-MCP design; it is not ' +
        'something to work around here.',
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('flags a differently-worded paraphrase making the same behavioural move', () => {
    const violations = findRecordAccessStandDownViolations(
      'Any read outside your own session record is explicitly out of bounds ' +
        'for this project. Do not attempt to work around that limitation.',
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('does not flag a guide naming difficulty while pointing at the escalation path', () => {
    const violations = findRecordAccessStandDownViolations(
      'Cross-table reads are not directly reachable from this sandbox today ' +
        '— request the capability via session.requestCapability and an ' +
        'operator will grant or decline it.',
    );
    expect(violations).toEqual([]);
  });

  it('does not flag ordinary access-method guidance with none of the stand-down phrasing', () => {
    const violations = findRecordAccessStandDownViolations(
      'Read the ops audit dashboard at https://example.com/ops for ' +
        'session-level history.',
    );
    expect(violations).toEqual([]);
  });
});
