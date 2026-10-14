import { existsSync } from 'fs';
import { join } from 'path';
import {
  getInvestigateProject,
  getInvestigateMilestone,
  getProjectDeployedShaRow,
  listInvestigateErroredSessions,
  listInvestigateNonDonePlanningSessions,
  listInvestigateDeployRuns,
  getInvestigateLastDeployEvent,
  listInvestigateNeedsAttentionPrs,
  listInvestigateAuditEvents,
} from '../db/queries';

/**
 * DB-derived half of the /investigate live-health snapshot (shape documented in
 * skills/investigate/reference/snapshot.md). Mirrors scripts/investigate-load.mjs's
 * local-DB path field for field; the GitHub verification of needsAttentionPRs and the
 * Notion board stay client-side.
 */

export class UnknownInvestigateProjectError extends Error {
  constructor(projectId: string) {
    super(
      `no project '${projectId}' in the projects table. --project is the registry id (claude-dashboard), NOT the config-dir name (claude-orchestrator).`,
    );
    this.name = 'UnknownInvestigateProjectError';
  }
}

export interface TaskIdForms {
  raw: string;
  bare: string;
  notion: string;
}

export interface InvestigateDbSnapshot {
  generatedAt: string;
  project: { id: string; name: string; projectDir: string };
  deployed: {
    sha: string | null;
    shortSha: string | null;
    recordedAt: string | null;
  };
  activeMilestone: {
    id: string;
    name: string;
    shortId: string | null;
    boardId: string | null;
  } | null;
  deployHint: string;
  health: {
    erroredSessions: Array<Record<string, unknown>>;
    recentPlanningSessions: Array<Record<string, unknown>>;
    recentDeploys: Array<Record<string, unknown>>;
    needsAttentionPRs: Array<Record<string, unknown>>;
    recentAuditEvents: Array<Record<string, unknown>>;
  };
}

export interface InvestigateSnapshotOptions {
  limit?: number;
  hours?: number;
  now?: number;
}

const PLANNING_TYPES = ['groom', 'design', 'ops'] as const;

const INCIDENT_EVENTS = [
  'session_errored',
  'deploy_failed',
  'stalled_pr_reconcile_attempt',
  'stalled_pr_retry_exhausted',
  'task_orphan_nudged',
  'task_orphan_reverted',
  'pr_closed',
  'pipeline_stage_failed',
  'session_marked_done_while_running',
  'process_boot',
] as const;

const short = (sha: string | null | undefined): string | null =>
  sha ? String(sha).slice(0, 10) : null;

function isoOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  if (/^\d+$/.test(String(v))) return new Date(Number(v)).toISOString();
  return String(v);
}

function trunc(s: unknown, n = 200): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function parsePauseReason(raw: string | null): unknown {
  if (raw == null) return null;
  const s = String(raw);
  if (s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      return { raw: s };
    }
  }
  return { reason: s };
}

function normId(raw: string | null): TaskIdForms | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const bare = s.replace(/^notion:/, '');
  return { raw: s, bare, notion: `notion:${bare}` };
}

