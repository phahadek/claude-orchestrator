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
//   node stage-task-intent.mjs <kind> <json-payload> [groupId] [decisionProposal]
//
// Example:
//   node stage-task-intent.mjs task.setStatus \
//     '{"taskId":"notion-abc123","status":"In Review"}'
//
// The optional [groupId] correlates multiple intents that form one
// structural-change unit (e.g. a grooming batch's setDependsOn + setStatus
// intents for the same task) so they present/apply together.
//
// The optional [decisionProposal] is a top-level rationale string for the
// staged intent (e.g. why this write is being proposed) — it's rendered
// above the payload in the staged-intent review panel. Pass an empty string
// to supply a groupId without a decisionProposal.
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_STAGE_TOKEN  the per-session, stage-only scoped credential
//                             (distinct from ORCHESTRATOR_DEVICE_TOKEN — this
//                             one can never apply, only stage)

import http from 'node:http';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [kind, payloadJson, groupId, decisionProposal] = process.argv.slice(2);
if (!kind || payloadJson === undefined) {
  fail(
    'usage: node stage-task-intent.mjs <kind> <json-payload> [groupId] [decisionProposal]\n' +
      'example: node stage-task-intent.mjs task.setStatus \'{"taskId":"...","status":"In Review"}\'',
  );
}

const host = process.env.ORCHESTRATOR_BACKEND_HOST ?? '127.0.0.1';
const port = process.env.ORCHESTRATOR_BACKEND_PORT ?? '3000';
const token = process.env.ORCHESTRATOR_STAGE_TOKEN;
if (!token) {
  fail(
    'ORCHESTRATOR_STAGE_TOKEN not set — this script must be run inside an ' +
      'orchestrator-launched session.',
  );
}

let payload;
try {
  payload = JSON.parse(payloadJson);
} catch {
  fail(`invalid JSON payload: ${payloadJson}`);
}

const body = JSON.stringify({
  kind,
  payload,
  ...(groupId ? { groupId } : {}),
  ...(decisionProposal ? { decisionProposal } : {}),
});

const req = http.request(
  {
    host,
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
