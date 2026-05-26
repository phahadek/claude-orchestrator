import type { NotionTask } from '../notion/types';

export interface ResolvedTask {
  task: NotionTask;
  source: 'notion' | 'yaml' | 'jira';
  blocked: boolean;
  blockers: NotionTask[];
  nonCode: boolean;
  wave: number;
}