export function buildInvestigateDbSnapshot(
  projectId: string,
  opts: InvestigateSnapshotOptions = {},
): InvestigateDbSnapshot {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
  const hours = opts.hours && opts.hours > 0 ? opts.hours : 48;
  const now = opts.now ?? Date.now();

  const project = getInvestigateProject(projectId);
  if (!project) throw new UnknownInvestigateProjectError(projectId);

  const deployedRow = getProjectDeployedShaRow(projectId);
  const deployed = deployedRow
    ? {
        sha: deployedRow.sha,
        shortSha: short(deployedRow.sha),
        recordedAt: deployedRow.recordedAt,
      }
    : { sha: null, shortSha: null, recordedAt: null };

  const m = project.mid ? getInvestigateMilestone(project.mid) : null;
  const activeMilestone = m
    ? { id: m.id, name: m.name, shortId: m.shortId, boardId: m.boardId }
    : null;

  const promptFileFor = (sessionId: string): string | null => {
    const f = join(
      project.projectDir,
      '.claude',
      'session-prompts',
      `${sessionId}.md`,
    );
    return existsSync(f) ? f : null;
  };

  const erroredSessions = listInvestigateErroredSessions(projectId, limit).map(
    (s) => {
      const err = s.lastErrorDetail || '';
      return {
        ...s,
        endedAt: isoOf(s.endedAt),
        taskIdForms: normId(s.taskId),
        lastErrorDetail: trunc(s.lastErrorDetail, 240),
        promptFile: promptFileFor(s.sessionId),
        preAssemblyFailure:
          /injectedProcedureContent|assemble planning procedure/i.test(err),
      };
    },
  );

  const planningCutoff = now - hours * 3600 * 1000;
  const recentPlanningSessions = listInvestigateNonDonePlanningSessions(
    projectId,
    PLANNING_TYPES,
    planningCutoff,
    limit,
  ).map((s) => ({
    ...s,
    startedAt: isoOf(s.startedAt),
    endedAt: isoOf(s.endedAt),
    taskIdForms: normId(s.taskId),
    pauseReason: parsePauseReason(s.pauseReason),
    lastErrorDetail: trunc(s.lastErrorDetail, 200),
    promptFile: promptFileFor(s.sessionId),
  }));

  const recentDeploys = listInvestigateDeployRuns(projectId, limit).map((r) => {
    const lastEvent = getInvestigateLastDeployEvent(r.runId);
    return {
      ...r,
      shortSha: short(r.targetSha),
      startedAt: isoOf(r.startedAt),
      completedAt: isoOf(r.completedAt),
      completed: r.status === 'succeeded',
      lastEvent: lastEvent
        ? {
            ...lastEvent,
            at: isoOf(lastEvent.at),
            detail: trunc(lastEvent.detail, 200),
          }
        : null,
    };
  });

  let deployHint: string;
  const latestDeploy = recentDeploys[0];
  if (!deployed.sha) {
    deployHint =
      'No deployed SHA recorded — cannot assert what is live. Do not diagnose against HEAD.';
  } else if (
    latestDeploy &&
    !latestDeploy.completed &&
    (latestDeploy.startedAt ?? '') > (deployed.recordedAt || '')
  ) {
    deployHint =
      `Live SHA is still ${deployed.shortSha} (recorded ${deployed.recordedAt}). A LATER deploy attempt ` +
      `(${latestDeploy.shortSha}, ${latestDeploy.status} at step '${latestDeploy.currentStep}') did NOT complete — ` +
      `the checkout/HEAD may be ahead of what is actually running. Re-verify current deployed state before asserting a fix landed.`;
  } else {
    deployHint =
      `Live SHA is ${deployed.shortSha} (recorded ${deployed.recordedAt}). This is the deployed truth — ` +
      `the checkout HEAD is NOT it. Fixes land fast: re-check this before framing anything as still-broken.`;
  }

  const needsAttentionPRs = listInvestigateNeedsAttentionPrs(limit).map(
    (p) => ({
      ...p,
      pauseReason: parsePauseReason(p.pauseReason),
      taskIdForms: normId(p.taskId),
      verifyCommand: `gh -R ${p.repo} pr view ${p.prNumber} --json state,mergedAt,closedAt`,
    }),
  );

  const recentAuditEvents = listInvestigateAuditEvents(
    projectId,
    INCIDENT_EVENTS,
    limit * 2,
  ).map((e) => {
    let payloadSummary: string | null = null;
    if (e.payload) {
      try {
        const p = JSON.parse(e.payload) as Record<string, unknown>;
        payloadSummary = trunc(
          Object.entries(p)
            .slice(0, 4)
            .map(
              ([k, v]) =>
                `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`,
            )
            .join(' '),
          160,
        );
      } catch {
        payloadSummary = trunc(e.payload, 160);
      }
    }
    return {
      ts: isoOf(e.ts),
      eventType: e.eventType,
      actorType: e.actorType,
      taskId: e.taskId,
      taskIdForms: normId(e.taskId),
      payloadSummary,
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    project: {
      id: project.id,
      name: project.name,
      projectDir: project.projectDir,
    },
    deployed,
    activeMilestone,
    deployHint,
    health: {
      erroredSessions,
      recentPlanningSessions,
      recentDeploys,
      needsAttentionPRs,
      recentAuditEvents,
    },
  };
}
