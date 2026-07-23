import { describe, it, expect } from 'vitest';
import {
  renderTaskBody,
  markdownToBlocks,
  isShellCommandLine,
  type TaskBodySections,
} from '../bodyRender';
import { blockToLine } from '../../notion/NotionClient';

function baseSections(
  overrides: Partial<TaskBodySections> = {},
): TaskBodySections {
  return {
    summary: 'Implement the thing.',
    dependencies: [],
    context: [],
    automatedCriteria: [],
    manualCriteria: [],
    ...overrides,
  };
}

describe('renderTaskBody — section structure', () => {
  it('renders headings, to-do, and code blocks for a full section model', () => {
    const blocks = renderTaskBody(
      baseSections({
        summary: 'Add the widget.',
        dependencies: ['Implement WidgetService'],
        context: [
          { type: 'paragraph', text: 'Some prose.' },
          { type: 'code', text: 'const x = 1;', language: 'typescript' },
        ],
        automatedCriteria: ['tsc passes'],
        manualCriteria: ['Widget renders in the browser'],
        filesAffected: ['src/widget.ts *(new)*'],
      }),
    );

    const summaryHeadingIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_2' &&
        JSON.stringify(b.heading_2).includes('Summary'),
    );
    expect(summaryHeadingIdx).toBeGreaterThanOrEqual(0);
    expect(blocks[summaryHeadingIdx + 1]).toMatchObject({
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: 'Add the widget.' } }] },
    });

    const depsHeadingIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_2' &&
        JSON.stringify(b.heading_2).includes('Dependencies'),
    );
    expect(blocks[depsHeadingIdx + 1]).toMatchObject({
      type: 'bulleted_list_item',
    });

    const codeBlock = blocks.find((b) => b.type === 'code');
    expect(codeBlock).toMatchObject({
      code: {
        rich_text: [{ text: { content: 'const x = 1;' } }],
        language: 'typescript',
      },
    });

    const filesHeadingIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_2' && JSON.stringify(b.heading_2).includes('Files'),
    );
    expect(blocks[filesHeadingIdx + 1]).toMatchObject({
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ text: { content: 'src/widget.ts *(new)*' } }],
      },
    });

    const implHeadingIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_2' &&
        JSON.stringify(b.heading_2).includes('Implementation notes'),
    );
    expect(blocks[implHeadingIdx + 1]).toMatchObject({ type: 'quote' });
  });

  it('renders "None — Wave N." when there are no dependencies', () => {
    const blocks = renderTaskBody(baseSections({ dependencies: [] }));
    const depsHeadingIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_2' &&
        JSON.stringify(b.heading_2).includes('Dependencies'),
    );
    expect(blocks[depsHeadingIdx + 1]).toMatchObject({
      type: 'paragraph',
      paragraph: {
        rich_text: [{ text: { content: 'None — Wave N.' } }],
      },
    });
  });
});

describe('renderTaskBody — acceptance criteria 🤖/👁️ split', () => {
  it('renders both the automated and manual subsections with their to-dos', () => {
    const blocks = renderTaskBody(
      baseSections({
        automatedCriteria: ['Unit test passes', 'tsc passes'],
        manualCriteria: ['Feature visible in browser'],
      }),
    );

    const automatedIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_3' &&
        JSON.stringify(b.heading_3).includes('🤖 Automated tests'),
    );
    const manualIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_3' &&
        JSON.stringify(b.heading_3).includes('👁️ Manual verification'),
    );
    expect(automatedIdx).toBeGreaterThanOrEqual(0);
    expect(manualIdx).toBeGreaterThan(automatedIdx);

    expect(blocks[automatedIdx + 1]).toMatchObject({
      type: 'to_do',
      to_do: {
        checked: false,
        rich_text: [{ text: { content: 'Unit test passes' } }],
      },
    });
    expect(blocks[automatedIdx + 2]).toMatchObject({
      type: 'to_do',
      to_do: { rich_text: [{ text: { content: 'tsc passes' } }] },
    });
    expect(blocks[manualIdx + 1]).toMatchObject({
      type: 'to_do',
      to_do: {
        rich_text: [{ text: { content: 'Feature visible in browser' } }],
      },
    });
  });

  it('falls back to the gate note when manual criteria is empty', () => {
    const blocks = renderTaskBody(
      baseSections({
        automatedCriteria: ['tsc passes'],
        manualCriteria: [],
      }),
    );
    const manualIdx = blocks.findIndex(
      (b) =>
        b.type === 'heading_3' &&
        JSON.stringify(b.heading_3).includes('👁️ Manual verification'),
    );
    expect(blocks[manualIdx + 1]).toMatchObject({
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            text: { content: 'Covered by the Manual Verification Gate task.' },
          },
        ],
      },
    });
  });
});

