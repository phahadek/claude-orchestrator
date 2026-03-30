export interface NotionTask {
  id: string;
  name: string;
  status: string;
  type: string;
  taskUrl: string;
  dependsOn: string[];  // parsed from pipe-delimited rich text field
}

export interface ResolvedTask {
  task: NotionTask;
  blocked: boolean;
  blockers: NotionTask[];  // direct + transitive blockers still not Done
  nonCode: boolean;        // true if type is Planning or Testing
}

export class NotionApiError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'NotionApiError';
  }
}
