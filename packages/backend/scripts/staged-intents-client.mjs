#!/usr/bin/env node
// Sanctioned session-side client for the shared, device-authed staged-intent
// surface (see packages/backend/src/routes/stagedIntents.ts): POST
// /api/staged-intents (create), POST /api/staged-intents/:id/apply (apply),
// and POST /api/staged-intents/:id/reject (reject).
//
// This is the surface the interactive skills (/groom, /design, /ops) use to
// stage and apply task-write intents: they run in the trusted Remote-Control
// session, authenticated by the static $ORCHESTRATOR_DEVICE_TOKEN, exactly
// like the dashboard panels and the other device-authed clients
// (groom-context-client.mjs, gate-state-client.mjs, seed-state-client.mjs).
//
// It is NOT a replacement for stage-task-intent.mjs, which remains the
// correct transport for unattended orchestrator-launched worktree sessions —
// those are authenticated by a per-session, stage-only scoped credential
// minted at spawn time (see SessionStageAuth.ts), never the static device
// token, and can never apply an intent, only stage one.
//
// Usage:
//   node staged-intents-client.mjs create <kind> <json-payload> <projectId> [groupId]
//   node staged-intents-client.mjs apply <intentId> [--override <reason>] [--actorType human|session]
//   node staged-intents-client.mjs reject <intentId>
//   node staged-intents-client.mjs list [--projectId <projectId>]
//
// Example:
//   node staged-intents-client.mjs create task.setDependsOn \
//     '{"taskId":"notion-abc123","dependsOn":[]}' proj-1 grp-notion-abc123
//   node staged-intents-client.mjs create task.setStatus \
//     '{"taskId":"notion-abc123","status":"Ready","groomingGate":{"size_check":{"decision":"no_split","loc":120},"type_check":"Code"}}' \
//     proj-1 grp-notion-abc123
//   node staged-intents-client.mjs apply <intentId>
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the request

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Issues one loopback HTTP request against the staged-intents API and
 * resolves with `{statusCode, body}`. Exported so tests can exercise it
 * directly without spawning a child process.
 */
export function requestStagedIntents({
  host,
  port,
  token,
  method,
  path,
  payload,
}) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: host ?? '127.0.0.1',
        port: Number(port),
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 500, body: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export function listStagedIntents({ host, port, token, projectId }) {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : '';
  return requestStagedIntents({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/staged-intents${query}`,
  });
}

export function createStagedIntent({
  host,
  port,
  token,
  kind,
  payload,
  projectId,
  groupId,
}) {
  return requestStagedIntents({
    host,
    port,
    token,
    method: 'POST',
    path: '/api/staged-intents',
    payload: {
      kind,
      payload,
      projectId,
      ...(groupId ? { groupId } : {}),
    },
  });
}

export function applyStagedIntent({
  host,
  port,
  token,
  intentId,
  override,
  reason,
  actorType,
}) {
  return requestStagedIntents({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/staged-intents/${encodeURIComponent(intentId)}/apply`,
    payload: {
      ...(override ? { override: true, reason } : {}),
      ...(actorType ? { actorType } : {}),
    },
  });
}

export function rejectStagedIntent({ host, port, token, intentId }) {
  return requestStagedIntents({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/staged-intents/${encodeURIComponent(intentId)}/reject`,
    payload: {},
  });
}

function parseFlags(argv) {
  function option(name) {
    const i = argv.indexOf(name);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  }
  return {
    override: option('--override'),
    actorType: option('--actorType'),
    projectId: option('--projectId'),
  };
}

const USAGE =
  'usage:\n' +
  '  node staged-intents-client.mjs create <kind> <json-payload> <projectId> [groupId]\n' +
  '  node staged-intents-client.mjs apply <intentId> [--override <reason>] [--actorType human|session]\n' +
  '  node staged-intents-client.mjs reject <intentId>\n' +
  '  node staged-intents-client.mjs list [--projectId <projectId>]';

async function main() {
  function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }

  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    fail(USAGE);
    return;
  }

  const host = process.env.ORCHESTRATOR_BACKEND_HOST ?? '127.0.0.1';
  const port = process.env.ORCHESTRATOR_BACKEND_PORT ?? '3000';
  const token = process.env.ORCHESTRATOR_DEVICE_TOKEN;
  if (!token) {
    fail(
      'ORCHESTRATOR_DEVICE_TOKEN not set — this script must be run with a ' +
        'device credential available.',
    );
    return;
  }

  try {
    let result;
    if (command === 'create') {
      const [kind, payloadJson, projectId, groupId] = rest;
      if (!kind || payloadJson === undefined || !projectId) return fail(USAGE);
      let payload;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        return fail(`invalid JSON payload: ${payloadJson}`);
      }
      result = await createStagedIntent({
        host,
        port,
        token,
        kind,
        payload,
        projectId,
        groupId,
      });
    } else if (command === 'apply') {
      const [intentId, ...flagArgv] = rest;
      if (!intentId) return fail(USAGE);
      const { override, actorType } = parseFlags(flagArgv);
      result = await applyStagedIntent({
        host,
        port,
        token,
        intentId,
        override: override !== undefined,
        reason: override,
        actorType,
      });
    } else if (command === 'reject') {
      const [intentId] = rest;
      if (!intentId) return fail(USAGE);
      result = await rejectStagedIntent({ host, port, token, intentId });
    } else if (command === 'list') {
      const { projectId } = parseFlags(rest);
      result = await listStagedIntents({ host, port, token, projectId });
    } else {
      return fail(USAGE);
    }

    process.stdout.write(result.body + '\n');
    if (result.statusCode >= 400) process.exitCode = 1;
  } catch (err) {
    fail(`request failed: ${err.message}`);
  }
}

// Only run the CLI when this file is executed directly (`node
// staged-intents-client.mjs ...`), not when imported by a test for the
// exported create/apply/reject/list helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
