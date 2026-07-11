/**
 * Renders the task-writing.md section model (Summary, Dependencies, Context,
 * Acceptance criteria, Files/Notion pages affected, Implementation notes)
 * into Notion block-write payloads, for use with the `/blocks/{id}/children`
 * append endpoint.
 */

/** Structured content model for the Context section (see docs/task-writing.md). */
type BlockModel =
  | { type: 'paragraph'; text: string }
  | { type: 'heading_3'; text: string }
  | { type: 'bulleted_list_item'; text: string }
  | { type: 'numbered_list_item'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language?: string };

export interface TaskBodySections {
  summary: string;
  dependencies: string[];
  context: BlockModel[];
  automatedCriteria: string[];
  manualCriteria: string[];
  filesAffected?: string[];
  notionPagesAffected?: string[];
}

interface NotionRichTextAnnotations {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

interface NotionRichTextItem {
  type: 'text';
  text: { content: string };
  annotations?: NotionRichTextAnnotations;
}

export interface RenderedBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

// ─── WAF hazard detection ───────────────────────────────────────────────────

/**
 * A body containing a bare shell-command line (an interpreter module
 * invocation with flags, or a service-restart line) is blocked by the
 * upstream WAF as a command-injection pattern. Such lines must be rendered
 * prosaically / backticked rather than as an executable command line —
 * see procedures.md § Notion access.
 */
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'npx',
  'npm',
  'yarn',
  'pnpm',
  'bash',
  'sh',
  'ts-node',
  'ruby',
  'perl',
  'php',
]);
const SERVICE_ACTIONS = new Set([
  'start',
  'stop',
  'restart',
  'reload',
  'status',
]);
// Anchored, single-pass, no nested quantifiers — safe against ReDoS.
const LONG_FLAG_RE = /^--[\w-]+$/;

/**
 * Tokenizes a line and inspects the leading command (after an optional
 * `sudo`) rather than a single sprawling regex — avoids the catastrophic
 * backtracking a `.*` + alternation pattern risks on adversarial input.
 */
export function isShellCommandLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return false;
  const offset = tokens[0].toLowerCase() === 'sudo' ? 1 : 0;
  const cmd = tokens[offset]?.toLowerCase();
  if (!cmd) return false;

  if (INTERPRETERS.has(cmd)) {
    const rest = tokens.slice(offset + 1);
    const hasModuleFlag = rest.some(
      (token, i) => token === '-m' && rest[i + 1] !== undefined,
    );
    const hasLongFlag = rest.some((token) => LONG_FLAG_RE.test(token));
    return hasModuleFlag || hasLongFlag;
  }

  if (cmd === 'systemctl') {
    const action = tokens[offset + 1]?.toLowerCase();
    return action !== undefined && SERVICE_ACTIONS.has(action);
  }

  if (cmd === 'service') {
    const action = tokens[offset + 2]?.toLowerCase();
    return action !== undefined && SERVICE_ACTIONS.has(action);
  }

  return false;
}

/**
 * Renders text as rich_text, backticking it (inline code annotation) when it
 * looks like an executable command line — WAF-safe, and still legible as a
 * reference to the command rather than a literal command block.
 */
function richText(text: string): NotionRichTextItem[] {
  if (isShellCommandLine(text)) {
    return [
      { type: 'text', text: { content: text }, annotations: { code: true } },
    ];
  }
  return [{ type: 'text', text: { content: text } }];
}

function italicRichText(text: string): NotionRichTextItem[] {
  return [
    { type: 'text', text: { content: text }, annotations: { italic: true } },
  ];
}

// ─── Block builders ─────────────────────────────────────────────────────────

function heading2(text: string): RenderedBlock {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: richText(text) },
  };
}

function heading3(text: string): RenderedBlock {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: richText(text) },
  };
}

function paragraph(
  text: string,
  richTextOverride?: NotionRichTextItem[],
): RenderedBlock {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richTextOverride ?? richText(text) },
  };
}

function bulletedListItem(text: string): RenderedBlock {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText(text) },
  };
}

