/**
 * TaskCacheRefresher — unresolvable milestone registration handling.
 *
 * A milestone registered in the DB but absent from the project's tasks.yaml
 * used to re-warn at poll cadence forever (LocalTaskBackend throws on every
 * cycle, TaskCacheRefresher just logged and moved on). Covers:
 * - repeated failures stop producing a warning per cycle (condemned once)
 * - the condemnation is logged exactly once, naming project/milestone/file
 * - a single transient failure does not permanently condemn the milestone
 * - a milestone that becomes resolvable again (tasks.yaml changes) is retried
 * - milestones that resolve normally are unaffected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../logger.js';

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    listMilestones: vi.fn(),
    reconcileYamlMilestones: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: { task_cache_refresh_interval_ms: 10_000 },
}));

import { TaskCacheRefresher } from '../orchestration/TaskCacheRefresher.js';
import { LocalTaskBackend } from '../tasks/LocalTaskBackend.js';
import { ProjectService } from '../projects/ProjectService.js';
import { getAllProjects } from '../config.js';

function writeTasksYaml(
  filePath: string,
  milestones: Array<{ id: string; name: string; tasks: unknown[] }>,
) {
  const lines: string[] = ['milestones:'];
  for (const m of milestones) {
    lines.push(`  - id: ${m.id}`);
    lines.push(`    name: ${m.name}`);
    if (m.tasks.length === 0) {
      lines.push(`    tasks: []`);
    } else {
      lines.push(`    tasks:`);
      for (const t of m.tasks as { id: string; name: string; status: string }[]) {
        lines.push(`      - id: ${t.id}`);
        lines.push(`        name: ${t.name}`);
        lines.push(`        status: ${t.status}`);
      }
    }
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

describe('TaskCacheRefresher — unresolvable milestone registration', () => {
  let projectDir: string;
  let filePath: string;
  const projectId = 'proj-yaml';
  const dbMilestoneId = 'db-uuid-1';
  const yamlMilestoneId = 'missing-milestone';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'task-cache-refresher-test-'),
    );
    filePath = path.join(projectDir, 'tasks.yaml');
    // The registered milestone id has no matching entry in tasks.yaml.
    writeTasksYaml(filePath, [{ id: 'm1', name: 'M1', tasks: [] }]);

    vi.mocked(getAllProjects).mockReturnValue([
      {
        id: projectId,
        name: 'YAML Project',
        projectDir,
        taskSource: 'yaml',
        nonMilestoneSourceConfig: null,
      },
    ] as never);
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      {
        id: dbMilestoneId,
        projectId,
        name: 'Missing Milestone',
        sourceId: yamlMilestoneId,
        displayOrder: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeRefresher() {
    return new TaskCacheRefresher(undefined, {
      listProjects: getAllProjects,
      resolveBackend: () => new LocalTaskBackend(projectDir, projectId),
    });
  }

  it('stops warning once the failure is classified unresolvable, and logs it exactly once', async () => {
    const refresher = makeRefresher();

    // Three consecutive cycles: config drift never self-heals, so the third
    // failure crosses the threshold and condemns the milestone.
    await refresher.refreshOnce();
    await refresher.refreshOnce();
    await refresher.refreshOnce();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = vi.mocked(logger.error).mock.calls[0][0] as string;
    expect(message).toContain(projectId);
    expect(message).toContain(yamlMilestoneId);
    expect(message).toContain(filePath);

    const warnCallsBeforeMore = vi.mocked(logger.warn).mock.calls.length;

    // Further cycles with the same broken file must not re-warn or re-log.
    await refresher.refreshOnce();
    await refresher.refreshOnce();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warnCallsBeforeMore);
  });

  it('does not permanently condemn a milestone after a single transient failure', async () => {
    const refresher = makeRefresher();

    await refresher.refreshOnce();
    expect(logger.error).not.toHaveBeenCalled();

    // Fix the file before the failure threshold is reached.
    writeTasksYaml(filePath, [
      { id: 'm1', name: 'M1', tasks: [] },
      { id: yamlMilestoneId, name: 'Now Resolvable', tasks: [] },
    ]);

    await refresher.refreshOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('picks a condemned milestone back up once tasks.yaml changes', async () => {
    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: () => new LocalTaskBackend(projectDir, projectId),
    });

    await refresher.refreshOnce();
    await refresher.refreshOnce();
    await refresher.refreshOnce();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(broadcasts.length).toBe(0);

    // Registration now exists; bump mtime forward to guarantee the change is
    // observable regardless of filesystem timestamp resolution.
    writeTasksYaml(filePath, [
      { id: 'm1', name: 'M1', tasks: [] },
      { id: yamlMilestoneId, name: 'Now Resolvable', tasks: [] },
    ]);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, future, future);

    await refresher.refreshOnce();

    // No additional error log — condemnation isn't re-triggered — and the
    // milestone is picked up again (broadcast fires on success).
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(broadcasts.length).toBe(1);
  });

  it('leaves normally-resolving milestones unaffected', async () => {
    writeTasksYaml(filePath, [
      { id: yamlMilestoneId, name: 'Resolvable', tasks: [] },
    ]);
    const broadcasts: unknown[] = [];
    const refresher = new TaskCacheRefresher((msg) => broadcasts.push(msg), {
      listProjects: getAllProjects,
      resolveBackend: () => new LocalTaskBackend(projectDir, projectId),
    });

    await refresher.refreshOnce();
    await refresher.refreshOnce();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(broadcasts.length).toBe(2);
  });
});
