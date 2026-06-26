#!/usr/bin/env node
/**
 * notion-page.mjs — Fetch a Notion page as Markdown via the REST API.
 *
 * The Notion MCP `notion-fetch` returns the entire page as a single
 * unbroken text blob with no internal line breaks, which makes large
 * pages (>50k chars) unreadable by file-handling tools and can blow
 * past the MCP response size limit entirely. This script calls the
 * Notion REST blocks API directly, paginates and recurses through
 * nested children, and emits clean line-broken Markdown that Grep /
 * Read offset-limit / Bash slicing can bite on.
 *
 * Usage:
 *   node notion-page.mjs <page-id> [options]
 *
 * Options:
 *   --env <path>     Path to .env file to load NOTION_API_KEY from
 *   --format <fmt>   "md" (default) or "json"
 *   --depth <n>      Max recursion depth into nested children (default: unlimited)
 *
 * Environment:
 *   NOTION_API_KEY   Required. Notion integration token (ntn_...).
 *                    Can also be loaded from --env file.
 *
 * Examples:
 *   # Fetch a page as Markdown
 *   node notion-page.mjs 35522f9152f381ce949ff216df0c922a \
 *     --env /c/Users/phadek/IdeaProjects/claude-dashboard/packages/backend/.env
 *
 *   # Pipe to a file
 *   node notion-page.mjs 35522f9152f381ce949ff216df0c922a --env <path> > arch.md
 *
 *   # Raw JSON (for debugging block structure)
 *   node notion-page.mjs <page-id> --env <path> --format json
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Arg parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  args.splice(i, 1);
  return true;
}

function option(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

const envPath = option('--env');
const format = option('--format') ?? 'md';
const maxDepth = option('--depth') ? Number(option('--depth')) : Infinity;
const pageIdRaw = args[0];

if (!pageIdRaw) {
  console.error('Usage: node notion-page.mjs <page-id> [options]');
  console.error('Run with no args to see full help at the top of the script.');
  process.exit(1);
}

if (!['md', 'json'].includes(format)) {
  console.error(`Error: --format must be "md" or "json", got "${format}"`);
  process.exit(1);
}

// ── Load env ─────────────────────────────────────────────────────────
if (envPath) {
  try {
    const abs = resolve(process.cwd(), envPath);
    const lines = readFileSync(abs, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) {
    console.error(`Warning: could not load env from ${envPath}: ${e.message}`);
  }
}

const NOTION_API_KEY = process.env.NOTION_API_KEY;
if (!NOTION_API_KEY) {
  console.error(
    'Error: NOTION_API_KEY not set. Pass --env <path> or export it.',
  );
  process.exit(1);
}

// ── ID normalisation ─────────────────────────────────────────────────
function normalizeId(raw) {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    console.error(`Error: "${raw}" is not a valid Notion page/block ID.`);
    process.exit(1);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const pageId = normalizeId(pageIdRaw);

// ── Notion API ───────────────────────────────────────────────────────
const NOTION_BASE = 'https://api.notion.com/v1';
const HEADERS = {
  Authorization: `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

async function getPage(id) {
  const res = await fetch(`${NOTION_BASE}/pages/${id}`, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    console.error(
      `Notion API error ${res.status} fetching page ${id}: ${text}`,
    );
    process.exit(1);
  }
  return res.json();
}

async function getChildren(blockId) {
  const blocks = [];
  let cursor = undefined;
  do {
    const url = new URL(`${NOTION_BASE}/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const text = await res.text();
      console.error(
        `Notion API error ${res.status} fetching children of ${blockId}: ${text}`,
      );
      process.exit(1);
    }
    const data = await res.json();
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function getBlockTree(blockId, depth) {
  const children = await getChildren(blockId);
  if (depth <= 0) {
    return children.map((b) => ({ ...b, _children: [] }));
  }
  const out = [];
  for (const b of children) {
    const node = { ...b, _children: [] };
    if (b.has_children) {
      node._children = await getBlockTree(b.id, depth - 1);
    }
    out.push(node);
  }
  return out;
}

// ── Rich text rendering ──────────────────────────────────────────────
function renderRichText(items) {
  if (!items || items.length === 0) return '';
  return items.map(renderRichTextItem).join('');
}

function renderRichTextItem(item) {
  let text = item.plain_text ?? '';
  if (!text) return '';

  const a = item.annotations ?? {};
  if (a.code) text = '`' + text + '`';
  if (a.bold) text = '**' + text + '**';
  if (a.italic) text = '*' + text + '*';
  if (a.strikethrough) text = '~~' + text + '~~';
  if (item.href) text = `[${text}](${item.href})`;
  return text;
}

// ── Block rendering ──────────────────────────────────────────────────
function indent(s, prefix) {
  return s
    .split('\n')
    .map((line) => (line.length ? prefix + line : line))
    .join('\n');
}

function renderBlock(block, listCtx) {
  const t = block.type;
  const payload = block[t] ?? {};
  const rt = (k = 'rich_text') => renderRichText(payload[k]);
  const kids = block._children ?? [];

  switch (t) {
    case 'heading_1':
      return `\n# ${rt()}\n`;
    case 'heading_2':
      return `\n## ${rt()}\n`;
    case 'heading_3':
      return `\n### ${rt()}\n`;
    case 'paragraph': {
      const body = rt();
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n\n' + indent(childMd, '  ') : '');
    }
    case 'bulleted_list_item': {
      const body = `- ${rt()}`;
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n' + indent(childMd, '  ') : '');
    }
    case 'numbered_list_item': {
      const n = listCtx?.numberedIndex ?? 1;
      const body = `${n}. ${rt()}`;
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n' + indent(childMd, '   ') : '');
    }
    case 'to_do': {
      const mark = payload.checked ? '[x]' : '[ ]';
      const body = `- ${mark} ${rt()}`;
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n' + indent(childMd, '  ') : '');
    }
    case 'toggle': {
      const body = `<details><summary>${rt()}</summary>`;
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n\n' + childMd + '\n' : '') + '</details>';
    }
    case 'quote': {
      const body = rt()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n' + indent(childMd, '> ') : '');
    }
    case 'callout': {
      const icon = payload.icon?.emoji ?? payload.icon?.type ?? '💡';
      const body = `> ${icon} ${rt()}`;
      const childMd = renderBlocks(kids);
      return body + (childMd ? '\n' + indent(childMd, '> ') : '');
    }
    case 'code': {
      const lang = payload.language ?? '';
      const body = payload.rich_text?.map((t) => t.plain_text).join('') ?? '';
      const caption = renderRichText(payload.caption);
      return (
        '```' +
        lang +
        '\n' +
        body +
        '\n```' +
        (caption ? '\n*' + caption + '*' : '')
      );
    }
    case 'divider':
      return '\n---\n';
    case 'table':
      return renderTable(payload, kids);
    case 'table_row':
      // Handled inside renderTable; standalone shouldn't happen
      return '';
    case 'column_list':
    case 'column':
    case 'synced_block':
      return renderBlocks(kids);
    case 'child_page':
      return `\n**[Child page: ${payload.title ?? '(untitled)'}]** (block id: ${block.id})\n`;
    case 'child_database':
      return `\n**[Child database: ${payload.title ?? '(untitled)'}]** (block id: ${block.id})\n`;
    case 'link_to_page': {
      const target = payload.page_id ?? payload.database_id ?? '?';
      return `\n[→ link to page: ${target}]\n`;
    }
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return `\n[${t}: ${payload.url ?? ''}]\n`;
    case 'image':
    case 'video':
    case 'file':
    case 'pdf':
    case 'audio': {
      const url = payload.external?.url ?? payload.file?.url ?? '';
      return `\n[${t}${url ? ': ' + url : ''}]\n`;
    }
    case 'equation':
      return `$${payload.expression ?? ''}$`;
    case 'breadcrumb':
    case 'table_of_contents':
    case 'template':
      return `\n[${t}]\n`;
    case 'unsupported':
      return `\n[unsupported block ${block.id}]\n`;
    default: {
      // Unknown block type: render rich_text if present, else placeholder.
      const fallback = renderRichText(payload.rich_text);
      return fallback || `\n[unhandled block type: ${t}]\n`;
    }
  }
}

function renderTable(payload, rowBlocks) {
  const rows = rowBlocks.filter((b) => b.type === 'table_row');
  if (rows.length === 0) return '\n[empty table]\n';
  const lines = [];
  const renderRow = (r) =>
    '| ' +
    (r.table_row.cells ?? [])
      .map((c) => renderRichText(c).replace(/\n/g, ' ').replace(/\|/g, '\\|'))
      .join(' | ') +
    ' |';
  lines.push(renderRow(rows[0]));
  if (payload.has_column_header) {
    const colCount = rows[0].table_row.cells?.length ?? 0;
    lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');
  }
  for (let i = 1; i < rows.length; i++) lines.push(renderRow(rows[i]));
  return '\n' + lines.join('\n') + '\n';
}

function renderBlocks(blocks) {
  const out = [];
  let numberedIndex = 0;
  for (const b of blocks) {
    if (b.type === 'numbered_list_item') {
      numberedIndex += 1;
    } else {
      numberedIndex = 0;
    }
    const md = renderBlock(b, { numberedIndex });
    out.push(md);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Property → title extraction ──────────────────────────────────────
function pageTitle(page) {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === 'title') {
      return prop.title?.map((t) => t.plain_text).join('') ?? '';
    }
  }
  return '';
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const page = await getPage(pageId);
  const title = pageTitle(page);
  const tree = await getBlockTree(pageId, maxDepth);

  if (format === 'json') {
    console.log(JSON.stringify({ page, blocks: tree }, null, 2));
    return;
  }

  // Markdown
  const lines = [];
  if (title) lines.push(`# ${title}`, '');
  lines.push(`<!-- notion page id: ${pageId} -->`);
  lines.push(`<!-- notion url: ${page.url ?? ''} -->`);
  lines.push('');
  lines.push(renderBlocks(tree));
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
