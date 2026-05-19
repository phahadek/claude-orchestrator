#!/usr/bin/env node
/**
 * notion-query.mjs — Query a Notion database with full pagination.
 *
 * The Notion MCP search tool caps results at 25. This script calls the
 * Notion REST API directly and paginates through ALL pages, so nothing
 * is silently dropped.
 *
 * Usage:
 *   node notion-query.mjs <database-id> [options]
 *
 * Options:
 *   --status <s>       Filter to a single status (e.g. "🗂️ Ready")
 *   --no-done          Exclude ✅ Done tasks
 *   --property <name>  Name of the status property (default: "Status")
 *   --title <name>     Name of the title property (default: auto-detect)
 *   --json             Output raw JSON instead of formatted table
 *   --env <path>       Path to .env file to load NOTION_API_KEY from
 *
 * Environment:
 *   NOTION_API_KEY     Required. Notion integration token (ntn_...).
 *                      Can also be loaded from --env file.
 *
 * Examples:
 *   # All tasks from a board
 *   NOTION_API_KEY=ntn_... node notion-query.mjs <your-database-id>
 *
 *   # Only Ready tasks, loading key from .env
 *   node notion-query.mjs <your-database-id> --env packages/backend/.env --status "🗂️ Ready"
 *
 *   # Exclude done tasks, JSON output
 *   node notion-query.mjs 4c30510b... --no-done --json
 *
 * Global install (symlink):
 *   ln -s <repo>/scripts/notion-query.mjs ~/.claude/scripts/notion-query.mjs
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
const statusFilter = option('--status');
const statusProp = option('--property') ?? 'Status';
const titlePropOverride = option('--title');
const noDone = flag('--no-done');
const jsonOut = flag('--json');

const databaseId = args[0];

if (!databaseId) {
  console.error('Usage: node notion-query.mjs <database-id> [options]');
  console.error('Run with no args to see full help at the top of the script.');
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

// ── Notion API ───────────────────────────────────────────────────────
const NOTION_BASE = 'https://api.notion.com/v1';
const HEADERS = {
  Authorization: `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

async function queryDatabase(dbId) {
  const pages = [];
  let cursor = undefined;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    // Apply status filter if requested
    if (statusFilter) {
      body.filter = {
        property: statusProp,
        select: { equals: statusFilter },
      };
    }

    const res = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Notion API error ${res.status}: ${text}`);
      process.exit(1);
    }

    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// ── Extract properties ───────────────────────────────────────────────
function detectTitleProp(page) {
  for (const [name, prop] of Object.entries(page.properties)) {
    if (prop.type === 'title') return name;
  }
  return 'Name';
}

function extractText(prop) {
  if (!prop) return '';
  if (prop.type === 'title')
    return prop.title?.map((t) => t.plain_text).join('') ?? '';
  if (prop.type === 'rich_text')
    return prop.rich_text?.map((t) => t.plain_text).join('') ?? '';
  if (prop.type === 'select') return prop.select?.name ?? '';
  if (prop.type === 'multi_select')
    return prop.multi_select?.map((s) => s.name).join(', ') ?? '';
  if (prop.type === 'relation')
    return prop.relation?.map((r) => r.id).join(', ') ?? '';
  if (prop.type === 'url') return prop.url ?? '';
  if (prop.type === 'number') return prop.number?.toString() ?? '';
  if (prop.type === 'checkbox') return prop.checkbox ? 'true' : 'false';
  return JSON.stringify(prop[prop.type] ?? '');
}

function mapPage(page, titleProp) {
  const result = { id: page.id, url: page.url };
  for (const [name, prop] of Object.entries(page.properties)) {
    result[name] = extractText(prop);
  }
  // Ensure a consistent 'title' key
  if (titleProp && titleProp !== 'title') {
    result._title = result[titleProp];
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const pages = await queryDatabase(databaseId);

  if (pages.length === 0) {
    console.log('No results.');
    return;
  }

  const titleProp = titlePropOverride ?? detectTitleProp(pages[0]);
  let rows = pages.map((p) => mapPage(p, titleProp));

  // Post-filter: exclude Done
  if (noDone) {
    rows = rows.filter((r) => r[statusProp] !== '✅ Done');
  }

  // JSON output
  if (jsonOut) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Grouped text output
  const groups = {};
  for (const r of rows) {
    const status = r[statusProp] || '(no status)';
    if (!groups[status]) groups[status] = [];
    groups[status].push(r);
  }

  console.log(`Total: ${rows.length} tasks\n`);

  // Status display order
  const order = [
    '🔲 Backlog',
    '🗂️ Ready',
    '🔄 In Progress',
    '👀 In Review',
    '✅ Done',
    '🚫 Blocked',
    '⏭️ Deferred',
  ];
  const statuses = [
    ...order.filter((s) => groups[s]),
    ...Object.keys(groups).filter((s) => !order.includes(s)),
  ];

  for (const status of statuses) {
    const items = groups[status];
    console.log(`${status} (${items.length}):`);
    for (const r of items) {
      const title = r[titleProp] || '(untitled)';
      const priority = r['Priority'] || '';
      const type = r['Type'] || '';
      const deps = r['Depends On'] ? ` [deps: ${r['Depends On']}]` : '';
      console.log(`  ${r.id} | ${priority} | ${type} | ${title}${deps}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
