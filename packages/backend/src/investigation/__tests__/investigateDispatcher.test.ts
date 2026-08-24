import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../config', () => ({
  getProjectById: vi
    .fn()
    .mockReturnValue({ contextUrl: 'https://notion.so/project' }),
}));

import {
  buildInvestigateProcedure,
  launchInvestigateBatch,
} from '../investigateDispatcher';
import { renderHardRulesMarkdown } from '../../planning/procedureCore';
import {
  insertReport,
  listDispatchedSessions,
  type InvestigationReportRow,
} from '../reportStore';

function makeReport(
  overrides: Partial<InvestigationReportRow> = {},
): InvestigationReportRow {
  return {
    id: 'report-1',
    project_id: 'proj-a',
    milestone_id: 'milestone-1',
    title: 'sessions erroring after deploy',
    symptom_text: 'several sessions errored right after the last deploy',
    evidence_text: null,
    state: 'committed',
    source: 'operator',
    origin_session_id: null,
    origin_task_id: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

// Informational, not a drift-guard enforcement — mirrors
// procedureCore.test.ts's lockstep guard pattern of asserting the rendered
// content contains what it must, not that it byte-for-byte matches a
// separately-maintained canon (the vendored /investigate SKILL.md stays its
// own canon; see config/procedures.md's two-canon rule).
describe('buildInvestigateProcedure', () => {
  it("includes the RC skill's five-stage structure", () => {
    const procedure = buildInvestigateProcedure([makeReport()]);
    expect(procedure).toMatch(/Live-health snapshot/);
    expect(procedure).toMatch(/Reconstruct the symptom, by value/);
    expect(procedure).toMatch(/Root-cause under an evidence law/);
    expect(procedure).toMatch(/### 4\. Frame/);
    expect(procedure).toMatch(/### 5\. Classify/);
    expect(procedure).toMatch(/### File/);
  });

  it('includes the shared hard-rules content from procedureCore.ts', () => {
    const procedure = buildInvestigateProcedure([makeReport()]);
    expect(procedure).toContain(renderHardRulesMarkdown());
  });

  it('lists every report in the batch by id, title, and symptom', () => {
    const reports = [
      makeReport({ id: 'r-1', title: 'first symptom' }),
      makeReport({
        id: 'r-2',
        title: 'second symptom',
        evidence_text: 'the trace',
      }),
    ];
    const procedure = buildInvestigateProcedure(reports);
    expect(procedure).toContain('id: r-1');
    expect(procedure).toContain('first symptom');
    expect(procedure).toContain('id: r-2');
    expect(procedure).toContain('second symptom');
    expect(procedure).toContain('evidence: the trace');
  });

  it('emits an - image: line only for a report that has one', () => {
    const reports = [
      makeReport({ id: 'r-1', image_path: '/data/investigation-report-images/r-1.png' }),
      makeReport({ id: 'r-2' }),
    ];
    const procedure = buildInvestigateProcedure(reports);
    expect(procedure).toContain('image: /data/investigation-report-images/r-1.png');

    const r2Section = procedure.slice(procedure.indexOf('id: r-2'));
    expect(r2Section).not.toMatch(/- image:/);
  });

  it('directs findings to a task.create staged intent, never a filed-task edit', () => {
    const procedure = buildInvestigateProcedure([makeReport()]);
    expect(procedure).toMatch(/task\.create/);
    expect(procedure).toMatch(/Never edit an already-filed task/);
  });

  it('names the mutation boundary — never a managed PR or session worktree/git write', () => {
    const procedure = buildInvestigateProcedure([makeReport()]);
    expect(procedure).toMatch(
      /never mutate another session's git, worktree, or PR/i,
    );
  });

  it('tells the session to end the turn with no tool call when nothing is actionable, not to stage a note', () => {
    const procedure = buildInvestigateProcedure([makeReport()]);
    expect(procedure).toMatch(/do not stage anything for it/i);
    expect(procedure).toMatch(
      /end the turn having called no tool for that report/i,
    );
    expect(procedure).toMatch(
      /stages nothing at all is itself the correct, terminal outcome/i,
    );
  });

  it('does not reference planning.noOp or any other unregistered tool for the no-finding case', () => {
    const procedure = buildInvestigateProcedure([makeReport()]);
    const fileSection = procedure.slice(procedure.indexOf('### File'));
    expect(fileSection).not.toMatch(/planning\.noOp/);
    expect(fileSection).not.toMatch(/planning_noOp/);
    expect(fileSection).not.toMatch(/no actionable finding" note/i);
  });
});

describe('launchInvestigateBatch', () => {
  function makeSessionManager() {
    return {
      start: vi.fn().mockResolvedValue('sess-1'),
    };
  }

  it('creates the session with task_id report-batch:<batchId> and sessionType ops, injecting buildInvestigateProcedure content', async () => {
    const report = insertReport({
      projectId: 'proj-a',
      milestoneId: 'milestone-1',
      title: 'sessions erroring after deploy',
      symptomText: 'several sessions errored',
      createdAt: new Date(0).toISOString(),
    });
    const sessionManager = makeSessionManager();

    const sessionId = await launchInvestigateBatch(sessionManager as never, [
      report.id,
    ]);

    expect(sessionId).toBe('sess-1');
    expect(sessionManager.start).toHaveBeenCalledTimes(1);
    const [taskUrl, , options] = sessionManager.start.mock.calls[0];
    expect(taskUrl).toMatch(/^report-batch:/);
    expect(options.taskId).toMatch(/^report-batch:/);
    expect(options.sessionType).toBe('ops');
    expect(options.injectedProcedureContent).toContain(report.symptom_text);
  });

  it('records an investigation_report_dispatch row for every report in the batch', async () => {
    const reportA = insertReport({
      projectId: 'proj-a',
      milestoneId: 'milestone-1',
      title: 'symptom A',
      symptomText: 'symptom A text',
      createdAt: new Date(0).toISOString(),
    });
    const reportB = insertReport({
      projectId: 'proj-a',
      milestoneId: 'milestone-1',
      title: 'symptom B',
      symptomText: 'symptom B text',
      createdAt: new Date(0).toISOString(),
    });
    const sessionManager = makeSessionManager();

    const sessionId = await launchInvestigateBatch(sessionManager as never, [
      reportA.id,
      reportB.id,
    ]);

    expect(listDispatchedSessions(reportA.id).map((d) => d.session_id)).toEqual(
      [sessionId],
    );
    expect(listDispatchedSessions(reportB.id).map((d) => d.session_id)).toEqual(
      [sessionId],
    );
  });

  it('rejects an empty batch without dispatching a session', async () => {
    const sessionManager = makeSessionManager();
    await expect(
      launchInvestigateBatch(sessionManager as never, []),
    ).rejects.toThrow(/non-empty/);
    expect(sessionManager.start).not.toHaveBeenCalled();
  });
});
