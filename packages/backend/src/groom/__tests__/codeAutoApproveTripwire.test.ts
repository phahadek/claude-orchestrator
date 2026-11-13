import { describe, it, expect } from 'vitest';
import { evaluateTripwire, TRIPWIRE_VERSION } from '../codeAutoApproveTripwire';
import { loadOrchestratorConfig } from '../../session/orchestrator-config';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLEAN_BODY = 'Rename a label in the header component.';
const CLEAN_PATHS = ['packages/frontend/src/Header.tsx'];

describe('evaluateTripwire', () => {
  it('does not match clean paths and body', () => {
    const r = evaluateTripwire({ paths: CLEAN_PATHS, body: CLEAN_BODY });
    expect(r.matched).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it.each([
    ['concurrency', 'src/job/retry.ts'],
    ['concurrency', 'src/x/ingestion/rate_limit.py'],
    ['data-mutation', 'migrations/postgres/0477_x.sql'],
    ['data-mutation', 'src/db/purge.ts'],
    ['auth', 'src/auth/session.ts'],
    ['ci-infra', '.github/workflows/ci.yml'],
    ['ci-infra', 'Dockerfile'],
    ['ci-infra', 'package.json'],
  ])('matches class %s on path %s', (cls, p) => {
    const r = evaluateTripwire({ paths: [p], body: CLEAN_BODY });
    expect(r.matches.some((m) => m.class === cls && m.source === 'path')).toBe(
      true,
    );
  });

  it('does not match planning prose in the body', () => {
    const body = [
      'Locked by Design task 123.',
      'No migration.',
      'Fail closed on timeout.',
      'Scheduler test: runs.',
      'YES token. Edit the Dockerfile and package.json; DROP TABLE x.',
    ].join('\n');
    const r = evaluateTripwire({ paths: [], body });
    expect(r.matched).toBe(false);
  });

  it('respects word boundaries', () => {
    expect(
      evaluateTripwire({ paths: [], body: 'a clockwise block, authentic' })
        .matched,
    ).toBe(false);
  });

  it('matches a non-empty Declared writes section as data-mutation', () => {
    const body = '## Declared writes\n- `Bash(npm ci:*)` — Not Prod-Mutating\n';
    const r = evaluateTripwire({ paths: CLEAN_PATHS, body });
    expect(
      r.matches.some(
        (m) => m.class === 'data-mutation' && m.term === 'Declared writes',
      ),
    ).toBe(true);
  });

  it('adds per-project extra terms and paths on paths only', () => {
    const extra = { paths: ['billing/'], terms: ['invoice'] };
    const r = evaluateTripwire({
      paths: ['billing/invoice.ts'],
      body: CLEAN_BODY,
      extra,
    });
    expect(r.matches.filter((m) => m.class === 'extra')).toHaveLength(2);
    const bodyOnly = evaluateTripwire({
      paths: CLEAN_PATHS,
      body: 'Change the invoice layout',
      extra,
    });
    expect(bodyOnly.matched).toBe(false);
  });

  it('carries TRIPWIRE_VERSION 2', () => {
    expect(TRIPWIRE_VERSION).toBe(2);
    expect(evaluateTripwire({ paths: [], body: '' }).version).toBe(
      TRIPWIRE_VERSION,
    );
  });
});

describe('codeAutoApprove config', () => {
  it('parses extras and ignores any attempt to remove a default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripwire-'));
    fs.writeFileSync(
      path.join(dir, '.claude-orchestrator.yml'),
      [
        'codeAutoApprove:',
        '  tripwireExtra:',
        '    paths: [billing/]',
        '    terms: [invoice]',
        '    remove: [lock]',
        '    exclude_terms: [lock]',
        '  remove: [lock]',
      ].join('\n'),
    );
    const cfg = loadOrchestratorConfig(dir);
    expect(cfg.codeAutoApprove).toEqual({
      tripwireExtra: { paths: ['billing/'], terms: ['invoice'] },
    });
    const r = evaluateTripwire({
      paths: ['src/lock.ts', 'src/invoice.ts'],
      body: '',
      extra: cfg.codeAutoApprove?.tripwireExtra,
    });
    expect(r.matches.some((m) => m.class === 'concurrency')).toBe(true);
    expect(r.matches.some((m) => m.class === 'extra')).toBe(true);
  });
});
