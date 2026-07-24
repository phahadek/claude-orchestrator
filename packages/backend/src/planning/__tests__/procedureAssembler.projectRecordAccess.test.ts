import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

const mockGetProjectById = vi.fn();
vi.mock('../../config', () => ({
  getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
}));

import { renderProjectRecordAccess } from '../procedureAssembler';

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
      join(reposDir, 'config', 'projects', basename(repoDir), 'investigation-guide.md'),
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
    expect(lines.join('\n')).toContain('Keyed by config-dir, not by registry id.');
  });

  it('falls back to no section (never throws) for an unknown project', () => {
    mockGetProjectById.mockReturnValue(undefined);

    expect(renderProjectRecordAccess('ops', 'unknown-project')).toEqual([]);
  });

  it('falls back to no section when the project has no guide artifact', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoDir,
    });
    // No investigation-guide.md written.

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
});
