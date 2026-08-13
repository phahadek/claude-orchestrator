import { describe, it, expect } from 'vitest';
import { scanTypeCheck } from '../typeCheck';

describe('scanTypeCheck', () => {
  it('flags a Code body containing operational-seed markers', () => {
    const body =
      '## Summary\nWire in the new analyzer.\n\nMake sure to set the api key in the config before merging.';
    expect(scanTypeCheck('💻 Code', body)).toEqual({
      decision: 'flagged',
      signals: ['api key'],
    });
  });

  it('does not flag a body whose only match is inside a code fence', () => {
    const body =
      '## Summary\nWire in the new analyzer.\n\n```\n// TODO: set the api key here\n```';
    expect(scanTypeCheck('💻 Code', body)).toEqual({ decision: 'none' });
  });

  it('does not flag a body whose only match is inside a block quote', () => {
    const body =
      '## Summary\nWire in the new analyzer.\n\n> historical note: this used to need an api key\n';
    expect(scanTypeCheck('💻 Code', body)).toEqual({ decision: 'none' });
  });

  it('does not flag a clean Code body', () => {
    const body = '## Summary\nWire in the new analyzer.\n';
    expect(scanTypeCheck('💻 Code', body)).toEqual({ decision: 'none' });
  });

  it('flags an Operational body carrying dispatchable-code markers', () => {
    const body =
      '## Summary\nRotate the API credential.\n\nAlso implement the module that syncs it.';
    expect(scanTypeCheck('🔧 Operational', body)).toEqual({
      decision: 'flagged',
      signals: ['implement the module'],
    });
  });

  it('flags an Investigation body carrying dispatchable-code markers', () => {
    const body = '## Summary\nWrite the script that reproduces the bug.';
    expect(scanTypeCheck('🔎 Investigation', body)).toEqual({
      decision: 'flagged',
      signals: ['Write the script'],
    });
  });

  it('is exempt (n/a) for Design tasks', () => {
    expect(scanTypeCheck('📐 Design', 'implement the module for real')).toEqual(
      {
        decision: 'n/a',
      },
    );
  });

  it('handles a null/undefined body without error', () => {
    expect(scanTypeCheck('💻 Code', null)).toEqual({ decision: 'none' });
    expect(scanTypeCheck('💻 Code', undefined)).toEqual({ decision: 'none' });
  });

  it('does not flag a clean observational Testing body', () => {
    const body =
      '## Summary\nRun the live import against staging and observe the result.\n\n' +
      'Mode: 🧪 Testing · observational\n\n' +
      '### 👁️ Manual verification\nDisposition: pass — verified the import completed by value.\n';
    expect(scanTypeCheck('🧪 Testing', body)).toEqual({ decision: 'none' });
  });

  it('flags a Testing body carrying a test-authoring mode marker', () => {
    const body =
      '## Summary\nWrite unit tests for the analyzer module.\n\n' +
      'Mode: 🧪 Testing · authoring\n\n' +
      '### 👁️ Manual verification\nDisposition: pass\n';
    const result = scanTypeCheck('🧪 Testing', body);
    expect(result.decision).toBe('flagged');
    expect(result.signals).toContain('Mode: 🧪 Testing · authoring');
  });

  it('flags a Testing body whose Manual verification uses bare pass/fail language', () => {
    const body =
      '## Summary\nRun the live import against staging and observe the result.\n\n' +
      'Mode: 🧪 Testing · observational\n\n' +
      '### 👁️ Manual verification\nRan it live — the import passed and everything looked fine.\n';
    const result = scanTypeCheck('🧪 Testing', body);
    expect(result.decision).toBe('flagged');
    expect(result.signals).toEqual([
      'Manual verification section missing disposition vocabulary (pass / blocked-pending-fix / pass-with-caveat)',
    ]);
  });
});
