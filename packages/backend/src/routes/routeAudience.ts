/**
 * Registry of every mutation route (router.post|patch|put|delete) under
 * packages/backend/src/routes/, keyed "<VERB> <full-api-path>" — the verb
 * plus the route's path template as mounted under /api (mount prefix +
 * the path literal as declared in the router file).
 *
 * Each entry classifies the route's intended caller:
 *  - 'operator': reached through the frontend UI. The guard test
 *    (routeAudience.test.ts) asserts a matching /api/... reference exists
 *    somewhere under packages/frontend/src.
 *  - 'session': called directly by a Claude session (a skill's own HTTP
 *    call, not through a UI button or a vendored Remote-Control script).
 *  - 'tooling': called by a vendored Remote-Control client script under
 *    scripts/ or packages/backend/scripts/. This guard does not check that
 *    surface — see the task's cascade notes.
 *  - 'known-gap': should be operator-facing but currently has no surface.
 *    `fixTask` names the task that closes the gap; once fixed, reclassify
 *    to 'operator' and delete the entry's fixTask.
 *
 * Adding a route here should be cheap: one literal classification plus a
 * one-line reason. Do not add supporting prose beyond that.
 */

type RouteAudience = 'operator' | 'session' | 'tooling' | 'known-gap';

export interface RouteAudienceEntry {
  audience: RouteAudience;
  reason: string;
  /** Required when audience is 'known-gap': the task that closes it. */
  fixTask?: string;
}

