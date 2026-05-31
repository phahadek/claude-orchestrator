export interface NotionTask {
  id: string;
  title: string;
  status: string;
  type: string; // '📋 Planning' | '💻 Code' | '🧪 Testing'
  dependsOn: string[]; // array of Notion page IDs
  notionUrl: string;
  prUrl?: string; // value of the "PR" URL property on the Notion page, if present
  priority?: string; // '🔴 High' | '🟡 Medium' | '🟢 Low'
}

// ResolvedTask has been moved to packages/backend/src/tasks/types.ts.
// Re-exported here for backward compatibility.
export type { ResolvedTask } from '../tasks/types';

export class NotionApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}
