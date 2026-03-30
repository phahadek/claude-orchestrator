import { NotionTask, ResolvedTask } from './types';
import { DependencyResolver } from './DependencyResolver';

const resolver = new DependencyResolver();

export class NotionClient {
  async fetchReadyTasks(_boardId: string): Promise<ResolvedTask[]> {
    // TODO: implement Notion API call
    const tasks: NotionTask[] = [];
    return resolver.resolve(tasks);
  }
}
