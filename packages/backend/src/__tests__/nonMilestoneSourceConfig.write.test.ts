import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── Source checks ─────────────────────────────────────────────────────────────

const queriesSource = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'queries.ts'),
  'utf-8',
);

describe('ProjectPatch — non_milestone_source_config field', () => {
  it('ProjectPatch interface includes non_milestone_source_config', () => {
    expect(queriesSource).toMatch(
      /non_milestone_source_config\?:\s*string\s*\|\s*null/,
    );
  });

  it('updateProject SET clause includes non_milestone_source_config', () => {
    expect(queriesSource).toContain(
      'non_milestone_source_config = @non_milestone_source_config',
    );
  });

  it('updateProject preserves non_milestone_source_config when absent from patch', () => {
    expect(queriesSource).toMatch(/'non_milestone_source_config' in patch/);
  });
});

// ── In-memory DB round-trip ────────────────────────────────────────────────────

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  insertProject,
  updateProject,
  getProjectRowById,
} from '../db/queries.js';

let seq = 0;
function newId() {
  return `proj-${++seq}`;
}

function create(id: string) {
  return insertProject({
    id,
    name: `P ${id}`,
    project_dir: `/p/${id}`,
    task_source: 'notion',
    context_url: null,
    github_repo: null,
  });
}

describe('updateProject — non_milestone_source_config round-trip', () => {
  it('persists a Notion database id config', () => {
    const id = newId();
    create(id);
    const cfg = JSON.stringify({ notionDatabaseId: 'nm-abc' });
    updateProject(id, { non_milestone_source_config: cfg });
    const row = getProjectRowById(id);
    expect(row!.non_milestone_source_config).toBe(cfg);
    expect(
      (JSON.parse(cfg) as { notionDatabaseId: string }).notionDatabaseId,
    ).toBe('nm-abc');
  });

  it('persists a YAML milestone id config', () => {
    const id = newId();
    create(id);
    const cfg = JSON.stringify({ milestoneId: 'backlog' });
    updateProject(id, { non_milestone_source_config: cfg });
    expect(getProjectRowById(id)!.non_milestone_source_config).toBe(cfg);
  });

  it('clears config when patched to null', () => {
    const id = newId();
    create(id);
    updateProject(id, {
      non_milestone_source_config: '{"notionDatabaseId":"x"}',
    });
    updateProject(id, { non_milestone_source_config: null });
    expect(getProjectRowById(id)!.non_milestone_source_config).toBeNull();
  });

  it('preserves config when field absent from patch', () => {
    const id = newId();
    create(id);
    const cfg = JSON.stringify({ notionDatabaseId: 'keep-me' });
    updateProject(id, { non_milestone_source_config: cfg });
    updateProject(id, { name: 'Renamed' });
    const row = getProjectRowById(id)!;
    expect(row.non_milestone_source_config).toBe(cfg);
    expect(row.name).toBe('Renamed');
  });

  it('returns undefined for a non-existent project', () => {
    expect(
      updateProject('no-such-id', { non_milestone_source_config: '{}' }),
    ).toBeUndefined();
  });
});
