import { config } from '../config';
import { upsertTaskCache, getCacheAge, getTaskCache } from '../db/queries';
import { NotionTask, NotionApiError, ResolvedTask } from './types';
import { DependencyResolver } from './DependencyResolver';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NOTION_VERSION = '2022-06-28';
const resolver = new DependencyResolver();

// ─── Internal Notion API response shapes ───────────────────────────────────

interface NotionRichTextItem {
  text: { content: string };
}

interface NotionPage {
  id: string;
  url: string;
  properties: {
    'Task Name': { type: 'title'; title: NotionRichTextItem[] };
    Status: { type: 'select'; select: { name: string } | null };
    Type: { type: 'select'; select: { name: string } | null };
    'Depends On': { type: 'rich_text'; rich_text: NotionRichTextItem[] };
    Notes: { type: 'rich_text'; rich_text: NotionRichTextItem[] };
    [key: string]: unknown;
  };
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

// Board-level cache uses a sentinel key so the full result can be stored
// without requiring a board_id column on task_cache.
function boardCacheKey(boardId: string): string {
  return `board:${boardId}`;
}

function isBoardCacheFresh(boardId: string): boolean {
  return getCacheAge(boardCacheKey(boardId)) < CACHE_TTL_MS;
}

function readBoardCache(boardId: string): NotionTask[] | null {
  const row = getTaskCache(boardCacheKey(boardId));
  if (!row) return null;
  try {
    return JSON.parse(row.raw_json) as NotionTask[];
  } catch {
    return null;
  }
}

function writeBoardCache(boardId: string, tasks: NotionTask[]): void {
  upsertTaskCache(boardCacheKey(boardId), JSON.stringify(tasks));
  // Also cache individual tasks by their own ID
  for (const task of tasks) {
    upsertTaskCache(task.id, JSON.stringify(task));
  }
}

// ─── Notion API helpers ─────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.notionApiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `https://api.notion.com/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new NotionApiError(res.status, text);
  }

  return res.json() as Promise<T>;
}

// ─── Page mapper ────────────────────────────────────────────────────────────

function mapPageToTask(page: NotionPage): NotionTask {
  const titleItems = page.properties['Task Name']?.title ?? [];
  const title = titleItems.map((t) => t.text.content).join('');

  const status = page.properties.Status?.select?.name ?? '';
  const type = page.properties.Type?.select?.name ?? '';

  const dependsOnRaw =
    page.properties['Depends On']?.rich_text?.[0]?.text?.content ?? '';
  const dependsOn = dependsOnRaw
    ? dependsOnRaw.split('|').map((id) => id.trim()).filter(Boolean)
    : [];

  return { id: page.id, title, status, type, dependsOn, notionUrl: page.url };
}

// ─── NotionClient ───────────────────────────────────────────────────────────

export class NotionClient {
  /**
   * Fetch all tasks from a Notion database board.
   * Results are cached per board with a 5-minute TTL.
   * Returns ResolvedTask[] with dependency annotations.
   */
  async fetchReadyTasks(boardId: string): Promise<ResolvedTask[]> {
    if (isBoardCacheFresh(boardId)) {
      const cached = readBoardCache(boardId);
      if (cached) return resolver.resolve(cached);
    }

    // Fetch all pages from the board (paginate through all results)
    const tasks: NotionTask[] = [];
    let startCursor: string | undefined;

    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: {
          or: [
            { property: 'Status', select: { equals: '🗂️ Ready' } },
            { property: 'Status', select: { equals: '🔄 In Progress' } },
            { property: 'Status', select: { equals: '👀 In Review' } },
          ],
        },
      };
      if (startCursor) body.start_cursor = startCursor;

      const response = await notionRequest<NotionQueryResponse>(
        'POST',
        `/databases/${boardId}/query`,
        body,
      );

      for (const page of response.results) {
        tasks.push(mapPageToTask(page));
      }

      startCursor = response.has_more && response.next_cursor
        ? response.next_cursor
        : undefined;
    } while (startCursor);

    writeBoardCache(boardId, tasks);
    return resolver.resolve(tasks);
  }

  /** Update the Status select property on a Notion task page. */
  async updateStatus(taskId: string, status: string): Promise<void> {
    await notionRequest('PATCH', `/pages/${taskId}`, {
      properties: {
        Status: { select: { name: status } },
      },
    });
  }

  /**
   * Append a PR URL to the Notes rich_text property on a Notion task page.
   * Fetches the current Notes content first so existing text is preserved.
   */
  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const page = await notionRequest<NotionPage>('GET', `/pages/${taskId}`);
    const existing =
      page.properties.Notes?.rich_text?.[0]?.text?.content ?? '';
    const updated = existing ? `${existing}\n${prUrl}` : prUrl;

    await notionRequest('PATCH', `/pages/${taskId}`, {
      properties: {
        Notes: {
          rich_text: [{ text: { content: updated } }],
        },
      },
    });
  }
}
