export interface NotionTask {
  id: string;
  title: string;
  status: string;
  type: string; // '📋 Planning' | '💻 Code' | '🧪 Testing' | '🚦 Gate'
  dependsOn: string[]; // array of Notion page IDs
  notionUrl: string;
  prUrl?: string; // value of the "PR" URL property on the Notion page, if present
  priority?: string; // '🔴 High' | '🟡 Medium' | '🟢 Low'
  reviewer?: string[]; // GitHub usernames to auto-request for review (corporate mode)
  archived?: boolean; // true if the Notion page has been archived (soft-deleted)
}

// ResolvedTask has been moved to packages/backend/src/tasks/types.ts.
// Re-exported here for backward compatibility.
export type { ResolvedTask } from '../tasks/types';

export class NotionApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    /** Parsed retry delay (ms) that was honoured before the retry budget was exhausted. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}
