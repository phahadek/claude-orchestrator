import { describe, it, expect } from 'vitest';
import {
  detectCrashSignature,
  buildWorkerCrashMessage,
} from '../workerCrashDetection';

describe('detectCrashSignature', () => {
  it('returns null when no signatures are configured', () => {
    expect(detectCrashSignature('anything at all', [])).toBeNull();
  });

  it('returns null when no signature substring appears in the output', () => {
    expect(
      detectCrashSignature('all tests passed', [
        'node down: Not properly terminated',
      ]),
    ).toBeNull();
  });

  it('extracts matched lines and the crashed node id', () => {
    const output = [
      'collecting tests...',
      '[gw3] node down: Not properly terminated',
      "worker gw3 crashed while running 'tests/foo.py::test_bar'",
      'replacing crashed worker gw3',
    ].join('\n');

    const match = detectCrashSignature(output, [
      'node down: Not properly terminated',
    ]);

    expect(match).not.toBeNull();
    expect(match!.matchedLines).toEqual([
      '[gw3] node down: Not properly terminated',
    ]);
    expect(match!.nodeId).toBe('tests/foo.py::test_bar');
  });

  it('matches on any of several configured signatures, and omits nodeId when the output never names one', () => {
    const output = 'replacing crashed worker gw1\nsome other line';
    const match = detectCrashSignature(output, [
      'node down: Not properly terminated',
      'replacing crashed worker',
    ]);
    expect(match).not.toBeNull();
    expect(match!.matchedLines).toEqual(['replacing crashed worker gw1']);
    expect(match!.nodeId).toBeUndefined();
  });
});

describe('buildWorkerCrashMessage', () => {
  it('renders the node id and matched lines, capped at 2000 characters, and never embeds an unrelated raw tail', () => {
    const hugeMatchedLine = 'x'.repeat(5000);
    const message = buildWorkerCrashMessage({
      matchedLines: [hugeMatchedLine],
      nodeId: 'tests/foo.py::test_bar',
    });

    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).toContain('tests/foo.py::test_bar');
  });

  it('omits the crashed-test line when no node id was extracted', () => {
    const message = buildWorkerCrashMessage({
      matchedLines: ['[gw3] node down: Not properly terminated'],
    });
    expect(message).not.toContain('**Crashed test:**');
    expect(message).toContain('node down: Not properly terminated');
  });
});
