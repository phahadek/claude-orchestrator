import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { insertSessionOrIgnore, updateSessionStatus } from '../../db/queries';
import {
  acquireCheckoutLockdown,
  releaseCheckoutLockdown,
  reconcileCheckoutLockdownAtBoot,
  getScratchDir,
} from '../checkoutLockdown';

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function seedSession(sessionId: string, status: string): void {
  insertSessionOrIgnore({
    session_id: sessionId,
    task_id: null,
    task_url: '',
    project_context_url: '',
    status: 'running',
    started_at: Date.now(),
    session_type: 'groom',
  });
  updateSessionStatus(sessionId, status);
}

describe('checkoutLockdown', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-lockdown-'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'hello\n');
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.writeFileSync(
      path.join(projectDir, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
  });

  afterEach(() => {
    // Lockdown may still be active — restore write access before rm, else
    // the fs.rmSync cleanup itself would EACCES on a locked-down tree.
    fs.chmodSync(projectDir, 0o755);
    for (const entry of fs.readdirSync(projectDir)) {
      try {
        fs.chmodSync(path.join(projectDir, entry), 0o755);
      } catch {
        // best-effort
      }
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('strips write permission from the checkout on first acquire, restores it on last release', () => {
    acquireCheckoutLockdown(projectDir, 'session-a', { applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    expect(canWrite(path.join(projectDir, '.git', 'HEAD'))).toBe(false);
    expect(canWrite(getScratchDir(projectDir, 'session-a'))).toBe(true);

    releaseCheckoutLockdown('session-a', { applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(getScratchDir(projectDir, 'session-a'))).toBe(false);
  });

  it('does not lift the lock while a second concurrent planning session is still active', () => {
    acquireCheckoutLockdown(projectDir, 'session-a', { applyFsLockdown: true });
    acquireCheckoutLockdown(projectDir, 'session-b', { applyFsLockdown: true });

    releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    // session-a's own scratch dir is gone, session-b's remains untouched.
    expect(fs.existsSync(getScratchDir(projectDir, 'session-a'))).toBe(false);
    expect(canWrite(getScratchDir(projectDir, 'session-b'))).toBe(true);

    releaseCheckoutLockdown('session-b', { applyFsLockdown: true });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
  });

  it('is a no-op for a session that never acquired a lock', () => {
    expect(() =>
      releaseCheckoutLockdown('never-acquired', { applyFsLockdown: true }),
    ).not.toThrow();
  });

  it('applyFsLockdown: false (Docker path) tracks ref-counting without touching filesystem permissions', () => {
    acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: false,
    });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    releaseCheckoutLockdown('session-a', { applyFsLockdown: false });
  });

  it('boot reconciliation prunes locks for terminal/missing sessions and restores the filesystem', () => {
    seedSession('dead-session', 'killed');
    acquireCheckoutLockdown(projectDir, 'dead-session', {
      applyFsLockdown: true,
    });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);

    reconcileCheckoutLockdownAtBoot({ applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(getScratchDir(projectDir, 'dead-session'))).toBe(
      false,
    );
  });

  it('boot reconciliation re-applies the lockdown for a still-active session (mid-crash restore)', () => {
    seedSession('live-session', 'running');
    // Simulate a crash between the DB insert and the chmod actually landing:
    // acquire with applyFsLockdown:false so the row exists but the tree is
    // still writable, then reconcile should notice count>0 and lock it.
    acquireCheckoutLockdown(projectDir, 'live-session', {
      applyFsLockdown: false,
    });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);

    reconcileCheckoutLockdownAtBoot({ applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    fs.chmodSync(projectDir, 0o755);
  });
});
