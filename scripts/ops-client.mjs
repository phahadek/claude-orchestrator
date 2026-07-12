#!/usr/bin/env node
/**
 * ops-client.mjs — backend-route client for the /ops skill (Flow step 2 + journal writes).
 *
 * Replaces the vendored ops-load.mjs (on-disk context-bundle.json/ops-worklist.json/
 * ops-state.json under config/projects/<dir>/.ops-cache/<milestone>/) and
 * ops-journal-set.mjs (in-place file writer) with calls to the backend's own
 * ops_journal DB via HTTP:
 *
 *   - GET  /api/ops-context?milestone=<id>&project=<id>   (context pages, board
 *     summary, classified worklist — same shape loadOpsContext assembles
 *     in-process; also seeds/reconciles ops_journal server-side, same as the
 *     old loader's job 3)
 *   - GET  /api/ops-journal?milestone=<id>                (current journal
 *     entries for the milestone, straight from ops_journal)
 *   - POST /api/ops-journal/:taskId/state                 (the one in-place
 *     field write the skill performs while working a task — state +
 *     optional resolution/disposition)
 *
 * Both routes are loopback-only and device-authed (mounted behind
 * requireDeviceAuth in packages/backend/src/server.ts). This client never
 * talks to Notion directly and writes nothing to disk — the DB is the only
 * store of record.
 *
 * Auth / addressing:
 *   ORCHESTRATOR_DEVICE_TOKEN   required — a valid enrolled device token
 *   ORCHESTRATOR_BACKEND_PORT   optional — default 3000 (matches
 *                                CONFIG_DEFAULTS.server.port)
 *   ORCHESTRATOR_BACKEND_HOST   optional — default 127.0.0.1 (loopback only;
 *                                the backend rejects non-loopback callers on
 *                                the enrollment bootstrap path anyway)
 *
 * Usage:
 *   node ops-client.mjs context --milestone <id> [--project <id>]
 *   node ops-client.mjs journal --milestone <id>
 *   node ops-client.mjs set-state --task <id> --state <state> \
 *     [--resolution '<json>'] [--disposition pass|blocked-pending-fix|pass-with-caveat]
 *
 *   <state> ∈ pending | candidate | staged-proposal | applied-pending-confirm |
 *            blocked | incident-frozen | resolved
 *
 * Every subcommand prints the route's JSON response to stdout and exits 0, or
 * prints an error to stderr and exits non-zero.
 */

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function fail(msg) {
  console.error(`ops-client: ${msg}`);
  process.exit(1);
}

const command = args.shift();
if (!command || !['context', 'journal', 'set-state'].includes(command)) {
  console.error(
    'Usage: node ops-client.mjs <context|journal|set-state> [options]\n' +
      'Run with no args to see full help at the top of the script.',
  );
  process.exit(1);
}

const host = process.env.ORCHESTRATOR_BACKEND_HOST ?? '127.0.0.1';
const port = process.env.ORCHESTRATOR_BACKEND_PORT ?? '3000';
const token = process.env.ORCHESTRATOR_DEVICE_TOKEN;
if (!token)
  fail(
    'ORCHESTRATOR_DEVICE_TOKEN is not set — /api/ops-context and /api/ops-journal are ' +
      'device-authed. Set it to an enrolled device token before running the /ops skill.',
  );

const baseUrl = `http://${host}:${port}`;

async function callApi(path, init = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (e) {
    fail(`request to ${path} failed: ${e.message}`);
  }
  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    fail(
      `non-JSON response from ${path} (status ${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (!res.ok) {
    fail(
      `${path} responded ${res.status}: ${body.error ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

switch (command) {
  case 'context': {
    const milestone = option('--milestone');
    const project = option('--project');
    if (!milestone) fail('context requires --milestone <id>');
    const qs = new URLSearchParams({ milestone });
    if (project) qs.set('project', project);
    const result = await callApi(`/api/ops-context?${qs.toString()}`);
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case 'journal': {
    const milestone = option('--milestone');
    if (!milestone) fail('journal requires --milestone <id>');
    const qs = new URLSearchParams({ milestone });
    const result = await callApi(`/api/ops-journal?${qs.toString()}`);
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case 'set-state': {
    const taskId = option('--task');
    const state = option('--state');
    const resolutionRaw = option('--resolution');
    const disposition = option('--disposition');
    if (!taskId || !state)
      fail('set-state requires --task <id> --state <state>');
    let resolution;
    if (resolutionRaw !== undefined) {
      try {
        resolution = JSON.parse(resolutionRaw);
      } catch (e) {
        fail(`--resolution is not valid JSON: ${e.message}`);
      }
    }
    const payload = { state };
    if (resolution !== undefined) payload.resolution = resolution;
    if (disposition !== undefined) payload.disposition = disposition;
    const result = await callApi(
      `/api/ops-journal/${encodeURIComponent(taskId)}/state`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    console.log(JSON.stringify(result, null, 2));
    break;
  }
}
