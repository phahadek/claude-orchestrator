import { describe, it, expect } from 'vitest';
import {
  validatePRBody,
  buildValidationComment,
  DEFAULT_PR_BODY_SECTIONS,
} from './PRBodyValidator';

const VALID_BODY = `## Summary
Changed the thing.

## Notion Task
https://notion.so/task-123

## Automated Tests
- Added unit test for validator
`;

describe('validatePRBody() — default sections', () => {
  it('accepts a body with all default sections', () => {
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

  it('accepts ## Task as an alternative to ## Notion Task', () => {
    const body = VALID_BODY.replace('## Notion Task', '## Task');
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
    expect(result.missingSections).not.toContain('## Files Changed');
  });

  it('rejects an empty body', () => {
    const result = validatePRBody('');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(3);
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

  it('rejects a body missing all task-heading variants', () => {
    const body = VALID_BODY.replace('## Notion Task\n', '')
      .replace('## Task Source\n', '')
      .replace('## Task\n', '');
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Notion Task');
  });

  it('reports all missing sections', () => {
    const result = validatePRBody('Just a description with no sections.');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(3);
  });
});

describe('validatePRBody() — custom sections config', () => {
  it('requires exactly the configured section list', () => {
    const config = { sections: ['## Summary', '## Automated Tests'] };
    const result = validatePRBody('## Summary\nok\n\n## Automated Tests\nok', config);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it('pauses as invalid when a body is missing a custom-configured section', () => {
    const config = { sections: ['## Summary', '## Automated Tests', '## Files Changed'] };
    const result = validatePRBody('## Summary\nok\n\n## Automated Tests\nok', config);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toEqual(['## Files Changed']);
  });

  it('does not require ## Files Changed when it is not in the configured list', () => {
    const config = { sections: DEFAULT_PR_BODY_SECTIONS };
    const result = validatePRBody(VALID_BODY, config);
    expect(result.valid).toBe(true);
  });
});

describe('validatePRBody() — max_section_chars', () => {
  it('reports the specific section exceeding its configured length ceiling', () => {
    const config = {
      sections: ['## Summary', '## Automated Tests'],
      maxSectionChars: { '## Summary': 10 },
    };
    const body =
      '## Summary\nThis summary is way longer than ten characters.\n\n## Automated Tests\nok';
    const result = validatePRBody(body, config);
    expect(result.valid).toBe(false);
    expect(result.oversizedSections).toEqual(['## Summary']);
    expect(result.missingSections).toHaveLength(0);
  });

  it('does not flag a section within its length ceiling', () => {
    const config = {
      sections: ['## Summary', '## Automated Tests'],
      maxSectionChars: { '## Summary': 1000 },
    };
    const body = '## Summary\nShort.\n\n## Automated Tests\nok';
    const result = validatePRBody(body, config);
    expect(result.valid).toBe(true);
    expect(result.oversizedSections).toHaveLength(0);
  });

  it('rejects a bare "No test changes" Automated Tests section', () => {
    const body = VALID_BODY.replace(
      '## Automated Tests\n- Added unit test for validator\n',
      '## Automated Tests\nNo test changes\n',
    );
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Automated Tests');
  });

  it('rejects trivially equivalent bare Automated Tests content ("none")', () => {
    const body = VALID_BODY.replace(
      '## Automated Tests\n- Added unit test for validator\n',
      '## Automated Tests\nnone\n',
    );
    const result = validatePRBody(body);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('## Automated Tests');
  });

  it('accepts "No test changes" followed by a substantive reason', () => {
    const body = VALID_BODY.replace(
      '## Automated Tests\n- Added unit test for validator\n',
      '## Automated Tests\nNo test changes — this is a documentation-only update with no testable behavior.\n',
    );
    const result = validatePRBody(body);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toHaveLength(0);
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
