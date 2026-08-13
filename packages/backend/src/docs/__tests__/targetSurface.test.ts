import { describe, it, expect } from 'vitest';
import { isRepoFileTargetSurface } from '../targetSurface';

describe('isRepoFileTargetSurface', () => {
  it('is true for a repo-relative file path', () => {
    expect(isRepoFileTargetSurface('docs/api/webhooks.md')).toBe(true);
    expect(isRepoFileTargetSurface('README.md')).toBe(true);
  });

  it('is false for a Notion page id (dashed or dashless) or notion.so URL', () => {
    expect(
      isRepoFileTargetSurface('20a1b2c3-d4e5-4f60-8a1b-2c3d4e5f6071'),
    ).toBe(false);
    expect(isRepoFileTargetSurface('20a1b2c3d4e54f608a1b2c3d4e5f6071')).toBe(
      false,
    );
    expect(
      isRepoFileTargetSurface(
        'https://www.notion.so/My-Page-20a1b2c3d4e54f608a1b2c3d4e5f6071',
      ),
    ).toBe(false);
  });

  it('is false for an empty/undeclared surface', () => {
    expect(isRepoFileTargetSurface('')).toBe(false);
    expect(isRepoFileTargetSurface('   ')).toBe(false);
  });
});
