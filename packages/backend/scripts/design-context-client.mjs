#!/usr/bin/env node
// Sanctioned session-side loader client for the /design skill's Step-1 load.
//
// Replaces design-load.mjs's old direct-Notion context-page fetch: instead of
// re-deriving the fixed context pages from the manifest and treating them as
// the sole source of architecture, this script calls the backend's loopback,
// device-authed GET /api/design-context route (see
// packages/backend/src/routes/designContext.ts) and prints the
// DesignLoadResult bundle as JSON on stdout. The route wraps the same
// loadDesignContext() (design/designLoad.ts) that resolves architecture via
// the project's `archStoreAdopted` dual read — the arch_unit store for a
// migrated project, the Notion context pages otherwise — so the skill always
// sees the canonical source, never a stale Notion copy. Mirrors
// groom-context-client.mjs.
//
// Usage:
//   node design-context-client.mjs --milestone <M> --task <taskId> [--project <project-id>]
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; the same
//                             pair the other sanctioned session clients use)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the read

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Fetch the DesignLoadResult bundle over loopback HTTP. Exported (rather than
 * inlined in the CLI body) so it can be exercised directly, in-process, by
 * tests without spawning a child process for the network round trip.
 */
export function fetchDesignContext({
  host,
  port,
  token,
  milestone,
  task,
  project,
}) {
  const query = new URLSearchParams({ milestone, task });
  if (project) query.set('project', project);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: host ?? '127.0.0.1',
        port: Number(port),
        path: `/api/design-context?${query.toString()}`,
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
  return {
    milestone: option('--milestone'),
    task: option('--task'),
    project: option('--project'),
  };
}

async function main() {
  function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }

  const { milestone, task, project } = parseArgs(process.argv.slice(2));
  if (!milestone || !task) {
    fail(
      'usage: node design-context-client.mjs --milestone <id> --task <taskId> [--project <id>]',
    );
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
    const { statusCode, body } = await fetchDesignContext({
      host,
      port,
      token,
      milestone,
      task,
      project,
    });
    if (statusCode >= 400) {
      fail(`design-context load failed (${statusCode}): ${body}`);
      return;
    }
    process.stdout.write(body + '\n');
  } catch (err) {
    fail(`request failed: ${err.message}`);
  }
}

// Only run the CLI when this file is executed directly (`node
// design-context-client.mjs ...`), not when imported by a test for
// fetchDesignContext().
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
