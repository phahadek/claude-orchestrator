import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const sessionManagerSource = fs.readFileSync(
  path.join(__dirname, '..', 'session', 'SessionManager.ts'),
  'utf-8',
);

const projectServiceSource = fs.readFileSync(
  path.join(__dirname, '..', 'projects', 'ProjectService.ts'),
  'utf-8',
);

// ── SessionManager ZDR gate — source checks ───────────────────────────────

describe('SessionManager.start() ZDR gate — corporate mode with data_residency_confirmed=0 refuses', () => {
  it('checks getCorporateMode().gates.requireZDR', () => {
    expect(sessionManagerSource).toMatch(/getCorporateMode\(\)/);
    expect(sessionManagerSource).toMatch(/gates\.requireZDR/);
  });

  it('checks project.dataResidencyConfirmed', () => {
    expect(sessionManagerSource).toMatch(/project\.dataResidencyConfirmed/);
  });

  it('throws a clear error message when ZDR gate blocks', () => {
    expect(sessionManagerSource).toMatch(/Session launch refused/);
    expect(sessionManagerSource).toMatch(/Zero Data Retention|ZDR/);
    expect(sessionManagerSource).toMatch(/corporate mode/);
  });
});

describe('SessionManager.start() ZDR gate — corporate mode with data_residency_confirmed=1 proceeds', () => {
  it('gate is conditional — only blocks when both requireZDR is true AND dataResidencyConfirmed is false', () => {
    // The guard must be: requireZDR AND NOT confirmed — so confirmed=true lets the session through
    expect(sessionManagerSource).toMatch(
      /gates\.requireZDR\s*&&\s*!project\.dataResidencyConfirmed/,
    );
  });
});

describe('SessionManager.start() ZDR gate — non-corporate mode skips check', () => {
  it('guard is gated on requireZDR so non-corporate (gates all false) is unaffected', () => {
    // In non-corporate mode, requireZDR is false, so the condition short-circuits
    expect(sessionManagerSource).toMatch(/gates\.requireZDR\s*&&/);
  });
});

describe('SessionManager.start() ZDR gate — refusal writes audit log entry', () => {
  it('calls recordEvent with session_launch_refused_zdr before throwing', () => {
    const zdrBlockStart = sessionManagerSource.indexOf('requireZDR');
    const refusedAuditIdx = sessionManagerSource.indexOf(
      'session_launch_refused_zdr',
    );
    const throwIdx = sessionManagerSource.indexOf('Session launch refused');
    // audit event fires after the gate check and before the throw
    expect(refusedAuditIdx).toBeGreaterThan(zdrBlockStart);
    expect(throwIdx).toBeGreaterThan(refusedAuditIdx);
  });

  it('audit event includes projectId in payload', () => {
    const refusedBlock = sessionManagerSource.slice(
      sessionManagerSource.indexOf('session_launch_refused_zdr'),
      sessionManagerSource.indexOf('Session launch refused') + 100,
    );
    expect(refusedBlock).toMatch(/projectId/);
  });
});

// ── ProjectService.setDataResidencyConfirmed — source checks ─────────────

describe('ProjectService.setDataResidencyConfirmed — writes data_residency_flag_toggled audit log', () => {
  it('calls recordEvent with data_residency_flag_toggled', () => {
    expect(projectServiceSource).toMatch(/data_residency_flag_toggled/);
    expect(projectServiceSource).toMatch(/recordEvent/);
  });

  it('audit payload includes previousValue and newValue', () => {
    const toggleBlock = projectServiceSource.slice(
      projectServiceSource.indexOf('data_residency_flag_toggled'),
    );
    expect(toggleBlock).toMatch(/previousValue/);
    expect(toggleBlock).toMatch(/newValue/);
  });

  it('audit payload includes projectId', () => {
    const toggleBlock = projectServiceSource.slice(
      projectServiceSource.indexOf('data_residency_flag_toggled'),
    );
    expect(toggleBlock).toMatch(/projectId/);
  });

  it('actor_type is human', () => {
    const toggleBlock = projectServiceSource.slice(
      projectServiceSource.indexOf('data_residency_flag_toggled'),
    );
    expect(toggleBlock).toMatch(/actor_type.*human|human.*actor_type/);
  });
});

// ── Runtime test: new event types are accepted by recordEvent ────────────

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT    NOT NULL,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT,
      project_id TEXT,
      task_id    TEXT,
      payload    TEXT    NOT NULL
    );
  `);
  return { db };
});

import { recordEvent } from '../audit/AuditLog.js';

describe('recordEvent — data_residency_flag_toggled event type', () => {
  it('inserts a data_residency_flag_toggled row with correct fields', async () => {
    const { db } = await import('../db/db.js');

    recordEvent({
      event_type: 'data_residency_flag_toggled',
      actor_type: 'human',
      project_id: 'proj-zdr-test',
      payload: {
        projectId: 'proj-zdr-test',
        previousValue: false,
        newValue: true,
      },
    });

    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT * FROM audit_log WHERE event_type='data_residency_flag_toggled' LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.event_type).toBe('data_residency_flag_toggled');
    expect(row!.actor_type).toBe('human');
    expect(row!.project_id).toBe('proj-zdr-test');
    const payload = JSON.parse(row!.payload as string) as Record<
      string,
      unknown
    >;
    expect(payload.previousValue).toBe(false);
    expect(payload.newValue).toBe(true);
    expect(payload.projectId).toBe('proj-zdr-test');
  });
});

describe('recordEvent — session_launch_refused_zdr event type', () => {
  it('inserts a session_launch_refused_zdr row', async () => {
    const { db } = await import('../db/db.js');

    recordEvent({
      event_type: 'session_launch_refused_zdr',
      actor_type: 'system',
      project_id: 'proj-zdr-test',
      payload: {
        projectId: 'proj-zdr-test',
        reason: 'data_residency_confirmed is false',
      },
    });

    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT * FROM audit_log WHERE event_type='session_launch_refused_zdr' LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.event_type).toBe('session_launch_refused_zdr');
    expect(row!.actor_type).toBe('system');
  });
});
