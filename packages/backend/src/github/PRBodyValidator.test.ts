import { describe, it, expect } from 'vitest';
import { validatePRBody, buildValidationComment } from './PRBodyValidator';

const VALID_BODY = `## Summary
Changed the thing.

## Notion Task
https://notion.so/task-123

## Automated Tests
- Added unit test for validator

## Files Changed
- src/github/PRBodyValidator.ts — new validator module
`;

describe('validatePRBody()', () => {
  it('accepts a body with all four required sections', () => {
    const result = validatePRBody(VALID_BODY);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it('accepts ## Task Source as an alternative to ## Notion Task', () => {
    const body = VALID_BODY.replace('## Notion Task', '## Task Source');
    const result = validatePRBody(body);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it('rejects a null body', () => {
    const result = validatePRBody(null);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Summary');
    expect(result.missingSections).toContain('## Notion Task');
    expect(result.missingSections).toContain('## Automated Tests');
    expect(result.missingSections).toContain('## Files Changed');
  });

  it('rejects an empty body', () => {
    const result = validatePRBody('');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(4);
  });

  it('rejects a body missing ## Summary', () => {
    const body = VALID_BODY.replace('## Summary\n', '');
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Summary');
    expect(result.missingSections).not.toContain('## Automated Tests');
  });

  it('rejects a body missing ## Automated Tests', () => {
    const body = VALID_BODY.replace('## Automated Tests\n', '');
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Automated Tests');
    expect(result.missingSections).not.toContain('## Summary');
  });

  it('rejects a body missing ## Files Changed', () => {
    const body = VALID_BODY.replace('## Files Changed\n', '');
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Files Changed');
  });

  it('rejects a body missing both task-source variants', () => {
    const body = VALID_BODY.replace('## Notion Task\n', '').replace(
      '## Task Source\n',
      '',
    );
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Notion Task');
  });

  it('reports all missing sections', () => {
    const result = validatePRBody('Just a description with no sections.');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(4);
  });
});

describe('buildValidationComment()', () => {
  it('includes all missing section names in the comment', () => {
    const comment = buildValidationComment(['## Summary', '## Files Changed']);
    expect(comment).toContain('## Summary');
    expect(comment).toContain('## Files Changed');
    expect(comment).toContain('PR body validation failed');
  });
});
