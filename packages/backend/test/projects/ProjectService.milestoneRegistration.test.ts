/**
 * Creating a milestone must register it in the project's grooming manifest
 * (config/projects/<dir>/grooming.json) — the manifest's `milestones` map
 * groomLoad.ts requires every milestone to already carry (see
 * groomLoad.ts's registerMilestoneInManifest/checkMilestoneRegistered).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

vi.mock('../../src/db/db.js', async () => {
  const { setupTestDb } = await import('../helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { ProjectService } from '../../src/projects/ProjectService.js';
import { db } from '../../src/db/db.js';

const BASE_MANIFEST = {
  backend: 'notion',
  source_root: 'packages/backend/src',
  notion_env: 'prod',
  status_vocab: { backlog: '🔲 Backlog' },
  context_pages: [{ id: 'ctx-1', title: 'Technical Architecture' }],
  $comment: 'gitignored, host-specific',
};

describe('ProjectService.createMilestone — grooming manifest registration', () => {
  let repoDir: string;
  let configDir: string;
  let manifestPath: string;

  beforeEach(() => {
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    repoDir = mkdtempSync(join(tmpdir(), 'proj-service-manifest-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'proj-service-manifest-config-'));
    const projectKey = basename(repoDir);
    mkdirSync(join(configDir, 'projects', projectKey), { recursive: true });
    manifestPath = join(configDir, 'projects', projectKey, 'grooming.json');
    writeFileSync(manifestPath, JSON.stringify(BASE_MANIFEST, null, 2));
    process.env.ORCHESTRATOR_CONFIG_DIR = configDir;

    ProjectService.create({ id: 'proj-1', name: 'P', projectDir: repoDir });
  });

  afterEach(() => {
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function readManifest() {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  }

  it('adds a milestones entry keyed by canonical short id, board = source_id', () => {
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M11 — Some Milestone',
      sourceId: 'notion-board-11',
      displayOrder: 0,
    });

    const manifest = readManifest();
    expect(manifest.milestones.M11).toEqual({ board: 'notion-board-11' });
  });

  it("the new entry's neighbours names the preceding milestone by display_order", () => {
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M11 — First',
      sourceId: 'board-11',
      displayOrder: 0,
    });
    ProjectService.createMilestone({
      id: 'm2',
      projectId: 'proj-1',
      name: 'M12 — Second',
      sourceId: 'board-12',
      displayOrder: 1,
    });

    const manifest = readManifest();
    expect(manifest.milestones.M12).toEqual({
      board: 'board-12',
      neighbours: [{ id: 'M11', board: 'board-11' }],
    });
    expect(manifest.milestones.M11).toEqual({ board: 'board-11' });
  });

  it('leaves all other manifest fields byte-identical', () => {
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M11 — Some Milestone',
      sourceId: 'board-11',
      displayOrder: 0,
    });

    const manifest = readManifest();
    expect(manifest.backend).toBe(BASE_MANIFEST.backend);
    expect(manifest.source_root).toBe(BASE_MANIFEST.source_root);
    expect(manifest.notion_env).toBe(BASE_MANIFEST.notion_env);
    expect(manifest.status_vocab).toEqual(BASE_MANIFEST.status_vocab);
    expect(manifest.context_pages).toEqual(BASE_MANIFEST.context_pages);
    expect(manifest.$comment).toBe(BASE_MANIFEST.$comment);
  });

  it('is a no-op and does not throw for a project with no config dir', () => {
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    ProjectService.create({
      id: 'proj-2',
      name: 'P2',
      projectDir: '/no/such/dir',
    });

    expect(() =>
      ProjectService.createMilestone({
        id: 'm-no-config',
        projectId: 'proj-2',
        name: 'M13 — Untracked',
        sourceId: 'board-13',
        displayOrder: 0,
      }),
    ).not.toThrow();
  });

  it('is a no-op and does not throw for a project whose config dir has no manifest', () => {
    const bareProjectKey = 'no-manifest-project';
    const bareRepoDir = join(repoDir, '..', bareProjectKey);
    mkdirSync(join(configDir, 'projects', bareProjectKey), {
      recursive: true,
    });
    ProjectService.create({
      id: 'proj-3',
      name: 'P3',
      projectDir: bareRepoDir,
    });

    expect(() =>
      ProjectService.createMilestone({
        id: 'm-no-manifest',
        projectId: 'proj-3',
        name: 'M14 — Untracked',
        sourceId: 'board-14',
        displayOrder: 0,
      }),
    ).not.toThrow();
  });

  it('does not duplicate or clobber an already-registered entry', () => {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        { ...BASE_MANIFEST, milestones: { M11: { board: 'existing-board' } } },
        null,
        2,
      ),
    );

    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M11 — Some Milestone',
      sourceId: 'notion-board-11',
      displayOrder: 0,
    });

    const manifest = readManifest();
    expect(manifest.milestones.M11).toEqual({ board: 'existing-board' });
    expect(Object.keys(manifest.milestones)).toEqual(['M11']);
  });
});
