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
  createdAt?: number; // backend-native creation time, epoch ms; absent when the source has none
}

/** Parses a backend creation timestamp (ISO string or Date) to epoch ms; undefined when absent or invalid. */
export function parseCreatedAt(value: unknown): number | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
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
