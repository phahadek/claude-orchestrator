#!/usr/bin/env node
// Sanctioned session-side client for the consolidated grooming Ready-flip
// (see packages/backend/src/routes/groomFlip.ts and
// TaskWriteCommands.flipToReady). Replaces the /groom skill's ~6 separate
// client calls for one task promotion — gate-state-client.mjs accrete,
// seed-state-client.mjs accrete, staged-intents-client.mjs create/apply for
// task.setDependsOn, staged-intents-client.mjs create/apply for
// task.setStatus — each of which carried a hand-typed full task id, the
// biggest grooming transcription-error surface (see context.md's 3a2/3a3
// shared-prefix collision warning).
//
// This client instead reads the task's own entry straight out of the
// session's local grooming-state.json cache (the file Step 4 of the /groom
// skill already maintains) and posts the whole thing in one request — no id
// is ever re-typed on the command line. The backend runs gate accretion +
// seed accretion + setDependsOn + setStatus(Ready) as one transaction,
// rolling back any already-committed accretion if a later step fails (see
// flipToReady's doc comment).
//
// Usage:
//   node groom-flip-client.mjs <grooming-state.json path> <taskId>
//
// The grooming-state.json entry for <taskId> must carry:
//   {
//     "title": "...", "project": "...", "milestone": "M12",
//     "hard_block_deps": ["<id>", ...],           // [] is a valid "no deps"
//     "size_check": {...}, "type_check": {...},   // see groomGate.ts
//     "gate_contribution": {
//       "classification": "Read-Only"|"Prod-Mutating"|"Opportunistic"|"needs-triage"|"none"|"n/a",
//       "items": [{"text": "..."}]                // [] when classification is "none"/"n/a"
//     },
//     "seed_contribution": {
//       "decision": "seeds"|"none"|"n/a",
//       "seeds": [{"spec": "..."}]                // [] when decision is "none"/"n/a"
//     }
//   }
//
// Example:
//   node ~/.claude/scripts/groom-flip-client.mjs \
//     .skill-cache/grooming/M12/grooming-state.json notion-abc123
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the request

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Issues the loopback POST /api/groom/flip request and resolves with
 * `{statusCode, body}`. Exported so tests can exercise it directly without
 * spawning a child process.
 */
export function requestGroomFlip({ host, port, token, payload }) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: host ?? '127.0.0.1',
        port: Number(port),
        path: '/api/groom/flip',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

/**
 * Reads `taskId`'s entry out of a grooming-state.json file and shapes it
 * into the flipToReady request payload — the one place a task id is read
 * from disk rather than typed, and the only id in the whole request.
 */
export function buildFlipPayload(groomingStatePath, taskId) {
  const state = JSON.parse(readFileSync(groomingStatePath, 'utf8'));
  const entry = state[taskId];
  if (!entry) {
    throw new Error(`no entry for task "${taskId}" in ${groomingStatePath}`);
  }
  const missing = [
    'title',
    'project',
    'milestone',
    'hard_block_deps',
    'size_check',
    'type_check',
    'gate_contribution',
    'seed_contribution',
  ].filter((key) => entry[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `grooming-state.json entry for "${taskId}" is missing required field(s): ${missing.join(', ')}`,
    );
  }
  return {
    project: entry.project,
    taskId,
    title: entry.title,
    milestone: entry.milestone,
    dependsOn: entry.hard_block_deps,
    groomingGate: {
      size_check: entry.size_check,
      type_check: entry.type_check,
      type: entry.type,
      regions: entry.regions,
      constraintsDispositioned: entry.constraints_dispositioned,
      filesPathsEntries: entry.files_paths_entries,
      dependsOnTasks: entry.depends_on_tasks,
      triage: entry.triage,
    },
    gateContribution: entry.gate_contribution,
    seedContribution: entry.seed_contribution,
  };
}

const USAGE =
  'usage: node groom-flip-client.mjs <grooming-state.json path> <taskId>';

async function main() {
  function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }

  const [groomingStatePath, taskId] = process.argv.slice(2);
  if (!groomingStatePath || !taskId) {
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
    const payload = buildFlipPayload(groomingStatePath, taskId);
    const result = await requestGroomFlip({ host, port, token, payload });
    process.stdout.write(result.body + '\n');
    if (result.statusCode >= 400) process.exitCode = 1;
  } catch (err) {
    fail(`request failed: ${err.message}`);
  }
}

// Only run the CLI when this file is executed directly (`node
// groom-flip-client.mjs ...`), not when imported by a test for the exported
// buildFlipPayload/requestGroomFlip helpers.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
