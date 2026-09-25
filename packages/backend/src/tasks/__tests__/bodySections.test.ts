import { describe, it, expect } from 'vitest';
import { splicePatchBodySection } from '../bodySections';

describe('splicePatchBodySection', () => {
  it('replace of a missing heading inserts the section, applied: true', () => {
    const result = splicePatchBodySection(
      '## Summary\nExisting summary.\n',
      'Deliverables',
      {
        operation: 'replace',
        find: 'anything',
        replaceWith: 'Ship the CLI flag.',
      },
    );

    expect(result.applied).toBe(true);
    expect(result.body).toContain('## Deliverables');
    expect(result.body).toContain('Ship the CLI flag.');
  });

  it('replace matches a heading regardless of emoji, via the shared normalizeHeadingText posture', () => {
    const result = splicePatchBodySection(
      '### 👁️ Manual verification\nOld verification text.\n',
      'Manual verification',
      {
        operation: 'replace',
        find: 'Old verification text.',
        replaceWith: 'Reconcile and capture the new state.',
      },
    );

    expect(result.applied).toBe(true);
    expect(result.body).toContain('### 👁️ Manual verification');
    expect(result.body).toContain('Reconcile and capture the new state.');
    expect(result.body).not.toContain('Old verification text.');
  });

  it('remove of a heading that is not present still returns applied: false', () => {
    const result = splicePatchBodySection(
      '## Summary\nOld.\n',
      'Deliverables',
      {
        operation: 'remove',
      },
    );

    expect(result.applied).toBe(false);
    expect(result.body).toBe('## Summary\nOld.\n');
  });

  it('remove matches a heading regardless of emoji, via the shared normalizeHeadingText posture', () => {
    const result = splicePatchBodySection(
      '### 👁️ Manual verification\nOld verification text.\n\n## Summary\nKeep.\n',
      'Manual verification',
      {
        operation: 'remove',
      },
    );

    expect(result.applied).toBe(true);
    expect(result.body).not.toContain('Manual verification');
    expect(result.body).toContain('## Summary\nKeep.');
  });
});
