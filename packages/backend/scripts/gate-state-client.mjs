#!/usr/bin/env node
// Sanctioned session-side client for the /gate skill's read/disposition/record
// loop over the gate-state API (see packages/backend/src/routes/gateState.ts
// and packages/backend/src/gate/gateService.ts).
//
// Replaces the old gate-load.mjs (Notion task-body fetch) + gate-parse.mjs
// (body parsing): the skill no longer loads the whole Gate task body and
// hand-edits a dated run-note back into it. Instead it drives the backend's
// gate_item / gate_item_event tables directly through this client — readiness
// + a tiered pull of runnable items, one classification tier at a time, then
// a disposition recorded per item as a durable event. All routes are
// loopback-only and device-authed, exactly like groom-context-client.mjs.
//
// Usage:
//   node gate-state-client.mjs readiness --project <P> --milestone <M>
//   node gate-state-client.mjs next --project <P> --milestone <M> [--classification <C>] [--limit <N>]
//   node gate-state-client.mjs item <gateItemId>
//   node gate-state-client.mjs event <gateItemId> <json-payload>
//   node gate-state-client.mjs approve <gateItemId> [operator]
//   node gate-state-client.mjs reopen <gateItemId> [reason] [operator]
//   node gate-state-client.mjs reclassify <gateItemId> <classification> [operator]
//   node gate-state-client.mjs accrete <json-payload>
//
// Example:
//   node gate-state-client.mjs event gi-42 \
//     '{"disposition":"pass","evidence":"manually clicked through checkout"}'
//   node gate-state-client.mjs reclassify gi-42 Read-Only
//   node gate-state-client.mjs accrete \
//     '{"project":"p1","taskId":"notion:t1","title":"Add retry","milestone":"M12",
//       "classification":"Read-Only","items":[{"text":"Click through checkout once"}]}'
//
// `disposition` on an `event` payload is optional (omit it for a pure log
// entry — evidence recorded, state left unchanged) and, when present, must
// be one of the server's closed vocabulary: pass, fail, deferred, discarded,
// noted. Anything else is rejected with 400. `noted` is non-terminal —
// records the event without resolving. `discarded` is terminal and
// non-blocking (void/created-in-error, distinct from `deferred`'s
// punted-to-next-milestone) and requires `evidence`.
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the request

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Issues one loopback HTTP request against the gate-state API and resolves
 * with `{statusCode, body}`. Exported (rather than inlined per-verb) so tests
 * can exercise it directly without spawning a child process.
 */
export function requestGateState({ host, port, token, method, path, payload }) {
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

export function fetchGateReadiness({ host, port, token, project, milestone }) {
  const query = new URLSearchParams({ project, milestone });
  return requestGateState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/gate/readiness?${query.toString()}`,
  });
}

export function fetchNextRunnableGateItems({
  host,
  port,
  token,
  project,
  milestone,
  classification,
  limit,
}) {
  const query = new URLSearchParams({ project, milestone });
  if (classification) query.set('classification', classification);
  if (limit !== undefined) query.set('limit', String(limit));
  return requestGateState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/gate/next?${query.toString()}`,
  });
}

export function fetchGateItem({ host, port, token, gateItemId }) {
  return requestGateState({
    host,
    port,
    token,
    method: 'GET',
    path: `/api/gate/items/${encodeURIComponent(gateItemId)}`,
  });
}

export function appendGateItemEvent({ host, port, token, gateItemId, event }) {
  return requestGateState({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/gate/items/${encodeURIComponent(gateItemId)}/events`,
    payload: event,
  });
}

export function approveGateItem({ host, port, token, gateItemId, operator }) {
  return requestGateState({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/gate/items/${encodeURIComponent(gateItemId)}/approve`,
    payload: operator === undefined ? {} : { operator },
  });
}

export function reopenGateItem({
  host,
  port,
  token,
  gateItemId,
  reason,
  operator,
}) {
  const payload = {};
  if (reason !== undefined) payload.reason = reason;
  if (operator !== undefined) payload.operator = operator;
  return requestGateState({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/gate/items/${encodeURIComponent(gateItemId)}/reopen`,
    payload,
  });
}

export function reclassifyGateItem({
  host,
  port,
  token,
  gateItemId,
  classification,
  operator,
}) {
  return requestGateState({
    host,
    port,
    token,
    method: 'POST',
    path: `/api/gate/items/${encodeURIComponent(gateItemId)}/classification`,
    payload:
      operator === undefined
        ? { classification }
        : { classification, operator },
  });
}

export function accreteGateContribution({ host, port, token, contribution }) {
  return requestGateState({
    host,
    port,
    token,
    method: 'POST',
    path: '/api/gate/accrete-contribution',
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
    classification: option('--classification'),
    limit: option('--limit'),
  };
}

const USAGE =
  'usage:\n' +
  '  node gate-state-client.mjs readiness --project <P> --milestone <M>\n' +
  '  node gate-state-client.mjs next --project <P> --milestone <M> [--classification <C>] [--limit <N>]\n' +
  '  node gate-state-client.mjs item <gateItemId>\n' +
  '  node gate-state-client.mjs event <gateItemId> <json-payload>\n' +
  '  node gate-state-client.mjs approve <gateItemId> [operator]\n' +
  '  node gate-state-client.mjs reopen <gateItemId> [reason] [operator]\n' +
  '  node gate-state-client.mjs reclassify <gateItemId> <classification> [operator]\n' +
  '  node gate-state-client.mjs accrete <json-payload>';

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
      result = await fetchGateReadiness({ host, port, token, project, milestone });
    } else if (command === 'next') {
      const { project, milestone, classification, limit } = parseFlags(rest);
      if (!project || !milestone) return fail(USAGE);
      result = await fetchNextRunnableGateItems({
        host,
        port,
        token,
        project,
        milestone,
        classification,
        limit,
      });
    } else if (command === 'item') {
      const [gateItemId] = rest;
      if (!gateItemId) return fail(USAGE);
      result = await fetchGateItem({ host, port, token, gateItemId });
    } else if (command === 'event') {
      const [gateItemId, payloadJson] = rest;
      if (!gateItemId || payloadJson === undefined) return fail(USAGE);
      let event;
      try {
        event = JSON.parse(payloadJson);
      } catch {
        return fail(`invalid JSON payload: ${payloadJson}`);
      }
      result = await appendGateItemEvent({
        host,
        port,
        token,
        gateItemId,
        event,
      });
    } else if (command === 'approve') {
      const [gateItemId, operator] = rest;
      if (!gateItemId) return fail(USAGE);
      result = await approveGateItem({
        host,
        port,
        token,
        gateItemId,
        operator,
      });
    } else if (command === 'reopen') {
      const [gateItemId, reason, operator] = rest;
      if (!gateItemId) return fail(USAGE);
      result = await reopenGateItem({
        host,
        port,
        token,
        gateItemId,
        reason,
        operator,
      });
    } else if (command === 'reclassify') {
      const [gateItemId, classification, operator] = rest;
      if (!gateItemId || !classification) return fail(USAGE);
      result = await reclassifyGateItem({
        host,
        port,
        token,
        gateItemId,
        classification,
        operator,
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
      result = await accreteGateContribution({
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
// gate-state-client.mjs ...`), not when imported by a test for the exported
// fetch/append/approve helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
