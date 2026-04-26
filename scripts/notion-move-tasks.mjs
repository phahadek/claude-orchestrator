#!/usr/bin/env node
/**
 * notion-move-tasks.mjs — Move Notion pages between databases.
 *
 * The Notion API does not support changing a page's parent database.
 * This script works around that by:
 *   1. Creating a new page in the target database with the same properties
 *   2. Copying all content blocks from the source page
 *   3. Archiving the source page
 *
 * Usage:
 *   node notion-move-tasks.mjs --target <database-id> --tasks <id1,id2,...> [options]
 *
 * Options:
 *   --target <id>       Target database ID (required)
 *   --tasks <ids>       Comma-separated page IDs to move (required)
 *   --env <path>        Path to .env file to load NOTION_API_KEY from
 *   --dry-run           Show what would happen without making changes
 *   --no-archive        Copy to target but don't archive the source page
 *   --status <s>        Override the Status property on moved tasks (e.g. "🔲 Backlog")
 *
 * Environment:
 *   NOTION_API_KEY      Required. Notion integration token.
 *
 * Known limitations:
 *   - Table blocks with children may fail to copy (Notion API limitation).
 *     The script will create the page without content and log a warning.
 *   - Relation properties (Depends On as relation type) are copied as-is
 *     but the relation targets still point to the source database's pages.
 *   - The new page gets a new ID. Any external references to the old ID
 *     will point to the archived page.
 *
 * Examples:
 *   # Move 3 tasks to M2a board
 *   node notion-move-tasks.mjs \
 *     --target <your-database-id> \
 *     --tasks "abc123,def456,ghi789" \
 *     --env packages/backend/.env
 *
 *   # Dry run — see what would happen
 *   node notion-move-tasks.mjs \
 *     --target <your-database-id> --tasks "abc123" --dry-run
 *
 *   # Move and reset status to Backlog
 *   node notion-move-tasks.mjs \
 *     --target 19287f31... --tasks "abc123" --status "🔲 Backlog"
 *
 * Global location: ~/.claude/scripts/notion-move-tasks.mjs (symlink)
 * Source: scripts/notion-move-tasks.mjs in the claude-orchestrator repo
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Arg parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
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
const targetDbId = option('--target');
const tasksRaw = option('--tasks');
const statusOverride = option('--status');
const dryRun = flag('--dry-run');
const noArchive = flag('--no-archive');

if (!targetDbId || !tasksRaw) {
  console.error('Usage: node notion-move-tasks.mjs --target <database-id> --tasks <id1,id2,...> [options]');
  console.error('Run with no args to see full help at the top of the script.');
  process.exit(1);
}

const taskIds = tasksRaw.split(',').map(id => id.trim()).filter(Boolean);

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
  console.error('Error: NOTION_API_KEY not set. Pass --env <path> or export it.');
  process.exit(1);
}

// ── Notion API ───────────────────────────────────────────────────────
const HEADERS = {
  'Authorization': `Bearer ${NOTION_API_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

async function api(method, path, body) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com/v1${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Block cleaning ───────────────────────────────────────────────────
/**
 * Recursively strip null values and metadata fields that Notion rejects
 * on create (id, timestamps, authorship, etc.)
 */
function cleanBlock(obj) {
  if (Array.isArray(obj)) return obj.map(cleanBlock);
  if (obj === null || typeof obj !== 'object') return obj;

  const skip = new Set([
    'id', 'created_time', 'last_edited_time', 'created_by',
    'last_edited_by', 'parent', 'has_children', 'archived',
    'in_trash', 'request_id',
  ]);

  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue;
    if (v === null || v === undefined) continue;
    // Notion limits rich_text arrays to 100 items
    if (k === 'rich_text' && Array.isArray(v) && v.length > 100) {
      cleaned[k] = v.slice(0, 100);
    } else {
      cleaned[k] = cleanBlock(v);
    }
  }
  return cleaned;
}

// ── Extract title from page ──────────────────────────────────────────
function getTitle(page) {
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === 'title') {
      return prop.title?.map(t => t.plain_text).join('') ?? '(untitled)';
    }
  }
  return '(untitled)';
}

// ── Build target properties from source page ─────────────────────────
function buildProperties(page) {
  const props = {};

  for (const [name, prop] of Object.entries(page.properties)) {
    switch (prop.type) {
      case 'title':
        props[name] = { title: prop.title };
        break;
      case 'select':
        if (name === 'Status' && statusOverride) {
          props[name] = { select: { name: statusOverride } };
        } else if (prop.select) {
          props[name] = { select: { name: prop.select.name } };
        }
        break;
      case 'rich_text':
        if (prop.rich_text?.length) {
          props[name] = { rich_text: prop.rich_text };
        }
        break;
      // Skip relation, rollup, formula, and other computed types —
      // they may not exist in the target database schema
      default:
        break;
    }
  }

  return props;
}

// ── Move a single task ───────────────────────────────────────────────
async function moveTask(pageId) {
  // 1. Fetch source page
  const page = await api('GET', `/pages/${pageId}`);
  const title = getTitle(page);

  if (dryRun) {
    console.log(`[dry-run] Would move: ${title} (${pageId})`);
    return { title, success: true };
  }

  const props = buildProperties(page);

  // 2. Create new page in target database (without content first)
  const newPage = await api('POST', '/pages', {
    parent: { database_id: targetDbId },
    properties: props,
  });

  // 3. Copy content blocks
  let contentCopied = true;
  try {
    let cursor;
    do {
      const url = `/blocks/${pageId}/children?page_size=50${cursor ? '&start_cursor=' + cursor : ''}`;
      const data = await api('GET', url);
      if (data.results.length > 0) {
        const cleaned = data.results.map(cleanBlock);
        await api('PATCH', `/blocks/${newPage.id}/children`, { children: cleaned });
      }
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.warn(`  ⚠ Content copy failed for "${title}": ${e.message}`);
    console.warn(`    Page created without content — copy manually if needed.`);
    contentCopied = false;
  }

  // 4. Archive source page
  if (!noArchive) {
    await api('PATCH', `/pages/${pageId}`, { archived: true });
  }

  const status = contentCopied ? '✅' : '⚠️';
  const archiveNote = noArchive ? ' (source kept)' : ' (source archived)';
  console.log(`${status} ${title} → ${newPage.id}${archiveNote}`);

  return { title, success: true, newId: newPage.id, contentCopied };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`Moving ${taskIds.length} task(s) to database ${targetDbId}`);
  if (dryRun) console.log('[DRY RUN — no changes will be made]\n');
  if (statusOverride) console.log(`Status override: ${statusOverride}\n`);
  console.log('');

  let ok = 0;
  let fail = 0;

  for (const id of taskIds) {
    try {
      await moveTask(id);
      ok++;
    } catch (e) {
      console.error(`❌ ${id}: ${e.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} moved, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
