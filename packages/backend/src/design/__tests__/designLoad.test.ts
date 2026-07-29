import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// design-load.mjs is a vendored CLI script (no TS backend twin), so it's
// exercised end-to-end here: a copy is spawned in a temp dir alongside fake
// notion-query.mjs / notion-page.mjs siblings that read canned fixtures
// instead of hitting Notion, exactly mirroring how the real script shells
// out to them (see runScript() in design-load.mjs).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_LOADER = resolve(
  __dirname,
  '../../../../../scripts/design-load.mjs',
);
if (!existsSync(REAL_LOADER)) {
  throw new Error(`expected design-load.mjs at ${REAL_LOADER}`);
}

const FAKE_NOTION_QUERY = `#!/usr/bin/env node
import { readFileSync } from 'fs';
const fixtures = JSON.parse(readFileSync(process.env.DESIGN_TEST_FIXTURES, 'utf8'));
const boardId = process.argv[2];
process.stdout.write(JSON.stringify(fixtures.boards[boardId] ?? []));
`;

const FAKE_NOTION_PAGE = `#!/usr/bin/env node
import { readFileSync } from 'fs';
const fixtures = JSON.parse(readFileSync(process.env.DESIGN_TEST_FIXTURES, 'utf8'));
const pageId = process.argv[2];
process.stdout.write(fixtures.pages[pageId] ?? '');
`;

// Stands in for the sanctioned design-context-client.mjs (which normally
// calls the backend's device-authed GET /api/design-context route) — reads
// canned per-task DesignLoadResult bundles from the same fixtures file
// instead of hitting the backend, exactly mirroring how the real script
// shells out to it (see runDesignContext() in design-load.mjs).
const FAKE_DESIGN_CONTEXT_CLIENT = `#!/usr/bin/env node
import { readFileSync } from 'fs';
const fixtures = JSON.parse(readFileSync(process.env.DESIGN_TEST_FIXTURES, 'utf8'));
const args = process.argv.slice(2);
const taskId = args[args.indexOf('--task') + 1];
const bundle = (fixtures.designContext ?? {})[taskId] ?? {
  archSource: 'notion',
  archUnits: [],
  unresolvedPageRefs: [],
  contextPages: [],
};
process.stdout.write(JSON.stringify(bundle));
`;

const MANIFEST = {
  status_property: 'Status',
  status_vocab: {
    ready: '🗂️ Ready',
    in_progress: '🔄 In Progress',
    backlog: '🔲 Backlog',
    in_review: '🔍 In Review',
    done: '✅ Done',
    deferred: '⏭️ Deferred',
  },
  source_root: 'src',
  packages: [],
  context_pages: [],
  milestones: {
    'M-test': { board: 'board-1', neighbours: [] },
  },
};

const TASK_A_BODY = `## Open questions to resolve during design
- Should we use queue X or queue Y for delivery?
- What retry policy should apply on failure?

## Implementation notes
LOCKED → Should we use queue X or queue Y for delivery?: Use queue X because it's already provisioned (2026-07-10)
LOCKED → Some question that does not exist in this task: Some stray decision
`;

const TASK_B_BODY = `## Open questions to resolve during design
- What should be the default timeout?
`;

const FIXTURES = {
  boards: {
    'board-1': [
      {
        id: 'task-a',
        url: 'https://notion.so/task-a',
        Type: '📐 Design',
        Status: '🗂️ Ready',
        Priority: '',
        'Task Name': 'Task A',
      },
      {
        id: 'task-b',
        url: 'https://notion.so/task-b',
        Type: '📐 Design',
        Status: '🗂️ Ready',
        Priority: '',
        'Task Name': 'Task B',
      },
    ],
  },
  pages: {
    'task-a': TASK_A_BODY,
    'task-b': TASK_B_BODY,
  },
  // Per-task design-context bundles the fake design-context-client.mjs
  // returns, standing in for the backend's archStoreAdopted dual read: a
  // store-adopted project resolves 'store' (task-a), a non-adopted one
  // resolves 'notion' (task-b) — both carry the same non-architecture
  // context pages, which never migrate into the store.
  designContext: {
    'task-a': {
      archSource: 'store',
      archUnits: [{ id: 'unit-1', title: 'Delivery invariant' }],
      unresolvedPageRefs: [],
      contextPages: [
        { id: 'ctx-1', title: '🗺️ Project Context', markdown: 'project context body' },
      ],
    },
    'task-b': {
      archSource: 'notion',
      archUnits: [],
      unresolvedPageRefs: [],
      contextPages: [
        { id: 'ctx-1', title: '🗺️ Project Context', markdown: 'project context body' },
      ],
    },
  },
};

function setupHarness() {
  const tmp = mkdtempSync(join(tmpdir(), 'design-load-'));
  const scriptsDir = join(tmp, 'scripts');
  const repoDir = join(tmp, 'repo');
  const cacheDir = join(tmp, 'cache');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(
    join(scriptsDir, 'design-load.mjs'),
    readFileSync(REAL_LOADER, 'utf8'),
  );
  writeFileSync(join(scriptsDir, 'notion-query.mjs'), FAKE_NOTION_QUERY);
  writeFileSync(join(scriptsDir, 'notion-page.mjs'), FAKE_NOTION_PAGE);
  writeFileSync(
    join(scriptsDir, 'design-context-client.mjs'),
    FAKE_DESIGN_CONTEXT_CLIENT,
  );

  const manifestPath = join(tmp, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
  const fixturesPath = join(tmp, 'fixtures.json');
  writeFileSync(fixturesPath, JSON.stringify(FIXTURES, null, 2));

  return { tmp, scriptsDir, repoDir, cacheDir, manifestPath, fixturesPath };
}

function runLoader(h: ReturnType<typeof setupHarness>) {
  const r = spawnSync(
    'node',
    [
      join(h.scriptsDir, 'design-load.mjs'),
      '--milestone',
      'M-test',
      '--repo',
      h.repoDir,
      '--manifest',
      h.manifestPath,
      '--cache-dir',
      h.cacheDir,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DESIGN_TEST_FIXTURES: h.fixturesPath },
    },
  );
  if (r.status !== 0) {
    throw new Error(`design-load.mjs failed: ${r.stderr}\n${r.stdout}`);
  }
  return r;
}