export const ROUTE_AUDIENCE: Record<string, RouteAudienceEntry> = {
  // -- mergeCandidates.ts --------------------------------------------------
  'POST /api/merge-candidates/confirm': {
    audience: 'session',
    reason:
      'invoked directly by the merge-candidates detection flow; result is staged as an intent for operator apply via staged-intents',
  },

  // -- settings.ts -----------------------------------------------------------
  'PATCH /api/settings': {
    audience: 'operator',
    reason: 'Settings page',
  },

  // -- opsJournal.ts -----------------------------------------------------
  'POST /api/ops-journal/:taskId/state': {
    audience: 'known-gap',
    reason: 'no frontend decision-surface mirror exists yet',
    fixTask: 'ops_journal decision-surface mirror (sibling task)',
  },

  // -- milestones.ts -------------------------------------------------------
  'PUT /api/milestones/:milestoneId/arm/:flow': {
    audience: 'operator',
    reason: 'gate-verify flow arm/disarm control',
  },

  // -- planningLaunch.ts -----------------------------------------------------
  'POST /api/planning/launch': {
    audience: 'operator',
    reason: 'planning launch control',
  },

  // -- diagnostics.ts --------------------------------------------------------
  'POST /api/diagnostics/scheduler/:name/trigger': {
    audience: 'operator',
    reason: 'diagnostics scheduler manual trigger',
  },

  // -- groomFlip.ts ------------------------------------------------------
  'POST /api/groom/flip': {
    audience: 'tooling',
    reason: 'called by scripts/groom-flip-client.mjs (vendored /groom skill)',
  },

  // -- update.ts ---------------------------------------------------------
  'POST /api/update/check': { audience: 'operator', reason: 'update banner' },
  'POST /api/update/dismiss': { audience: 'operator', reason: 'update banner' },
  'POST /api/update/install': { audience: 'operator', reason: 'update banner' },
  'PUT /api/update/channel': {
    audience: 'operator',
    reason: 'update channel setting',
  },

  // -- design.ts -----------------------------------------------------------
  'POST /api/design/:taskId/completeness-disposition': {
    audience: 'tooling',
    reason: 'backs an MCP completeness tool, not a UI action',
  },
  'POST /api/design/:taskId/trace-coverage': {
    audience: 'tooling',
    reason: 'backs an MCP completeness tool, not a UI action',
  },

  // -- deploy.ts -----------------------------------------------------------
  'POST /api/deploy/report-in': {
    audience: 'session',
    reason: "called by each project's /deploy playbook, not a UI action",
  },
  'POST /api/deploy/launch': {
    audience: 'operator',
    reason: 'deploy launch button',
  },

  // -- setup.ts ------------------------------------------------------------
  'POST /api/setup/validate': {
    audience: 'operator',
    reason: 'first-run setup wizard',
  },
  'POST /api/setup/import': {
    audience: 'operator',
    reason: 'first-run setup wizard',
  },
  'POST /api/setup/save-credentials': {
    audience: 'operator',
    reason: 'first-run setup wizard',
  },
  'POST /api/setup/complete': {
    audience: 'operator',
    reason: 'first-run setup wizard',
  },

  // -- prs.ts ----------------------------------------------------------------
  'POST /api/prs/:prNumber/review': {
    audience: 'operator',
    reason: 'PR panel review action',
  },
  'POST /api/prs/:owner/:repoName/:prNumber/merge': {
    audience: 'operator',
    reason: 'PR panel merge action',
  },
  'POST /api/prs/:owner/:repoName/:prNumber/re-review': {
    audience: 'operator',
    reason: 'PR panel re-review action',
  },
  'POST /api/prs/:owner/:repoName/:prNumber/approve': {
    audience: 'operator',
    reason: 'PR panel approve action',
  },
  'POST /api/prs/:owner/:repoName/:prNumber/verify-manual-items': {
    audience: 'operator',
    reason:
      'operator sign-off clearing manual_verification_pending — single-action dashboard button',
  },
  'DELETE /api/prs/:prNumber': {
    audience: 'operator',
    reason: 'PR panel remove action',
  },
  'POST /api/prs/:owner/:repoName/:prNumber/fix-conflicts': {
    audience: 'operator',
    reason: 'PR panel fix-conflicts action',
  },
  'POST /api/prs/:prNumber/fix': {
    audience: 'session',
    reason:
      'manual re-send-review-findings-to-session utility, issued directly by an ops session, no UI button',
  },
  'POST /api/prs/:prNumber/unpark': {
    audience: 'session',
    reason:
      'deprecated alias superseded by POST /api/tasks/:taskId/recover (the operator-bound canonical interface); retained for direct/manual invocation only',
  },
  'POST /api/prs/ingest': {
    audience: 'session',
    reason:
      'backfills a PR untracked by the orchestrator; invoked directly by an ops session, no UI button',
  },

  // -- tasks.ts --------------------------------------------------------------
  'POST /api/tasks/refresh': {
    audience: 'operator',
    reason: 'task board refresh action',
  },
  'POST /api/tasks/:taskId/unblock': {
    audience: 'operator',
    reason: 'task card unblock action',
  },
  'POST /api/tasks/:taskId/assign-repo': {
    audience: 'operator',
    reason: 'task card assign-repo action',
  },
  'POST /api/tasks/move-preview': {
    audience: 'operator',
    reason: 'task move dialog',
  },
  'POST /api/tasks/:taskId/recover': {
    audience: 'operator',
    reason: 'task card recover action',
  },
  'PATCH /api/tasks/:id/status': {
    audience: 'session',
    reason:
      'manual status override issued directly by an ops session; UI-driven moves flow through move-preview -> staged-intents instead',
  },

  // -- taskAbort.ts --------------------------------------------------------
  'POST /api/tasks/:id/abort': {
    audience: 'operator',
    reason: 'task card abort action',
  },

  // -- gateState.ts ------------------------------------------------------
  'POST /api/gate/reconcile': {
    audience: 'session',
    reason:
      'manual gate-runnability reconcile trigger, issued directly by an ops session, no UI button',
  },
  'POST /api/gate/items/:id/events': {
    audience: 'operator',
    reason: 'gate item disposition',
  },
  'POST /api/gate/items/:id/approve': {
    audience: 'operator',
    reason: 'gate item disposition',
  },
  'POST /api/gate/items/:id/reject': {
    audience: 'operator',
    reason: "gate item disposition — the consent gate's reject path",
  },
  'POST /api/gate/items/:id/reopen': {
    audience: 'operator',
    reason: 'gate item disposition',
  },
  'POST /api/gate/items/:id/classification': {
    audience: 'operator',
    reason: 'gate item reclassify',
  },
  'POST /api/gate/backfill': {
    audience: 'tooling',
    reason: 'Remote-Control tooling (gate-state-client.mjs)',
  },
  'POST /api/gate/accrete-contribution': {
    audience: 'tooling',
    reason: 'called by packages/backend/scripts/gate-state-client.mjs',
  },
  'POST /api/gate/verify-launch': {
    audience: 'operator',
    reason: 'gate verify-session launch',
  },

  // -- seedState.ts --------------------------------------------------------
  'POST /api/seed/items/:id/events': {
    audience: 'operator',
    reason: 'seed item disposition',
  },
  'POST /api/seed/backfill': {
    audience: 'tooling',
    reason: 'Remote-Control tooling (seed-state-client.mjs)',
  },
  'POST /api/seed/accrete-contribution': {
    audience: 'tooling',
    reason: 'called by packages/backend/scripts/seed-state-client.mjs',
  },

  // -- stagedIntents.ts ----------------------------------------------------
  'POST /api/staged-intents': {
    audience: 'operator',
    reason: 'staged-intent creation surface',
  },
  'POST /api/staged-intents/:id/apply': {
    audience: 'operator',
    reason: 'staged-intent apply action',
  },
  'POST /api/staged-intents/:id/approve': {
    audience: 'operator',
    reason: 'staged-intent approve action',
  },
  'POST /api/staged-intents/:id/acknowledge': {
    audience: 'operator',
    reason: 'staged-intent acknowledge action',
  },
  'POST /api/staged-intents/group/:groupId/recover': {
    audience: 'known-gap',
    reason: 'no frontend or vendored-client binding exists yet',
    fixTask: 'group-recovery surface (sibling task)',
  },
  'POST /api/staged-intents/group/:groupId/commit': {
    audience: 'operator',
    reason: 'staged-intent group commit action',
  },
  'POST /api/staged-intents/group/:groupId/approve': {
    audience: 'operator',
    reason: 'staged-intent group approve action',
  },
  'POST /api/staged-intents/group/:groupId/reject': {
    audience: 'operator',
    reason: 'staged-intent group reject action',
  },
  'POST /api/staged-intents/batch/commit': {
    audience: 'operator',
    reason: 'staged-intent batch commit action',
  },
  'POST /api/staged-intents/:id/reject': {
    audience: 'operator',
    reason: 'staged-intent reject action',
  },
  'POST /api/staged-intents/:id/answer': {
    audience: 'operator',
    reason: 'staged-intent answer action',
  },
};

