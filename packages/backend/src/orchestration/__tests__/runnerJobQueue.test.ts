import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';

vi.mock('../runnerUnreachabilityReconciler', () => ({
  RUNNER_UNREACHABLE_GRACE_MS: 1000,
}));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({
  RUNNER_TLS_CERT_PATH: '',
  RUNNER_TLS_KEY_PATH: '',
  RUNNER_LISTENER_PORT: 0,
  RUNNER_LISTENER_HOST: '127.0.0.1',
}));
vi.mock('../../auth/DeviceAuth', () => ({
  requireRunnerAuth: (
    req: { headers: Record<string, string>; device?: unknown },
    res: {
      status: (n: number) => { json: (b: unknown) => void };
    },
    next: () => void,
  ) => {
    const t = req.headers['x-test-token'];
    if (!t) return res.status(401).json({ error: 'unauthorized' });
    if (!t.startsWith('runner')) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.device = { id: t };
    next();
  },
}));

import {
  enqueueRunnerJob,
  claimRunnerJob,
  listClaimableJobs,
  submitRunnerResult,
  RunnerUnreachableError,
  _resetRunnerJobQueueForTests,
} from '../runnerJobQueue';
import { createRunnerApp } from '../../routes/runnerChannel';
import type { RunnerResultPackage } from '../runnerResultPackage';

const archive = Buffer.from('gz-bytes');
function job(runId = 'r1') {
  return {
    runId,
    projectId: 'p1',
    spec: { commands: ['npm test'] },
    snapshot: {
      manifest: { contentHash: 'h', entries: [], totalBytes: 8 },
      archive,
    },
    contentHash: 'h',
    testReportGlob: null,
  };
}
function validPkg(): RunnerResultPackage {
  return {
    passed: true,
    output: 'ok',
    commandResults: [{ command: 'npm test', passed: true }],
    oomKilled: false,
    startedAt: 1,
    finishedAt: 2,
    runnerConcurrentRunCount: 0,
    structuredResult: null,
  };
}

beforeEach(() => _resetRunnerJobQueueForTests());
afterEach(() => {
  vi.useRealTimers();
  _resetRunnerJobQueueForTests();
});

describe('runnerJobQueue', () => {
  it('claims once, then settles on result', async () => {
    const p = enqueueRunnerJob(job());
    expect(listClaimableJobs()).toHaveLength(1);
    expect(claimRunnerJob('r1', 'runner-a')).not.toBeNull();
    expect(claimRunnerJob('r1', 'runner-b')).toBeNull();
    expect(listClaimableJobs()).toHaveLength(0);
    expect(submitRunnerResult('r1', 'runner-b', validPkg())).toBe(false);
    expect(submitRunnerResult('r1', 'runner-a', validPkg())).toBe(true);
    await expect(p).resolves.toMatchObject({ passed: true });
  });

  it('rejects with RunnerUnreachableError after the grace period', async () => {
    vi.useFakeTimers();
    const p = enqueueRunnerJob(job(), 500);
    const assertion = expect(p).rejects.toBeInstanceOf(RunnerUnreachableError);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    expect(claimRunnerJob('r1', 'runner-a')).toBeNull();
  });
});

describe('runner channel routes', () => {
  const app = createRunnerApp();
  const auth = { 'x-test-token': 'runner-a' };

  it('rejects non-runner tokens with 403 on every route', async () => {
    const h = { 'x-test-token': 'operator-x' };
    const r = supertest(app);
    expect((await r.get('/api/runner/poll').set(h)).status).toBe(403);
    expect((await r.post('/api/runner/jobs/r1/claim').set(h)).status).toBe(403);
    expect((await r.get('/api/runner/jobs/r1/snapshot').set(h)).status).toBe(
      403,
    );
    expect(
      (await r.post('/api/runner/jobs/r1/result').set(h).send(validPkg()))
        .status,
    ).toBe(403);
  });

  it('claim, download, and result resolve the job; second claim gets nothing', async () => {
    const p = enqueueRunnerJob(job());
    const r = supertest(app);
    const poll = await r.get('/api/runner/poll').set(auth);
    expect(poll.body.work).toHaveLength(1);
    expect(JSON.stringify(poll.body)).not.toContain('commands');
    expect(
      (await r.post('/api/runner/jobs/r1/claim').set(auth)).status,
    ).toBe(200);
    expect(
      (await r.post('/api/runner/jobs/r1/claim').set(auth)).status,
    ).toBe(404);
    const snap = await r
      .get('/api/runner/jobs/r1/snapshot')
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect((snap.body as Buffer).equals(archive)).toBe(true);
    const res = await r
      .post('/api/runner/jobs/r1/result')
      .set(auth)
      .send(validPkg());
    expect(res.status).toBe(200);
    await expect(p).resolves.toMatchObject({ passed: true });
  });

  it('rejects an invalid result with 400 and leaves the job pending', async () => {
    const p = enqueueRunnerJob(job(), 400);
    const assertion = expect(p).rejects.toBeInstanceOf(RunnerUnreachableError);
    claimRunnerJob('r1', 'runner-a');
    const res = await supertest(app)
      .post('/api/runner/jobs/r1/result')
      .set(auth)
      .send({ passed: 'yes' });
    expect(res.status).toBe(400);
    await assertion;
  });
});