function readState(h: ReturnType<typeof setupHarness>) {
  return JSON.parse(
    readFileSync(join(h.cacheDir, 'design-state.json'), 'utf8'),
  );
}
function readWorklist(h: ReturnType<typeof setupHarness>) {
  return JSON.parse(
    readFileSync(join(h.cacheDir, 'design-worklist.json'), 'utf8'),
  );
}
function readBundle(h: ReturnType<typeof setupHarness>) {
  return JSON.parse(
    readFileSync(join(h.cacheDir, 'context-bundle.json'), 'utf8'),
  );
}

describe('design-load.mjs', () => {
  let harness: ReturnType<typeof setupHarness> | undefined;

  afterEach(() => {
    if (harness) rmSync(harness.tmp, { recursive: true, force: true });
    harness = undefined;
  });

  it('pre-populates a body-locked decision (locked_source: "body") and flags an unmatched lock', () => {
    harness = setupHarness();
    runLoader(harness);
    const state = readState(harness);

    const lockedQ = state['task-a'].open_questions.find(
      (q: { q: string }) =>
        q.q === 'Should we use queue X or queue Y for delivery?',
    );
    expect(lockedQ.locked_decision).toBe(
      "Use queue X because it's already provisioned",
    );
    expect(lockedQ.locked_source).toBe('body');
    expect(lockedQ.signed_off_at).toBe('2026-07-10');

    const unmatchedQ = state['task-a'].open_questions.find(
      (q: { q: string }) =>
        q.q === 'What retry policy should apply on failure?',
    );
    expect(unmatchedQ.locked_decision).toBeNull();

    // The second LOCKED marker named a question that isn't in this task's
    // open_questions — it must not be silently dropped.
    expect(state['task-a'].partial_locks_present).toBe(true);
  });

  it('seeds carries: [] on a task with no cross-task carries, preserves an existing carry across a resume, and surfaces it as an inbound carry on the sibling', () => {
    harness = setupHarness();

    // Fresh load: no design-state.json exists yet.
    runLoader(harness);
    const fresh = readState(harness);
    expect(fresh['task-a'].carries).toEqual([]);
    expect(fresh['task-b'].carries).toEqual([]);

    // Simulate the skill recording a cross-task carry during Step 3.
    fresh['task-a'].carries = [
      { to_task: 'task-b', note: 'B must honor the queue-X choice' },
    ];
    writeFileSync(
      join(harness.cacheDir, 'design-state.json'),
      JSON.stringify(fresh, null, 2),
    );

    // Resume: the carry must survive, and task-b must see it as inbound.
    runLoader(harness);
    const resumed = readState(harness);
    expect(resumed['task-a'].carries).toEqual([
      { to_task: 'task-b', note: 'B must honor the queue-X choice' },
    ]);

    const worklist = readWorklist(harness);
    const taskB = worklist.executable.find(
      (t: { id: string }) => t.id === 'task-b',
    );
    expect(taskB.inbound_carries).toEqual([
      {
        from_task: 'task-a',
        from_title: 'Task A',
        note: 'B must honor the queue-X choice',
      },
    ]);
  });

  it('regression: a task with no body-locks and no carries seeds identically to today', () => {
    harness = setupHarness();
    runLoader(harness);
    const state = readState(harness);

    expect(state['task-b'].open_questions).toEqual([
      {
        q: 'What should be the default timeout?',
        investigated: false,
        recommendation: null,
        locked_decision: null,
        signed_off_at: null,
      },
    ]);
    expect(state['task-b'].partial_locks_present).toBe(false);

    const worklist = readWorklist(harness);
    const taskB = worklist.executable.find(
      (t: { id: string }) => t.id === 'task-b',
    );
    expect(taskB.inbound_carries).toEqual([]);
  });

  it('loads each task\'s architecture via the design-context route (archStoreAdopted dual read), and carries the non-architecture context pages on both branches', () => {
    harness = setupHarness();
    runLoader(harness);
    const worklist = readWorklist(harness);

    const taskA = worklist.executable.find(
      (t: { id: string }) => t.id === 'task-a',
    );
    expect(taskA.arch_source).toBe('store');
    expect(taskA.arch_units).toEqual([
      { id: 'unit-1', title: 'Delivery invariant' },
    ]);

    const taskB = worklist.executable.find(
      (t: { id: string }) => t.id === 'task-b',
    );
    expect(taskB.arch_source).toBe('notion');
    expect(taskB.arch_units).toEqual([]);

    const bundle = readBundle(harness);
    expect(bundle.context_pages).toEqual([
      {
        id: 'ctx-1',
        title: '🗺️ Project Context',
        file: 'context/ctx1.md',
        status: 'fetched',
      },
    ]);
    expect(
      readFileSync(join(harness.cacheDir, 'context', 'ctx1.md'), 'utf8'),
    ).toBe('project context body');
  });
});
