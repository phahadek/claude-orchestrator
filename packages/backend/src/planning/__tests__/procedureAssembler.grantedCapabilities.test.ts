/**
 * `renderOpsCapabilities` lists the session's already-granted capabilities,
 * resolved with the same resolver and inputs `SessionManager.start` seeds from.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockGetProjectById = vi.fn();
vi.mock('../../config', () => ({
  getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
}));

import { renderOpsCapabilities } from '../procedureAssembler';
import {
  loadOrchestratorConfig,
  resolvePreGrantCapabilities,
} from '../../session/orchestrator-config';

const HEADER =
  'Already granted to this session — use directly, do not request:';

describe('renderOpsCapabilities — already-granted capabilities', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'granted-capabilities-'));
    mockGetProjectById.mockReturnValue({ id: 'proj-a', projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    mockGetProjectById.mockReset();
  });

  const writeConfig = (body: string) =>
    writeFileSync(join(projectDir, '.claude-orchestrator.yml'), body);

  it('lists ops pre-grants under the Already granted line', () => {
    writeConfig(
      [
        'capability_pre_grants:',
        '  ops:',
        '    - "Bash(pm-ro-query:*)"',
        '    - "Bash(pm-host:*)"',
      ].join('\n'),
    );
    const rendered = renderOpsCapabilities('proj-a', 'notion:abc').join('\n');
    expect(rendered).toContain(HEADER);
    expect(rendered).toContain('- Bash(pm-ro-query:*)');
    expect(rendered).toContain('- Bash(pm-host:*)');
    expect(rendered).not.toContain('nothing more');
  });

  it('resolves gate-verify and investigate pre-grants for their own sub-kind', () => {
    writeConfig(
      [
        'capability_pre_grants:',
        '  ops:',
        '    - "Bash(pm-host:*)"',
        '  gate-verify:',
        '    - "Bash(pm-ro-query:*)"',
        '  investigate:',
        '    - "read:audit-log:proj-a"',
      ].join('\n'),
    );
    const gate = renderOpsCapabilities('proj-a', 'gate-item:g1').join('\n');
    expect(gate).toContain('- Bash(pm-ro-query:*)');
    expect(gate).not.toContain('- Bash(pm-host:*)');

    const inv = renderOpsCapabilities('proj-a', 'report-batch:b1').join('\n');
    expect(inv).toContain('- read:audit-log:proj-a');
    expect(inv).not.toContain('- Bash(pm-ro-query:*)');
  });

  it('renders no Already granted line when the project has no pre-grants', () => {
    const rendered = renderOpsCapabilities('proj-a', 'notion:abc').join('\n');
    expect(rendered).not.toContain('Already granted');
  });

  it('renders exactly what resolvePreGrantCapabilities returns, including isGrantable filtering', () => {
    writeConfig(
      [
        'capability_pre_grants:',
        '  ops:',
        '    - "read:audit-log:proj-a"',
        '    - "Bash(git task-intent apply:*)"',
      ].join('\n'),
    );
    const expected = resolvePreGrantCapabilities(
      loadOrchestratorConfig(projectDir),
      'ops',
      'notion:abc',
    );
    const rendered = renderOpsCapabilities('proj-a', 'notion:abc');
    const bullets = rendered
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2));
    expect(bullets).toEqual(expected);
    expect(rendered.join('\n')).not.toContain('git task-intent apply');
  });
});