/**
 * Mount prefix for each routes/*.ts file, as registered in server.ts.
 * Used by the guard test to reconstruct each route's full /api path from
 * its router-declared path template.
 */
export const ROUTE_FILE_MOUNT_PREFIX: Record<string, string> = {
  'mergeCandidates.ts': '/api',
  'settings.ts': '/api/settings',
  'opsJournal.ts': '/api',
  'milestones.ts': '/api',
  'planningLaunch.ts': '/api',
  'diagnostics.ts': '/api/diagnostics',
  'groomFlip.ts': '/api',
  'update.ts': '/api',
  'design.ts': '/api',
  'deploy.ts': '/api',
  'setup.ts': '/api',
  'prs.ts': '/api',
  'tasks.ts': '/api',
  'taskAbort.ts': '/api',
  'gateState.ts': '/api',
  'seedState.ts': '/api',
  'stagedIntents.ts': '/api',
};

/**
 * Normalizes a route path for comparison: strips query strings and
 * collapses :param / ${...} dynamic segments to a single wildcard token.
 * Both the backend's declared path templates and the frontend's raw
 * fetch-call path literals are normalized this way before comparing.
 */
export function normalizeRoutePath(rawPath: string): string {
  const withoutQuery = rawPath.split('?')[0];
  const segments = withoutQuery
    .split('/')
    .filter((segment) => segment.length > 0);
  const normalized = segments.map((segment) => {
    if (segment.startsWith(':')) return '*';
    if (/^\$\{[^}]*\}$/.test(segment)) return '*';
    return segment;
  });
  return '/' + normalized.join('/');
}

/** Joins a router mount prefix and a router-declared path into one full path. */
export function joinMountPath(mountPrefix: string, routePath: string): string {
  return (
    `${mountPrefix}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  );
}