function numberedListItem(text: string): RenderedBlock {
  return {
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: richText(text) },
  };
}

function quote(text: string): RenderedBlock {
  return {
    object: 'block',
    type: 'quote',
    quote: { rich_text: richText(text) },
  };
}

function todo(text: string, checked = false): RenderedBlock {
  return {
    object: 'block',
    type: 'to_do',
    to_do: { rich_text: richText(text), checked },
  };
}

function codeBlock(text: string, language = 'plain text'): RenderedBlock {
  return {
    object: 'block',
    type: 'code',
    code: { rich_text: [{ type: 'text', text: { content: text } }], language },
  };
}

/**
 * Renders a code block. If any line looks like an executable shell command,
 * the whole snippet is rendered as a paragraph with inline code annotations
 * instead of a `code` block — the WAF flags command-shaped lines inside code
 * blocks too, so the safe path is prosaic/backticked text, never a literal
 * command line.
 */
function renderCode(text: string, language?: string): RenderedBlock {
  const lines = text.split('\n');
  if (lines.some(isShellCommandLine)) {
    const richTextItems: NotionRichTextItem[] = lines.flatMap((line, i) => {
      const item: NotionRichTextItem = {
        type: 'text',
        text: { content: i === lines.length - 1 ? line : `${line}\n` },
        annotations: { code: true },
      };
      return [item];
    });
    return paragraph(text, richTextItems);
  }
  return codeBlock(text, language);
}

function renderContextBlock(block: BlockModel): RenderedBlock {
  switch (block.type) {
    case 'paragraph':
      return paragraph(block.text);
    case 'heading_3':
      return heading3(block.text);
    case 'bulleted_list_item':
      return bulletedListItem(block.text);
    case 'numbered_list_item':
      return numberedListItem(block.text);
    case 'quote':
      return quote(block.text);
    case 'code':
      return renderCode(block.text, block.language);
  }
}

// ─── Section renderers ───────────────────────────────────────────────────────

function renderDependencies(dependencies: string[]): RenderedBlock[] {
  if (dependencies.length === 0) {
    return [paragraph('None — Wave N.', italicRichText('None — Wave N.'))];
  }
  return dependencies.map((dep) => bulletedListItem(dep));
}

function renderAcceptanceCriteria(
  automatedCriteria: string[],
  manualCriteria: string[],
): RenderedBlock[] {
  const blocks: RenderedBlock[] = [heading2('Acceptance criteria')];
  blocks.push(heading3('🤖 Automated tests'));
  blocks.push(...automatedCriteria.map((c) => todo(c)));
  blocks.push(heading3('👁️ Manual verification'));
  if (manualCriteria.length === 0) {
    blocks.push(paragraph('Covered by the Manual Verification Gate task.'));
  } else {
    blocks.push(...manualCriteria.map((c) => todo(c)));
  }
  return blocks;
}

/** Renders the full task-writing.md section model into Notion block-write payloads. */
export function renderTaskBody(sections: TaskBodySections): RenderedBlock[] {
  const blocks: RenderedBlock[] = [];

  blocks.push(heading2('Summary'));
  blocks.push(paragraph(sections.summary));

  blocks.push(heading2('Dependencies'));
  blocks.push(...renderDependencies(sections.dependencies));

  blocks.push(heading2('Context'));
  blocks.push(...sections.context.map(renderContextBlock));

  blocks.push(
    ...renderAcceptanceCriteria(
      sections.automatedCriteria,
      sections.manualCriteria,
    ),
  );

  if (sections.filesAffected?.length) {
    blocks.push(heading2('Files / paths affected'));
    blocks.push(...sections.filesAffected.map((f) => bulletedListItem(f)));
  }

  if (sections.notionPagesAffected?.length) {
    blocks.push(heading2('Notion pages affected'));
    blocks.push(
      ...sections.notionPagesAffected.map((p) => bulletedListItem(p)),
    );
  }

  blocks.push(heading2('Implementation notes'));
  blocks.push(quote('To be filled in during/after task completion.'));

  return blocks;
}
