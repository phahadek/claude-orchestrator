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
    [
      'concurrency',
      'src/job/retry.ts',
      'Add exponential backoff to the sender.',
    ],
    ['data-mutation', 'src/db/purge.ts', 'Run a backfill of old rows.'],
    ['auth', 'src/auth/session.ts', 'Rotate the credential store.'],
    ['ci-infra', '.github/workflows/ci.yml', 'Edit the Dockerfile base image.'],
  ])('matches class %s on path and body', (cls, p, body) => {
    const pathHit = evaluateTripwire({ paths: [p], body: CLEAN_BODY });
    expect(
      pathHit.matches.some((m) => m.class === cls && m.source === 'path'),
    ).toBe(true);
    const bodyHit = evaluateTripwire({ paths: CLEAN_PATHS, body });
    expect(
      bodyHit.matches.some((m) => m.class === cls && m.source === 'body'),
    ).toBe(true);
  });

  it('matches SQL statements and root configs', () => {
    expect(
      evaluateTripwire({
        paths: [],
        body: 'DROP TABLE users; UPDATE t SET a=1',
      }).matches.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      evaluateTripwire({ paths: ['package.json'], body: '' }).matched,
    ).toBe(true);
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

  it('adds per-project extra terms and paths', () => {
    const extra = { paths: ['billing/'], terms: ['invoice'] };
    const r = evaluateTripwire({
      paths: ['billing/x.ts'],
      body: 'Change the invoice layout',
      extra,
    });
    expect(r.matches.filter((m) => m.class === 'extra')).toHaveLength(3);
  });

  it('carries TRIPWIRE_VERSION', () => {
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
      paths: [],
      body: 'take a lock and send an invoice',
      extra: cfg.codeAutoApprove?.tripwireExtra,
    });
    expect(r.matches.some((m) => m.class === 'concurrency')).toBe(true);
    expect(r.matches.some((m) => m.class === 'extra')).toBe(true);
  });
});
