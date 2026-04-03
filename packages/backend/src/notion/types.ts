export interface NotionTask {
  id: string;
  title: string;
  status: string;
  type: string; // '📋 Planning' | '💻 Code' | '🧪 Testing'
  dependsOn: string[]; // array of Notion page IDs
  notionUrl: string;
  prUrl?: string; // value of the "PR" URL property on the Notion page, if present
}

export interface ResolvedTask {
  task: NotionTask;
  blocked: boolean;
  blockers: NotionTask[];  // direct + transitive blockers still not Done
  nonCode: boolean;        // true if type is Planning or Testing
  wave: number;            // dispatch wave: 1 = immediately launchable, 2+ = blocked by lower waves
}

export class NotionApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}
