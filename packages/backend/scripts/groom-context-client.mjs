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
//   ORCHESTRATOR_STAGE_PORT   backend loopback port (the same var the
//                             sanctioned stage-task-intent.mjs client uses)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the read

import http from 'node:http';
import { pathToFileURL } from 'node:url';

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

  const port = process.env.ORCHESTRATOR_STAGE_PORT;
  const token = process.env.ORCHESTRATOR_DEVICE_TOKEN;
  if (!port || !token) {
    fail(
      'ORCHESTRATOR_STAGE_PORT / ORCHESTRATOR_DEVICE_TOKEN not set — this script ' +
        'must be run with the backend loopback port and a device credential available.',
    );
    return;
  }

  try {
    const { statusCode, body } = await fetchGroomContext({
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
