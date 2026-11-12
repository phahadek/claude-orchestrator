import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRecordEvent, mockStatus, mockExec } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
  mockStatus: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({ recordEvent: mockRecordEvent }));
vi.mock('../../config', () => ({
  getProjectById: () => ({ projectDir: '/repo', baseBranch: 'dev' }),
}));
vi.mock('../../tasks/TaskWriteCommands', () => ({
  getCachedStatus: mockStatus,
}));
vi.mock('child_process', () => ({ execFileSync: mockExec }));

import { verifyStateClaims } from '../stateClaims';
import { StageGuardRejectionError } from '../stageGuard';

const UUID = '41622f91-52f3-8156-ac07-fcdcdb04792d';
const BARE = UUID.replace(/-/g, '');

function run(texts: string[], claims?: unknown) {
  return verifyStateClaims({
    sessionId: 's1',
    projectId: 'p1',
    texts,
    claims,
  });
}

function trackedOnBase(tracked: string[]) {
  mockExec.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'rev-parse') return;
    const p = args[2].split(':')[1];
    if (!tracked.includes(p)) throw new Error('missing');
  });
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockStatus.mockReset();
  mockExec.mockReset();
  trackedOnBase(['packages/a/b.ts']);
});

describe('verifyStateClaims', () => {
  it('stages unchanged when nothing is mentioned', () => {
    expect(run(['Which approach? and/or e.g. this'])).toEqual([]);
  });

  it('rejects an uncovered task id or path with an audit event', () => {
    expect(() => run([`See ${UUID}`])).toThrow(StageGuardRejectionError);
    expect(() => run(['Edit packages/a/b.ts'])).toThrow(
      StageGuardRejectionError,
    );
    expect(mockRecordEvent).toHaveBeenCalledTimes(2);
    expect(mockRecordEvent.mock.calls[0][0]).toMatchObject({
      event_type: 'stage_guard_rejected',
      payload: { guardId: 'state-claim' },
    });
  });

  it('matches hyphenated, bare and notion: forms to one claim', () => {
    mockStatus.mockReturnValue('Done');
    const out = run(
      [`${UUID} then ${BARE} then notion:${UUID}`],
      [{ taskId: UUID, status: 'Done' }],
    );
    expect(out[0].verified).toBe('✅ Done');
  });

  it('rejects a false task status claim', () => {
    mockStatus.mockReturnValue('Done');
    expect(() =>
      run([`${UUID}`], [{ taskId: UUID, status: 'In Progress' }]),
    ).toThrow(/task store/);
  });

  it('accepts correct path claims and rejects false ones', () => {
    expect(
      run(
        ['x packages/a/b.ts'],
        [{ path: 'packages/a/b.ts', onBase: 'exists' }],
      )[0].verified,
    ).toBe('exists on dev');
    expect(() =>
      run(
        ['x packages/a/b.ts'],
        [{ path: 'packages/a/b.ts', onBase: 'missing' }],
      ),
    ).toThrow(StageGuardRejectionError);
    expect(() =>
      run(
        ['x packages/a/c.ts'],
        [{ path: 'packages/a/c.ts', onBase: 'exists' }],
      ),
    ).toThrow(StageGuardRejectionError);
    expect(
      run(
        ['x packages/a/c.ts'],
        [{ path: 'packages/a/c.ts', onBase: 'missing' }],
      ),
    ).toHaveLength(1);
  });
});
