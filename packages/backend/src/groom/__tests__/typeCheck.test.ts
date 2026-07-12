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
});
