#!/usr/bin/env node
// Sanctioned session-side own-record-read transport.
//
// Orchestrator-launched sessions cannot use raw HTTP (curl/wget are
// deliberately off the auto-dispatch allowlist), but `node` is allowlisted.
// This script is the one sanctioned way a session reads the orchestrator's
// own runtime records (session_events + audit_log) for one target session
// id: it GETs the backend's loopback-only read endpoint
// (GET /api/session-record-reads/:targetSessionId), authenticated by the
// same per-session scoped stage credential stage-task-intent.mjs uses.
//
// Unlike stage-task-intent.mjs, this read only succeeds once an operator has
// approved a `session.requestCapability` request naming
// `read:session-record:<targetSessionId>` for this session — see
// session/orchestrator-config.ts#sessionRecordReadCapability. A 403 with
// code `capability_not_granted` means that grant is still outstanding (or
// was never requested): stage the request and wait to be re-dispatched
// rather than retrying this script.
//
// Usage:
//   node read-session-record.mjs <targetSessionId>
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_STAGE_TOKEN  the per-session, stage-only scoped credential
//                             (distinct from ORCHESTRATOR_DEVICE_TOKEN — this
//                             one can never apply or write, only stage/read)

import http from 'node:http';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [targetSessionId] = process.argv.slice(2);
if (!targetSessionId) {
  fail(
    'usage: node read-session-record.mjs <targetSessionId>\n' +
      'example: node read-session-record.mjs 0fac72f0-1234-5678-9abc-def012345678',
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

const req = http.request(
  {
    host,
    port: Number(port),
    path: `/api/session-record-reads/${encodeURIComponent(targetSessionId)}`,
    method: 'GET',
    headers: {
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
req.end();
