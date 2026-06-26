import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/db.js', async () => {
  const { setupTestDb } = await import('../helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { ProjectService, getProjectRepos } from '../../src/projects/ProjectService.js';
import { db } from '../../src/db/db.js';

beforeEach(() => {
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
});

describe('ProjectService.create / list / getById', () => {
  it('persists a new project with default task_source=notion', () => {
    const created = ProjectService.create({
      id: 'proj-1',
      name: 'My Project',
      projectDir: '/tmp/proj',
      contextUrl: 'https://notion.so/ctx',
      githubRepo: 'owner/repo',
    });
    expect(created.id).toBe('proj-1');
    expect(created.taskSource).toBe('notion');
    expect(created.milestones).toEqual([]);
    expect(created.createdAt).toBeGreaterThan(0);

    const list = ProjectService.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('proj-1');

    const got = ProjectService.getById('proj-1');
    expect(got?.name).toBe('My Project');
    expect(got?.githubRepo).toBe('owner/repo');
  });

  it('returns undefined for missing project', () => {
    expect(ProjectService.getById('missing')).toBeUndefined();
  });

  it('returns project with milestones nested', () => {
    ProjectService.create({ id: 'proj-1', name: 'P', projectDir: '/p' });
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M1',
      sourceId: 'src-1',
      displayOrder: 0,
    });
    ProjectService.createMilestone({
      id: 'm2',
      projectId: 'proj-1',
      name: 'M2',
      sourceId: 'src-2',
      displayOrder: 1,
    });

    const got = ProjectService.getById('proj-1');
    expect(got?.milestones).toHaveLength(2);
    expect(got?.milestones.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('ProjectService.update', () => {
  it('updates fields and bumps updatedAt', async () => {
    ProjectService.create({ id: 'proj-1', name: 'A', projectDir: '/a' });
    const before = ProjectService.getById('proj-1')!;

    await new Promise((r) => setTimeout(r, 5));
    const updated = ProjectService.update('proj-1', {
      name: 'B',
      github_repo: 'owner/x',
    });
    expect(updated?.name).toBe('B');
    expect(updated?.githubRepo).toBe('owner/x');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('returns undefined when project does not exist', () => {
    expect(ProjectService.update('missing', { name: 'X' })).toBeUndefined();
  });
});

describe('ProjectService.delete (cascade)', () => {
  it('removes the project and cascades to its milestones', () => {
    ProjectService.create({ id: 'proj-1', name: 'A', projectDir: '/a' });
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M1',
    });
    ProjectService.createMilestone({
      id: 'm2',
      projectId: 'proj-1',
      name: 'M2',
    });
    expect(ProjectService.listMilestones('proj-1')).toHaveLength(2);

    const deleted = ProjectService.delete('proj-1');
    expect(deleted).toBe(true);
    expect(ProjectService.getById('proj-1')).toBeUndefined();
    expect(ProjectService.listMilestones('proj-1')).toHaveLength(0);
  });

  it('returns false when project does not exist', () => {
    expect(ProjectService.delete('missing')).toBe(false);
  });

  it('does NOT cascade to other projects', () => {
    ProjectService.create({ id: 'p1', name: 'A', projectDir: '/a' });
    ProjectService.create({ id: 'p2', name: 'B', projectDir: '/b' });
    ProjectService.createMilestone({ id: 'm-p1', projectId: 'p1', name: 'M' });
    ProjectService.createMilestone({ id: 'm-p2', projectId: 'p2', name: 'M' });

    ProjectService.delete('p1');
    expect(ProjectService.getById('p2')).toBeDefined();
    expect(ProjectService.listMilestones('p2')).toHaveLength(1);
  });
});

describe('ProjectService.deleteMilestone', () => {
  it('removes a single milestone but leaves the project intact', () => {
    ProjectService.create({ id: 'proj-1', name: 'A', projectDir: '/a' });
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'proj-1',
      name: 'M1',
    });
    ProjectService.createMilestone({
      id: 'm2',
      projectId: 'proj-1',
      name: 'M2',
    });

    expect(ProjectService.deleteMilestone('m1')).toBe(true);
    expect(ProjectService.listMilestones('proj-1').map((m) => m.id)).toEqual([
      'm2',
    ]);
    expect(ProjectService.getById('proj-1')).toBeDefined();
  });
});

describe('ProjectService.getByGithubRepo', () => {
  it('returns the project that owns the repo', () => {
    ProjectService.create({
      id: 'p1',
      name: 'A',
      projectDir: '/a',
      githubRepo: 'owner/a',
    });
    ProjectService.create({
      id: 'p2',
      name: 'B',
      projectDir: '/b',
      githubRepo: 'owner/b',
    });
    expect(ProjectService.getByGithubRepo('owner/a')?.id).toBe('p1');
    expect(ProjectService.getByGithubRepo('owner/b')?.id).toBe('p2');
    expect(ProjectService.getByGithubRepo('owner/missing')).toBeUndefined();
  });

  it('matches a repo inside a multi-repo JSON array', () => {
    ProjectService.create({
      id: 'multi',
      name: 'Multi',
      projectDir: '/m',
      githubRepo: JSON.stringify(['org/r1', 'org/r2']),
    });
    expect(ProjectService.getByGithubRepo('org/r1')?.id).toBe('multi');
    expect(ProjectService.getByGithubRepo('org/r2')?.id).toBe('multi');
    expect(ProjectService.getByGithubRepo('org/r3')).toBeUndefined();
  });
});

describe('getProjectRepos', () => {
  it('returns [repo] for a bare string', () => {
    expect(getProjectRepos({ githubRepo: 'owner/repo' })).toEqual([
      'owner/repo',
    ]);
  });

  it('returns parsed list for a JSON array', () => {
    expect(
      getProjectRepos({ githubRepo: JSON.stringify(['o/r1', 'o/r2']) }),
    ).toEqual(['o/r1', 'o/r2']);
  });

  it('returns [] for null', () => {
    expect(getProjectRepos({ githubRepo: null })).toEqual([]);
  });
});

describe('ProjectService milestone update', () => {
  it('updates milestone fields and bumps updatedAt', () => {
    ProjectService.create({ id: 'p1', name: 'A', projectDir: '/a' });
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'p1',
      name: 'old',
      sourceId: 'src-1',
    });

    const updated = ProjectService.updateMilestone('m1', {
      name: 'new',
      display_order: 5,
    });
    expect(updated?.name).toBe('new');
    expect(updated?.displayOrder).toBe(5);
    expect(updated?.sourceId).toBe('src-1');
  });
});
