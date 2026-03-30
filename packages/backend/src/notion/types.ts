export interface NotionTask {
  id: string;
  title: string;
  status: string;
  type: string; // '📋 Planning' | '💻 Code' | '🧪 Testing'
  dependsOn: string[]; // array of Notion page IDs
  notionUrl: string;
}

export interface ResolvedTask {
  task: NotionTask;
  blocked: boolean;
  blockers: NotionTask[];  // direct + transitive blockers still not Done
  nonCode: boolean;        // true if type is Planning or Testing
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
