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
//   node seed-state-client.mjs readiness --milestone <M>
//   node seed-state-client.mjs next --milestone <M> --deploySha <sha> [--limit <N>]
//   node seed-state-client.mjs item <seedItemId>
//   node seed-state-client.mjs detail <seedItemId>
//   node seed-state-client.mjs event <seedItemId> <json-payload>
//
// Example:
//   node seed-state-client.mjs event si-42 \
//     '{"outcome":"applied","evidence":"row inserted via analyzer_configs CRUD"}'
//   node seed-state-client.mjs event si-43 \
//     '{"outcome":"blocked","evidence":"CRUD rejected: missing dependent row","filedFollowon":"81f3"}'
//
// Env:
//   ORCHESTRATOR_STAGE_PORT   backend loopback port (shared with the other
//                             sanctioned session clients)
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

export function fetchSeedReadiness({ host, port, token, milestone }) {
  const query = new URLSearchParams({ milestone });
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
  milestone,
  deploySha,
  limit,
}) {
  const query = new URLSearchParams({ milestone, deploySha });
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

function parseFlags(argv) {
  function option(name) {
    const i = argv.indexOf(name);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    return argv[i + 1];
  }
  return {
    milestone: option('--milestone'),
    deploySha: option('--deploySha'),
    limit: option('--limit'),
  };
}

const USAGE =
  'usage:\n' +
  '  node seed-state-client.mjs readiness --milestone <M>\n' +
  '  node seed-state-client.mjs next --milestone <M> --deploySha <sha> [--limit <N>]\n' +
  '  node seed-state-client.mjs item <seedItemId>\n' +
  '  node seed-state-client.mjs detail <seedItemId>\n' +
  '  node seed-state-client.mjs event <seedItemId> <json-payload>';

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
    let result;
    if (command === 'readiness') {
      const { milestone } = parseFlags(rest);
      if (!milestone) return fail(USAGE);
      result = await fetchSeedReadiness({ port, token, milestone });
    } else if (command === 'next') {
      const { milestone, deploySha, limit } = parseFlags(rest);
      if (!milestone || !deploySha) return fail(USAGE);
      result = await fetchNextApplyableSeedItems({
        port,
        token,
        milestone,
        deploySha,
        limit,
      });
    } else if (command === 'item') {
      const [seedItemId] = rest;
      if (!seedItemId) return fail(USAGE);
      result = await fetchSeedItem({ port, token, seedItemId });
    } else if (command === 'detail') {
      const [seedItemId] = rest;
      if (!seedItemId) return fail(USAGE);
      result = await fetchSeedItemDetail({ port, token, seedItemId });
    } else if (command === 'event') {
      const [seedItemId, payloadJson] = rest;
      if (!seedItemId || payloadJson === undefined) return fail(USAGE);
      let event;
      try {
        event = JSON.parse(payloadJson);
      } catch {
        return fail(`invalid JSON payload: ${payloadJson}`);
      }
      result = await appendSeedItemEvent({ port, token, seedItemId, event });
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
