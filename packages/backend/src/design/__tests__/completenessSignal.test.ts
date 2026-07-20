/**
 * Tests for the advisory trace-coverage signal (OQ1 of the M12 completeness
 * safeguard). AC: an output (a filed Code task's region, or an acceptance
 * criterion) that maps to no locked decision is flagged; a mapped one is not.
 * The signal never blocks — it always returns advisory: true.
 */

import { describe, it, expect } from 'vitest';
import { computeTraceCoverage } from '../completenessSignal';

const worklistOptions = {
  sourceRoot: 'packages/backend/src',
  packages: ['auth', 'billing'],
  areaAliases: {},
  trackedFiles: [
    'packages/backend/src/auth/login.ts',
    'packages/backend/src/billing/invoice.ts',
  ],
};

describe('computeTraceCoverage', () => {
  it('is always advisory', () => {
    const result = computeTraceCoverage({
      designTaskId: 'notion:design1',
      acceptanceCriteria: [],
      lockedDecisions: [],
      followOnTasks: [],
      worklistOptions,
    });
    expect(result.advisory).toBe(true);
    expect(result.flags).toEqual([]);
  });

  it('does not flag a follow-on task region that maps to a locked decision', () => {
    const result = computeTraceCoverage({
      designTaskId: 'notion:design1',
      acceptanceCriteria: [],
      lockedDecisions: [
        {
          question: 'Should login support MFA?',
          decision: 'Yes, add MFA to the auth login flow.',
        },
      ],
      followOnTasks: [
        {
          id: 'notion:code1',
          title: 'Add MFA to login',
          filesSection: '`packages/backend/src/auth/login.ts`',
          rawMarkdown: 'Add MFA to packages/backend/src/auth/login.ts',
        },
      ],
      worklistOptions,
    });
    expect(result.flags).toEqual([]);
  });

  it('flags a follow-on task region that maps to no locked decision', () => {
    const result = computeTraceCoverage({
      designTaskId: 'notion:design1',
      acceptanceCriteria: [],
      lockedDecisions: [
        {
          question: 'Should login support MFA?',
          decision: 'Yes, add MFA to the auth login flow.',
        },
      ],
      followOnTasks: [
        {
          id: 'notion:code2',
          title: 'Rework invoice PDF export',
          filesSection: '`packages/backend/src/billing/invoice.ts`',
          rawMarkdown:
            'Rework the invoice PDF export in packages/backend/src/billing/invoice.ts',
        },
      ],
      worklistOptions,
    });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toMatchObject({
      kind: 'region',
      sourceId: 'notion:code2',
    });
  });

  it('flags an acceptance criterion that maps to no locked decision', () => {
    const result = computeTraceCoverage({
      designTaskId: 'notion:design1',
      acceptanceCriteria: [
        'Invoices export as PDF within 5 seconds.',
      ],
      lockedDecisions: [
        {
          question: 'Should login support MFA?',
          decision: 'Yes, add MFA to the auth login flow.',
        },
      ],
      followOnTasks: [],
      worklistOptions,
    });
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]).toMatchObject({
      kind: 'acceptance_criterion',
      sourceId: '0',
    });
  });

  it('does not flag an acceptance criterion that maps to a locked decision', () => {
    const result = computeTraceCoverage({
      designTaskId: 'notion:design1',
      acceptanceCriteria: ['Login enforces MFA for all users.'],
      lockedDecisions: [
        {
          question: 'Should login support MFA?',
          decision: 'Yes, add MFA to the auth login flow.',
        },
      ],
      followOnTasks: [],
      worklistOptions,
    });
    expect(result.flags).toEqual([]);
  });
});
