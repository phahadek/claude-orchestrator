#!/usr/bin/env node
// Sanctioned session-side write-intent transport.
//
// Orchestrator-launched sessions cannot use raw HTTP (curl/wget are
// deliberately off the auto-dispatch allowlist), but `node` is allowlisted.
// This script is the one sanctioned way a session submits a staged
// task-write intent: it posts to the backend's loopback-only stage endpoint
// (POST /api/task-intents), authenticated by the per-session scoped stage
// credential injected into this process's env at spawn time.
//
// This credential is stage-only — it can never apply an intent, only stage
// one for a human to review and apply.
//
// Usage:
//   node "$ORCHESTRATOR_STAGE_CLI" <kind> <json-payload> [groupId]
//
// Example:
//   node "$ORCHESTRATOR_STAGE_CLI" task.setStatus \
//     '{"taskId":"notion-abc123","status":"In Review"}'
//
// The optional [groupId] correlates multiple intents that form one
// structural-change unit (e.g. a grooming batch's setDependsOn + setStatus
// intents for the same task) so the shared staged-intent panel can
// present/apply them as a group.

import http from 'node:http';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [kind, payloadJson, groupId] = process.argv.slice(2);
if (!kind || payloadJson === undefined) {
  fail(
    'usage: node stage-task-intent.mjs <kind> <json-payload> [groupId]\n' +
      'example: node stage-task-intent.mjs task.setStatus \'{"taskId":"...","status":"In Review"}\'',
  );
}

const port = process.env.ORCHESTRATOR_STAGE_PORT;
const token = process.env.ORCHESTRATOR_STAGE_TOKEN;
if (!port || !token) {
  fail(
    'ORCHESTRATOR_STAGE_PORT / ORCHESTRATOR_STAGE_TOKEN not set — this script ' +
      'must be run inside an orchestrator-launched session.',
  );
}

let payload;
try {
  payload = JSON.parse(payloadJson);
} catch {
  fail(`invalid JSON payload: ${payloadJson}`);
}

const body = JSON.stringify(
  groupId ? { kind, payload, groupId } : { kind, payload },
);

const req = http.request(
  {
    host: '127.0.0.1',
    port: Number(port),
    path: '/api/task-intents',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${token}`,
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      process.stdout.write(data + '\n');
      if ((res.statusCode ?? 500) >= 400) {
        process.exit(1);
      }
    });
  },
);

req.on('error', (err) => fail(`request failed: ${err.message}`));
req.write(body);
req.end();
