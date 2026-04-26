import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { TaskTrackerBackend } from './TaskTrackerBackend';
import type { ResolvedTask, NotionTask } from '../notion/types';
import { DependencyResolver } from '../notion/DependencyResolver';

// ── tasks.yaml schema ────────────────────────────────────────────────────────

interface LocalTask {
  id: string;
  name: string;
  status: string;       // Backlog | Ready | In Progress | In Review | Done
  priority?: string;    // High | Medium | Low
  type?: string;        // Code | Planning | Testing
  depends_on?: string[];
  pr_url?: string | null;
  context?: string;
  acceptance_criteria?: string;
  files_affected?: string[];
  notes?: string;
}

interface TasksFile {
  board_id?: string;
  tasks: LocalTask[];
}

// ── Status mapping ───────────────────────────────────────────────────────────

const STATUS_DISPLAY: Record<string, string> = {
  'Backlog':     '🔲 Backlog',
  'Ready':       '🗂️ Ready',
  'In Progress': '🔄 In Progress',
  'In Review':   '👀 In Review',
  'Done':        '✅ Done',
};

const TYPE_DISPLAY: Record<string, string> = {
  'Code':     '💻 Code',
  'Planning': '📋 Planning',
  'Testing':  '🧪 Testing',
};

function toDisplayStatus(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

function toDisplayType(type: string): string {
  return TYPE_DISPLAY[type] ?? type;
}

function fromDisplayStatus(display: string): string {
  const entry = Object.entries(STATUS_DISPLAY).find(([, v]) => v === display);
  return entry ? entry[0] : display;
}

// ── LocalTaskBackend ─────────────────────────────────────────────────────────

const resolver = new DependencyResolver();

/**
 * File-based implementation of TaskTrackerBackend.
 * Reads/writes task definitions from a `tasks.yaml` file in `projectDir`.
 */
export class LocalTaskBackend implements TaskTrackerBackend {
  readonly type = 'local' as const;

  constructor(private readonly projectDir: string) {}

  private get filePath(): string {
    return path.join(this.projectDir, 'tasks.yaml');
  }

  private readFile(): TasksFile {
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const parsed = yaml.load(raw) as TasksFile;
    if (!parsed || !Array.isArray(parsed.tasks)) {
      throw new Error(`[LocalTaskBackend] tasks.yaml has no tasks array in ${this.filePath}`);
    }
    return parsed;
  }

  private writeFile(file: TasksFile): void {
    fs.writeFileSync(this.filePath, yaml.dump(file, { lineWidth: 120 }), 'utf-8');
  }

  private mapToNotionTask(t: LocalTask): NotionTask {
    return {
      id: t.id,
      title: t.name,
      status: toDisplayStatus(t.status),
      type: toDisplayType(t.type ?? 'Code'),
      dependsOn: t.depends_on ?? [],
      notionUrl: '',
      prUrl: t.pr_url ?? undefined,
      priority: t.priority,
    };
  }

  async fetchReadyTasks(boardId: string, _skipCache?: boolean): Promise<ResolvedTask[]> {
    void boardId; // boardId not used — single board per file
    const file = this.readFile();
    const allTasks = file.tasks.map((t) => this.mapToNotionTask(t));
    const readyTasks = allTasks.filter((t) => t.status === STATUS_DISPLAY['Ready']);
    // Run through DependencyResolver against all tasks for accurate wave computation
    const resolved = resolver.resolve(allTasks);
    return resolved.filter((r) => r.task.status === STATUS_DISPLAY['Ready'] || readyTasks.some((t) => t.id === r.task.id));
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const file = this.readFile();
    const task = file.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    task.pr_url = prUrl;
    this.writeFile(file);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const file = this.readFile();
    const task = file.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);
    task.status = fromDisplayStatus(status);
    this.writeFile(file);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const file = this.readFile();
    const task = file.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`[LocalTaskBackend] task not found: ${taskId}`);

    const sections: string[] = [`# ${task.name}`];
    if (task.context?.trim()) {
      sections.push(`## Context\n${task.context.trim()}`);
    }
    if (task.acceptance_criteria?.trim()) {
      sections.push(`## Acceptance Criteria\n${task.acceptance_criteria.trim()}`);
    }
    if (task.files_affected && task.files_affected.length > 0) {
      sections.push(`## Files\n${task.files_affected.map((f) => `- ${f}`).join('\n')}`);
    }
    if (task.notes?.trim()) {
      sections.push(`## Notes\n${task.notes.trim()}`);
    }
    return sections.join('\n\n');
  }
}
