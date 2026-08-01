import { describe, it, expect } from 'vitest';
import { PLANNING_INTENT_KINDS } from '../planningIntentKinds';

describe('PLANNING_INTENT_KINDS', () => {
  it('carries a non-empty entry for every planning workflow, including docs', () => {
    for (const workflow of [
      'groom',
      'design',
      'ops',
      'split',
      'docs',
    ] as const) {
      expect(Array.isArray(PLANNING_INTENT_KINDS[workflow])).toBe(true);
      expect(PLANNING_INTENT_KINDS[workflow].length).toBeGreaterThan(0);
    }
  });

  it('docs.notion.pageEdit is the staged-write path for a Notion-page Target surface', () => {
    expect(PLANNING_INTENT_KINDS.docs).toContain('notion.pageEdit');
  });

  it('the docs intent-kind set is not identical to the design set', () => {
    expect(new Set(PLANNING_INTENT_KINDS.docs)).not.toEqual(
      new Set(PLANNING_INTENT_KINDS.design),
    );
  });

  it('docs carries no task.* staging surface — a docs session reads its own task but does not write task status/body', () => {
    expect(
      PLANNING_INTENT_KINDS.docs.some((k) => k.startsWith('task.')),
    ).toBe(false);
  });
});
