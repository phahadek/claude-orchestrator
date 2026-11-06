/**
 * `renderAdHocReadCapability` / `renderOpsCapabilities` must never hard-code
 * this repo's own `packages/backend/scripts/adhoc-query.ts` as the
 * sanctioned ad-hoc DB read for every managed project — that path resolves
 * only for the self-hosted project. This asserts the paragraph is resolved
 * per-project from `.claude-orchestrator.yml`'s `ad_hoc_read_command`, with
 * a generic, script-agnostic fallback for a project that declares none, and
 * pins that this repo's own config still produces the `adhoc-query.ts`
 * guidance so today's behaviour is preserved through configuration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockGetProjectById = vi.fn();
vi.mock('../../config', () => ({
  getProjectById: (...args: unknown[]) => mockGetProjectById(...args),
}));

import {
  renderAdHocReadCapability,
  renderOpsCapabilities,
} from '../procedureAssembler';
import { loadOrchestratorConfig } from '../../session/orchestrator-config';

describe('renderAdHocReadCapability', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ad-hoc-read-capability-'));
    mockGetProjectById.mockReturnValue({ id: 'proj-a', projectDir });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    mockGetProjectById.mockReset();
  });

  it('emits a generic replacement naming no script when the project declares no ad_hoc_read_command', () => {
    const rendered = renderAdHocReadCapability('proj-a').join('\n');
    expect(rendered).not.toContain('adhoc-query');
    expect(rendered).not.toContain('packages/backend/scripts/');
    expect(rendered).toMatch(/session\.requestCapability/);
    expect(rendered).toMatch(/no dedicated MCP read tool/);
  });

  it('renders the same generic replacement when the project is unresolvable', () => {
    mockGetProjectById.mockReturnValue(undefined);
    const rendered = renderAdHocReadCapability('unknown-project').join('\n');
    expect(rendered).not.toContain('adhoc-query');
    expect(rendered).not.toContain('packages/backend/scripts/');
    expect(rendered).toMatch(/session\.requestCapability/);
  });

  it('names the declared command verbatim inside the session.requestCapability example', () => {
    writeFileSync(
      join(projectDir, '.claude-orchestrator.yml'),
      "ad_hoc_read_command: 'Bash(python3 scripts/ro_query.py:*)'\n",
    );
    const rendered = renderAdHocReadCapability('proj-a').join('\n');
    expect(rendered).toContain(
      '"capability":"Bash(python3 scripts/ro_query.py:*)"',
    );
  });

  it('surfaces the same project-resolved behaviour through renderOpsCapabilities', () => {
    const withoutCommand = renderOpsCapabilities('proj-a').join('\n');
    expect(withoutCommand).not.toContain('adhoc-query');
    expect(withoutCommand).not.toContain('packages/backend/scripts/');

    writeFileSync(
      join(projectDir, '.claude-orchestrator.yml'),
      "ad_hoc_read_command: 'Bash(python3 scripts/ro_query.py:*)'\n",
    );
    const withCommand = renderOpsCapabilities('proj-a').join('\n');
    expect(withCommand).toContain('Bash(python3 scripts/ro_query.py:*)');
  });
});

describe('this repo declares its own ad_hoc_read_command', () => {
  // Repo root, resolved relative to this test file rather than any
  // deploy-path assumption — packages/backend/src/planning/__tests__ is 5
  // directories below the repo root.
  const repoRoot = join(__dirname, '../../../../..');

  it("this repo's .claude-orchestrator.yml declares ad_hoc_read_command", () => {
    const config = loadOrchestratorConfig(repoRoot);
    expect(config.ad_hoc_read_command).toBe(
      'Bash(npx ts-node packages/backend/scripts/adhoc-query.ts:*)',
    );
  });

  it('the declared command matches the raw yml text, not just the parsed default', () => {
    const raw = readFileSync(
      join(repoRoot, '.claude-orchestrator.yml'),
      'utf-8',
    );
    expect(raw).toContain('ad_hoc_read_command:');
    expect(raw).toContain('packages/backend/scripts/adhoc-query.ts');
  });

  it('rendering for claude-dashboard still produces the adhoc-query.ts guidance', () => {
    mockGetProjectById.mockReturnValue({
      id: 'claude-dashboard',
      projectDir: repoRoot,
    });
    const rendered = renderOpsCapabilities('claude-dashboard').join('\n');
    expect(rendered).toContain('packages/backend/scripts/adhoc-query.ts');
    expect(rendered).toMatch(
      /Bash\(npx ts-node packages\/backend\/scripts\/adhoc-query\.ts:\*\)/,
    );
  });
});