describe('WAF-safe command-line rendering', () => {
  it('detects interpreter module invocations and service-restart lines', () => {
    expect(isShellCommandLine('python3 -m http.server --bind 0.0.0.0')).toBe(
      true,
    );
    expect(
      isShellCommandLine('node -e "console.log(1)" --experimental-foo'),
    ).toBe(true);
    expect(isShellCommandLine('sudo systemctl restart nginx')).toBe(true);
    expect(isShellCommandLine('service nginx restart')).toBe(true);
    expect(isShellCommandLine('Some prose about the widget.')).toBe(false);
  });

  it('renders a command-line-shaped paragraph prosaically/backticked, not as a raw command', () => {
    const blocks = renderTaskBody(
      baseSections({
        context: [
          {
            type: 'paragraph',
            text: 'python3 -m mypackage.cli run --flag value',
          },
        ],
      }),
    );
    const contextParagraph = blocks.find(
      (b) =>
        b.type === 'paragraph' &&
        JSON.stringify(b.paragraph).includes('mypackage.cli'),
    );
    expect(contextParagraph).toMatchObject({
      paragraph: {
        rich_text: [
          {
            text: { content: 'python3 -m mypackage.cli run --flag value' },
            annotations: { code: true },
          },
        ],
      },
    });
  });

  it('renders a command-shaped code block as backticked prose instead of a `code` block type', () => {
    const blocks = renderTaskBody(
      baseSections({
        context: [
          {
            type: 'code',
            text: 'sudo systemctl restart my-service',
            language: 'bash',
          },
        ],
      }),
    );
    // Must not be emitted as an executable `code` block.
    const rawCodeBlock = blocks.find(
      (b) =>
        b.type === 'code' &&
        JSON.stringify(b.code).includes('systemctl restart'),
    );
    expect(rawCodeBlock).toBeUndefined();

    const prosaicBlock = blocks.find(
      (b) =>
        b.type === 'paragraph' &&
        JSON.stringify(b.paragraph).includes('systemctl restart'),
    );
    expect(prosaicBlock).toMatchObject({
      paragraph: {
        rich_text: [
          {
            text: { content: 'sudo systemctl restart my-service' },
            annotations: { code: true },
          },
        ],
      },
    });
  });

  it('leaves a non-command code block rendered as a `code` block', () => {
    const blocks = renderTaskBody(
      baseSections({
        context: [{ type: 'code', text: 'const x = 1;\nconst y = 2;' }],
      }),
    );
    const codeBlock = blocks.find((b) => b.type === 'code');
    expect(codeBlock).toMatchObject({
      code: {
        rich_text: [{ text: { content: 'const x = 1;\nconst y = 2;' } }],
      },
    });
  });
});

