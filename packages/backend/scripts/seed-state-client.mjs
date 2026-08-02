#!/usr/bin/env node
// Sanctioned session-side client for the /ops skill's config-seed handling
// over the seed-state API (see packages/backend/src/routes/seedState.ts and
// packages/backend/src/seed/seedService.ts).
//
// Replaces reading the milestone config-seed task's body (the accreted seed
// list) as the source of what to apply: /ops instead reads readiness + a
// bounded pull of applyable seed_item rows one at a time from here, the
// operator applies each seed via the *target project's* own audited
// config-CRUD (the orchestrator never applies another project's config —
// see nextApplyableSeedItems), and /ops records the outcome as a durable
// seed_item_event through this client. Same shape as gate-state-client.mjs;
// all routes are loopback-only and device-authed.
//
// Usage:
//   node seed-state-client.mjs readiness --project <P> --milestone <M>
//   node seed-state-client.mjs next --project <P> --milestone <M> --deploySha <sha> [--limit <N>]
//   node seed-state-client.mjs item <seedItemId>
//   node seed-state-client.mjs detail <seedItemId>
//   node seed-state-client.mjs event <seedItemId> <json-payload>
//   node seed-state-client.mjs accrete <json-payload>
//
// Example:
//   node seed-state-client.mjs event si-42 \
//     '{"outcome":"applied","evidence":"row inserted via analyzer_configs CRUD"}'
//   node seed-state-client.mjs event si-43 \
//     '{"outcome":"blocked","evidence":"CRUD rejected: missing dependent row","filedFollowon":"81f3"}'
//   node seed-state-client.mjs accrete \
//     '{"project":"p1","taskId":"notion:t1","title":"Add retry","milestone":"M12",
//       "decision":"seeds","seeds":[{"spec":"analyzer_configs row for retry-backoff"}]}'
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the request

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Issues one loopback HTTP request against the seed-state API and resolves
 * with `{statusCode, body}`. Exported (rather than inlined per-verb) so tests
 * can exercise it directly without spawning a child process.
 */
export function requestSeedState({ host, port, token, method, path, payload }) {
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

export function fetchSeedReadiness({ host, port, token, project, milestone }) {
  const query = new URLSearchParams({ project, milestone });
  return requestSeedState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/seed/readiness?${query.toString()}`,
  });
}

export function fetchNextApplyableSeedItems({
  host,
  port,
  token,
  project,
  milestone,
  deploySha,
  limit,
}) {
  const query = new URLSearchParams({ project, milestone, deploySha });
  if (limit !== undefined) query.set('limit', String(limit));
  return requestSeedState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/seed/next?${query.toString()}`,
  });
}

export function fetchSeedItem({ host, port, token, seedItemId }) {
  return requestSeedState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/seed/items/${encodeURIComponent(seedItemId)}`,
  });
}

export function fetchSeedItemDetail({ host, port, token, seedItemId }) {
  return requestSeedState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/seed/items/${encodeURIComponent(seedItemId)}/detail`,
  });
}

export function appendSeedItemEvent({ host, port, token, seedItemId, event }) {
  return requestSeedState({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/seed/items/${encodeURIComponent(seedItemId)}/events`,
    payload: event,
  });
}

export function accreteSeedContribution({ host, port, token, contribution }) {
  return requestSeedState({
    host,
    port,
    token,
    method: 'POST',
    path: '/api/seed/accrete-contribution',
    payload: contribution,
  });
}

function parseFlags(argv) {
  function option(name) {
    const i = argv.indexOf(name);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  }
  return {
    project: option('--project'),
    milestone: option('--milestone'),
    deploySha: option('--deploySha'),
    limit: option('--limit'),
  };
}

const USAGE =
  'usage:\n' +
  '  node seed-state-client.mjs readiness --project <P> --milestone <M>\n' +
  '  node seed-state-client.mjs next --project <P> --milestone <M> --deploySha <sha> [--limit <N>]\n' +
  '  node seed-state-client.mjs item <seedItemId>\n' +
  '  node seed-state-client.mjs detail <seedItemId>\n' +
  '  node seed-state-client.mjs event <seedItemId> <json-payload>\n' +
  '  node seed-state-client.mjs accrete <json-payload>';

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
    if (command === 'readiness') {
      const { project, milestone } = parseFlags(rest);
      if (!project || !milestone) return fail(USAGE);
      result = await fetchSeedReadiness({
        host,
        port,
        token,
        project,
        milestone,
      });
    } else if (command === 'next') {
      const { project, milestone, deploySha, limit } = parseFlags(rest);
      if (!project || !milestone || !deploySha) return fail(USAGE);
      result = await fetchNextApplyableSeedItems({
        host,
        port,
        token,
        project,
        milestone,
        deploySha,
        limit,
      });
    } else if (command === 'item') {
      const [seedItemId] = rest;
      if (!seedItemId) return fail(USAGE);
      result = await fetchSeedItem({ host, port, token, seedItemId });
    } else if (command === 'detail') {
      const [seedItemId] = rest;
      if (!seedItemId) return fail(USAGE);
      result = await fetchSeedItemDetail({ host, port, token, seedItemId });
    } else if (command === 'event') {
      const [seedItemId, payloadJson] = rest;
      if (!seedItemId || payloadJson === undefined) return fail(USAGE);
      let event;
      try {
        event = JSON.parse(payloadJson);
      } catch {
        return fail(`invalid JSON payload: ${payloadJson}`);
      }
      result = await appendSeedItemEvent({
        host,
        port,
        token,
        seedItemId,
        event,
      });
    } else if (command === 'accrete') {
      const [payloadJson] = rest;
      if (payloadJson === undefined) return fail(USAGE);
      let contribution;
      try {
        contribution = JSON.parse(payloadJson);
      } catch {
        return fail(`invalid JSON payload: ${payloadJson}`);
      }
      result = await accreteSeedContribution({
        host,
        port,
        token,
        contribution,
      });
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
// seed-state-client.mjs ...`), not when imported by a test for the exported
// fetch/append helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
