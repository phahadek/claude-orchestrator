#!/usr/bin/env node
// Sanctioned session-side loader client for the /groom skill's Step-1 load.
//
// Replaces the old groom-load.mjs Notion shell-out: instead of re-deriving
// context pages, the target board, and the code-exploration worklist itself,
// this script calls the backend's loopback, device-authed GET
// /api/groom-context route (see packages/backend/src/routes/groomContext.ts)
// and prints the GroomLoadResult bundle as JSON on stdout. The route wraps
// the same loadGroomContext() the panel uses, so the skill and the dashboard
// panel always see identical context.
//
// Usage:
//   node groom-context-client.mjs --milestone <M> [--project <id>]
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; the same
//                             pair the other sanctioned session clients use)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the read
//   ORCHESTRATOR_ROUTE_CREDENTIAL_FILE dispatched-session credential file,
//                             read only when ORCHESTRATOR_DEVICE_TOKEN is unset

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Resolves the bearer token: prefer the shared operator device token
 * (RC-session usage), falling back to a dispatched session's own
 * per-session route credential file when no device token is set.
 */
function resolveRouteToken() {
  if (process.env.ORCHESTRATOR_DEVICE_TOKEN) {
    return process.env.ORCHESTRATOR_DEVICE_TOKEN;
  }
  const credFile = process.env.ORCHESTRATOR_ROUTE_CREDENTIAL_FILE;
  if (!credFile) return undefined;
  try {
    return readFileSync(credFile, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Fetch the GroomLoadResult bundle over loopback HTTP. Exported (rather than
 * inlined in the CLI body) so it can be exercised directly, in-process, by
 * tests without spawning a child process for the network round trip.
 */
export function fetchGroomContext({ host, port, token, milestone, project }) {
  const query = new URLSearchParams({ milestone });
  if (project) query.set('project', project);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: host ?? '127.0.0.1',
        port: Number(port),
        path: `/api/groom-context?${query.toString()}`,
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
          resolve({ statusCode: res.statusCode ?? 500, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function parseArgs(argv) {
  function option(name) {
    const i = argv.indexOf(name);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  }
  return { milestone: option('--milestone'), project: option('--project') };
}

async function main() {
  function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }

  const { milestone, project } = parseArgs(process.argv.slice(2));
  if (!milestone) {
    fail(
      'usage: node groom-context-client.mjs --milestone <id> [--project <id>]',
    );
    return;
  }

  const host = process.env.ORCHESTRATOR_BACKEND_HOST ?? '127.0.0.1';
  const port = process.env.ORCHESTRATOR_BACKEND_PORT ?? '3000';
  const token = resolveRouteToken();
  if (!token) {
    fail(
      'Neither ORCHESTRATOR_DEVICE_TOKEN nor a readable ORCHESTRATOR_ROUTE_CREDENTIAL_FILE ' +
        'is set — this script must be run with a device credential available.',
    );
    return;
  }

  try {
    const { statusCode, body } = await fetchGroomContext({
      host,
      port,
      token,
      milestone,
      project,
    });
    process.stdout.write(body + '\n');
    if (statusCode >= 400) process.exitCode = 1;
  } catch (err) {
    fail(`request failed: ${err.message}`);
  }
}

// Only run the CLI when this file is executed directly (`node
// groom-context-client.mjs ...`), not when imported by a test for
// fetchGroomContext().
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