describe('markdownToBlocks — move round-trip (blockToLine inverse)', () => {
  /** Mirrors NotionClient.fetchTaskPage: one blockToLine per block, joined. */
  function toMarkdown(blocks: ReturnType<typeof renderTaskBody>): string {
    return blocks
      .map((b) => blockToLine(b as unknown as Parameters<typeof blockToLine>[0]))
      .join('\n');
  }

  it('reproduces the source body plus only the appended provenance line — no duplicate Summary, no empty skeleton', () => {
    const sourceBlocks = renderTaskBody(
      baseSections({
        summary: 'Do the thing.',
        dependencies: ['Some dependency'],
        context: [
          { type: 'heading_3', text: 'Root cause' },
          { type: 'paragraph', text: 'Some prose about the bug.' },
          { type: 'bulleted_list_item', text: 'A context bullet' },
        ],
        automatedCriteria: ['Unit test passes'],
        manualCriteria: ['Covered by the Manual Verification Gate task.'],
      }),
    );
    const sourceMarkdown = toMarkdown(sourceBlocks);

    const movedBlocks = markdownToBlocks(sourceMarkdown);
    const provenanceLine = 'Moved from notion:abc (milestone m1).';
    movedBlocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: provenanceLine } }] },
    });

    const movedMarkdown = toMarkdown(movedBlocks);
    expect(movedMarkdown).toBe(`${sourceMarkdown}\n${provenanceLine}`);

    const summaryHeadings = movedMarkdown
      .split('\n')
      .filter((l) => l === '## Summary');
    const implHeadings = movedMarkdown
      .split('\n')
      .filter((l) => l === '## Implementation notes');
    expect(summaryHeadings).toHaveLength(1);
    expect(implHeadings).toHaveLength(1);
  });

  it('parses headings, lists, quotes, dividers, and fenced code blocks', () => {
    const markdown = [
      '## Summary',
      'Some summary text.',
      '## Dependencies',
      '- Task A',
      '- Task B',
      '### Sub-heading',
      '> A quoted line',
      '---',
      '```typescript',
      'const x = 1;',
      'const y = 2;',
      '```',
      '1. A numbered item',
    ].join('\n');

    const blocks = markdownToBlocks(markdown);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading_2',
      'paragraph',
      'heading_2',
      'bulleted_list_item',
      'bulleted_list_item',
      'heading_3',
      'quote',
      'divider',
      'code',
      'numbered_list_item',
    ]);
    expect(blocks[8]).toMatchObject({
      code: {
        rich_text: [{ text: { content: 'const x = 1;\nconst y = 2;' } }],
        language: 'typescript',
      },
    });
  });
});

describe("rich_text chunking for Notion's 2000-char-per-item cap", () => {
  it('splits a >2000-char paragraph into multiple rich_text items, each <=2000 chars', () => {
    const longText = 'a'.repeat(2004);
    const blocks = renderTaskBody(
      baseSections({
        context: [{ type: 'paragraph', text: longText }],
      }),
    );
    const contextParagraph = blocks.find(
      (b) =>
        b.type === 'paragraph' &&
        JSON.stringify(b.paragraph).includes('a'.repeat(50)),
    );
    expect(contextParagraph).toBeDefined();
    const richTextItems = (contextParagraph as any).paragraph.rich_text;
    expect(richTextItems.length).toBeGreaterThan(1);
    for (const item of richTextItems) {
      expect(item.text.content.length).toBeLessThanOrEqual(2000);
    }
    expect(richTextItems.map((item: any) => item.text.content).join('')).toBe(
      longText,
    );
  });

  it('splits a >2000-char code block into multiple rich_text items, each <=2000 chars', () => {
    const longText = 'x'.repeat(4500);
    const blocks = renderTaskBody(
      baseSections({
        context: [{ type: 'code', text: longText, language: 'typescript' }],
      }),
    );
    const codeBlock = blocks.find((b) => b.type === 'code');
    expect(codeBlock).toBeDefined();
    const richTextItems = (codeBlock as any).code.rich_text;
    expect(richTextItems.length).toBe(3);
    for (const item of richTextItems) {
      expect(item.text.content.length).toBeLessThanOrEqual(2000);
    }
    expect(richTextItems.map((item: any) => item.text.content).join('')).toBe(
      longText,
    );
  });
});
