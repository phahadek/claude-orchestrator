/**
 * Route-level coverage for GET /api/groom-context: distinct from the
 * loadGroomContext unit tests (groom/__tests__/groomLoad.test.ts), this
 * exercises the actual HTTP route + its NotionClient wiring to confirm a
 * migrated project (archStoreAdopted=true) still returns the manifest's
 * non-architecture context pages, not an empty array.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

vi.mock('../../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertProject, updateProject } from '../../db/queries.js';
import { createGroomContextRouter } from '../groomContext';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function setupRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'groom-context-route-'));
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n');
  git(['init'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['branch', '-m', 'dev'], repoDir);
  return repoDir;
}

const CONTEXT_PAGES = [
  { id: 'ctx-tech-arch', title: '🏗️ Technical Architecture' },
  { id: 'ctx-coding-guidelines', title: '📐 Coding Guidelines' },
  { id: 'ctx-project-context', title: '🗺️ Project Context' },
  { id: 'ctx-product-design', title: '🧩 Product Design Doc' },
  { id: 'ctx-dev-setup', title: '⚙️ Dev Setup & Git' },
  { id: 'ctx-future-scope', title: '🔭 Future Scope' },
];

function titleProp(text: string) {
  return { type: 'title', title: [{ text: { content: text } }] };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createGroomContextRouter());
  return app;
}

describe('GET /api/groom-context', () => {
  let repoDir: string;
  let configDir: string;
  const PROJECT_ID = 'groom-context-route-project';

  beforeEach(() => {
    db.prepare('DELETE FROM projects').run();
    repoDir = setupRepo();
    configDir = mkdtempSync(join(tmpdir(), 'groom-context-config-'));
    const projectKey = basename(repoDir);
    mkdirSync(join(configDir, 'projects', projectKey), { recursive: true });
    writeFileSync(
      join(configDir, 'projects', projectKey, 'grooming.json'),
      JSON.stringify({
        source_root: '',
        integration_branch: 'dev',
        packages: [],
        area_aliases: {},
        context_pages: CONTEXT_PAGES.map((p) => ({ id: p.id, title: p.title })),
        milestones: { 'M-route-test': { board: 'fake-board' } },
      }),
    );
    process.env.ORCHESTRATOR_CONFIG_DIR = configDir;

    insertProject({
      id: PROJECT_ID,
      name: 'Groom Context Route Project',
      project_dir: repoDir,
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    updateProject(PROJECT_ID, { arch_store_adopted: 1 });

    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';

      const boardMatch = u.match(/\/databases\/([^/]+)\/query/);
      if (boardMatch && method === 'POST') {
        return jsonResponse({
          results: [],
          has_more: false,
          next_cursor: null,
        });
      }

      const pageMatch = u.match(/\/pages\/([^/]+)$/);
      if (pageMatch && method === 'GET') {
        const id = pageMatch[1];
        const page = CONTEXT_PAGES.find((p) => p.id === id);
        return jsonResponse({
          id,
          url: `https://notion.so/${id}`,
          properties: { 'Task Name': titleProp(page?.title ?? id) },
        });
      }

      const blocksMatch = u.match(/\/blocks\/([^/]+)\/children/);
      if (blocksMatch && method === 'GET') {
        const id = blocksMatch[1];
        return jsonResponse({
          results: [
            {
              id: `p-${id}`,
              type: 'paragraph',
              paragraph: {
                rich_text: [{ text: { content: `Body content for ${id}.` } }],
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }

      throw new Error(`unmocked fetch ${method} ${u}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns all six manifest context pages with non-empty markdown for a migrated project', async () => {
    const res = await supertest(buildApp()).get(
      `/api/groom-context?milestone=M-route-test&project=${PROJECT_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.archSource).toBe('store');
    expect(res.body.contextPages).toHaveLength(CONTEXT_PAGES.length);
    const returnedIds = res.body.contextPages
      .map((p: { id: string }) => p.id)
      .sort();
    expect(returnedIds).toEqual(CONTEXT_PAGES.map((p) => p.id).sort());
    for (const page of res.body.contextPages) {
      expect(typeof page.markdown).toBe('string');
      expect(page.markdown.length).toBeGreaterThan(0);
    }
  });
});
