/**
 * End-to-end tests for the base64 screenshot intake added to
 * routes/reportState.ts (Accept a base64 screenshot on the investigation
 * report intake routes task). Unlike reportState.test.ts (which mocks
 * reportService to test request parsing/status-code translation in
 * isolation), these run the real router + reportService + reportStore
 * against a test DB and a temp XDG_DATA_HOME, mirroring
 * reportStoreImage.test.ts's setup — so the size-cap rejection and the
 * round-trip really exercise decode -> validate -> filesystem write ->
 * image_path column, not a mock's stand-in.
 *
 * AC: POST accepts a base64 image within the 8MB cap and rejects one
 * exceeding it, naming the cap explicitly (not a generic body-parser
 * error); an oversized *request body* (over the 12mb JSON parser limit)
 * 413s before route logic runs. PATCH can replace and clear a draft
 * report's image. A multi-MB PNG round-trips with identical bytes.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import {
  createReportStateRouter,
  reportImageBodyParser,
} from '../reportState.js';

function makeApp() {
  const app = express();
  // Mirrors server.ts's ordering: the scoped parser runs ahead of the
  // global default so /api/reports gets the raised 12mb limit.
  app.use('/api/reports', reportImageBodyParser);
  app.use(express.json());
  app.use('/api', createReportStateRouter());
  return app;
}

function pngDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

let tmpParent: string;
let prevXdgDataHome: string | undefined;

beforeAll(() => {
  ProjectService.create({
    id: 'proj-1',
    name: 'Project One',
    projectDir: '/tmp/proj-1',
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM audit_log').run();
  tmpParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'report-images-route-test-'),
  );
  prevXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmpParent;
});

afterEach(() => {
  if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdgDataHome;
  fs.rmSync(tmpParent, { recursive: true, force: true });
});

describe('POST /api/reports image handling', () => {
  it('accepts a multi-MB base64 PNG within the 8MB cap and round-trips it byte-for-byte', async () => {
    const bytes = crypto.randomBytes(3 * 1024 * 1024);
    const res = await request(makeApp())
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 't',
        symptomText: 's',
        image: pngDataUrl(bytes),
      });

    expect(res.status).toBe(201);
    expect(res.body.image_path).toBeTruthy();
    expect(fs.readFileSync(res.body.image_path).equals(bytes)).toBe(true);
  });

  it('rejects a decoded image over the 8MB cap with 400 naming the 8 MB cap', async () => {
    // 8.5MB decoded -> ~11.3MB base64, comfortably under the 12mb body limit
    // so this is rejected by route validation, not the body parser.
    const bytes = crypto.randomBytes(8.5 * 1024 * 1024);
    const res = await request(makeApp())
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 't',
        symptomText: 's',
        image: pngDataUrl(bytes),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 MB/);
  });

  it('413s a request body over the 12mb parser limit before route logic runs', async () => {
    // 10MB decoded -> ~13.3MB base64, over the 12mb JSON body limit.
    const bytes = crypto.randomBytes(10 * 1024 * 1024);
    const res = await request(makeApp())
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 't',
        symptomText: 's',
        image: pngDataUrl(bytes),
      });

    expect(res.status).toBe(413);
  });
});

describe('PATCH /api/reports/:id image handling', () => {
  it('replaces a draft report image', async () => {
    const app = makeApp();
    const created = await request(app)
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 't',
        symptomText: 's',
        image: pngDataUrl(Buffer.from('original-bytes')),
      });
    const id = created.body.id as string;
    const originalPath = created.body.image_path as string;

    const newBytes = crypto.randomBytes(1024);
    const res = await request(app)
      .patch(`/api/reports/${id}`)
      .send({ image: pngDataUrl(newBytes) });

    expect(res.status).toBe(200);
    expect(res.body.image_path).toBeTruthy();
    expect(fs.readFileSync(res.body.image_path).equals(newBytes)).toBe(true);
    // Original file path is still valid (same extension -> same path reused).
    expect(res.body.image_path).toBe(originalPath);
  });

  it('clears a draft report image', async () => {
    const app = makeApp();
    const created = await request(app)
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 't',
        symptomText: 's',
        image: pngDataUrl(Buffer.from('original-bytes')),
      });
    const id = created.body.id as string;
    const originalPath = created.body.image_path as string;
    expect(fs.existsSync(originalPath)).toBe(true);

    const res = await request(app)
      .patch(`/api/reports/${id}`)
      .send({ image: null });

    expect(res.status).toBe(200);
    expect(res.body.image_path).toBeNull();
    expect(fs.existsSync(originalPath)).toBe(false);
  });

  it('rejects a decoded image over the 8MB cap on update, naming the cap', async () => {
    const app = makeApp();
    const created = await request(app).post('/api/reports').send({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    const id = created.body.id as string;

    const bytes = crypto.randomBytes(8.5 * 1024 * 1024);
    const res = await request(app)
      .patch(`/api/reports/${id}`)
      .send({ image: pngDataUrl(bytes) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 MB/);
  });
});

describe('GET /api/reports/:id/image', () => {
  it('serves the image bytes with the correct content-type for an attached image', async () => {
    const app = makeApp();
    const bytes = crypto.randomBytes(2048);
    const created = await request(app)
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 't',
        symptomText: 's',
        image: pngDataUrl(bytes),
      });
    const id = created.body.id as string;

    const res = await request(app).get(`/api/reports/${id}/image`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.compare(res.body, bytes)).toBe(0);
  });

  it('404s for a report that has no attached image', async () => {
    const app = makeApp();
    const created = await request(app).post('/api/reports').send({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    const id = created.body.id as string;

    const res = await request(app).get(`/api/reports/${id}/image`);

    expect(res.status).toBe(404);
  });

  it('404s for a nonexistent report id', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/reports/no-such-report/image');
    expect(res.status).toBe(404);
  });
});
